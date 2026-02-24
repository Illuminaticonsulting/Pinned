#!/usr/bin/env bash
set -euo pipefail

# ─── Colors ─────────────────────────────────────────────────────────────────
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

info()  { echo -e "${GREEN}[✓]${NC} $1"; }
warn()  { echo -e "${YELLOW}[!]${NC} $1"; }
error() { echo -e "${RED}[✗]${NC} $1"; exit 1; }

echo ""
echo "╔═══════════════════════════════════════════╗"
echo "║       Pinned — Development Setup          ║"
echo "╚═══════════════════════════════════════════╝"
echo ""

# ─── Check Prerequisites ────────────────────────────────────────────────────

echo "Checking prerequisites..."

command -v node >/dev/null 2>&1 || error "Node.js is required but not installed. Install it from https://nodejs.org"
NODE_VER=$(node -v | sed 's/v//')
NODE_MAJOR=$(echo "$NODE_VER" | cut -d. -f1)
if [ "$NODE_MAJOR" -lt 20 ]; then
  error "Node.js 20+ is required. Current version: $NODE_VER"
fi
info "Node.js $NODE_VER"

command -v pnpm >/dev/null 2>&1 || error "pnpm is required but not installed. Run: npm install -g pnpm"
info "pnpm $(pnpm -v)"

command -v docker >/dev/null 2>&1 || error "Docker is required but not installed. Install it from https://docker.com"
info "Docker $(docker --version | awk '{print $3}' | tr -d ',')"

command -v python3 >/dev/null 2>&1 || warn "Python 3 not found — AI service setup will be skipped"
if command -v python3 >/dev/null 2>&1; then
  info "Python $(python3 --version | awk '{print $2}')"
fi

echo ""

# ─── Environment File ───────────────────────────────────────────────────────

if [ ! -f .env ]; then
  cp .env.example .env
  info "Created .env from .env.example"
  warn "Review .env and update secrets before running in production"
else
  info ".env already exists — skipping"
fi

echo ""

# ─── Start Infrastructure ───────────────────────────────────────────────────

echo "Starting infrastructure services..."

docker compose up -d timescaledb redis

echo "Waiting for services to be healthy..."

# Wait for TimescaleDB
MAX_WAIT=60
WAITED=0
until docker compose exec -T timescaledb pg_isready -U pinned -d pinned >/dev/null 2>&1; do
  sleep 2
  WAITED=$((WAITED + 2))
  if [ "$WAITED" -ge "$MAX_WAIT" ]; then
    error "TimescaleDB did not become healthy within ${MAX_WAIT}s"
  fi
done
info "TimescaleDB is ready"

# Wait for Redis
WAITED=0
until docker compose exec -T redis redis-cli ping >/dev/null 2>&1; do
  sleep 2
  WAITED=$((WAITED + 2))
  if [ "$WAITED" -ge "$MAX_WAIT" ]; then
    error "Redis did not become healthy within ${MAX_WAIT}s"
  fi
done
info "Redis is ready"

echo ""

# ─── Install Dependencies ───────────────────────────────────────────────────

echo "Installing Node.js dependencies..."
pnpm install
info "Node.js dependencies installed"

echo ""

# ─── Database Migrations ────────────────────────────────────────────────────

echo "Running database migrations..."
pnpm db:migrate
info "Database migrations complete"

echo ""

# ─── Python Dependencies ────────────────────────────────────────────────────

if command -v python3 >/dev/null 2>&1; then
  echo "Installing Python dependencies for AI service..."
  if [ -f packages/ai-service/requirements.txt ]; then
    pip3 install -r packages/ai-service/requirements.txt --quiet 2>/dev/null || \
      python3 -m pip install -r packages/ai-service/requirements.txt --quiet
    info "Python dependencies installed"
  else
    warn "packages/ai-service/requirements.txt not found — skipping"
  fi
else
  warn "Skipping Python dependency installation (python3 not found)"
fi

echo ""

# ─── Done ────────────────────────────────────────────────────────────────────

echo "╔═══════════════════════════════════════════╗"
echo "║         Setup Complete!                   ║"
echo "╚═══════════════════════════════════════════╝"
echo ""
echo "Next steps:"
echo "  1. Review and update .env with your API keys"
echo "  2. Start all services:  pnpm dev"
echo "  3. Or start individually:"
echo "     - Server:        pnpm dev:server"
echo "     - Chart Engine:  pnpm dev:chart"
echo "     - AI Service:    pnpm dev:ai"
echo ""
echo "Infrastructure:"
echo "  - TimescaleDB:  localhost:5432"
echo "  - Redis:        localhost:6379"
echo ""
