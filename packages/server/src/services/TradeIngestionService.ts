import { logger } from '../utils/logger';
import { redis } from '../utils/redis';
import { pool } from '../db';
import { config } from '../config';
import type { Trade } from '@pinned/shared-types';

const FLUSH_INTERVAL_MS = 500;
const STREAM_MAXLEN = 10_000;

export class TradeIngestionService {
  private buffer: Trade[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  // Metrics
  private totalIngested = 0;
  private tradeCountWindow: number[] = [];
  private metricsTimer: ReturnType<typeof setInterval> | null = null;

  /** Accept a trade from an exchange adapter. */
  async onTrade(trade: Trade): Promise<void> {
    if (!this.running) return;

    this.buffer.push(trade);
    this.totalIngested++;
    this.tradeCountWindow.push(Date.now());

    // Publish to Redis Stream immediately so downstream consumers have minimal latency
    try {
      const streamKey = `trades:${trade.exchange}:${trade.symbol}`;
      await redis.xadd(
        streamKey,
        'MAXLEN',
        '~',
        String(STREAM_MAXLEN),
        '*',
        'time', String(trade.time),
        'price', String(trade.price),
        'size', String(trade.size),
        'side', trade.side,
        'tradeId', trade.tradeId,
        'exchange', trade.exchange,
        'symbol', trade.symbol,
      );
    } catch (err) {
      logger.error('TradeIngestionService: failed to publish trade to Redis Stream', {
        error: String(err),
        symbol: trade.symbol,
        exchange: trade.exchange,
      });
    }
  }

  /** Flush buffered trades to TimescaleDB as a batch INSERT. */
  private async flush(): Promise<void> {
    if (this.buffer.length === 0) return;

    // Swap buffer atomically so new trades go to a fresh array
    const batch = this.buffer;
    this.buffer = [];

    try {
      const values: any[] = [];
      const placeholders: string[] = [];

      for (let i = 0; i < batch.length; i++) {
        const t = batch[i];
        const offset = i * 7;
        placeholders.push(
          `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7})`,
        );
        values.push(
          new Date(t.time).toISOString(),
          t.exchange,
          t.symbol,
          t.price,
          t.size,
          t.side,
          t.tradeId,
        );
      }

      const sql = `
        INSERT INTO trades (time, exchange, symbol, price, size, side, trade_id)
        VALUES ${placeholders.join(', ')}
        ON CONFLICT DO NOTHING
      `;

      await pool.query(sql, values);

      logger.debug('TradeIngestionService: flushed batch to DB', {
        count: batch.length,
      });
    } catch (err) {
      logger.error('TradeIngestionService: DB batch insert failed, re-buffering trades', {
        error: String(err),
        batchSize: batch.length,
      });
      // Prepend failed batch back so data is not lost
      this.buffer = batch.concat(this.buffer);
    }
  }

  /** Returns trades ingested per second over the last 10 seconds. */
  getTradesPerSecond(): number {
    const cutoff = Date.now() - 10_000;
    this.tradeCountWindow = this.tradeCountWindow.filter((ts) => ts >= cutoff);
    return this.tradeCountWindow.length / 10;
  }

  /** Returns total trades ingested since start. */
  getTotalIngested(): number {
    return this.totalIngested;
  }

  getMetrics(): { tradesPerSecond: number; totalIngested: number; bufferSize: number } {
    return {
      tradesPerSecond: this.getTradesPerSecond(),
      totalIngested: this.totalIngested,
      bufferSize: this.buffer.length,
    };
  }

  start(): void {
    if (this.running) return;
    this.running = true;

    this.flushTimer = setInterval(() => {
      this.flush().catch((err) => {
        logger.error('TradeIngestionService: flush error', { error: String(err) });
      });
    }, FLUSH_INTERVAL_MS);

    this.metricsTimer = setInterval(() => {
      const metrics = this.getMetrics();
      logger.info('TradeIngestionService: metrics', metrics);
    }, 30_000);

    logger.info('TradeIngestionService: started', { flushIntervalMs: FLUSH_INTERVAL_MS });
  }

  async stop(): Promise<void> {
    this.running = false;

    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.metricsTimer) {
      clearInterval(this.metricsTimer);
      this.metricsTimer = null;
    }

    // Final flush
    await this.flush();
    logger.info('TradeIngestionService: stopped', { totalIngested: this.totalIngested });
  }
}
