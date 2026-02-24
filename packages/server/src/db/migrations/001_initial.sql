-- 001_initial.sql
-- Initial schema for the Pinned crypto orderflow trading platform

-- Enable TimescaleDB extension
CREATE EXTENSION IF NOT EXISTS timescaledb;

-- ============================================================
-- TRADES (hypertable)
-- ============================================================
CREATE TABLE IF NOT EXISTS trades (
    time        TIMESTAMPTZ      NOT NULL,
    exchange    TEXT             NOT NULL,
    symbol      TEXT             NOT NULL,
    price       DOUBLE PRECISION NOT NULL,
    size        DOUBLE PRECISION NOT NULL,
    side        TEXT             NOT NULL,
    trade_id    TEXT
);

SELECT create_hypertable('trades', 'time', if_not_exists => TRUE);

CREATE INDEX IF NOT EXISTS idx_trades_exchange_symbol_time
    ON trades (exchange, symbol, time DESC);

-- ============================================================
-- CANDLES (hypertable)
-- ============================================================
CREATE TABLE IF NOT EXISTS candles (
    time        TIMESTAMPTZ      NOT NULL,
    exchange    TEXT             NOT NULL,
    symbol      TEXT             NOT NULL,
    timeframe   TEXT             NOT NULL,
    open        DOUBLE PRECISION,
    high        DOUBLE PRECISION,
    low         DOUBLE PRECISION,
    close       DOUBLE PRECISION,
    volume      DOUBLE PRECISION,
    buy_volume  DOUBLE PRECISION,
    sell_volume DOUBLE PRECISION,
    UNIQUE (time, exchange, symbol, timeframe)
);

SELECT create_hypertable('candles', 'time', if_not_exists => TRUE);

CREATE INDEX IF NOT EXISTS idx_candles_exchange_symbol_timeframe_time
    ON candles (exchange, symbol, timeframe, time DESC);

-- ============================================================
-- ORDERBOOK SNAPSHOTS (hypertable with compression)
-- ============================================================
CREATE TABLE IF NOT EXISTS orderbook_snapshots (
    time        TIMESTAMPTZ NOT NULL,
    exchange    TEXT        NOT NULL,
    symbol      TEXT        NOT NULL,
    bids        JSONB       NOT NULL,
    asks        JSONB       NOT NULL
);

SELECT create_hypertable('orderbook_snapshots', 'time', if_not_exists => TRUE);

CREATE INDEX IF NOT EXISTS idx_orderbook_exchange_symbol_time
    ON orderbook_snapshots (exchange, symbol, time DESC);

ALTER TABLE orderbook_snapshots SET (
    timescaledb.compress,
    timescaledb.compress_segmentby = 'exchange,symbol'
);

SELECT add_compression_policy('orderbook_snapshots', INTERVAL '24 hours', if_not_exists => TRUE);

-- ============================================================
-- USERS
-- ============================================================
CREATE TABLE IF NOT EXISTS users (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email         TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    display_name  TEXT,
    avatar        TEXT,
    preferences   JSONB DEFAULT '{}',
    created_at    TIMESTAMPTZ DEFAULT NOW(),
    updated_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- DRAWINGS
-- ============================================================
CREATE TABLE IF NOT EXISTS drawings (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID REFERENCES users(id) ON DELETE CASCADE,
    symbol      TEXT NOT NULL,
    timeframe   TEXT NOT NULL,
    type        TEXT NOT NULL,
    points      JSONB NOT NULL,
    properties  JSONB NOT NULL,
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    updated_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_drawings_user_symbol_timeframe
    ON drawings (user_id, symbol, timeframe);

-- ============================================================
-- ALERTS
-- ============================================================
CREATE TABLE IF NOT EXISTS alerts (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id        UUID REFERENCES users(id) ON DELETE CASCADE,
    symbol         TEXT NOT NULL,
    condition      JSONB NOT NULL,
    delivery       JSONB NOT NULL,
    active         BOOLEAN DEFAULT true,
    expires_at     TIMESTAMPTZ,
    last_triggered TIMESTAMPTZ,
    created_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_alerts_user_active
    ON alerts (user_id, active);

-- ============================================================
-- SIGNALS (hypertable)
-- ============================================================
CREATE TABLE IF NOT EXISTS signals (
    time         TIMESTAMPTZ      NOT NULL,
    symbol       TEXT             NOT NULL,
    direction    TEXT             NOT NULL,
    confidence   DOUBLE PRECISION,
    reasoning    TEXT,
    triggers     JSONB,
    pattern_type TEXT,
    regime       TEXT,
    metadata     JSONB
);

SELECT create_hypertable('signals', 'time', if_not_exists => TRUE);

CREATE INDEX IF NOT EXISTS idx_signals_symbol_time
    ON signals (symbol, time DESC);

-- ============================================================
-- SHARED CHARTS
-- ============================================================
CREATE TABLE IF NOT EXISTS shared_charts (
    id          TEXT PRIMARY KEY,
    user_id     UUID REFERENCES users(id),
    state       JSONB NOT NULL,
    view_count  INTEGER DEFAULT 0,
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    expires_at  TIMESTAMPTZ
);

-- ============================================================
-- API CONNECTIONS
-- ============================================================
CREATE TABLE IF NOT EXISTS api_connections (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id              UUID REFERENCES users(id) ON DELETE CASCADE,
    exchange             TEXT NOT NULL,
    encrypted_key        TEXT NOT NULL,
    encrypted_secret     TEXT NOT NULL,
    encrypted_passphrase TEXT,
    created_at           TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- WATCHLISTS
-- ============================================================
CREATE TABLE IF NOT EXISTS watchlists (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID REFERENCES users(id) ON DELETE CASCADE,
    name        TEXT NOT NULL DEFAULT 'Default',
    symbols     JSONB NOT NULL DEFAULT '[]',
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- PATTERN EVENTS (hypertable)
-- ============================================================
CREATE TABLE IF NOT EXISTS pattern_events (
    time           TIMESTAMPTZ      NOT NULL,
    exchange       TEXT             NOT NULL,
    symbol         TEXT             NOT NULL,
    type           TEXT             NOT NULL,
    price          DOUBLE PRECISION,
    confidence     DOUBLE PRECISION,
    direction      TEXT,
    estimated_size DOUBLE PRECISION,
    duration       INTEGER,
    metadata       JSONB
);

SELECT create_hypertable('pattern_events', 'time', if_not_exists => TRUE);

CREATE INDEX IF NOT EXISTS idx_pattern_events_exchange_symbol_time
    ON pattern_events (exchange, symbol, time DESC);

-- ============================================================
-- RETENTION POLICIES
-- ============================================================
SELECT add_retention_policy('trades', INTERVAL '30 days', if_not_exists => TRUE);
SELECT add_retention_policy('orderbook_snapshots', INTERVAL '7 days', if_not_exists => TRUE);
SELECT add_retention_policy('signals', INTERVAL '90 days', if_not_exists => TRUE);
SELECT add_retention_policy('pattern_events', INTERVAL '30 days', if_not_exists => TRUE);

-- ============================================================
-- CONTINUOUS AGGREGATE: 5-minute candles from trades
-- ============================================================
CREATE MATERIALIZED VIEW IF NOT EXISTS candles_5m
WITH (timescaledb.continuous) AS
SELECT
    time_bucket('5 minutes', time) AS time,
    exchange,
    symbol,
    first(price, time)  AS open,
    max(price)           AS high,
    min(price)           AS low,
    last(price, time)   AS close,
    sum(size)            AS volume,
    sum(CASE WHEN side = 'buy'  THEN size ELSE 0 END) AS buy_volume,
    sum(CASE WHEN side = 'sell' THEN size ELSE 0 END) AS sell_volume
FROM trades
GROUP BY time_bucket('5 minutes', time), exchange, symbol
WITH NO DATA;

SELECT add_continuous_aggregate_policy('candles_5m',
    start_offset  => INTERVAL '1 hour',
    end_offset    => INTERVAL '5 minutes',
    schedule_interval => INTERVAL '5 minutes',
    if_not_exists => TRUE
);
