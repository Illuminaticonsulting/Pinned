"""Signal and regime query endpoints."""

from __future__ import annotations

import json
import logging
from typing import Any

from fastapi import APIRouter, HTTPException, Query

router = APIRouter()
logger = logging.getLogger("pinned.ai.routes.signals")


@router.get("")
async def list_signals(
    symbol: str = Query(..., description="Trading pair, e.g. BTC-USDT"),
    since: int | None = Query(None, description="Unix timestamp (ms) lower bound"),
    limit: int = Query(100, ge=1, le=1000, description="Max results"),
) -> list[dict[str, Any]]:
    """Query historical signals from TimescaleDB.

    Args:
        symbol: Trading pair filter.
        since: Optional start timestamp in epoch milliseconds.
        limit: Maximum rows to return.

    Returns:
        List of signal dicts, newest first.
    """
    from app.main import app_state

    if app_state.db_pool is None:
        raise HTTPException(status_code=503, detail="Database unavailable")

    conn = None
    try:
        conn = app_state.db_pool.getconn()
        with conn.cursor() as cur:
            if since is not None:
                cur.execute(
                    """
                    SELECT id, symbol, direction, confidence, pattern,
                           pattern_confidence, regime, regime_confidence,
                           reasoning, features_snapshot,
                           EXTRACT(EPOCH FROM timestamp) * 1000 AS timestamp
                    FROM signals
                    WHERE symbol = %s AND timestamp >= to_timestamp(%s / 1000.0)
                    ORDER BY timestamp DESC
                    LIMIT %s
                    """,
                    (symbol, since, limit),
                )
            else:
                cur.execute(
                    """
                    SELECT id, symbol, direction, confidence, pattern,
                           pattern_confidence, regime, regime_confidence,
                           reasoning, features_snapshot,
                           EXTRACT(EPOCH FROM timestamp) * 1000 AS timestamp
                    FROM signals
                    WHERE symbol = %s
                    ORDER BY timestamp DESC
                    LIMIT %s
                    """,
                    (symbol, limit),
                )
            columns = [desc[0] for desc in cur.description]
            rows = cur.fetchall()

        signals = []
        for row in rows:
            sig = dict(zip(columns, row))
            # Parse JSON fields
            if isinstance(sig.get("features_snapshot"), str):
                try:
                    sig["features_snapshot"] = json.loads(sig["features_snapshot"])
                except (json.JSONDecodeError, TypeError):
                    pass
            if sig.get("timestamp") is not None:
                sig["timestamp"] = int(sig["timestamp"])
            signals.append(sig)

        return signals
    except HTTPException:
        raise
    except Exception:
        logger.exception("Failed to query signals for %s", symbol)
        raise HTTPException(status_code=500, detail="Internal server error")
    finally:
        if conn is not None:
            try:
                app_state.db_pool.putconn(conn)
            except Exception:
                pass


@router.get("/latest")
async def latest_signal(
    symbol: str = Query(..., description="Trading pair, e.g. BTC-USDT"),
) -> dict[str, Any]:
    """Get the most recent signal from Redis cache.

    Falls back to the database if Redis is unavailable.

    Args:
        symbol: Trading pair.

    Returns:
        Latest signal dict, or 404 if none found.
    """
    from app.main import app_state

    # Try Redis cache first
    if app_state.redis is not None:
        try:
            raw = await app_state.redis.get(f"signal:latest:{symbol}")
            if raw is not None:
                return json.loads(raw)
        except Exception:
            logger.debug("Redis cache miss for latest signal %s", symbol)

    # Fallback: DB
    if app_state.db_pool is not None:
        conn = None
        try:
            conn = app_state.db_pool.getconn()
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT id, symbol, direction, confidence, pattern,
                           pattern_confidence, regime, regime_confidence,
                           reasoning, features_snapshot,
                           EXTRACT(EPOCH FROM timestamp) * 1000 AS timestamp
                    FROM signals
                    WHERE symbol = %s
                    ORDER BY timestamp DESC
                    LIMIT 1
                    """,
                    (symbol,),
                )
                columns = [desc[0] for desc in cur.description]
                row = cur.fetchone()

            if row is not None:
                sig = dict(zip(columns, row))
                if isinstance(sig.get("features_snapshot"), str):
                    try:
                        sig["features_snapshot"] = json.loads(sig["features_snapshot"])
                    except (json.JSONDecodeError, TypeError):
                        pass
                if sig.get("timestamp") is not None:
                    sig["timestamp"] = int(sig["timestamp"])
                return sig
        except Exception:
            logger.exception("DB fallback failed for latest signal %s", symbol)
        finally:
            if conn is not None:
                try:
                    app_state.db_pool.putconn(conn)
                except Exception:
                    pass

    raise HTTPException(status_code=404, detail=f"No signal found for {symbol}")


@router.get("/regime", tags=["regime"])
async def get_regime(
    symbol: str = Query(..., description="Trading pair, e.g. BTC-USDT"),
) -> dict[str, Any]:
    """Return the current regime classification for *symbol*.

    Regime is served from an in-memory cache populated by the background
    regime loop.  Falls back to Redis if available.

    Args:
        symbol: Trading pair.

    Returns:
        Regime dict with regime, confidence, since, and indicators.
    """
    from app.main import app_state

    # In-memory cache
    if app_state.signal_generator is not None:
        cached = app_state.signal_generator.get_cached_regime(symbol)
        if cached is not None:
            return cached

    # Redis fallback
    if app_state.redis is not None:
        try:
            raw = await app_state.redis.get(f"regime:{symbol}")
            if raw is not None:
                return json.loads(raw)
        except Exception:
            pass

    raise HTTPException(status_code=404, detail=f"No regime data for {symbol}")
