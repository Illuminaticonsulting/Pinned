import { logger } from '../utils/logger';
import { redis } from '../utils/redis';
import { pool } from '../db';
import { config } from '../config';
import type { BigTrade, Exchange, Side, Trade } from '@pinned/shared-types';

/**
 * Threshold multipliers relative to BTC.
 * For example ETH volume threshold = BTC threshold × multiplier.
 */
const SYMBOL_MULTIPLIERS: Record<string, number> = {
  'BTC-USDT': 1.0,
  'ETH-USDT': 10.0,
  'SOL-USDT': 200.0,
};

function getThreshold(symbol: string): number {
  const baseThreshold = config.BIG_TRADE_THRESHOLD_BTC;
  const multiplier = SYMBOL_MULTIPLIERS[symbol] ?? 1.0;
  return baseThreshold * multiplier;
}

interface PriceLevelAccum {
  totalSize: number;
  side: Side;
  tradeCount: number;
  firstTime: number;
}

interface WindowState {
  levels: Map<number, PriceLevelAccum>;
  windowStart: number;
  timer: ReturnType<typeof setTimeout> | null;
}

export class BigTradeService {
  private running = false;
  private windows = new Map<string, WindowState>(); // tag -> WindowState
  private lastStreamIds = new Map<string, string>();
  private windowMs: number;

  constructor() {
    this.windowMs = config.BIG_TRADE_WINDOW_MS;
  }

  /** Get or create the sliding window state for a symbol. */
  private getWindow(exchange: Exchange, symbol: string): WindowState {
    const tag = `${exchange}:${symbol}`;
    let state = this.windows.get(tag);

    if (!state) {
      state = {
        levels: new Map(),
        windowStart: Date.now(),
        timer: null,
      };
      this.windows.set(tag, state);
      this.scheduleWindowClose(exchange, symbol, state);
    }

    return state;
  }

  /** Schedule the window close evaluation. */
  private scheduleWindowClose(
    exchange: Exchange,
    symbol: string,
    state: WindowState,
  ): void {
    if (state.timer) clearTimeout(state.timer);

    state.timer = setTimeout(() => {
      this.evaluateWindow(exchange, symbol).catch((err) => {
        logger.error('BigTradeService: window evaluation failed', {
          error: String(err),
          exchange,
          symbol,
        });
      });
    }, this.windowMs);
  }

  /** Process a single trade from the stream. */
  private addTrade(trade: Trade): void {
    const state = this.getWindow(trade.exchange, trade.symbol);
    const accum = state.levels.get(trade.price);

    if (accum) {
      accum.totalSize += trade.size;
      accum.tradeCount++;
    } else {
      state.levels.set(trade.price, {
        totalSize: trade.size,
        side: trade.side,
        tradeCount: 1,
        firstTime: trade.time,
      });
    }
  }

  /** Evaluate the window for big trades and reset. */
  private async evaluateWindow(
    exchange: Exchange,
    symbol: string,
  ): Promise<void> {
    const tag = `${exchange}:${symbol}`;
    const state = this.windows.get(tag);
    if (!state) return;

    const threshold = getThreshold(symbol);
    const bigTrades: BigTrade[] = [];

    for (const [price, accum] of state.levels) {
      if (accum.totalSize >= threshold) {
        const bt: BigTrade = {
          time: accum.firstTime,
          price,
          totalSize: accum.totalSize,
          side: accum.side,
          tradeCount: accum.tradeCount,
          exchange,
          symbol,
        };
        bigTrades.push(bt);
      }
    }

    // Reset the window
    state.levels.clear();
    state.windowStart = Date.now();
    this.scheduleWindowClose(exchange, symbol, state);

    // Process detected big trades
    for (const bt of bigTrades) {
      // Publish to Redis Pub/Sub
      try {
        const channel = `big_trades:${exchange}:${symbol}`;
        await redis.publish(channel, JSON.stringify(bt));
      } catch (err) {
        logger.error('BigTradeService: Redis publish failed', {
          error: String(err),
          exchange,
          symbol,
        });
      }

      // Persist to TimescaleDB
      try {
        await pool.query(
          `INSERT INTO big_trades (time, exchange, symbol, price, total_size, side, trade_count)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT DO NOTHING`,
          [
            new Date(bt.time).toISOString(),
            bt.exchange,
            bt.symbol,
            bt.price,
            bt.totalSize,
            bt.side,
            bt.tradeCount,
          ],
        );
      } catch (err) {
        logger.error('BigTradeService: DB insert failed', {
          error: String(err),
          exchange,
          symbol,
        });
      }

      logger.info('BigTradeService: big trade detected', {
        exchange,
        symbol,
        price: bt.price,
        size: bt.totalSize,
        side: bt.side,
        tradeCount: bt.tradeCount,
      });
    }
  }

  /** Poll Redis Stream for trades. */
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

            const data: Record<string, string> = {};
            for (let i = 0; i < fields.length; i += 2) {
              data[fields[i]] = fields[i + 1];
            }

            const trade: Trade = {
              time: Number(data.time),
              price: Number(data.price),
              size: Number(data.size),
              side: data.side as Side,
              tradeId: data.tradeId,
              exchange: data.exchange as Exchange,
              symbol: data.symbol,
            };

            this.addTrade(trade);
          }
        }
      } catch (err) {
        if (!this.running) break;
        logger.error('BigTradeService: stream read error', {
          error: String(err),
          stream: streamKey,
        });
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }

  start(symbols: string[]): void {
    if (this.running) return;
    this.running = true;

    const exchanges: Exchange[] = ['blofin', 'mexc'];
    for (const exchange of exchanges) {
      for (const symbol of symbols) {
        this.pollStream(exchange, symbol).catch((err) => {
          logger.error('BigTradeService: poll loop crashed', {
            error: String(err),
            exchange,
            symbol,
          });
        });
      }
    }

    logger.info('BigTradeService: started', {
      symbols,
      windowMs: this.windowMs,
      thresholdBtc: config.BIG_TRADE_THRESHOLD_BTC,
    });
  }

  async stop(): Promise<void> {
    this.running = false;

    for (const [, state] of this.windows) {
      if (state.timer) clearTimeout(state.timer);
    }
    this.windows.clear();
    this.lastStreamIds.clear();

    logger.info('BigTradeService: stopped');
  }
}
