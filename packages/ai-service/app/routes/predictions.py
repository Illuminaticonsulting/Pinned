"""Prediction and feature inspection endpoints."""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from app.config import settings
from app.features.data_loader import (
    get_latest_orderbook,
    get_recent_candles,
    get_recent_deltas,
    get_recent_patterns,
)
from app.features.engineering import compute_features

router = APIRouter()
logger = logging.getLogger("pinned.ai.routes.predictions")


class PredictRequest(BaseModel):
    """Request body for the /predict endpoint."""

    features: dict[str, Any]


class PredictResponse(BaseModel):
    """Response body for the /predict endpoint."""

    pattern: str
    confidence: float


@router.post("/predict", response_model=PredictResponse)
async def predict(body: PredictRequest) -> PredictResponse:
    """Run features through the pattern recognition model.

    Accepts an arbitrary feature dict and returns the predicted pattern
    type with its confidence score.

    Args:
        body: JSON body containing a ``features`` dict.

    Returns:
        Predicted pattern label and confidence.
    """
    from app.main import app_state

    if app_state.pattern_model is None:
        raise HTTPException(status_code=503, detail="Pattern model not loaded")

    try:
        pattern, confidence = await asyncio.to_thread(
            app_state.pattern_model.predict, body.features
        )
        return PredictResponse(pattern=pattern, confidence=round(confidence, 4))
    except Exception:
        logger.exception("Prediction failed")
        raise HTTPException(status_code=500, detail="Prediction error")


@router.get("/features")
async def get_features(
    symbol: str = Query(..., description="Trading pair, e.g. BTC-USDT"),
) -> dict[str, Any]:
    """Compute and return the current feature vector for a symbol.

    Useful for debugging and feature analysis. Fetches live data from
    Redis and TimescaleDB, runs the feature engineering pipeline, and
    returns the resulting dict.

    Args:
        symbol: Trading pair.

    Returns:
        Full feature dictionary.
    """
    from app.main import app_state

    try:
        candles = await asyncio.to_thread(
            get_recent_candles,
            app_state.db_pool,
            symbol,
            "1m",
            settings.FEATURE_WINDOW_SIZE,
        )
        deltas = await asyncio.to_thread(
            get_recent_deltas,
            app_state.redis,
            symbol,
            settings.DELTA_WINDOW_SIZE,
        )
        orderbook = await asyncio.to_thread(
            get_latest_orderbook,
            app_state.redis,
            "binance",
            symbol,
        )
        patterns = await asyncio.to_thread(
            get_recent_patterns,
            app_state.redis,
            app_state.db_pool,
            symbol,
            10,
        )

        features = await asyncio.to_thread(
            compute_features, candles, deltas, orderbook, patterns
        )
        features["symbol"] = symbol

        return features
    except Exception:
        logger.exception("Feature computation failed for %s", symbol)
        raise HTTPException(status_code=500, detail="Feature computation error")
