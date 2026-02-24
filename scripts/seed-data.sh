#!/usr/bin/env bash
set -euo pipefail

# ─── Seed script for Pinned ──────────────────────────────────────────────────
# Fetches sample BTC-USDT candle data from BloFin API and inserts into TimescaleDB.

GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m'

info()  { echo -e "${GREEN}[✓]${NC} $1"; }
error() { echo -e "${RED}[✗]${NC} $1"; exit 1; }

# ─── Config ──────────────────────────────────────────────────────────────────

DATABASE_URL="${DATABASE_URL:-postgresql://pinned:pinned_dev@localhost:5432/pinned}"
BLOFIN_API="https://openapi.blofin.com"
INST_ID="BTC-USDT"
BAR="1m"
LIMIT=300

echo ""
echo "Seeding $INST_ID candle data ($LIMIT candles, $BAR timeframe)..."
echo ""

# ─── Fetch candles from BloFin ───────────────────────────────────────────────

command -v curl >/dev/null 2>&1 || error "curl is required"
command -v psql >/dev/null 2>&1 || error "psql is required (install via: brew install postgresql or apt install postgresql-client)"

RESPONSE=$(curl -s "${BLOFIN_API}/api/v1/market/candles?instId=${INST_ID}&bar=${BAR}&limit=${LIMIT}")

# Validate response
CODE=$(echo "$RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('code',''))" 2>/dev/null || echo "")
if [ "$CODE" != "0" ]; then
  error "BloFin API returned error code: $CODE"
fi

# ─── Insert into TimescaleDB ────────────────────────────────────────────────

COUNT=0

echo "$RESPONSE" | python3 -c "
import sys, json

data = json.load(sys.stdin).get('data', [])
for row in data:
    ts, o, h, l, c, vol = row[0], row[1], row[2], row[3], row[4], row[5]
    buy_vol = row[6] if len(row) > 6 else '0'
    sell_vol = row[7] if len(row) > 7 else '0'
    # Convert epoch ms to ISO timestamp
    from datetime import datetime, timezone
    dt = datetime.fromtimestamp(int(ts) / 1000, tz=timezone.utc).isoformat()
    print(f\"INSERT INTO candles (time, exchange, symbol, timeframe, open, high, low, close, volume, buy_volume, sell_volume) VALUES ('{dt}', 'blofin', '${INST_ID}', '${BAR}', {o}, {h}, {l}, {c}, {vol}, {buy_vol}, {sell_vol}) ON CONFLICT DO NOTHING;\")
" | psql "$DATABASE_URL" --quiet 2>/dev/null

# Count inserted
COUNT=$(psql "$DATABASE_URL" -t -A -c "SELECT COUNT(*) FROM candles WHERE exchange='blofin' AND symbol='${INST_ID}' AND timeframe='${BAR}';" 2>/dev/null || echo "0")

echo ""
info "Seeded $COUNT ${INST_ID} candle records into TimescaleDB"
echo ""
