import { logger } from '../utils/logger';
import { redis } from '../utils/redis';
import { pool } from '../db';
import { config } from '../config';
import type { OrderbookSnapshot, OrderbookLevel, DeltaChange, Exchange, Trade } from '@pinned/shared-types';

const BUFFER_MAX_LEN = 28_800; // ~2 hours at 4 snapshots/sec
const DELTA_STREAM_MAXLEN = 50_000;
const DB_PERSIST_INTERVAL_MS = 60_000;

export class OrderbookService {
  private running = false;
  private prevSnapshots = new Map<string, OrderbookSnapshot>();
  private persistTimers = new Map<string, ReturnType<typeof setInterval>>();
  private lastPersisted = new Map<string, number>();

  // Metrics
  private snapshotCount = 0;
  private deltaCount = 0;
  private metricsTimer: ReturnType<typeof setInterval> | null = null;
  private snapshotWindow: number[] = [];
  private deltaWindow: number[] = [];

  /** Called by exchange adapters on each orderbook snapshot (typically 4x/sec). */
  async onSnapshot(snapshot: OrderbookSnapshot): Promise<void> {
    if (!this.running) return;

    const tag = `${snapshot.exchange}:${snapshot.symbol}`;
    const now = Date.now();

    this.snapshotCount++;
    this.snapshotWindow.push(now);

    // a. Store current snapshot in Redis
    const latestKey = `ob:${tag}:latest`;
    const bufferKey = `ob:${tag}:buffer`;

    const serialized = JSON.stringify(snapshot);

    try {
      const pipeline = redis.pipeline();
      pipeline.set(latestKey, serialized);
      pipeline.lpush(bufferKey, serialized);
      pipeline.ltrim(bufferKey, 0, BUFFER_MAX_LEN - 1);
      await pipeline.exec();
    } catch (err) {
      logger.error('OrderbookService: Redis write failed', {
        error: String(err),
        tag,
      });
    }

    // c. Calculate deltas
    const prev = this.prevSnapshots.get(tag);
    if (prev) {
      const deltas = this.computeDeltas(snapshot, prev);

      if (deltas.length > 0) {
        this.deltaCount += deltas.length;
        this.deltaWindow.push(...Array(deltas.length).fill(now));

        // e. Publish deltas to Redis Stream
        await this.publishDeltas(snapshot.exchange, snapshot.symbol, deltas);
      }
    }

    // Store current as previous for next delta
    this.prevSnapshots.set(tag, snapshot);

    // f. Persist to DB every 60 seconds
    const lastPersist = this.lastPersisted.get(tag) ?? 0;
    if (now - lastPersist >= DB_PERSIST_INTERVAL_MS) {
      this.lastPersisted.set(tag, now);
      this.persistSnapshot(snapshot).catch((err) => {
        logger.error('OrderbookService: DB persist failed', {
          error: String(err),
          tag,
        });
      });
    }
  }

  /** Compute level-by-level deltas between two snapshots. */
  private computeDeltas(
    current: OrderbookSnapshot,
    prev: OrderbookSnapshot,
  ): DeltaChange[] {
    const deltas: DeltaChange[] = [];
    const now = current.time;

    // Build maps for efficient lookup
    const buildMap = (levels: OrderbookLevel[]): Map<number, number> => {
      const m = new Map<number, number>();
      for (const lvl of levels) {
        m.set(lvl.price, lvl.size);
      }
      return m;
    };

    const processSide = (
      currentLevels: OrderbookLevel[],
      prevLevels: OrderbookLevel[],
    ): void => {
      const curMap = buildMap(currentLevels);
      const prevMap = buildMap(prevLevels);

      // Check all previous levels
      for (const [price, prevSize] of prevMap) {
        const curSize = curMap.get(price) ?? 0;
        const sizeDelta = curSize - prevSize;

        if (Math.abs(sizeDelta) < 1e-12) continue;

        // Determine type heuristically:
        // - Negative delta without a trade => cancellation
        // - Negative delta with a trade => fill
        // - Positive delta => addition
        let type: DeltaChange['type'];
        if (sizeDelta > 0) {
          type = 'addition';
        } else {
          // We'll mark as cancellation here; cross-referencing with trades is
          // done downstream by callers who inspect the redis trades stream
          type = 'cancellation';
        }

        deltas.push({ price, sizeDelta, type, time: now });
      }

      // New price levels not in prev
      for (const [price, curSize] of curMap) {
        if (!prevMap.has(price)) {
          deltas.push({ price, sizeDelta: curSize, type: 'addition', time: now });
        }
      }
    };

    processSide(current.bids, prev.bids);
    processSide(current.asks, prev.asks);

    return deltas;
  }

  /** Cross-reference a delta with recent trades to determine fill vs cancellation. */
  private async classifyDelta(
    delta: DeltaChange,
    exchange: Exchange,
    symbol: string,
  ): Promise<DeltaChange> {
    if (delta.sizeDelta >= 0) return delta;

    try {
      const streamKey = `trades:${exchange}:${symbol}`;
      // Read last 100 trades (within ~3 seconds)
      const entries = await redis.xrevrange(streamKey, '+', '-', 'COUNT', '100');

      const recentCutoff = delta.time - 3000;
      for (const [, fields] of entries) {
        const data: Record<string, string> = {};
        for (let i = 0; i < fields.length; i += 2) {
          data[fields[i]] = fields[i + 1];
        }
        const tradeTime = Number(data.time);
        if (tradeTime < recentCutoff) break;

        const tradePrice = Number(data.price);
        if (Math.abs(tradePrice - delta.price) < 1e-8) {
          delta.type = 'fill';
          return delta;
        }
      }
    } catch (err) {
      // Fallback to cancellation if we can't check trades
      logger.debug('OrderbookService: trade cross-ref failed', { error: String(err) });
    }

    return delta;
  }

  /** Publish deltas to Redis Stream. */
  private async publishDeltas(
    exchange: Exchange,
    symbol: string,
    deltas: DeltaChange[],
  ): Promise<void> {
    const streamKey = `deltas:${exchange}:${symbol}`;

    try {
      const pipeline = redis.pipeline();

      for (const d of deltas) {
        // Attempt fill classification for negative deltas
        const classified = d.sizeDelta < 0
          ? await this.classifyDelta(d, exchange, symbol)
          : d;

        pipeline.xadd(
          streamKey,
          'MAXLEN',
          '~',
          String(DELTA_STREAM_MAXLEN),
          '*',
          'price', String(classified.price),
          'sizeDelta', String(classified.sizeDelta),
          'type', classified.type,
          'time', String(classified.time),
        );
      }

      await pipeline.exec();
    } catch (err) {
      logger.error('OrderbookService: delta publish failed', {
        error: String(err),
        exchange,
        symbol,
      });
    }
  }

  /** Persist a snapshot to TimescaleDB (throttled to once per 60s). */
  private async persistSnapshot(snapshot: OrderbookSnapshot): Promise<void> {
    try {
      const topBids = snapshot.bids.slice(0, 25);
      const topAsks = snapshot.asks.slice(0, 25);

      await pool.query(
        `INSERT INTO orderbook_snapshots (time, exchange, symbol, bids, asks)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          new Date(snapshot.time).toISOString(),
          snapshot.exchange,
          snapshot.symbol,
          JSON.stringify(topBids),
          JSON.stringify(topAsks),
        ],
      );

      logger.debug('OrderbookService: snapshot persisted to DB', {
        exchange: snapshot.exchange,
        symbol: snapshot.symbol,
      });
    } catch (err) {
      logger.error('OrderbookService: snapshot persist failed', {
        error: String(err),
      });
    }
  }

  getSnapshotsPerSecond(): number {
    const cutoff = Date.now() - 10_000;
    this.snapshotWindow = this.snapshotWindow.filter((ts) => ts >= cutoff);
    return this.snapshotWindow.length / 10;
  }

  getDeltasPerSecond(): number {
    const cutoff = Date.now() - 10_000;
    this.deltaWindow = this.deltaWindow.filter((ts) => ts >= cutoff);
    return this.deltaWindow.length / 10;
  }

  getMetrics(): {
    snapshotsPerSecond: number;
    deltasPerSecond: number;
    totalSnapshots: number;
    totalDeltas: number;
    trackedSymbols: number;
  } {
    return {
      snapshotsPerSecond: this.getSnapshotsPerSecond(),
      deltasPerSecond: this.getDeltasPerSecond(),
      totalSnapshots: this.snapshotCount,
      totalDeltas: this.deltaCount,
      trackedSymbols: this.prevSnapshots.size,
    };
  }

  start(): void {
    if (this.running) return;
    this.running = true;

    this.metricsTimer = setInterval(() => {
      const metrics = this.getMetrics();
      logger.info('OrderbookService: metrics', metrics);
    }, 30_000);

    logger.info('OrderbookService: started');
  }

  async stop(): Promise<void> {
    this.running = false;

    if (this.metricsTimer) {
      clearInterval(this.metricsTimer);
      this.metricsTimer = null;
    }

    for (const [, timer] of this.persistTimers) {
      clearInterval(timer);
    }
    this.persistTimers.clear();
    this.prevSnapshots.clear();

    logger.info('OrderbookService: stopped');
  }
}
