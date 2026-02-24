"""Data loading utilities for Redis and TimescaleDB.

Each function gracefully handles connection failures and returns empty
data so the caller can continue with degraded functionality.
"""

from __future__ import annotations

import json
import logging
from typing import Any

import psycopg2
import psycopg2.pool
import redis.asyncio as aioredis

logger = logging.getLogger("pinned.ai.data_loader")


# ---------------------------------------------------------------------------
# TimescaleDB loaders
# ---------------------------------------------------------------------------

def get_recent_candles(
    db_pool: psycopg2.pool.ThreadedConnectionPool | None,
    symbol: str,
    timeframe: str = "1m",
    limit: int = 500,
) -> list[dict[str, Any]]:
    """Fetch recent OHLCV candles from TimescaleDB.

    Args:
        db_pool: ThreadedConnectionPool instance (may be ``None``).
        symbol: Trading pair, e.g. ``"BTC-USDT"``.
        timeframe: Candle interval, e.g. ``"1m"``.
        limit: Maximum number of candles to retrieve.

    Returns:
        List of candle dicts ordered oldest-first, or empty list on failure.
    """
    if db_pool is None:
        return []

    query = """
        SELECT time, open, high, low, close, volume,
               buy_volume, sell_volume, delta,
               imbalance_count, max_imbalance_ratio
        FROM candles
        WHERE symbol = %s AND timeframe = %s
        ORDER BY time DESC
        LIMIT %s
    """
    conn = None
    try:
        conn = db_pool.getconn()
        with conn.cursor() as cur:
            cur.execute(query, (symbol, timeframe, limit))
            columns = [desc[0] for desc in cur.description]
            rows = cur.fetchall()

        candles = [dict(zip(columns, row)) for row in reversed(rows)]
        return candles
    except Exception:
        logger.exception("Failed to fetch candles for %s", symbol)
        return []
    finally:
        if conn is not None:
            try:
                db_pool.putconn(conn)
            except Exception:
                pass


# ---------------------------------------------------------------------------
# Redis loaders
# ---------------------------------------------------------------------------

def get_recent_deltas(
    redis_client: aioredis.Redis | None,
    symbol: str,
    limit: int = 1000,
) -> list[dict[str, Any]]:
    """Read recent delta events from a Redis Stream (synchronous wrapper).

    This uses a blocking call internally; intended for use inside
    ``asyncio.to_thread``.

    Args:
        redis_client: Async Redis client (used synchronously here via pool).
        symbol: Trading pair.
        limit: Maximum entries to return.

    Returns:
        List of delta event dicts, newest-last.
    """
    if redis_client is None:
        return []

    try:
        import redis as sync_redis

        pool = redis_client.connection_pool
        url = str(pool.connection_kwargs.get("host", "localhost"))
        port = int(pool.connection_kwargs.get("port", 6379))
        r = sync_redis.Redis(host=url, port=port, decode_responses=True)

        stream_key = f"deltas:{symbol}"
        raw = r.xrevrange(stream_key, count=limit)
        events: list[dict[str, Any]] = []
        for _msg_id, data in reversed(raw):
            try:
                events.append(json.loads(data.get("payload", "{}")))
            except (json.JSONDecodeError, TypeError):
                events.append(data)
        return events
    except Exception:
        logger.exception("Failed to fetch deltas for %s", symbol)
        return []


def get_latest_orderbook(
    redis_client: aioredis.Redis | None,
    exchange: str,
    symbol: str,
) -> dict[str, Any]:
    """Fetch the most recent orderbook snapshot from Redis.

    Args:
        redis_client: Async Redis client.
        exchange: Exchange identifier, e.g. ``"binance"``.
        symbol: Trading pair.

    Returns:
        Orderbook dict or empty dict on failure.
    """
    if redis_client is None:
        return {}

    try:
        import redis as sync_redis

        pool = redis_client.connection_pool
        url = str(pool.connection_kwargs.get("host", "localhost"))
        port = int(pool.connection_kwargs.get("port", 6379))
        r = sync_redis.Redis(host=url, port=port, decode_responses=True)

        key = f"orderbook:{exchange}:{symbol}"
        raw = r.get(key)
        if raw is None:
            return {}
        return json.loads(raw)
    except Exception:
        logger.exception("Failed to fetch orderbook for %s:%s", exchange, symbol)
        return {}


def get_recent_patterns(
    redis_client: aioredis.Redis | None,
    db_pool: psycopg2.pool.ThreadedConnectionPool | None,
    symbol: str,
    minutes: int = 10,
) -> list[dict[str, Any]]:
    """Fetch recent DOM pattern events (absorption, spoof, iceberg).

    Attempts Redis first, falls back to TimescaleDB.

    Args:
        redis_client: Async Redis client.
        db_pool: ThreadedConnectionPool instance.
        symbol: Trading pair.
        minutes: Lookback window in minutes.

    Returns:
        List of pattern event dicts.
    """
    # Try Redis first
    if redis_client is not None:
        try:
            import redis as sync_redis

            pool = redis_client.connection_pool
            url = str(pool.connection_kwargs.get("host", "localhost"))
            port = int(pool.connection_kwargs.get("port", 6379))
            r = sync_redis.Redis(host=url, port=port, decode_responses=True)

            key = f"patterns:{symbol}"
            raw_list = r.lrange(key, 0, 200)
            patterns: list[dict[str, Any]] = []
            for raw in raw_list:
                try:
                    patterns.append(json.loads(raw))
                except (json.JSONDecodeError, TypeError):
                    pass
            if patterns:
                return patterns
        except Exception:
            logger.debug("Redis pattern fetch failed, trying DB")

    # Fallback to DB
    if db_pool is not None:
        try:
            conn = db_pool.getconn()
            try:
                with conn.cursor() as cur:
                    cur.execute(
                        """
                        SELECT type, price, size, timestamp, metadata
                        FROM pattern_events
                        WHERE symbol = %s
                          AND timestamp >= NOW() - INTERVAL '%s minutes'
                        ORDER BY timestamp DESC
                        """,
                        (symbol, minutes),
                    )
                    columns = [desc[0] for desc in cur.description]
                    rows = cur.fetchall()
                return [dict(zip(columns, row)) for row in rows]
            finally:
                db_pool.putconn(conn)
        except Exception:
            logger.debug("DB pattern fetch failed for %s", symbol)

    return []


def get_ofi_buffer(
    redis_client: aioredis.Redis | None,
    exchange: str,
    symbol: str,
) -> list[float]:
    """Get the rolling Order Flow Imbalance buffer from Redis.

    Args:
        redis_client: Async Redis client.
        exchange: Exchange identifier.
        symbol: Trading pair.

    Returns:
        List of OFI float values.
    """
    if redis_client is None:
        return []

    try:
        import redis as sync_redis

        pool = redis_client.connection_pool
        url = str(pool.connection_kwargs.get("host", "localhost"))
        port = int(pool.connection_kwargs.get("port", 6379))
        r = sync_redis.Redis(host=url, port=port, decode_responses=True)

        key = f"ofi:{exchange}:{symbol}"
        raw_list = r.lrange(key, 0, -1)
        return [float(v) for v in raw_list]
    except Exception:
        logger.exception("Failed to fetch OFI buffer for %s:%s", exchange, symbol)
        return []


def get_funding_rate(
    redis_client: aioredis.Redis | None,
    exchange: str,
    symbol: str,
) -> dict[str, Any]:
    """Fetch the latest funding rate from Redis.

    Args:
        redis_client: Async Redis client.
        exchange: Exchange identifier.
        symbol: Trading pair.

    Returns:
        Dict with funding rate data, or empty dict on failure.
    """
    if redis_client is None:
        return {}

    try:
        import redis as sync_redis

        pool = redis_client.connection_pool
        url = str(pool.connection_kwargs.get("host", "localhost"))
        port = int(pool.connection_kwargs.get("port", 6379))
        r = sync_redis.Redis(host=url, port=port, decode_responses=True)

        key = f"funding:{exchange}:{symbol}"
        raw = r.get(key)
        if raw is None:
            return {}
        return json.loads(raw)
    except Exception:
        logger.exception("Failed to fetch funding rate for %s:%s", exchange, symbol)
        return {}
