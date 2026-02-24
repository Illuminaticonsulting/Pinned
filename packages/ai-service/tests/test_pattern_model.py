"""Unit tests for the PatternClassifier (rule-based fallback & confidence)."""

import pytest
import numpy as np
import pandas as pd

from app.models.pattern_model import PatternClassifier, PATTERN_LABELS


# ─── Fixtures ────────────────────────────────────────────────────────────────


def _make_features(**overrides) -> dict:
    """Base feature dict with neutral defaults."""
    base = {
        "delta_5": 0.0,
        "volume_ratio": 1.0,
        "higher_highs_5": 0,
        "lower_lows_5": 0,
        "imbalance_count_5": 0,
        "delta_slope_20": 0.0,
        "price_rsi_14": 50.0,
        "delta_pct_5": 0.0,
        "absorption_events_10": 0,
    }
    base.update(overrides)
    return base


# ─── Tests ───────────────────────────────────────────────────────────────────


class TestRuleBasedPredictions:
    """Test the rule-based fallback classification logic."""

    def test_no_pattern_for_neutral_features(self):
        classifier = PatternClassifier()
        pattern, confidence = classifier.predict(_make_features())
        assert pattern == "no_pattern"
        assert confidence > 0.5

    def test_absorption_support_detected(self):
        classifier = PatternClassifier()
        features = _make_features(
            delta_5=500.0,
            lower_lows_5=3,
            volume_ratio=1.5,
        )
        pattern, confidence = classifier.predict(features)
        assert pattern == "absorption_support"
        assert 0 < confidence <= 1.0

    def test_absorption_resistance_detected(self):
        classifier = PatternClassifier()
        features = _make_features(
            delta_5=-500.0,
            higher_highs_5=3,
            volume_ratio=1.5,
        )
        pattern, confidence = classifier.predict(features)
        assert pattern == "absorption_resistance"
        assert 0 < confidence <= 1.0

    def test_exhaustion_detected(self):
        classifier = PatternClassifier()
        features = _make_features(
            delta_slope_20=0.01,
            volume_ratio=1.8,
            price_rsi_14=80.0,
        )
        pattern, confidence = classifier.predict(features)
        assert pattern == "exhaustion"
        assert 0 < confidence <= 1.0


class TestConfidence:
    """Verify confidence is clamped correctly."""

    def test_confidence_never_exceeds_1(self):
        classifier = PatternClassifier()
        # Extreme features that push score high
        features = _make_features(
            delta_5=10_000.0,
            lower_lows_5=5,
            volume_ratio=5.0,
            delta_slope_20=1.0,
            imbalance_count_5=10,
            delta_pct_5=0.9,
            absorption_events_10=10,
        )
        pattern, confidence = classifier.predict(features)
        assert confidence <= 1.0

    def test_confidence_is_positive(self):
        classifier = PatternClassifier()
        features = _make_features()
        _, confidence = classifier.predict(features)
        assert confidence > 0


class TestPatternLabels:
    """Verify PATTERN_LABELS list and predict output."""

    def test_predict_returns_valid_label(self):
        classifier = PatternClassifier()
        for features in [
            _make_features(),
            _make_features(delta_5=500, lower_lows_5=3, volume_ratio=1.5),
            _make_features(delta_slope_20=0.01, volume_ratio=1.8, price_rsi_14=20),
        ]:
            pattern, _ = classifier.predict(features)
            assert pattern in PATTERN_LABELS, f"'{pattern}' not in PATTERN_LABELS"

    def test_accepts_dataframe_input(self):
        classifier = PatternClassifier()
        df = pd.DataFrame([_make_features()])
        pattern, confidence = classifier.predict(df)
        assert pattern in PATTERN_LABELS
        assert isinstance(confidence, float)
