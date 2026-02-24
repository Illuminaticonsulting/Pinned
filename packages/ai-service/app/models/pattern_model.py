"""Pattern recognition model using XGBoost with rule-based fallback.

Classifies footprint/orderflow patterns for trading signal generation.
"""

from __future__ import annotations

import logging
import os
import pickle
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
from xgboost import XGBClassifier

logger = logging.getLogger("pinned.ai.pattern")

PATTERN_LABELS: list[str] = [
    "absorption_support",
    "absorption_resistance",
    "exhaustion",
    "breakout_imbalance",
    "reversal_divergence",
    "continuation",
    "no_pattern",
]

_LABEL_TO_IDX: dict[str, int] = {lbl: idx for idx, lbl in enumerate(PATTERN_LABELS)}

# ---------------------------------------------------------------------------
# Thresholds for rule-based classification
# ---------------------------------------------------------------------------

_VOLUME_HIGH_QUANTILE = 0.75
_DELTA_STRONG = 0.4  # |delta / volume| considered strong
_IMBALANCE_STREAK = 3
_DIVERGENCE_WINDOW = 10


class PatternClassifier:
    """XGBoost-backed pattern classifier with rule-based fallback."""

    def __init__(self) -> None:
        self._model: XGBClassifier | None = None
        self._trained: bool = False

    # ------------------------------------------------------------------
    # Training
    # ------------------------------------------------------------------

    def train(self, features_df: pd.DataFrame, labels: pd.Series | np.ndarray) -> None:
        """Fit the XGBoost classifier on labelled feature data.

        Args:
            features_df: Feature matrix (rows = samples).
            labels: Corresponding pattern label strings.
        """
        encoded = np.array([_LABEL_TO_IDX[lbl] for lbl in labels])

        self._model = XGBClassifier(
            n_estimators=200,
            max_depth=6,
            learning_rate=0.1,
            subsample=0.8,
            objective="multi:softprob",
            num_class=len(PATTERN_LABELS),
            eval_metric="mlogloss",
            use_label_encoder=False,
            verbosity=0,
        )
        self._model.fit(features_df, encoded)
        self._trained = True
        logger.info("PatternClassifier trained on %d samples", len(labels))

    # ------------------------------------------------------------------
    # Prediction
    # ------------------------------------------------------------------

    def predict(self, features: dict[str, Any] | pd.DataFrame) -> tuple[str, float]:
        """Return (pattern_type, confidence) for the given feature vector.

        Falls back to rule-based heuristics when no trained model is loaded.
        """
        if self._trained and self._model is not None:
            return self._predict_ml(features)
        return self._predict_rules(features)

    def _predict_ml(self, features: dict[str, Any] | pd.DataFrame) -> tuple[str, float]:
        """Predict using the trained XGBoost model."""
        if isinstance(features, dict):
            df = pd.DataFrame([features])
        else:
            df = features.iloc[[-1]] if len(features) > 1 else features

        probas = self._model.predict_proba(df)[0]  # type: ignore[union-attr]
        idx = int(np.argmax(probas))
        return PATTERN_LABELS[idx], float(probas[idx])

    def _predict_rules(self, features: dict[str, Any] | pd.DataFrame) -> tuple[str, float]:
        """Rule-based fallback when no trained model is available."""
        if isinstance(features, pd.DataFrame):
            feat = features.iloc[-1].to_dict()
        else:
            feat = dict(features)

        candidates: list[tuple[str, float]] = []

        delta_5 = feat.get("delta_5", 0.0)
        volume_ratio = feat.get("volume_ratio", 1.0)
        higher_highs = feat.get("higher_highs_5", 0)
        lower_lows = feat.get("lower_lows_5", 0)
        imbalance_count = feat.get("imbalance_count_5", 0)
        delta_slope = feat.get("delta_slope_20", 0.0)
        rsi = feat.get("price_rsi_14", 50.0)
        delta_pct = feat.get("delta_pct_5", 0.0)
        absorption_events = feat.get("absorption_events_10", 0)

        high_volume = volume_ratio > 1.3

        # --- absorption_support ---
        if delta_5 > 0 and lower_lows >= 2 and high_volume:
            strength = min(1.0, (delta_5 / max(abs(delta_5), 1e-9)) * 0.4 + (volume_ratio - 1) * 0.3 + 0.3)
            candidates.append(("absorption_support", strength))

        # --- absorption_resistance ---
        if delta_5 < 0 and higher_highs >= 2 and high_volume:
            strength = min(1.0, (abs(delta_5) / max(abs(delta_5), 1e-9)) * 0.4 + (volume_ratio - 1) * 0.3 + 0.3)
            candidates.append(("absorption_resistance", strength))

        # --- exhaustion ---
        if abs(delta_slope) < 0.05 and high_volume and (rsi > 75 or rsi < 25):
            ext_strength = 0.5 + 0.25 * (volume_ratio - 1) + 0.25 * abs(rsi - 50) / 50
            candidates.append(("exhaustion", min(1.0, ext_strength)))

        # --- breakout_imbalance ---
        if imbalance_count >= _IMBALANCE_STREAK and volume_ratio > 1.2:
            bi_strength = min(1.0, 0.4 + 0.2 * (imbalance_count - _IMBALANCE_STREAK) + 0.2 * (volume_ratio - 1))
            candidates.append(("breakout_imbalance", bi_strength))

        # --- reversal_divergence ---
        price_extreme = higher_highs >= 3 or lower_lows >= 3
        delta_diverging = (higher_highs >= 3 and delta_slope < -0.05) or (lower_lows >= 3 and delta_slope > 0.05)
        if price_extreme and delta_diverging:
            rd_strength = min(1.0, 0.5 + 0.25 * abs(delta_slope) + 0.25 * (absorption_events / 5))
            candidates.append(("reversal_divergence", rd_strength))

        # --- continuation ---
        if abs(delta_pct) > _DELTA_STRONG and volume_ratio > 1.0 and abs(delta_slope) > 0.05:
            ct_strength = min(1.0, 0.3 + 0.35 * abs(delta_pct) + 0.35 * abs(delta_slope))
            candidates.append(("continuation", ct_strength))

        if not candidates:
            return "no_pattern", 0.9

        # Highest-confidence candidate wins
        candidates.sort(key=lambda c: c[1], reverse=True)
        return candidates[0]

    # ------------------------------------------------------------------
    # Persistence
    # ------------------------------------------------------------------

    def save(self, path: str) -> None:
        """Persist the trained model to disk.

        Args:
            path: Directory in which to store the model file.
        """
        if self._model is None:
            logger.warning("No trained model to save")
            return

        os.makedirs(path, exist_ok=True)
        filepath = Path(path) / "pattern_classifier.pkl"
        with open(filepath, "wb") as fh:
            pickle.dump(self._model, fh)
        logger.info("Pattern model saved to %s", filepath)

    def load(self, path: str) -> None:
        """Load a previously-trained model from disk.

        Args:
            path: Directory containing pattern_classifier.pkl.
        """
        filepath = Path(path) / "pattern_classifier.pkl"
        if not filepath.exists():
            logger.info("No saved pattern model found at %s – using rule-based fallback", filepath)
            return

        with open(filepath, "rb") as fh:
            self._model = pickle.load(fh)  # noqa: S301
        self._trained = True
        logger.info("Pattern model loaded from %s", filepath)

    # ------------------------------------------------------------------
    # Synthetic label generation
    # ------------------------------------------------------------------

    @classmethod
    def generate_synthetic_labels(cls, features_df: pd.DataFrame) -> pd.Series:
        """Bootstrap training labels from rule-based heuristics.

        Useful for generating an initial training set before real labelled
        data is available.

        Args:
            features_df: Feature matrix (one row per sample).

        Returns:
            Pandas Series of label strings aligned with the input index.
        """
        classifier = cls()
        labels: list[str] = []
        for _, row in features_df.iterrows():
            pattern, _conf = classifier._predict_rules(row.to_dict())
            labels.append(pattern)
        return pd.Series(labels, index=features_df.index, name="pattern_label")
