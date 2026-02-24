"""Signal generation orchestrator.

Combines pattern recognition, regime classification, and feature engineering
to produce actionable trading signals.
"""

from __future__ import annotations

import json
import logging
import time
import uuid
from typing import Any

import psycopg2.pool
import redis.asyncio as aioredis

from app.config import settings
from app.features.data_loader import (
    get_latest_orderbook,
    get_recent_candles,
    get_recent_deltas,
    get_recent_patterns,
)
from app.features.engineering import compute_features
from app.models.pattern_model import PatternClassifier
from app.models.regime_model import RegimeClassifier

logger = logging.getLogger("pinned.ai.signals")

# Direction constants
LONG = "long"
SHORT = "short"
FLAT = "flat"


class SignalGenerator:
    """Orchestrates feature computation, pattern recognition, and regime
    detection to produce trading signals."""

    def __init__(
        self,
        pattern_model: PatternClassifier,
        regime_model: RegimeClassifier,
        redis_client: aioredis.Redis | None,
        db_pool: psycopg2.pool.ThreadedConnectionPool | None,
        min_confidence: float = 0.6,
    ) -> None:
        self._pattern = pattern_model
        self._regime = regime_model
        self._redis = redis_client
        self._db_pool = db_pool
        self._min_confidence = min_confidence

        # Cache the latest regime per symbol
        self._regime_cache: dict[str, dict[str, Any]] = {}

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def generate_signal(self, symbol: str) -> dict[str, Any] | None:
        """Run the full signal generation pipeline for *symbol*.

        Returns a signal dict matching the shared Signal type, or ``None``
        if confidence is below the threshold.
        """

        # a. Load recent data
        candles = get_recent_candles(
            self._db_pool, symbol, timeframe="1m", limit=settings.FEATURE_WINDOW_SIZE
        )
        deltas = get_recent_deltas(self._redis, symbol, limit=settings.DELTA_WINDOW_SIZE)
        orderbook = get_latest_orderbook(self._redis, "binance", symbol)
        patterns = get_recent_patterns(self._redis, self._db_pool, symbol, minutes=10)

        if not candles:
            logger.debug("No candle data for %s – skipping signal generation", symbol)
            return None

        # b. Compute features
        features = compute_features(candles, deltas, orderbook, patterns)
        if not features:
            return None

        features["symbol"] = symbol

        # c. Pattern recognition
        pattern_type, pattern_conf = self._pattern.predict(features)

        # d. Regime classification
        regime_info = self._regime.classify(features)
        regime = regime_info["regime"]
        regime_conf = regime_info["confidence"]

        # Update cache
        self._regime_cache[symbol] = regime_info

        # e. Determine signal direction
        direction = self._determine_direction(pattern_type, regime, features)

        # f. Combined confidence
        combined_confidence = self._combined_confidence(
            pattern_conf, regime_conf, pattern_type, regime, direction, features
        )

        # g. Threshold check
        if combined_confidence < self._min_confidence:
            logger.debug(
                "Signal for %s below threshold: %s %.2f (pattern=%s, regime=%s)",
                symbol,
                direction,
                combined_confidence,
                pattern_type,
                regime,
            )
            return None

        # h. Reasoning
        reasoning = self._build_reasoning(
            symbol, direction, pattern_type, pattern_conf, regime, regime_conf, features
        )

        # Build signal dict
        now_ms = int(time.time() * 1000)
        signal: dict[str, Any] = {
            "id": str(uuid.uuid4()),
            "symbol": symbol,
            "direction": direction,
            "confidence": round(combined_confidence, 4),
            "pattern": pattern_type,
            "pattern_confidence": round(pattern_conf, 4),
            "regime": regime,
            "regime_confidence": round(regime_conf, 4),
            "reasoning": reasoning,
            "features_snapshot": {
                "delta_5": features.get("delta_5"),
                "volume_ratio": features.get("volume_ratio"),
                "price_rsi_14": features.get("price_rsi_14"),
                "distance_to_poc": features.get("distance_to_poc"),
            },
            "timestamp": now_ms,
            "created_at": now_ms,
        }

        # i. Persist
        self._store_signal(signal)

        # j. Return
        return signal

    def update_regime(self, symbol: str) -> dict[str, Any] | None:
        """Recompute and cache the market regime for *symbol*."""
        candles = get_recent_candles(self._db_pool, symbol, timeframe="1m", limit=200)
        if not candles:
            return None

        deltas = get_recent_deltas(self._redis, symbol, limit=500)
        orderbook = get_latest_orderbook(self._redis, "binance", symbol)
        patterns = get_recent_patterns(self._redis, self._db_pool, symbol, minutes=10)

        features = compute_features(candles, deltas, orderbook, patterns)
        features["symbol"] = symbol

        regime_info = self._regime.classify(features)
        self._regime_cache[symbol] = regime_info
        self._store_regime(symbol, regime_info)
        return regime_info

    def get_cached_regime(self, symbol: str) -> dict[str, Any] | None:
        """Return the last computed regime for *symbol* without recomputing."""
        return self._regime_cache.get(symbol)

    # ------------------------------------------------------------------
    # Direction logic
    # ------------------------------------------------------------------

    def _determine_direction(
        self, pattern: str, regime: str, features: dict[str, Any]
    ) -> str:
        """Map pattern + regime to a trade direction."""
        delta_5 = features.get("delta_5", 0.0)

        if pattern == "absorption_support" and regime in ("trending_up", "reversing_up"):
            return LONG
        if pattern == "absorption_resistance" and regime in ("trending_down", "reversing_down"):
            return SHORT

        if pattern == "breakout_imbalance":
            return LONG if delta_5 > 0 else SHORT

        if pattern == "exhaustion":
            # Counter-trend
            if regime in ("trending_up",):
                return SHORT
            if regime in ("trending_down",):
                return LONG
            return FLAT

        if pattern == "reversal_divergence":
            # Counter-trend
            if regime in ("reversing_up",):
                return LONG
            if regime in ("reversing_down",):
                return SHORT
            return LONG if delta_5 > 0 else SHORT

        if pattern == "continuation":
            return LONG if delta_5 > 0 else SHORT

        return FLAT

    # ------------------------------------------------------------------
    # Confidence
    # ------------------------------------------------------------------

    def _combined_confidence(
        self,
        pattern_conf: float,
        regime_conf: float,
        pattern: str,
        regime: str,
        direction: str,
        features: dict[str, Any],
    ) -> float:
        """Blend pattern, regime, and feature-alignment confidence."""
        if direction == FLAT:
            return 0.0

        # Base: weighted average
        combined = 0.45 * pattern_conf + 0.35 * regime_conf

        # Feature alignment bonus
        alignment = 0.0

        delta_5 = features.get("delta_5", 0.0)
        rsi = features.get("price_rsi_14", 50.0)
        volume_ratio = features.get("volume_ratio", 1.0)

        if direction == LONG:
            if delta_5 > 0:
                alignment += 0.3
            if rsi < 70:
                alignment += 0.2
            if volume_ratio > 1.2:
                alignment += 0.2
        elif direction == SHORT:
            if delta_5 < 0:
                alignment += 0.3
            if rsi > 30:
                alignment += 0.2
            if volume_ratio > 1.2:
                alignment += 0.2

        # Regime-pattern coherence bonus
        coherent_combos = {
            ("absorption_support", "trending_up"),
            ("absorption_support", "reversing_up"),
            ("absorption_resistance", "trending_down"),
            ("absorption_resistance", "reversing_down"),
            ("breakout_imbalance", "trending_up"),
            ("breakout_imbalance", "trending_down"),
            ("exhaustion", "reversing_up"),
            ("exhaustion", "reversing_down"),
        }
        if (pattern, regime) in coherent_combos:
            alignment += 0.3

        combined += 0.20 * min(alignment, 1.0)

        return min(combined, 1.0)

    # ------------------------------------------------------------------
    # Reasoning
    # ------------------------------------------------------------------

    def _build_reasoning(
        self,
        symbol: str,
        direction: str,
        pattern: str,
        pattern_conf: float,
        regime: str,
        regime_conf: float,
        features: dict[str, Any],
    ) -> str:
        """Generate a human-readable explanation of the signal."""
        parts: list[str] = []

        dir_label = {"long": "bullish", "short": "bearish", "flat": "neutral"}.get(direction, direction)
        parts.append(f"{symbol} shows a {dir_label} signal.")

        pattern_nice = pattern.replace("_", " ").title()
        parts.append(
            f"Pattern detected: {pattern_nice} (confidence {pattern_conf:.0%})."
        )

        regime_nice = regime.replace("_", " ").title()
        parts.append(f"Market regime: {regime_nice} (confidence {regime_conf:.0%}).")

        delta_5 = features.get("delta_5", 0.0)
        vol_ratio = features.get("volume_ratio", 1.0)
        rsi = features.get("price_rsi_14", 50.0)

        if abs(delta_5) > 0:
            delta_dir = "positive" if delta_5 > 0 else "negative"
            parts.append(f"Cumulative delta (5-bar): {delta_5:.1f} ({delta_dir}).")

        if vol_ratio > 1.3:
            parts.append(f"Volume elevated at {vol_ratio:.1f}x average.")

        if rsi > 70:
            parts.append(f"RSI(14) overbought at {rsi:.1f}.")
        elif rsi < 30:
            parts.append(f"RSI(14) oversold at {rsi:.1f}.")

        return " ".join(parts)

    # ------------------------------------------------------------------
    # Persistence helpers
    # ------------------------------------------------------------------

    def _store_signal(self, signal: dict[str, Any]) -> None:
        """Persist signal to Redis (cache) and TimescaleDB (history)."""
        symbol = signal["symbol"]
        payload = json.dumps(signal, default=str)

        # Redis
        if self._redis is not None:
            try:
                import redis as sync_redis

                pool = self._redis.connection_pool
                url = str(pool.connection_kwargs.get("host", "localhost"))
                port = int(pool.connection_kwargs.get("port", 6379))
                r = sync_redis.Redis(host=url, port=port, decode_responses=True)

                r.set(f"signal:latest:{symbol}", payload, ex=300)
                r.lpush(f"signals:{symbol}", payload)
                r.ltrim(f"signals:{symbol}", 0, 499)
            except Exception:
                logger.warning("Failed to cache signal in Redis", exc_info=True)

        # TimescaleDB
        if self._db_pool is not None:
            conn = None
            try:
                conn = self._db_pool.getconn()
                with conn.cursor() as cur:
                    cur.execute(
                        """
                        INSERT INTO signals (
                            id, symbol, direction, confidence, pattern,
                            pattern_confidence, regime, regime_confidence,
                            reasoning, features_snapshot, timestamp
                        ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, to_timestamp(%s / 1000.0))
                        ON CONFLICT (id) DO NOTHING
                        """,
                        (
                            signal["id"],
                            symbol,
                            signal["direction"],
                            signal["confidence"],
                            signal["pattern"],
                            signal["pattern_confidence"],
                            signal["regime"],
                            signal["regime_confidence"],
                            signal["reasoning"],
                            json.dumps(signal.get("features_snapshot", {})),
                            signal["timestamp"],
                        ),
                    )
                conn.commit()
            except Exception:
                logger.warning("Failed to persist signal to DB", exc_info=True)
                if conn is not None:
                    try:
                        conn.rollback()
                    except Exception:
                        pass
            finally:
                if conn is not None:
                    try:
                        self._db_pool.putconn(conn)
                    except Exception:
                        pass

    def _store_regime(self, symbol: str, regime_info: dict[str, Any]) -> None:
        """Cache regime info in Redis."""
        if self._redis is None:
            return

        try:
            import redis as sync_redis

            pool = self._redis.connection_pool
            url = str(pool.connection_kwargs.get("host", "localhost"))
            port = int(pool.connection_kwargs.get("port", 6379))
            r = sync_redis.Redis(host=url, port=port, decode_responses=True)

            payload = json.dumps(regime_info, default=str)
            r.set(f"regime:{symbol}", payload, ex=120)
        except Exception:
            logger.warning("Failed to cache regime in Redis", exc_info=True)
