"""Unit tests for the RegimeClassifier."""

import pytest
import numpy as np

from app.models.regime_model import RegimeClassifier, REGIME_TYPES


# ─── Fixtures ────────────────────────────────────────────────────────────────


def _make_features(**overrides) -> dict:
    """Base feature dict with neutral defaults."""
    base = {
        "delta_slope_20": 0.0,
        "higher_highs_5": 0,
        "lower_lows_5": 0,
        "vp_kurtosis": 3.0,
        "delta_5": 0.0,
        "price_sma_20": 30_000.0,
        "price_sma_50": 30_000.0,
        "inside_va": True,
        "volume_ratio": 1.0,
        "distance_to_poc": 0.0,
        "absorption_events_10": 0,
        "symbol": "BTC-USDT",
    }
    base.update(overrides)
    return base


# ─── Tests ───────────────────────────────────────────────────────────────────


class TestTrendingClassification:
    """Tests for trending up/down regime."""

    def test_trending_up_detected(self):
        classifier = RegimeClassifier()
        features = _make_features(
            delta_slope_20=0.08,
            higher_highs_5=3,
            vp_kurtosis=4.0,
            delta_5=500,
            price_sma_20=30_500,
            price_sma_50=30_000,
        )
        result = classifier.classify(features)
        assert result["regime"] == "trending_up"
        assert result["confidence"] > 0

    def test_trending_down_detected(self):
        classifier = RegimeClassifier()
        features = _make_features(
            delta_slope_20=-0.08,
            lower_lows_5=3,
            vp_kurtosis=4.0,
            delta_5=-500,
            price_sma_20=29_500,
            price_sma_50=30_000,
        )
        result = classifier.classify(features)
        assert result["regime"] == "trending_down"
        assert result["confidence"] > 0


class TestRangingClassification:
    """Tests for ranging (consolidation) regime."""

    def test_ranging_detected(self):
        classifier = RegimeClassifier()
        features = _make_features(
            delta_slope_20=0.01,   # flat
            vp_kurtosis=1.5,       # bimodal
            inside_va=True,
            volume_ratio=1.0,
        )
        result = classifier.classify(features)
        assert result["regime"] == "ranging"
        assert result["confidence"] > 0


class TestReversingClassification:
    """Tests for reversing up/down regime."""

    def test_reversing_up_detected(self):
        classifier = RegimeClassifier()
        features = _make_features(
            lower_lows_5=3,              # price making lower lows
            delta_slope_20=0.05,         # but delta turning positive (divergence)
            distance_to_poc=-2.0,        # price at VP low
            absorption_events_10=3,
            delta_5=200,
        )
        result = classifier.classify(features)
        assert result["regime"] == "reversing_up"
        assert result["confidence"] > 0

    def test_reversing_down_detected(self):
        classifier = RegimeClassifier()
        features = _make_features(
            higher_highs_5=3,            # price making higher highs
            delta_slope_20=-0.05,        # but delta turning negative (divergence)
            distance_to_poc=2.0,         # price at VP high
            absorption_events_10=3,
            delta_5=-200,
        )
        result = classifier.classify(features)
        assert result["regime"] == "reversing_down"
        assert result["confidence"] > 0


class TestEdgeCases:
    """Edge cases and invariants."""

    def test_all_zeros_does_not_crash(self):
        classifier = RegimeClassifier()
        features = _make_features(
            delta_slope_20=0,
            higher_highs_5=0,
            lower_lows_5=0,
            vp_kurtosis=0,
            delta_5=0,
            price_sma_20=0,
            price_sma_50=0,
            volume_ratio=0,
            distance_to_poc=0,
            absorption_events_10=0,
        )
        result = classifier.classify(features)
        assert result["regime"] in REGIME_TYPES
        assert 0 <= result["confidence"] <= 1

    def test_extreme_values_clamp_confidence(self):
        classifier = RegimeClassifier()
        features = _make_features(
            delta_slope_20=100.0,
            higher_highs_5=100,
            vp_kurtosis=100.0,
            delta_5=1_000_000,
            price_sma_20=100_000,
            price_sma_50=50_000,
        )
        result = classifier.classify(features)
        assert result["confidence"] <= 1.0, "Confidence should be clamped to 1.0"

    def test_result_contains_expected_keys(self):
        classifier = RegimeClassifier()
        result = classifier.classify(_make_features())
        assert "regime" in result
        assert "confidence" in result
        assert "since" in result
        assert "indicators" in result

    def test_regime_duration_tracking(self):
        classifier = RegimeClassifier()
        r1 = classifier.classify(_make_features(
            delta_slope_20=0.08,
            higher_highs_5=3,
            vp_kurtosis=4.0,
            delta_5=500,
            price_sma_20=30_500,
            price_sma_50=30_000,
        ))

        # Classify again with the same regime — since should be the same
        r2 = classifier.classify(_make_features(
            delta_slope_20=0.08,
            higher_highs_5=3,
            vp_kurtosis=4.0,
            delta_5=500,
            price_sma_20=30_500,
            price_sma_50=30_000,
        ))
        assert r1["since"] == r2["since"]

    def test_output_regime_in_valid_types(self):
        classifier = RegimeClassifier()
        result = classifier.classify(_make_features())
        assert result["regime"] in REGIME_TYPES
