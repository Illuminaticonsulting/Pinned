"""Feature engineering pipeline.

Transforms raw candle, delta, orderbook, and pattern data into a feature
vector suitable for ML models. All computation is numpy-based for speed.
"""

from __future__ import annotations

import logging
from typing import Any

import numpy as np
import pandas as pd

logger = logging.getLogger("pinned.ai.features")


def compute_features(
    candles: list[dict[str, Any]],
    deltas: list[dict[str, Any]],
    orderbook_summary: dict[str, Any] | None,
    patterns: list[dict[str, Any]] | None,
) -> dict[str, Any]:
    """Compute the full feature vector from raw market data.

    Args:
        candles: List of OHLCV candle dicts (oldest first).
        deltas: List of delta / footprint event dicts.
        orderbook_summary: Latest DOM / orderbook summary dict.
        patterns: Recent pattern events (absorption, spoof, iceberg, etc.).

    Returns:
        Dictionary of named features ready for model consumption.
    """
    features: dict[str, Any] = {}

    if not candles:
        logger.warning("No candle data provided – returning empty features")
        return features

    # --- Convert to arrays ------------------------------------------------
    closes = np.array([c.get("close", 0.0) for c in candles], dtype=np.float64)
    highs = np.array([c.get("high", 0.0) for c in candles], dtype=np.float64)
    lows = np.array([c.get("low", 0.0) for c in candles], dtype=np.float64)
    volumes = np.array([c.get("volume", 0.0) for c in candles], dtype=np.float64)
    candle_deltas = np.array([c.get("delta", 0.0) for c in candles], dtype=np.float64)
    buy_volumes = np.array([c.get("buy_volume", 0.0) for c in candles], dtype=np.float64)
    sell_volumes = np.array([c.get("sell_volume", 0.0) for c in candles], dtype=np.float64)
    imbalance_counts = np.array(
        [c.get("imbalance_count", 0) for c in candles], dtype=np.float64
    )
    max_imbalance_ratios = np.array(
        [c.get("max_imbalance_ratio", 0.0) for c in candles], dtype=np.float64
    )

    n = len(closes)

    # =====================================================================
    # Footprint features
    # =====================================================================
    window_5 = min(5, n)
    features["imbalance_count_5"] = float(np.sum(imbalance_counts[-window_5:]))
    features["max_imbalance_ratio_5"] = float(np.max(max_imbalance_ratios[-window_5:])) if window_5 > 0 else 0.0
    features["delta_5"] = float(np.sum(candle_deltas[-window_5:]))

    vol_5 = float(np.sum(volumes[-window_5:]))
    features["delta_pct_5"] = features["delta_5"] / vol_5 if vol_5 > 0 else 0.0

    total_buy_5 = float(np.sum(buy_volumes[-window_5:]))
    total_sell_5 = float(np.sum(sell_volumes[-window_5:]))
    features["buy_sell_ratio_5"] = total_buy_5 / total_sell_5 if total_sell_5 > 0 else 1.0

    window_20 = min(20, n)
    features["delta_slope_20"] = _linear_slope(candle_deltas[-window_20:]) if window_20 >= 2 else 0.0

    # =====================================================================
    # Price features
    # =====================================================================
    features["price_sma_20"] = float(np.mean(closes[-min(20, n) :])) if n > 0 else 0.0
    features["price_sma_50"] = float(np.mean(closes[-min(50, n) :])) if n > 0 else 0.0
    features["price_ema_12"] = _ema(closes, 12)
    features["price_rsi_14"] = _rsi(closes, 14)
    features["atr_14"] = _atr(highs, lows, closes, 14)
    features["higher_highs_5"] = _consecutive_higher(highs, 5)
    features["lower_lows_5"] = _consecutive_lower(lows, 5)

    # =====================================================================
    # Volume features
    # =====================================================================
    vol_sma_20 = float(np.mean(volumes[-min(20, n) :])) if n > 0 else 1.0
    features["volume_sma_20"] = vol_sma_20
    features["volume_ratio"] = float(volumes[-1]) / vol_sma_20 if vol_sma_20 > 0 and n > 0 else 1.0
    features["volume_trend"] = _linear_slope(volumes[-min(10, n) :]) if n >= 2 else 0.0

    # =====================================================================
    # DOM / orderbook features
    # =====================================================================
    if orderbook_summary:
        walls = orderbook_summary.get("walls", [])
        features["wall_count"] = len(walls)
        features["avg_wall_size"] = float(np.mean([w.get("size", 0) for w in walls])) if walls else 0.0
    else:
        features["wall_count"] = 0
        features["avg_wall_size"] = 0.0

    # Pattern event counts from last 10 minutes
    patterns = patterns or []
    features["absorption_events_10"] = _count_events(patterns, "absorption")
    features["spoof_events_10"] = _count_events(patterns, "spoof")
    features["iceberg_events_10"] = _count_events(patterns, "iceberg")

    # =====================================================================
    # Volume Profile features
    # =====================================================================
    vp_dist = _build_volume_profile(closes, volumes)
    if vp_dist is not None and len(vp_dist) > 3:
        poc_idx = int(np.argmax(vp_dist))
        price_min, price_max = float(np.min(closes)), float(np.max(closes))
        price_range = price_max - price_min if price_max > price_min else 1.0
        poc_price = price_min + (poc_idx / len(vp_dist)) * price_range
        current_price = float(closes[-1])
        features["distance_to_poc"] = ((current_price - poc_price) / poc_price * 100) if poc_price > 0 else 0.0

        # Value area (70% of volume)
        sorted_bins = np.argsort(vp_dist)[::-1]
        cumulative = 0.0
        total = float(np.sum(vp_dist))
        va_bins: set[int] = set()
        for b in sorted_bins:
            cumulative += vp_dist[b]
            va_bins.add(int(b))
            if total > 0 and cumulative / total >= 0.7:
                break

        current_bin = int((current_price - price_min) / price_range * (len(vp_dist) - 1)) if price_range > 0 else 0
        current_bin = max(0, min(current_bin, len(vp_dist) - 1))
        features["inside_va"] = current_bin in va_bins

        features["vp_kurtosis"] = float(_safe_kurtosis(vp_dist))
        features["vp_skew"] = float(_safe_skew(vp_dist))
    else:
        features["distance_to_poc"] = 0.0
        features["inside_va"] = True
        features["vp_kurtosis"] = 3.0
        features["vp_skew"] = 0.0

    # =====================================================================
    # Cross features
    # =====================================================================
    features["delta_x_volume_ratio"] = features["delta_5"] * features["volume_ratio"]
    delta_sign = 1.0 if features["delta_5"] >= 0 else -1.0
    features["rsi_x_delta"] = features["price_rsi_14"] * delta_sign

    # =====================================================================
    # NaN handling: forward fill then zero fill
    # =====================================================================
    for key, val in features.items():
        if isinstance(val, float) and (np.isnan(val) or np.isinf(val)):
            features[key] = 0.0

    return features


# =========================================================================
# Helper functions
# =========================================================================

def _linear_slope(arr: np.ndarray) -> float:
    """Compute the OLS slope of an array indexed 0..N-1."""
    n = len(arr)
    if n < 2:
        return 0.0
    x = np.arange(n, dtype=np.float64)
    x_mean = x.mean()
    y_mean = arr.mean()
    denom = float(np.sum((x - x_mean) ** 2))
    if denom == 0:
        return 0.0
    return float(np.sum((x - x_mean) * (arr - y_mean)) / denom)


def _ema(arr: np.ndarray, period: int) -> float:
    """Return the latest EMA value for *period*."""
    if len(arr) == 0:
        return 0.0
    alpha = 2.0 / (period + 1)
    ema = float(arr[0])
    for val in arr[1:]:
        ema = alpha * float(val) + (1 - alpha) * ema
    return ema


def _rsi(closes: np.ndarray, period: int = 14) -> float:
    """Compute RSI using exponential moving average of gains/losses."""
    if len(closes) < period + 1:
        return 50.0

    changes = np.diff(closes)
    gains = np.where(changes > 0, changes, 0.0)
    losses = np.where(changes < 0, -changes, 0.0)

    avg_gain = float(np.mean(gains[:period]))
    avg_loss = float(np.mean(losses[:period]))

    for i in range(period, len(gains)):
        avg_gain = (avg_gain * (period - 1) + gains[i]) / period
        avg_loss = (avg_loss * (period - 1) + losses[i]) / period

    if avg_loss == 0:
        return 100.0
    rs = avg_gain / avg_loss
    return 100.0 - 100.0 / (1.0 + rs)


def _atr(highs: np.ndarray, lows: np.ndarray, closes: np.ndarray, period: int = 14) -> float:
    """Average True Range."""
    n = len(closes)
    if n < 2:
        return 0.0
    tr = np.maximum(highs[1:] - lows[1:], np.abs(highs[1:] - closes[:-1]))
    tr = np.maximum(tr, np.abs(lows[1:] - closes[:-1]))
    if len(tr) < period:
        return float(np.mean(tr)) if len(tr) > 0 else 0.0
    return float(np.mean(tr[-period:]))


def _consecutive_higher(arr: np.ndarray, max_lookback: int) -> int:
    """Count consecutive higher values from the end of *arr*."""
    count = 0
    for i in range(len(arr) - 1, 0, -1):
        if arr[i] > arr[i - 1]:
            count += 1
        else:
            break
        if count >= max_lookback:
            break
    return count


def _consecutive_lower(arr: np.ndarray, max_lookback: int) -> int:
    """Count consecutive lower values from the end of *arr*."""
    count = 0
    for i in range(len(arr) - 1, 0, -1):
        if arr[i] < arr[i - 1]:
            count += 1
        else:
            break
        if count >= max_lookback:
            break
    return count


def _count_events(patterns: list[dict[str, Any]], event_type: str) -> int:
    """Count pattern events whose type contains *event_type*."""
    return sum(1 for p in patterns if event_type in p.get("type", "").lower())


def _build_volume_profile(closes: np.ndarray, volumes: np.ndarray, bins: int = 50) -> np.ndarray | None:
    """Build a simple volume-at-price histogram."""
    if len(closes) < 3:
        return None
    price_min, price_max = float(np.min(closes)), float(np.max(closes))
    if price_max <= price_min:
        return None
    bin_edges = np.linspace(price_min, price_max, bins + 1)
    indices = np.digitize(closes, bin_edges) - 1
    indices = np.clip(indices, 0, bins - 1)
    profile = np.zeros(bins, dtype=np.float64)
    for idx, vol in zip(indices, volumes):
        profile[idx] += vol
    return profile


def _safe_kurtosis(arr: np.ndarray) -> float:
    """Fisher kurtosis, returning 3.0 (normal) on failure."""
    if len(arr) < 4:
        return 3.0
    std = float(np.std(arr))
    if std == 0:
        return 3.0
    mean = float(np.mean(arr))
    n = len(arr)
    m4 = float(np.mean((arr - mean) ** 4))
    return m4 / (std ** 4) - 3.0


def _safe_skew(arr: np.ndarray) -> float:
    """Skewness, returning 0.0 on failure."""
    if len(arr) < 3:
        return 0.0
    std = float(np.std(arr))
    if std == 0:
        return 0.0
    mean = float(np.mean(arr))
    m3 = float(np.mean((arr - mean) ** 3))
    return m3 / (std ** 3)
