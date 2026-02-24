"""Rule-based market regime classifier.

Provides interpretable regime detection for crypto markets based on
delta, volume profile, and price structure analysis.
"""

from __future__ import annotations

import logging
import time
from typing import Any

import numpy as np

logger = logging.getLogger("pinned.ai.regime")

REGIME_TYPES: list[str] = [
    "trending_up",
    "trending_down",
    "ranging",
    "reversing_up",
    "reversing_down",
]

_DELTA_SLOPE_THRESHOLD = 0.03
_KURTOSIS_BIMODAL_THRESHOLD = 2.0


class RegimeClassifier:
    """Classify the current market regime using rule-based analysis.

    Each regime is scored with a confidence value (0-1).  The regime with
    the highest confidence is returned.
    """

    def __init__(self) -> None:
        self._last_regime: dict[str, Any] = {}
        self._regime_since: dict[str, int] = {}

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def classify(self, features: dict[str, Any]) -> dict[str, Any]:
        """Determine the current market regime and confidence.

        Args:
            features: Feature dictionary (output of feature engineering).

        Returns:
            Dict with keys: regime, confidence, since (epoch ms),
            and indicators (supporting evidence).
        """
        scores: dict[str, tuple[float, dict[str, Any]]] = {}

        scores["trending_up"] = self._score_trending_up(features)
        scores["trending_down"] = self._score_trending_down(features)
        scores["ranging"] = self._score_ranging(features)
        scores["reversing_up"] = self._score_reversing_up(features)
        scores["reversing_down"] = self._score_reversing_down(features)

        best_regime = max(scores, key=lambda k: scores[k][0])
        best_confidence, indicators = scores[best_regime]

        # Clamp confidence
        best_confidence = float(np.clip(best_confidence, 0.0, 1.0))

        symbol = str(features.get("symbol", "unknown"))

        # Track regime duration
        if self._last_regime.get(symbol) != best_regime:
            self._regime_since[symbol] = int(time.time() * 1000)
            self._last_regime[symbol] = best_regime

        since = self._regime_since.get(symbol, int(time.time() * 1000))

        return {
            "regime": best_regime,
            "confidence": best_confidence,
            "since": since,
            "indicators": indicators,
        }

    # ------------------------------------------------------------------
    # Regime scoring functions
    # ------------------------------------------------------------------

    def _score_trending_up(self, f: dict[str, Any]) -> tuple[float, dict[str, Any]]:
        delta_slope = f.get("delta_slope_20", 0.0)
        higher_highs = f.get("higher_highs_5", 0)
        vp_kurtosis = f.get("vp_kurtosis", 3.0)
        delta_cum = f.get("delta_5", 0.0)
        price_sma_20 = f.get("price_sma_20", 0.0)
        price_sma_50 = f.get("price_sma_50", 0.0)

        score = 0.0
        indicators: dict[str, Any] = {}

        # Delta slope positive
        if delta_slope > _DELTA_SLOPE_THRESHOLD:
            score += min(0.25, delta_slope * 2)
            indicators["delta_slope_positive"] = True

        # Higher highs
        if higher_highs >= 2:
            score += min(0.25, higher_highs * 0.08)
            indicators["higher_highs"] = higher_highs

        # Unimodal VP (kurtosis >= threshold)
        if vp_kurtosis >= _KURTOSIS_BIMODAL_THRESHOLD:
            score += 0.2
            indicators["vp_unimodal"] = True

        # Cumulative delta positive
        if delta_cum > 0:
            score += 0.15
            indicators["delta_cumulative_positive"] = True

        # SMA alignment
        if price_sma_20 > price_sma_50 > 0:
            score += 0.15
            indicators["sma_aligned_up"] = True

        return score, indicators

    def _score_trending_down(self, f: dict[str, Any]) -> tuple[float, dict[str, Any]]:
        delta_slope = f.get("delta_slope_20", 0.0)
        lower_lows = f.get("lower_lows_5", 0)
        vp_kurtosis = f.get("vp_kurtosis", 3.0)
        delta_cum = f.get("delta_5", 0.0)
        price_sma_20 = f.get("price_sma_20", 0.0)
        price_sma_50 = f.get("price_sma_50", 0.0)

        score = 0.0
        indicators: dict[str, Any] = {}

        if delta_slope < -_DELTA_SLOPE_THRESHOLD:
            score += min(0.25, abs(delta_slope) * 2)
            indicators["delta_slope_negative"] = True

        if lower_lows >= 2:
            score += min(0.25, lower_lows * 0.08)
            indicators["lower_lows"] = lower_lows

        if vp_kurtosis >= _KURTOSIS_BIMODAL_THRESHOLD:
            score += 0.2
            indicators["vp_unimodal"] = True

        if delta_cum < 0:
            score += 0.15
            indicators["delta_cumulative_negative"] = True

        if 0 < price_sma_20 < price_sma_50:
            score += 0.15
            indicators["sma_aligned_down"] = True

        return score, indicators

    def _score_ranging(self, f: dict[str, Any]) -> tuple[float, dict[str, Any]]:
        vp_kurtosis = f.get("vp_kurtosis", 3.0)
        inside_va = f.get("inside_va", False)
        delta_slope = f.get("delta_slope_20", 0.0)
        volume_ratio = f.get("volume_ratio", 1.0)

        score = 0.0
        indicators: dict[str, Any] = {}

        # Bimodal VP (low kurtosis)
        if vp_kurtosis < _KURTOSIS_BIMODAL_THRESHOLD:
            score += 0.3
            indicators["vp_bimodal"] = True

        # Price inside value area
        if inside_va:
            score += 0.25
            indicators["inside_value_area"] = True

        # Flat delta slope
        if abs(delta_slope) < _DELTA_SLOPE_THRESHOLD:
            score += 0.25
            indicators["flat_delta_slope"] = True

        # Normal volume
        if 0.7 <= volume_ratio <= 1.3:
            score += 0.2
            indicators["normal_volume"] = True

        return score, indicators

    def _score_reversing_up(self, f: dict[str, Any]) -> tuple[float, dict[str, Any]]:
        delta_slope = f.get("delta_slope_20", 0.0)
        lower_lows = f.get("lower_lows_5", 0)
        distance_to_poc = f.get("distance_to_poc", 0.0)
        absorption_events = f.get("absorption_events_10", 0)
        delta_cum = f.get("delta_5", 0.0)

        score = 0.0
        indicators: dict[str, Any] = {}

        # Bullish delta divergence: price making lower lows but delta turning positive
        if lower_lows >= 2 and delta_slope > 0:
            score += 0.3
            indicators["delta_divergence_bullish"] = True

        # Price at VP extreme low (large negative distance to POC)
        if distance_to_poc < -1.5:
            score += 0.25
            indicators["price_at_vp_low"] = True

        # Absorption events
        if absorption_events > 2:
            score += min(0.25, absorption_events * 0.08)
            indicators["absorption_count"] = absorption_events

        # Delta turning positive
        if delta_cum > 0:
            score += 0.2
            indicators["delta_positive"] = True

        return score, indicators

    def _score_reversing_down(self, f: dict[str, Any]) -> tuple[float, dict[str, Any]]:
        delta_slope = f.get("delta_slope_20", 0.0)
        higher_highs = f.get("higher_highs_5", 0)
        distance_to_poc = f.get("distance_to_poc", 0.0)
        absorption_events = f.get("absorption_events_10", 0)
        delta_cum = f.get("delta_5", 0.0)

        score = 0.0
        indicators: dict[str, Any] = {}

        # Bearish delta divergence: price making higher highs but delta turning negative
        if higher_highs >= 2 and delta_slope < 0:
            score += 0.3
            indicators["delta_divergence_bearish"] = True

        # Price at VP extreme high
        if distance_to_poc > 1.5:
            score += 0.25
            indicators["price_at_vp_high"] = True

        # Absorption events
        if absorption_events > 2:
            score += min(0.25, absorption_events * 0.08)
            indicators["absorption_count"] = absorption_events

        # Delta turning negative
        if delta_cum < 0:
            score += 0.2
            indicators["delta_negative"] = True

        return score, indicators
