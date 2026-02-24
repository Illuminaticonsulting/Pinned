"""Unit tests for the feature engineering pipeline."""

import pytest
import numpy as np

from app.features.engineering import (
    compute_features,
    _rsi,
    _linear_slope,
    _ema,
    _consecutive_higher,
    _consecutive_lower,
)


# ─── Fixtures ────────────────────────────────────────────────────────────────


def _make_candles(n: int = 30, base_price: float = 30_000.0) -> list[dict]:
    """Generate synthetic candle data with a slight uptrend."""
    candles = []
    for i in range(n):
        price = base_price + i * 10
        candles.append({
            "time": 1_700_000_000_000 + i * 60_000,
            "open": price,
            "high": price + 50,
            "low": price - 30,
            "close": price + 20,
            "volume": 100 + i * 2,
            "buy_volume": 60 + i,
            "sell_volume": 40 + i,
            "delta": 20,
            "imbalance_count": 1 if i % 3 == 0 else 0,
            "max_imbalance_ratio": 2.5 if i % 3 == 0 else 0.0,
        })
    return candles


# ─── Tests ───────────────────────────────────────────────────────────────────


class TestComputeFeatures:
    """Tests for the main compute_features function."""

    def test_returns_dict_with_expected_keys(self):
        candles = _make_candles(30)
        features = compute_features(candles, [], None, None)

        assert isinstance(features, dict)
        assert "price_rsi_14" in features
        assert "delta_5" in features
        assert "volume_ratio" in features
        assert "price_sma_20" in features
        assert "imbalance_count_5" in features

    def test_feature_values_are_numeric(self):
        candles = _make_candles(30)
        features = compute_features(candles, [], None, None)

        for key, val in features.items():
            if key == "inside_va":  # boolean
                continue
            assert isinstance(val, (int, float)), f"{key} is {type(val)}"

    def test_no_nan_in_output(self):
        candles = _make_candles(30)
        features = compute_features(candles, [], None, None)

        for key, val in features.items():
            if isinstance(val, float):
                assert not np.isnan(val), f"{key} is NaN"
                assert not np.isinf(val), f"{key} is Inf"

    def test_empty_candles_returns_empty_dict(self):
        features = compute_features([], [], None, None)
        assert features == {}

    def test_single_candle_does_not_crash(self):
        candles = _make_candles(1)
        features = compute_features(candles, [], None, None)
        assert isinstance(features, dict)
        assert len(features) > 0


class TestRSI:
    """Tests for the internal RSI calculation."""

    def test_rsi_returns_50_for_insufficient_data(self):
        closes = np.array([100.0, 101.0, 102.0])
        assert _rsi(closes, 14) == 50.0

    def test_rsi_returns_100_for_pure_uptrend(self):
        closes = np.array([float(i) for i in range(1, 25)])
        rsi = _rsi(closes, 14)
        assert rsi == 100.0

    def test_rsi_bounded_between_0_and_100(self):
        np.random.seed(42)
        closes = np.cumsum(np.random.randn(100)) + 100
        rsi = _rsi(closes, 14)
        assert 0 <= rsi <= 100


class TestDeltaSlope:
    """Tests for delta slope (linear regression)."""

    def test_positive_slope_for_increasing_values(self):
        arr = np.array([1.0, 2.0, 3.0, 4.0, 5.0])
        slope = _linear_slope(arr)
        assert slope > 0

    def test_negative_slope_for_decreasing_values(self):
        arr = np.array([5.0, 4.0, 3.0, 2.0, 1.0])
        slope = _linear_slope(arr)
        assert slope < 0

    def test_zero_slope_for_constant_values(self):
        arr = np.array([3.0, 3.0, 3.0, 3.0])
        slope = _linear_slope(arr)
        assert abs(slope) < 1e-10

    def test_returns_zero_for_single_element(self):
        arr = np.array([5.0])
        slope = _linear_slope(arr)
        assert slope == 0.0


class TestHelpers:
    """Tests for EMA and consecutive higher/lower helpers."""

    def test_ema_returns_zero_for_empty_array(self):
        assert _ema(np.array([]), 12) == 0.0

    def test_consecutive_higher_counts_correctly(self):
        arr = np.array([1.0, 2.0, 3.0, 4.0, 5.0])
        assert _consecutive_higher(arr, 5) == 4

    def test_consecutive_lower_counts_correctly(self):
        arr = np.array([5.0, 4.0, 3.0, 2.0, 1.0])
        assert _consecutive_lower(arr, 5) == 4
