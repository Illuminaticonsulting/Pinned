/**
 * Prometheus metrics middleware and metric objects for the Pinned platform.
 *
 * Exports:
 *  - metricsMiddleware  — Express middleware to record HTTP request metrics.
 *  - register           — Prometheus client registry (scrape via GET /metrics).
 *  - Individual metric objects for use in other services.
 */

import { Request, Response, NextFunction } from 'express';
import client, { Registry, Histogram, Counter, Gauge } from 'prom-client';

// ─── Registry ──────────────────────────────────────────────────────────────────

export const register: Registry = new client.Registry();

register.setDefaultLabels({ app: 'pinned-server' });

// Collect default Node.js metrics (GC, event loop lag, etc.)
client.collectDefaultMetrics({ register });

// ─── HTTP Metrics ──────────────────────────────────────────────────────────────

export const httpRequestDuration = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'route', 'status'] as const,
  buckets: [0.005, 0.01, 0.05, 0.1, 0.3, 0.5, 1, 2, 5],
  registers: [register],
});

export const httpRequestCounter = new Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'route', 'status'] as const,
  registers: [register],
});

// ─── WebSocket Metrics ─────────────────────────────────────────────────────────

export const activeWebSocketConnections = new Gauge({
  name: 'ws_active_connections',
  help: 'Number of active WebSocket connections',
  registers: [register],
});

// ─── Trade Ingestion Metrics ───────────────────────────────────────────────────

export const tradeIngestionCounter = new Counter({
  name: 'trade_ingestion_total',
  help: 'Total trades ingested from exchanges',
  labelNames: ['exchange', 'symbol'] as const,
  registers: [register],
});

// ─── Orderbook Metrics ─────────────────────────────────────────────────────────

export const orderbookSnapshotsPerSecond = new Gauge({
  name: 'orderbook_snapshots_per_second',
  help: 'Rate of orderbook snapshot processing',
  registers: [register],
});

// ─── Heatmap Metrics ───────────────────────────────────────────────────────────

export const heatmapComputationDuration = new Histogram({
  name: 'heatmap_computation_duration_seconds',
  help: 'Duration of heatmap computation in seconds',
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2],
  registers: [register],
});

// ─── Infrastructure Metrics ────────────────────────────────────────────────────

export const redisMemoryUsage = new Gauge({
  name: 'redis_memory_usage_bytes',
  help: 'Redis memory usage in bytes',
  registers: [register],
});

export const dbConnectionPoolStats = new Gauge({
  name: 'db_connection_pool_stats',
  help: 'Database connection pool statistics',
  labelNames: ['stat'] as const,
  registers: [register],
});

// ─── Pattern & Alert Metrics ───────────────────────────────────────────────────

export const patternEventsCounter = new Counter({
  name: 'pattern_events_total',
  help: 'Total pattern events detected',
  labelNames: ['type'] as const,
  registers: [register],
});

export const alertsEvaluatedCounter = new Counter({
  name: 'alerts_evaluated_total',
  help: 'Total alert conditions evaluated',
  registers: [register],
});

export const alertsTriggeredCounter = new Counter({
  name: 'alerts_triggered_total',
  help: 'Total alerts triggered and delivered',
  registers: [register],
});

// ─── Express Middleware ────────────────────────────────────────────────────────

/**
 * Express middleware that records HTTP request duration and counts.
 * Mount early in the middleware chain for accurate timing.
 *
 * @example
 * ```ts
 * app.use(metricsMiddleware);
 * ```
 */
export function metricsMiddleware(req: Request, res: Response, next: NextFunction): void {
  const end = httpRequestDuration.startTimer();

  res.on('finish', () => {
    const route = req.route?.path ?? req.path ?? 'unknown';
    const labels = {
      method: req.method,
      route,
      status: String(res.statusCode),
    };

    end(labels);
    httpRequestCounter.inc(labels);
  });

  next();
}
