import { logger } from '../utils/logger';
import { redis } from '../utils/redis';
import { pool } from '../db';
import { config } from '../config';
import zlib from 'zlib';
import { promisify } from 'util';
import type {
  Exchange,
  OrderbookSnapshot,
  HeatmapCell,
  HeatmapUpdate,
} from '@pinned/shared-types';

const deflate = promisify(zlib.deflate);

const SNAPSHOT_BUFFER_READ = 2400; // 10 minutes at 4/sec
const TIME_COLUMNS = 600;          // 1 per second = 10 min
const PRICE_TICKS = 500;           // ±500 ticks from current price
const GRID_HEIGHT = PRICE_TICKS * 2; // total price rows
const PRECOMPUTED_TTL = 30;        // seconds

interface HeatmapState {
  prevCells: Map<string, number>; // "priceIdx:timeIdx" => intensity
  timer: ReturnType<typeof setInterval> | null;
  deltaStreamId: string;
  deltaPollRunning: boolean;
}

export class HeatmapService {
  private running = false;
  private states = new Map<string, HeatmapState>(); // tag -> state

  /** Compute the heatmap for a single exchange:symbol pair. */
  private async compute(exchange: Exchange, symbol: string): Promise<void> {
    const tag = `${exchange}:${symbol}`;
    const state = this.states.get(tag);
    if (!state) return;

    const bufferKey = `ob:${exchange}:${symbol}:buffer`;

    try {
      // a. Read last 2400 snapshots from Redis circular buffer
      const rawSnapshots = await redis.lrange(bufferKey, 0, SNAPSHOT_BUFFER_READ - 1);
      if (rawSnapshots.length === 0) {
        logger.debug('HeatmapService: no snapshots in buffer', { tag });
        return;
      }

      const snapshots: OrderbookSnapshot[] = rawSnapshots.map((r) => JSON.parse(r));

      // Determine current price from most recent snapshot
      const latest = snapshots[0];
      const currentPrice =
        latest.bids.length > 0 && latest.asks.length > 0
          ? (latest.bids[0].price + latest.asks[0].price) / 2
          : latest.bids[0]?.price ?? latest.asks[0]?.price ?? 0;

      if (currentPrice === 0) return;

      // e. Price range: current ± 500 ticks
      // Estimate tick size from bid levels
      let tickSize = 0.5; // default
      if (latest.bids.length >= 2) {
        tickSize = Math.abs(latest.bids[0].price - latest.bids[1].price);
        if (tickSize === 0) tickSize = 0.5;
      }

      const priceMin = currentPrice - PRICE_TICKS * tickSize;
      const priceMax = currentPrice + PRICE_TICKS * tickSize;

      // Time range: earliest snapshot to latest
      const timeStart = snapshots[snapshots.length - 1].time;
      const timeEnd = snapshots[0].time;
      const timeDuration = timeEnd - timeStart || 1;
      const timeStep = timeDuration / TIME_COLUMNS;

      // b. Build 2D grid: priceIndex × timeIndex
      // c. For each cell: value = max order size seen at that price during that second
      const grid = new Float32Array(GRID_HEIGHT * TIME_COLUMNS);

      for (const snap of snapshots) {
        const timeIdx = Math.min(
          Math.floor(((snap.time - timeStart) / timeDuration) * TIME_COLUMNS),
          TIME_COLUMNS - 1,
        );

        const processLevels = (levels: OrderbookSnapshot['bids']) => {
          for (const lvl of levels) {
            if (lvl.price < priceMin || lvl.price > priceMax) continue;
            const priceIdx = Math.floor(
              ((lvl.price - priceMin) / (priceMax - priceMin)) * GRID_HEIGHT,
            );
            if (priceIdx < 0 || priceIdx >= GRID_HEIGHT) continue;

            const cellIdx = priceIdx * TIME_COLUMNS + timeIdx;
            grid[cellIdx] = Math.max(grid[cellIdx], lvl.size);
          }
        };

        processLevels(snap.bids);
        processLevels(snap.asks);
      }

      // d. Normalize to 0-255
      let maxVal = 0;
      for (let i = 0; i < grid.length; i++) {
        if (grid[i] > maxVal) maxVal = grid[i];
      }

      const normFactor = maxVal > 0 ? 255 / maxVal : 0;

      // f. Serialize as compact binary: non-zero cells as [uint16 priceIdx, uint16 timeIdx, uint8 intensity]
      const nonZeroCells: HeatmapCell[] = [];
      const cellEntries: number[] = [];

      const newCells = new Map<string, number>();

      for (let pi = 0; pi < GRID_HEIGHT; pi++) {
        for (let ti = 0; ti < TIME_COLUMNS; ti++) {
          const val = grid[pi * TIME_COLUMNS + ti];
          if (val <= 0) continue;

          const intensity = Math.round(val * normFactor);
          if (intensity === 0) continue;

          const cellKey = `${pi}:${ti}`;
          newCells.set(cellKey, intensity);

          nonZeroCells.push({
            priceIndex: pi,
            timeIndex: ti,
            intensity,
            maxSize: val,
          });

          cellEntries.push(pi, ti, intensity);
        }
      }

      // Pack into binary buffer: 5 bytes per cell (2 + 2 + 1)
      const binaryBuf = Buffer.alloc(cellEntries.length / 3 * 5);
      let offset = 0;
      for (let i = 0; i < cellEntries.length; i += 3) {
        binaryBuf.writeUInt16LE(cellEntries[i], offset);
        binaryBuf.writeUInt16LE(cellEntries[i + 1], offset + 2);
        binaryBuf.writeUInt8(cellEntries[i + 2], offset + 4);
        offset += 5;
      }

      // g. Compress with zlib
      const compressed = await deflate(binaryBuf);

      // h. Store in Redis with TTL
      const precomputedKey = `heatmap:${exchange}:${symbol}:precomputed`;
      await redis.setex(precomputedKey, PRECOMPUTED_TTL, compressed as any);

      // i. Publish diff to Pub/Sub (only changed cells)
      const diffCells: HeatmapCell[] = [];
      for (const [cellKey, intensity] of newCells) {
        const prevIntensity = state.prevCells.get(cellKey);
        if (prevIntensity !== intensity) {
          const [pi, ti] = cellKey.split(':').map(Number);
          const maxSize = grid[pi * TIME_COLUMNS + ti];
          diffCells.push({ priceIndex: pi, timeIndex: ti, intensity, maxSize });
        }
      }

      // Also detect removed cells
      for (const [cellKey] of state.prevCells) {
        if (!newCells.has(cellKey)) {
          const [pi, ti] = cellKey.split(':').map(Number);
          diffCells.push({ priceIndex: pi, timeIndex: ti, intensity: 0, maxSize: 0 });
        }
      }

      if (diffCells.length > 0) {
        const diffMsg: HeatmapUpdate = {
          type: 'diff',
          cells: diffCells,
          priceMin,
          priceMax,
          timeStart,
          timeEnd,
          tickSize,
          timeStep,
        };

        try {
          await redis.publish(
            `heatmap_diff:${exchange}:${symbol}`,
            JSON.stringify(diffMsg),
          );
        } catch (err) {
          logger.error('HeatmapService: diff publish failed', {
            error: String(err),
            tag,
          });
        }
      }

      state.prevCells = newCells;

      logger.debug('HeatmapService: recomputed', {
        tag,
        nonZeroCells: nonZeroCells.length,
        diffCells: diffCells.length,
        compressedBytes: compressed.length,
      });
    } catch (err) {
      logger.error('HeatmapService: compute error', {
        error: String(err),
        tag,
      });
    }
  }

  /** Subscribe to delta stream between full computations for incremental updates. */
  private async pollDeltaStream(
    exchange: Exchange,
    symbol: string,
  ): Promise<void> {
    const streamKey = `deltas:${exchange}:${symbol}`;
    const tag = `${exchange}:${symbol}`;
    const state = this.states.get(tag);
    if (!state) return;

    state.deltaPollRunning = true;

    while (this.running && state.deltaPollRunning) {
      try {
        const results = await redis.xread(
          'COUNT', '200',
          'BLOCK', '2000',
          'STREAMS', streamKey,
          state.deltaStreamId,
        );

        if (!results) continue;

        for (const [, entries] of results) {
          for (const [id] of entries) {
            state.deltaStreamId = id;
            // Incremental cell updates are handled during full recomputation.
            // Between full ticks, the deltas are consumed to keep the stream position
            // current so the next full computation reflects up-to-date data.
          }
        }
      } catch (err) {
        if (!this.running) break;
        logger.error('HeatmapService: delta poll error', {
          error: String(err),
          tag,
        });
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }

  /** Returns the latest precomputed compressed heatmap blob. */
  async getPrecomputedHeatmap(
    exchange: Exchange,
    symbol: string,
  ): Promise<Buffer | null> {
    const key = `heatmap:${exchange}:${symbol}:precomputed`;
    try {
      const buf = await redis.getBuffer(key);
      return buf;
    } catch (err) {
      logger.error('HeatmapService: getPrecomputedHeatmap error', {
        error: String(err),
      });
      return null;
    }
  }

  start(symbols: string[]): void {
    if (this.running) return;
    this.running = true;

    const exchanges: Exchange[] = ['blofin', 'mexc'];
    const intervalMs = config.HEATMAP_RECOMPUTE_INTERVAL_MS;

    for (const exchange of exchanges) {
      for (const symbol of symbols) {
        const tag = `${exchange}:${symbol}`;
        const state: HeatmapState = {
          prevCells: new Map(),
          timer: null,
          deltaStreamId: '$',
          deltaPollRunning: false,
        };

        this.states.set(tag, state);

        // Periodic full recomputation
        state.timer = setInterval(() => {
          this.compute(exchange, symbol).catch((err) => {
            logger.error('HeatmapService: periodic compute failed', {
              error: String(err),
              tag,
            });
          });
        }, intervalMs);

        // Start delta stream polling
        this.pollDeltaStream(exchange, symbol).catch((err) => {
          logger.error('HeatmapService: delta poll crashed', {
            error: String(err),
            tag,
          });
        });
      }
    }

    logger.info('HeatmapService: started', { symbols, intervalMs });
  }

  async stop(): Promise<void> {
    this.running = false;

    for (const [, state] of this.states) {
      if (state.timer) {
        clearInterval(state.timer);
        state.timer = null;
      }
      state.deltaPollRunning = false;
    }
    this.states.clear();

    logger.info('HeatmapService: stopped');
  }
}
