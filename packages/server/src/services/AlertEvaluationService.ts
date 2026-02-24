import { logger } from '../utils/logger';
import { redis } from '../utils/redis';
import { pool } from '../db';
import { config } from '../config';
import type {
  Alert,
  AlertCondition,
  AlertDelivery,
  Exchange,
  PatternEvent,
} from '@pinned/shared-types';

const EVAL_INTERVAL_MS = 1_000;
const ALERT_CACHE_TTL_MS = 30_000;

interface CachedAlerts {
  alerts: Alert[];
  fetchedAt: number;
}

interface AlertTriggerEvent {
  alertId: string;
  userId: string;
  symbol: string;
  condition: AlertCondition;
  triggeredAt: number;
  currentValue: number;
}

export class AlertEvaluationService {
  private running = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private cache: CachedAlerts | null = null;

  /** Load active alerts from DB, with 30-second cache. */
  private async getActiveAlerts(): Promise<Alert[]> {
    const now = Date.now();

    if (this.cache && now - this.cache.fetchedAt < ALERT_CACHE_TTL_MS) {
      return this.cache.alerts;
    }

    try {
      const result = await pool.query<{
        id: string;
        user_id: string;
        symbol: string;
        condition_type: string;
        condition_value: number;
        condition_operator: string;
        delivery: string[];
        active: boolean;
        created_at: string;
        last_triggered: string | null;
        expires_at: string | null;
      }>(
        `SELECT id, user_id, symbol, condition_type, condition_value,
                condition_operator, delivery, active, created_at,
                last_triggered, expires_at
         FROM alerts
         WHERE active = true
           AND (expires_at IS NULL OR expires_at > NOW())`,
      );

      const alerts: Alert[] = result.rows.map((row) => ({
        id: row.id,
        userId: row.user_id,
        symbol: row.symbol,
        condition: {
          type: row.condition_type as AlertCondition['type'],
          value: row.condition_value,
          operator: row.condition_operator as AlertCondition['operator'],
        },
        delivery: row.delivery as AlertDelivery[],
        active: row.active,
        createdAt: new Date(row.created_at).getTime(),
        lastTriggered: row.last_triggered
          ? new Date(row.last_triggered).getTime()
          : undefined,
        expiresAt: row.expires_at
          ? new Date(row.expires_at).getTime()
          : undefined,
      }));

      this.cache = { alerts, fetchedAt: now };
      return alerts;
    } catch (err) {
      logger.error('AlertEvaluationService: failed to load alerts', {
        error: String(err),
      });
      return this.cache?.alerts ?? [];
    }
  }

  /** Evaluate a single alert against live data. */
  private async evaluateAlert(alert: Alert): Promise<void> {
    const { condition, symbol } = alert;
    let currentValue: number | null = null;
    let shouldTrigger = false;

    try {
      switch (condition.type) {
        case 'price_cross':
          currentValue = await this.getLatestPrice(symbol);
          if (currentValue !== null) {
            shouldTrigger = this.compareValue(
              currentValue,
              condition.value,
              condition.operator,
            );
          }
          break;

        case 'delta_divergence':
          currentValue = await this.getCumulativeDelta(symbol);
          if (currentValue !== null) {
            shouldTrigger = this.compareValue(
              currentValue,
              condition.value,
              condition.operator,
            );
          }
          break;

        case 'ofi_threshold':
          currentValue = await this.getLatestOFI(symbol);
          if (currentValue !== null) {
            shouldTrigger = this.compareValue(
              currentValue,
              condition.value,
              condition.operator,
            );
          }
          break;

        case 'absorption':
          currentValue = await this.getRecentPatternConfidence(
            symbol,
            'absorption',
          );
          if (currentValue !== null) {
            shouldTrigger = this.compareValue(
              currentValue,
              condition.value,
              condition.operator,
            );
          }
          break;

        case 'funding_spike':
          currentValue = await this.getFundingDeviation(symbol);
          if (currentValue !== null) {
            // Trigger if deviation > 2 std dev (represented by condition.value)
            shouldTrigger = Math.abs(currentValue) > condition.value;
          }
          break;

        case 'pattern':
          currentValue = await this.getRecentPatternConfidence(symbol);
          if (currentValue !== null) {
            shouldTrigger = currentValue >= condition.value;
          }
          break;
      }
    } catch (err) {
      logger.error('AlertEvaluationService: evaluation error', {
        error: String(err),
        alertId: alert.id,
        type: condition.type,
      });
      return;
    }

    if (shouldTrigger && currentValue !== null) {
      await this.triggerAlert(alert, currentValue);
    }
  }

  /** Compare a value against a condition threshold with the specified operator. */
  private compareValue(
    current: number,
    threshold: number,
    operator: AlertCondition['operator'],
  ): boolean {
    switch (operator) {
      case 'gt':
        return current > threshold;
      case 'lt':
        return current < threshold;
      case 'cross_above':
        return current > threshold; // simplistic — full cross detection needs previous value
      case 'cross_below':
        return current < threshold;
      default:
        return false;
    }
  }

  // ─── Data Fetchers ─────────────────────────────────────────────────────────

  private async getLatestPrice(symbol: string): Promise<number | null> {
    try {
      // Try both exchanges, return the first available
      for (const exchange of ['blofin', 'mexc'] as Exchange[]) {
        const raw = await redis.get(`ob:${exchange}:${symbol}:latest`);
        if (raw) {
          const ob = JSON.parse(raw);
          if (ob.bids?.length > 0 && ob.asks?.length > 0) {
            return (ob.bids[0].price + ob.asks[0].price) / 2;
          }
        }
      }
    } catch (err) {
      logger.debug('AlertEvaluationService: price fetch error', {
        error: String(err),
      });
    }
    return null;
  }

  private async getCumulativeDelta(symbol: string): Promise<number | null> {
    try {
      for (const exchange of ['blofin', 'mexc'] as Exchange[]) {
        const channel = `ofi:${exchange}:${symbol}`;
        // Read latest OFI as a proxy for cumulative delta
        const raw = await redis.get(`${channel}:latest`);
        if (raw) {
          const data = JSON.parse(raw);
          return data.cumulative ?? null;
        }
      }
    } catch {
      // ignore
    }
    return null;
  }

  private async getLatestOFI(symbol: string): Promise<number | null> {
    try {
      for (const exchange of ['blofin', 'mexc'] as Exchange[]) {
        const raw = await redis.get(`ofi:${exchange}:${symbol}:latest`);
        if (raw) {
          return JSON.parse(raw).value ?? null;
        }
      }
    } catch {
      // ignore
    }
    return null;
  }

  private async getRecentPatternConfidence(
    symbol: string,
    patternType?: string,
  ): Promise<number | null> {
    try {
      const cutoff = new Date(Date.now() - 60_000).toISOString();
      const typeFilter = patternType
        ? 'AND type = $3'
        : '';
      const params: any[] = [symbol, cutoff];
      if (patternType) params.push(patternType);

      const result = await pool.query(
        `SELECT confidence FROM pattern_events
         WHERE symbol = $1 AND time > $2 ${typeFilter}
         ORDER BY time DESC LIMIT 1`,
        params,
      );

      if (result.rows.length > 0) {
        return result.rows[0].confidence;
      }
    } catch {
      // ignore
    }
    return null;
  }

  private async getFundingDeviation(symbol: string): Promise<number | null> {
    try {
      // Get recent funding rates and compute std dev
      const result = await pool.query(
        `SELECT rate FROM funding_rates
         WHERE symbol = $1
         ORDER BY time DESC
         LIMIT 100`,
        [symbol],
      );

      if (result.rows.length < 10) return null;

      const rates = result.rows.map((r) => r.rate);
      const mean = rates.reduce((a: number, b: number) => a + b, 0) / rates.length;
      const variance =
        rates.reduce((sum: number, r: number) => sum + (r - mean) ** 2, 0) /
        rates.length;
      const stdDev = Math.sqrt(variance);

      if (stdDev === 0) return null;

      const latestRate = rates[0];
      return (latestRate - mean) / stdDev;
    } catch {
      // ignore
    }
    return null;
  }

  // ─── Alert Triggering ──────────────────────────────────────────────────────

  private async triggerAlert(alert: Alert, currentValue: number): Promise<void> {
    const now = Date.now();

    // Debounce: don't re-trigger within 60 seconds
    if (alert.lastTriggered && now - alert.lastTriggered < 60_000) {
      return;
    }

    logger.info('AlertEvaluationService: alert triggered', {
      alertId: alert.id,
      userId: alert.userId,
      symbol: alert.symbol,
      type: alert.condition.type,
      value: currentValue,
    });

    // Update last_triggered in DB
    try {
      await pool.query(
        `UPDATE alerts SET last_triggered = $1 WHERE id = $2`,
        [new Date(now).toISOString(), alert.id],
      );
    } catch (err) {
      logger.error('AlertEvaluationService: failed to update last_triggered', {
        error: String(err),
        alertId: alert.id,
      });
    }

    // If once-only condition, deactivate
    if (
      alert.condition.operator === 'cross_above' ||
      alert.condition.operator === 'cross_below'
    ) {
      try {
        await pool.query(
          `UPDATE alerts SET active = false WHERE id = $1`,
          [alert.id],
        );
      } catch (err) {
        logger.error('AlertEvaluationService: failed to deactivate alert', {
          error: String(err),
          alertId: alert.id,
        });
      }
    }

    // Publish trigger event to user-specific Redis channel
    const triggerEvent: AlertTriggerEvent = {
      alertId: alert.id,
      userId: alert.userId,
      symbol: alert.symbol,
      condition: alert.condition,
      triggeredAt: now,
      currentValue,
    };

    try {
      await redis.publish(
        `alert_triggers:${alert.userId}`,
        JSON.stringify(triggerEvent),
      );
    } catch (err) {
      logger.error('AlertEvaluationService: Redis publish failed', {
        error: String(err),
        alertId: alert.id,
      });
    }

    // Queue delivery jobs
    for (const delivery of alert.delivery) {
      try {
        const job = JSON.stringify({
          type: delivery,
          alertId: alert.id,
          userId: alert.userId,
          symbol: alert.symbol,
          condition: alert.condition,
          currentValue,
          triggeredAt: now,
        });

        switch (delivery) {
          case 'in_app':
            // Already published via WebSocket above
            break;
          case 'telegram':
            await redis.lpush('delivery:telegram', job);
            break;
          case 'email':
            await redis.lpush('delivery:email', job);
            break;
          case 'browser_push':
            await redis.lpush('delivery:browser_push', job);
            break;
        }
      } catch (err) {
        logger.error('AlertEvaluationService: delivery queue failed', {
          error: String(err),
          delivery,
          alertId: alert.id,
        });
      }
    }

    // Invalidate cache so next tick picks up updated last_triggered / active state
    this.cache = null;
  }

  // ─── Evaluation Loop ──────────────────────────────────────────────────────

  private async tick(): Promise<void> {
    const alerts = await this.getActiveAlerts();

    const tasks = alerts.map((alert) =>
      this.evaluateAlert(alert).catch((err) => {
        logger.error('AlertEvaluationService: alert eval failed', {
          error: String(err),
          alertId: alert.id,
        });
      }),
    );

    await Promise.allSettled(tasks);
  }

  start(): void {
    if (this.running) return;
    this.running = true;

    this.timer = setInterval(() => {
      this.tick().catch((err) => {
        logger.error('AlertEvaluationService: tick failed', {
          error: String(err),
        });
      });
    }, EVAL_INTERVAL_MS);

    logger.info('AlertEvaluationService: started', {
      evalIntervalMs: EVAL_INTERVAL_MS,
      cacheTtlMs: ALERT_CACHE_TTL_MS,
    });
  }

  async stop(): Promise<void> {
    this.running = false;

    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    this.cache = null;
    logger.info('AlertEvaluationService: stopped');
  }
}
