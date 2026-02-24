import { logger } from '../utils/logger';
import { redis } from '../utils/redis';
import { config } from '../config';
import type { Exchange, OrderbookSnapshot } from '@pinned/shared-types';

const OFI_BUFFER_SIZE = 300; // 5 minutes of 1-second samples
const COMPUTE_INTERVAL_MS = 1_000;

interface OFIState {
  buffer: number[];
  prevBidPrice: number;
  prevBidSize: number;
  prevAskPrice: number;
  prevAskSize: number;
  initialized: boolean;
  timer: ReturnType<typeof setInterval> | null;
  latestSnapshot: OrderbookSnapshot | null;
}

export class OFIService {
  private running = false;
  private states = new Map<string, OFIState>(); // `${exchange}:${symbol}` -> state

  /** Feed a new snapshot (can be called directly or consumed from Redis). */
  onSnapshot(snapshot: OrderbookSnapshot): void {
    if (!this.running) return;

    const tag = `${snapshot.exchange}:${snapshot.symbol}`;
    let state = this.states.get(tag);

    if (!state) {
      state = {
        buffer: [],
        prevBidPrice: 0,
        prevBidSize: 0,
        prevAskPrice: 0,
        prevAskSize: 0,
        initialized: false,
        timer: null,
        latestSnapshot: null,
      };
      this.states.set(tag, state);
    }

    state.latestSnapshot = snapshot;
  }

  /**
   * Compute OFI value based on latest snapshot vs previous state.
   *
   * OFI = (best_bid_size_change if bid_price >= prev_bid_price else -prev_best_bid_size)
   *     - (best_ask_size_change if ask_price <= prev_ask_price else -prev_best_ask_size)
   */
  private async compute(exchange: Exchange, symbol: string): Promise<void> {
    const tag = `${exchange}:${symbol}`;
    const state = this.states.get(tag);
    if (!state) return;

    let snapshot = state.latestSnapshot;

    // If no direct snapshot, try reading from Redis
    if (!snapshot) {
      try {
        const raw = await redis.get(`ob:${exchange}:${symbol}:latest`);
        if (raw) {
          snapshot = JSON.parse(raw) as OrderbookSnapshot;
        }
      } catch (err) {
        logger.error('OFIService: failed to read snapshot from Redis', {
          error: String(err),
          tag,
        });
        return;
      }
    }

    if (!snapshot || snapshot.bids.length === 0 || snapshot.asks.length === 0) return;

    const bestBidPrice = snapshot.bids[0].price;
    const bestBidSize = snapshot.bids[0].size;
    const bestAskPrice = snapshot.asks[0].price;
    const bestAskSize = snapshot.asks[0].size;

    if (!state.initialized) {
      state.prevBidPrice = bestBidPrice;
      state.prevBidSize = bestBidSize;
      state.prevAskPrice = bestAskPrice;
      state.prevAskSize = bestAskSize;
      state.initialized = true;
      return;
    }

    // Bid component
    let bidComponent: number;
    if (bestBidPrice >= state.prevBidPrice) {
      bidComponent = bestBidSize - state.prevBidSize;
    } else {
      bidComponent = -state.prevBidSize;
    }

    // Ask component
    let askComponent: number;
    if (bestAskPrice <= state.prevAskPrice) {
      askComponent = bestAskSize - state.prevAskSize;
    } else {
      askComponent = -state.prevAskSize;
    }

    const ofi = bidComponent - askComponent;

    // Update previous values
    state.prevBidPrice = bestBidPrice;
    state.prevBidSize = bestBidSize;
    state.prevAskPrice = bestAskPrice;
    state.prevAskSize = bestAskSize;

    // Store in rolling buffer
    state.buffer.push(ofi);
    if (state.buffer.length > OFI_BUFFER_SIZE) {
      state.buffer.shift();
    }

    // Publish to Redis Pub/Sub
    try {
      await redis.publish(`ofi:${exchange}:${symbol}`, JSON.stringify({
        time: Date.now(),
        value: ofi,
        cumulative: state.buffer.reduce((a, b) => a + b, 0),
      }));
    } catch (err) {
      logger.error('OFIService: publish failed', {
        error: String(err),
        tag,
      });
    }
  }

  /** Returns the last 300 OFI values (5-minute rolling buffer). */
  getOFIBuffer(exchange: Exchange, symbol: string): number[] {
    const tag = `${exchange}:${symbol}`;
    const state = this.states.get(tag);
    return state ? [...state.buffer] : [];
  }

  start(symbols: string[]): void {
    if (this.running) return;
    this.running = true;

    const exchanges: Exchange[] = ['blofin', 'mexc'];
    for (const exchange of exchanges) {
      for (const symbol of symbols) {
        const tag = `${exchange}:${symbol}`;

        // Initialize state if not existing
        if (!this.states.has(tag)) {
          this.states.set(tag, {
            buffer: [],
            prevBidPrice: 0,
            prevBidSize: 0,
            prevAskPrice: 0,
            prevAskSize: 0,
            initialized: false,
            timer: null,
            latestSnapshot: null,
          });
        }

        const state = this.states.get(tag)!;
        state.timer = setInterval(() => {
          this.compute(exchange, symbol).catch((err) => {
            logger.error('OFIService: compute error', {
              error: String(err),
              tag,
            });
          });
        }, COMPUTE_INTERVAL_MS);
      }
    }

    logger.info('OFIService: started', { symbols });
  }

  async stop(): Promise<void> {
    this.running = false;

    for (const [, state] of this.states) {
      if (state.timer) {
        clearInterval(state.timer);
        state.timer = null;
      }
    }
    this.states.clear();

    logger.info('OFIService: stopped');
  }
}
