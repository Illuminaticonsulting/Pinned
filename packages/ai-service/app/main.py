"""Pinned AI Service – FastAPI application entry point.

Provides pattern recognition, regime detection, and trading signal generation
for the Pinned crypto orderflow platform.
"""

from __future__ import annotations

import asyncio
import logging
import time
from contextlib import asynccontextmanager
from typing import AsyncGenerator

import psycopg2
import psycopg2.pool
import redis.asyncio as aioredis
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from prometheus_fastapi_instrumentator import Instrumentator

from app.config import settings
from app.models.pattern_model import PatternClassifier
from app.models.regime_model import RegimeClassifier
from app.routes import health, predictions, signals
from app.signals.generator import SignalGenerator

logger = logging.getLogger("pinned.ai")

# ---------------------------------------------------------------------------
# Global state – populated during startup, cleaned up on shutdown
# ---------------------------------------------------------------------------

class AppState:
    """Mutable container for shared runtime resources."""

    redis: aioredis.Redis | None = None
    db_pool: psycopg2.pool.ThreadedConnectionPool | None = None
    pattern_model: PatternClassifier | None = None
    regime_model: RegimeClassifier | None = None
    signal_generator: SignalGenerator | None = None
    models_loaded: bool = False
    start_time: float = 0.0
    _tasks: list[asyncio.Task] = []  # noqa: RUF012


app_state = AppState()

# ---------------------------------------------------------------------------
# Background loops
# ---------------------------------------------------------------------------

ACTIVE_SYMBOLS: list[str] = ["BTC-USDT", "ETH-USDT", "SOL-USDT"]


async def _prediction_loop() -> None:
    """Periodically compute features and generate predictions for active symbols."""

    while True:
        try:
            for symbol in ACTIVE_SYMBOLS:
                if app_state.signal_generator is None:
                    break
                try:
                    signal = await asyncio.to_thread(
                        app_state.signal_generator.generate_signal, symbol
                    )
                    if signal is not None:
                        logger.info(
                            "Signal generated for %s: %s (%.2f)",
                            symbol,
                            signal.get("direction"),
                            signal.get("confidence", 0),
                        )
                except Exception:
                    logger.exception("Prediction failed for %s", symbol)
        except asyncio.CancelledError:
            break
        except Exception:
            logger.exception("Prediction loop error")
        await asyncio.sleep(settings.PREDICTION_INTERVAL_SECONDS)


async def _regime_loop() -> None:
    """Periodically update regime classification for active symbols."""

    while True:
        try:
            for symbol in ACTIVE_SYMBOLS:
                if app_state.signal_generator is None:
                    break
                try:
                    regime = await asyncio.to_thread(
                        app_state.signal_generator.update_regime, symbol
                    )
                    if regime is not None:
                        logger.info(
                            "Regime for %s: %s (%.2f)",
                            symbol,
                            regime.get("regime"),
                            regime.get("confidence", 0),
                        )
                except Exception:
                    logger.exception("Regime update failed for %s", symbol)
        except asyncio.CancelledError:
            break
        except Exception:
            logger.exception("Regime loop error")
        await asyncio.sleep(settings.REGIME_UPDATE_INTERVAL_SECONDS)

# ---------------------------------------------------------------------------
# Lifespan
# ---------------------------------------------------------------------------

@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncGenerator[None, None]:
    """Manage startup and shutdown of shared resources."""

    logging.basicConfig(
        level=getattr(logging, settings.LOG_LEVEL.upper(), logging.INFO),
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    )

    app_state.start_time = time.time()

    # --- Redis ---
    try:
        app_state.redis = aioredis.from_url(
            settings.REDIS_URL,
            decode_responses=True,
            socket_connect_timeout=5,
        )
        await app_state.redis.ping()
        logger.info("Connected to Redis at %s", settings.REDIS_URL)
    except Exception:
        logger.warning("Redis unavailable – caching disabled", exc_info=True)
        app_state.redis = None

    # --- PostgreSQL / TimescaleDB ---
    try:
        app_state.db_pool = psycopg2.pool.ThreadedConnectionPool(
            minconn=1,
            maxconn=5,
            dsn=settings.DATABASE_URL,
        )
        logger.info("Connected to database")
    except Exception:
        logger.warning("Database unavailable – persistence disabled", exc_info=True)
        app_state.db_pool = None

    # --- Models ---
    try:
        pattern_model = PatternClassifier()
        pattern_model.load(settings.MODEL_PATH)
        app_state.pattern_model = pattern_model

        regime_model = RegimeClassifier()
        app_state.regime_model = regime_model

        app_state.models_loaded = True
        logger.info("Models loaded successfully")
    except Exception:
        logger.warning("Model loading failed – using rule-based fallback", exc_info=True)
        app_state.pattern_model = PatternClassifier()
        app_state.regime_model = RegimeClassifier()
        app_state.models_loaded = True

    # --- Signal generator ---
    app_state.signal_generator = SignalGenerator(
        pattern_model=app_state.pattern_model,
        regime_model=app_state.regime_model,
        redis_client=app_state.redis,
        db_pool=app_state.db_pool,
        min_confidence=settings.MIN_CONFIDENCE_THRESHOLD,
    )

    # --- Background tasks ---
    app_state._tasks.append(asyncio.create_task(_prediction_loop()))
    app_state._tasks.append(asyncio.create_task(_regime_loop()))
    logger.info("Background tasks started")

    yield

    # --- Shutdown ---
    for task in app_state._tasks:
        task.cancel()
    await asyncio.gather(*app_state._tasks, return_exceptions=True)

    if app_state.redis is not None:
        await app_state.redis.aclose()
        logger.info("Redis connection closed")

    if app_state.db_pool is not None:
        app_state.db_pool.closeall()
        logger.info("Database pool closed")

    logger.info("AI service shut down cleanly")

# ---------------------------------------------------------------------------
# Application factory
# ---------------------------------------------------------------------------

app = FastAPI(
    title="Pinned AI Service",
    version="1.0.0",
    description="Pattern recognition, regime detection, and signal generation for crypto orderflow.",
    lifespan=lifespan,
)

# --- Middleware ---
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://localhost:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

Instrumentator().instrument(app).expose(app)

# --- Routers ---
app.include_router(health.router, tags=["health"])
app.include_router(signals.router, prefix="/signals", tags=["signals"])
app.include_router(predictions.router, tags=["predictions"])
