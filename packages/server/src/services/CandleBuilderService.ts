import { logger } from '../utils/logger';
import { redis, redisSub } from '../utils/redis';
import { pool } from '../db';
import { config } from '../config';
import type { Candle, Trade, Timeframe, Exchange } from '@pinned/shared-types';

const TIMEFRAMES: Timeframe[] = ['1m', '5m', '15m', '1h', '4h', '1d'];

const TIMEFRAME_MS: Record<Timeframe, number> = {
  '1m': 60_000,
  '5m': 300_000,
  '15m': 900_000,
  '1h': 3_600_000,
  '4h': 14_400_000,
  '1d': 86_400_000,
};

function getTimeBucket(tradeTime: number, tfMs: number): number {
  return Math.floor(tradeTime / tfMs) * tfMs;
}

interface OpenCandle extends Candle {
  dirty: boolean;
}

type CandleKey = string; // `${exchange}:${symbol}:${timeframe}`

export class CandleBuilderService {
  private candles = new Map<CandleKey, OpenCandle>();
  private running = false;
  private pollTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private lastStreamIds = new Map<string, string>();

  /** Get or create the open candle for a given key. */
  private getOrCreate(
    exchange: Exchange,
    symbol: string,
    tf: Timeframe,
    tradeTime: number,
    tradePrice: number,
  ): OpenCandle {
    const key: CandleKey = `${exchange}:${symbol}:${tf}`;
    const tfMs = TIMEFRAME_MS[tf];
    const bucket = getTimeBucket(tradeTime, tfMs);

    let candle = this.candles.get(key);

    if (candle && candle.time !== bucket) {
      // Time boundary crossed — close current candle
      this.closeCandle(candle);
      candle = undefined;
    }

    if (!candle) {
      candle = {
        time: bucket,
        open: tradePrice,
        high: tradePrice,
        low: tradePrice,
        close: tradePrice,
        volume: 0,
        buyVolume: 0,
        sellVolume: 0,
        exchange,
        symbol,
        timeframe: tf,
        dirty: false,
      };
      this.candles.set(key, candle);
    }

    return candle;
  }

  /** Process a single trade: update all timeframe candles. */
  private processTrade(trade: Trade): void {
    for (const tf of TIMEFRAMES) {
      const candle = this.getOrCreate(
        trade.exchange,
        trade.symbol,
        tf,
        trade.time,
        trade.price,
      );

      candle.high = Math.max(candle.high, trade.price);
      candle.low = Math.min(candle.low, trade.price);
      candle.close = trade.price;
      candle.volume += trade.size;

      if (trade.side === 'buy') {
        candle.buyVolume += trade.size;
      } else {
        candle.sellVolume += trade.size;
      }

      candle.dirty = true;
    }
  }

  /** Flush a completed candle to DB and publish to Redis Pub/Sub. */
  private async closeCandle(candle: OpenCandle): Promise<void> {
    try {
      await pool.query(
        `INSERT INTO candles (time, exchange, symbol, timeframe, open, high, low, close, volume, buy_volume, sell_volume)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT DO NOTHING`,
        [
          new Date(candle.time).toISOString(),
          candle.exchange,
          candle.symbol,
          candle.timeframe,
          candle.open,
          candle.high,
          candle.low,
          candle.close,
          candle.volume,
          candle.buyVolume,
          candle.sellVolume,
        ],
      );
    } catch (err) {
      logger.error('CandleBuilderService: DB insert failed for closed candle', {
        error: String(err),
        symbol: candle.symbol,
        timeframe: candle.timeframe,
        time: candle.time,
      });
    }

    const channel = `candles:${candle.exchange}:${candle.symbol}:${candle.timeframe}`;
    const payload: Candle = {
      time: candle.time,
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
      volume: candle.volume,
      buyVolume: candle.buyVolume,
      sellVolume: candle.sellVolume,
      exchange: candle.exchange,
      symbol: candle.symbol,
      timeframe: candle.timeframe,
    };

    try {
      await redis.publish(channel, JSON.stringify(payload));
    } catch (err) {
      logger.error('CandleBuilderService: Redis publish failed', {
        error: String(err),
        channel,
      });
    }

    logger.debug('CandleBuilderService: candle closed', {
      symbol: candle.symbol,
      timeframe: candle.timeframe,
      time: candle.time,
    });
  }

  /** Returns the current open (partial) candle for clients. */
  getOpenCandle(exchange: Exchange, symbol: string, timeframe: Timeframe): Candle | null {
    const key: CandleKey = `${exchange}:${symbol}:${timeframe}`;
    const candle = this.candles.get(key);
    if (!candle) return null;

    return {
      time: candle.time,
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
      volume: candle.volume,
      buyVolume: candle.buyVolume,
      sellVolume: candle.sellVolume,
      exchange: candle.exchange,
      symbol: candle.symbol,
      timeframe: candle.timeframe,
    };
  }

  /** Poll a Redis Stream for new trades using XREAD. */
  private async pollStream(exchange: Exchange, symbol: string): Promise<void> {
    const streamKey = `trades:${exchange}:${symbol}`;
    const tag = `${exchange}:${symbol}`;

    if (!this.lastStreamIds.has(tag)) {
      this.lastStreamIds.set(tag, '$');
    }

    while (this.running) {
      try {
        const results = await redis.xread(
          'COUNT', '500',
          'BLOCK', '2000',
          'STREAMS', streamKey,
          this.lastStreamIds.get(tag)!,
        );

        if (!results) continue;

        for (const [, entries] of results) {
          for (const [id, fields] of entries) {
            this.lastStreamIds.set(tag, id);

            // Parse fields array [key, val, key, val, ...]
            const data: Record<string, string> = {};
            for (let i = 0; i < fields.length; i += 2) {
              data[fields[i]] = fields[i + 1];
            }

            const trade: Trade = {
              time: Number(data.time),
              price: Number(data.price),
              size: Number(data.size),
              side: data.side as Trade['side'],
              tradeId: data.tradeId,
              exchange: data.exchange as Exchange,
              symbol: data.symbol,
            };

            this.processTrade(trade);
          }
        }
      } catch (err) {
        if (!this.running) break;
        logger.error('CandleBuilderService: stream read error', {
          error: String(err),
          stream: streamKey,
        });
        // Back off briefly on error
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }

  start(symbols: string[]): void {
    if (this.running) return;
    this.running = true;

    // Start polling each symbol's trade stream.
    // Config doesn't tell us exchange per symbol, so we iterate known exchanges.
    const exchanges: Exchange[] = ['blofin', 'mexc'];
    for (const exchange of exchanges) {
      for (const symbol of symbols) {
        this.pollStream(exchange, symbol).catch((err) => {
          logger.error('CandleBuilderService: poll loop crashed', {
            error: String(err),
            exchange,
            symbol,
          });
        });
      }
    }

    logger.info('CandleBuilderService: started', { symbols });
  }

  async stop(): Promise<void> {
    this.running = false;

    // Flush any open candles that have data
    for (const [, candle] of this.candles) {
      if (candle.dirty) {
        await this.closeCandle(candle);
      }
    }
    this.candles.clear();
    this.lastStreamIds.clear();

    logger.info('CandleBuilderService: stopped');
  }
}
