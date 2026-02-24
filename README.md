# Pinned — Crypto-Native Orderflow Intelligence Platform

A professional-grade trading platform that surfaces institutional orderflow, footprint analytics, and AI-driven signals across multiple crypto exchanges — built for traders who demand depth beyond the candlestick.

---

## Features

- **Footprint Charts** — Visualize bid/ask volume at every price level within each candle. Spot absorption, exhaustion, and initiative activity in real time.
- **DOM Heatmap** — Live depth-of-market heatmap with historical replay. See where large limit orders cluster, get pulled, or get filled.
- **AI Signals** — Machine-learning models that detect anomalous orderflow patterns (spoofing, iceberg orders, absorption events) and surface actionable signals.
- **Multi-Exchange Support** — Unified feed across BloFin, MEXC, and more. Normalized orderbook and trade data with sub-second latency.
- **Community Sync** — Share chart markups, drawing sets, and signal alerts with your trading group in real time.
- **Custom Indicators** — Stacked imbalance, delta divergence, cumulative volume delta (CVD), and volume-weighted average price (VWAP) built for orderflow.
- **Drawing Tools** — Professional annotation toolkit: trend lines, zones, Fibonacci, and orderflow-specific markup.
- **Alerting** — Configurable alerts via Telegram and email on orderflow events, price levels, and AI signal triggers.

---

## Tech Stack

| Layer            | Technology                                    |
| ---------------- | --------------------------------------------- |
| Chart Engine     | TypeScript, HTML Canvas, WebGL                |
| Backend Server   | Node.js, Fastify, WebSocket, Bull (Redis)     |
| AI Service       | Python, FastAPI, scikit-learn, PyTorch         |
| Database         | PostgreSQL (Drizzle ORM)                      |
| Cache / PubSub   | Redis                                         |
| Shared Types     | TypeScript (workspace package)                |
| Monorepo         | pnpm workspaces, Turborepo                    |
| Reverse Proxy    | Nginx                                         |
| Containerization | Docker, Docker Compose                        |

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                           NGINX                                  │
│                     (reverse proxy / TLS)                         │
└──────┬────────────────────┬──────────────────────┬───────────────┘
       │                    │                      │
       ▼                    ▼                      ▼
┌──────────────┐  ┌─────────────────┐  ┌───────────────────┐
│ Chart Engine │  │   API Server    │  │   AI Service      │
│  (Canvas/GL) │  │  (Fastify + WS) │  │  (FastAPI)        │
│              │  │                 │  │                   │
│  - Footprint │  │  - REST API     │  │  - Signal Models  │
│  - Heatmap   │  │  - WebSocket    │  │  - Anomaly Detect │
│  - Drawings  │  │  - Auth / JWT   │  │  - Pattern Engine │
│  - Indicators│  │  - Exchange Adp │  │  - Feature Eng.   │
└──────┬───────┘  └────┬───────┬────┘  └────────┬──────────┘
       │               │       │                 │
       │               ▼       ▼                 │
       │         ┌──────────────────┐            │
       │         │   PostgreSQL     │            │
       │         │   (Drizzle ORM)  │            │
       │         └──────────────────┘            │
       │               │                         │
       │               ▼                         │
       │         ┌──────────────────┐            │
       └────────►│     Redis        │◄───────────┘
                 │  (cache/pubsub)  │
                 └──────────────────┘
```

---

## Getting Started

### Prerequisites

- **Node.js** >= 20
- **pnpm** >= 9
- **Python** >= 3.11
- **Docker** & **Docker Compose**
- **Redis** >= 7
- **PostgreSQL** >= 16

### Installation

```bash
# Clone the repository
git clone https://github.com/your-org/pinned.git
cd pinned

# Install dependencies
pnpm install

# Copy environment config
cp .env.example .env
# Edit .env with your API keys and secrets

# Start infrastructure (Postgres, Redis)
docker compose up -d

# Run database migrations
pnpm db:migrate

# Start all services in development mode
pnpm dev
```

### Running Individual Services

```bash
# Backend API server only
pnpm dev:server

# Chart engine dev server
pnpm dev:chart

# AI service
pnpm dev:ai
```

### Building for Production

```bash
# Build all packages
pnpm build

# Run tests across all packages
pnpm test

# Lint all packages
pnpm lint
```

---

## Environment Setup

1. Copy `.env.example` to `.env`.
2. Fill in your exchange API credentials (BloFin, MEXC).
3. Set strong, unique values for `JWT_SECRET` and `JWT_REFRESH_SECRET`.
4. Configure `DATABASE_URL` to point to your PostgreSQL instance.
5. Configure `REDIS_URL` to point to your Redis instance.
6. (Optional) Add `TELEGRAM_BOT_TOKEN` and `SENDGRID_API_KEY` for alerting.

---

## Project Structure

```
pinned/
├── packages/
│   ├── chart-engine/     # Canvas/WebGL charting library
│   ├── server/           # Fastify API + WebSocket server
│   ├── ai-service/       # Python FastAPI ML service
│   └── shared-types/     # Shared TypeScript type definitions
├── nginx/                # Nginx reverse proxy config
├── scripts/              # Dev & deployment scripts
├── docker-compose.yml
├── turbo.json
├── tsconfig.base.json
└── package.json
```

---

## License

MIT
