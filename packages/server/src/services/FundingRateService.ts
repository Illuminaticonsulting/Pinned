import { logger } from '../utils/logger';
import { redis } from '../utils/redis';
import { pool } from '../db';
import { config } from '../config';
import type { FundingRate, Exchange } from '@pinned/shared-types';

const FETCH_INTERVAL_MS = 60_000;

/**
 * Exchange adapter interface expected by this service.
 * Each exchange adapter module should export an object conforming to this shape.
 */
interface ExchangeAdapter {
  exchange: Exchange;
  fetchFundingRate(symbol: string): Promise<FundingRate>;
}

export class FundingRateService {
  private running = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private adapters: ExchangeAdapter[] = [];
  private symbols: string[] = [];

  /** Register exchange adapters that provide REST funding rate endpoints. */
  registerAdapter(adapter: ExchangeAdapter): void {
    this.adapters.push(adapter);
    logger.info('FundingRateService: adapter registered', {
      exchange: adapter.exchange,
    });
  }

  /** Fetch funding rate from a single adapter for a single symbol. */
  private async fetchAndStore(
    adapter: ExchangeAdapter,
    symbol: string,
  ): Promise<void> {
    let fundingRate: FundingRate;

    try {
      fundingRate = await adapter.fetchFundingRate(symbol);
    } catch (err) {
      logger.error('FundingRateService: fetch failed', {
        error: String(err),
        exchange: adapter.exchange,
        symbol,
      });
      return;
    }

    // Persist to TimescaleDB
    try {
      await pool.query(
        `INSERT INTO funding_rates (time, exchange, symbol, rate, next_funding_time)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT DO NOTHING`,
        [
          new Date(fundingRate.time).toISOString(),
          fundingRate.exchange,
          fundingRate.symbol,
          fundingRate.rate,
          new Date(fundingRate.nextFundingTime).toISOString(),
        ],
      );
    } catch (err) {
      logger.error('FundingRateService: DB insert failed', {
        error: String(err),
        exchange: adapter.exchange,
        symbol,
      });
    }

    // Publish to Redis Pub/Sub
    try {
      const channel = `funding:${fundingRate.exchange}:${fundingRate.symbol}`;
      await redis.publish(channel, JSON.stringify(fundingRate));
    } catch (err) {
      logger.error('FundingRateService: Redis publish failed', {
        error: String(err),
        exchange: adapter.exchange,
        symbol,
      });
    }

    logger.debug('FundingRateService: rate fetched', {
      exchange: fundingRate.exchange,
      symbol: fundingRate.symbol,
      rate: fundingRate.rate,
    });
  }

  /** Run a single tick: fetch all symbols from all adapters. */
  private async tick(): Promise<void> {
    const tasks: Promise<void>[] = [];

    for (const adapter of this.adapters) {
      for (const symbol of this.symbols) {
        tasks.push(this.fetchAndStore(adapter, symbol));
      }
    }

    await Promise.allSettled(tasks);
  }

  start(symbols: string[]): void {
    if (this.running) return;
    this.running = true;
    this.symbols = symbols;

    // Fetch immediately on start
    this.tick().catch((err) => {
      logger.error('FundingRateService: initial tick failed', {
        error: String(err),
      });
    });

    this.timer = setInterval(() => {
      this.tick().catch((err) => {
        logger.error('FundingRateService: tick failed', {
          error: String(err),
        });
      });
    }, FETCH_INTERVAL_MS);

    logger.info('FundingRateService: started', {
      symbols,
      adapters: this.adapters.map((a) => a.exchange),
      intervalMs: FETCH_INTERVAL_MS,
    });
  }

  async stop(): Promise<void> {
    this.running = false;

    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    logger.info('FundingRateService: stopped');
  }
}
