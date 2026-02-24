import { logger } from '../utils/logger';
import { redis } from '../utils/redis';
import { pool } from '../db';
import { config } from '../config';
import type { PatternEvent, Exchange, DeltaChange } from '@pinned/shared-types';

// ─── Iceberg Config ──────────────────────────────────────────────────────────
const ICEBERG_MIN_REFILL_COUNT = 3;
const ICEBERG_MAX_DURATION_MS = 60_000;
const ICEBERG_MIN_SIZE_RATIO = 0.5;

// ─── Spoof Config ────────────────────────────────────────────────────────────
const SPOOF_BOOK_DEPTH_RATIO = 0.02; // 2% of total visible book depth
const SPOOF_DISAPPEAR_WINDOW_MS = 3_000;

// ─── Absorption Config ──────────────────────────────────────────────────────
const ABSORPTION_RATIO_THRESHOLD = 3;

// ─── State Machines ──────────────────────────────────────────────────────────

type IcebergPhase = 'IDLE' | 'DEPLETED' | 'REFILLED';

interface IcebergState {
  phase: IcebergPhase;
  price: number;
  refillCount: number;
  firstSeen: number;
  lastSize: number;
  direction: 'bid' | 'ask';
}

interface SpoofCandidate {
  price: number;
  size: number;
  appearedAt: number;
  direction: 'bid' | 'ask';
}

interface AbsorptionTracker {
  tradeVolumeAtLevel: number;
  sizeDecrease: number;
  lastTime: number;
}

export class PatternDetectionService {
  private running = false;
  private lastStreamIds = new Map<string, string>();

  // Per-symbol state
  private icebergStates = new Map<string, Map<number, IcebergState>>(); // tag -> price -> state
  private spoofCandidates = new Map<string, Map<number, SpoofCandidate>>(); // tag -> price -> candidate
  private absorptionTrackers = new Map<string, Map<number, AbsorptionTracker>>(); // tag -> price -> tracker
  private totalBookDepth = new Map<string, number>(); // tag -> total depth

  /** Process a delta event from the orderbook delta stream. */
  private async processDelta(
    exchange: Exchange,
    symbol: string,
    delta: DeltaChange,
  ): Promise<void> {
    const tag = `${exchange}:${symbol}`;
    const direction: 'bid' | 'ask' = delta.sizeDelta < 0 ? 'ask' : 'bid';

    // === Iceberg Detection ===
    await this.updateIceberg(exchange, symbol, tag, delta, direction);

    // === Spoof Detection ===
    await this.updateSpoof(exchange, symbol, tag, delta, direction);

    // === Absorption Detection ===
    await this.updateAbsorption(exchange, symbol, tag, delta, direction);
  }

  // ─── Iceberg ───────────────────────────────────────────────────────────────

  private async updateIceberg(
    exchange: Exchange,
    symbol: string,
    tag: string,
    delta: DeltaChange,
    direction: 'bid' | 'ask',
  ): Promise<void> {
    if (!this.icebergStates.has(tag)) {
      this.icebergStates.set(tag, new Map());
    }
    const states = this.icebergStates.get(tag)!;
    let state = states.get(delta.price);

    const now = delta.time;

    if (!state) {
      state = {
        phase: 'IDLE',
        price: delta.price,
        refillCount: 0,
        firstSeen: now,
        lastSize: Math.abs(delta.sizeDelta),
        direction,
      };
      states.set(delta.price, state);
    }

    // Expire stale state
    if (now - state.firstSeen > ICEBERG_MAX_DURATION_MS) {
      state.phase = 'IDLE';
      state.refillCount = 0;
      state.firstSeen = now;
    }

    const absSizeDelta = Math.abs(delta.sizeDelta);

    switch (state.phase) {
      case 'IDLE':
        // Level was depleted (significant size removed)
        if (delta.type === 'fill' || (delta.sizeDelta < 0 && absSizeDelta > 0)) {
          state.phase = 'DEPLETED';
          state.firstSeen = now;
        }
        break;

      case 'DEPLETED':
        // Level was refilled (size added back)
        if (delta.sizeDelta > 0 && absSizeDelta >= state.lastSize * ICEBERG_MIN_SIZE_RATIO) {
          state.phase = 'REFILLED';
          state.refillCount++;
          state.lastSize = absSizeDelta;

          if (state.refillCount >= ICEBERG_MIN_REFILL_COUNT) {
            // Emit iceberg pattern
            const event: PatternEvent = {
              type: 'iceberg',
              time: now,
              price: delta.price,
              exchange,
              symbol,
              confidence: Math.min(state.refillCount / 5, 1.0),
              estimatedSize: state.lastSize * state.refillCount,
              direction,
              duration: now - state.firstSeen,
            };
            await this.emitPattern(event);

            // Reset after emission
            state.phase = 'IDLE';
            state.refillCount = 0;
          }
        }
        break;

      case 'REFILLED':
        // Wait for next depletion
        if (delta.sizeDelta < 0 && absSizeDelta > 0) {
          state.phase = 'DEPLETED';
        }
        break;
    }
  }

  // ─── Spoof ─────────────────────────────────────────────────────────────────

  private async updateSpoof(
    exchange: Exchange,
    symbol: string,
    tag: string,
    delta: DeltaChange,
    direction: 'bid' | 'ask',
  ): Promise<void> {
    if (!this.spoofCandidates.has(tag)) {
      this.spoofCandidates.set(tag, new Map());
    }
    const candidates = this.spoofCandidates.get(tag)!;
    const now = delta.time;
    const bookDepth = this.totalBookDepth.get(tag) ?? 0;

    // Expire old candidates
    for (const [price, c] of candidates) {
      if (now - c.appearedAt > SPOOF_DISAPPEAR_WINDOW_MS) {
        candidates.delete(price);
      }
    }

    if (delta.sizeDelta > 0 && bookDepth > 0) {
      // Large order appeared
      const ratio = delta.sizeDelta / bookDepth;
      if (ratio >= SPOOF_BOOK_DEPTH_RATIO) {
        candidates.set(delta.price, {
          price: delta.price,
          size: delta.sizeDelta,
          appearedAt: now,
          direction,
        });
      }
    } else if (delta.sizeDelta < 0) {
      // Something was removed — check if it was a spoof candidate
      const candidate = candidates.get(delta.price);
      if (candidate && now - candidate.appearedAt <= SPOOF_DISAPPEAR_WINDOW_MS) {
        // Check if there was a corresponding fill (trade at this level)
        const wasTrade = delta.type === 'fill';

        if (!wasTrade) {
          // Large order disappeared without trade => spoof
          const event: PatternEvent = {
            type: 'spoof',
            time: now,
            price: delta.price,
            exchange,
            symbol,
            confidence: 0.7,
            estimatedSize: candidate.size,
            direction: candidate.direction,
            duration: now - candidate.appearedAt,
          };
          await this.emitPattern(event);
        }

        candidates.delete(delta.price);
      }
    }
  }

  /** Update total book depth from orderbook snapshot (called when snapshot arrives). */
  updateBookDepth(exchange: Exchange, symbol: string, totalDepth: number): void {
    const tag = `${exchange}:${symbol}`;
    this.totalBookDepth.set(tag, totalDepth);
  }

  // ─── Absorption ────────────────────────────────────────────────────────────

  private async updateAbsorption(
    exchange: Exchange,
    symbol: string,
    tag: string,
    delta: DeltaChange,
    direction: 'bid' | 'ask',
  ): Promise<void> {
    if (!this.absorptionTrackers.has(tag)) {
      this.absorptionTrackers.set(tag, new Map());
    }
    const trackers = this.absorptionTrackers.get(tag)!;
    let tracker = trackers.get(delta.price);
    const now = delta.time;

    if (!tracker) {
      tracker = { tradeVolumeAtLevel: 0, sizeDecrease: 0, lastTime: now };
      trackers.set(delta.price, tracker);
    }

    // Expire old entries (reset after 10 seconds of inactivity)
    if (now - tracker.lastTime > 10_000) {
      tracker.tradeVolumeAtLevel = 0;
      tracker.sizeDecrease = 0;
    }
    tracker.lastTime = now;

    if (delta.type === 'fill') {
      tracker.tradeVolumeAtLevel += Math.abs(delta.sizeDelta);
    }

    if (delta.sizeDelta < 0) {
      tracker.sizeDecrease += Math.abs(delta.sizeDelta);
    }

    // Check absorption ratio
    if (tracker.sizeDecrease > 0 && tracker.tradeVolumeAtLevel > 0) {
      const ratio = tracker.tradeVolumeAtLevel / tracker.sizeDecrease;

      if (ratio >= ABSORPTION_RATIO_THRESHOLD) {
        // Gauge 0-100 based on ratio (3 = 50, 6+ = 100)
        const gauge = Math.min(Math.round(((ratio - 1) / 5) * 100), 100);

        const event: PatternEvent = {
          type: 'absorption',
          time: now,
          price: delta.price,
          exchange,
          symbol,
          confidence: Math.min(ratio / 6, 1.0),
          estimatedSize: tracker.tradeVolumeAtLevel,
          direction,
        };
        await this.emitPattern(event);

        // Reset after emission
        tracker.tradeVolumeAtLevel = 0;
        tracker.sizeDecrease = 0;
      }
    }
  }

  // ─── Emit ──────────────────────────────────────────────────────────────────

  private async emitPattern(event: PatternEvent): Promise<void> {
    // Publish to Redis Pub/Sub
    try {
      const channel = `patterns:${event.exchange}:${event.symbol}`;
      await redis.publish(channel, JSON.stringify(event));
    } catch (err) {
      logger.error('PatternDetectionService: Redis publish failed', {
        error: String(err),
        type: event.type,
      });
    }

    // Store in TimescaleDB
    try {
      await pool.query(
        `INSERT INTO pattern_events (time, exchange, symbol, type, price, confidence, estimated_size, direction, duration)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          new Date(event.time).toISOString(),
          event.exchange,
          event.symbol,
          event.type,
          event.price,
          event.confidence,
          event.estimatedSize ?? null,
          event.direction,
          event.duration ?? null,
        ],
      );
    } catch (err) {
      logger.error('PatternDetectionService: DB insert failed', {
        error: String(err),
        type: event.type,
      });
    }

    logger.info('PatternDetectionService: pattern detected', {
      type: event.type,
      exchange: event.exchange,
      symbol: event.symbol,
      price: event.price,
      confidence: event.confidence,
    });
  }

  // ─── Stream Polling ────────────────────────────────────────────────────────

  private async pollDeltaStream(
    exchange: Exchange,
    symbol: string,
  ): Promise<void> {
    const streamKey = `deltas:${exchange}:${symbol}`;
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

            const delta: DeltaChange = {
              price: Number(data.price),
              sizeDelta: Number(data.sizeDelta),
              type: data.type as DeltaChange['type'],
              time: Number(data.time),
            };

            await this.processDelta(exchange, symbol, delta);
          }
        }
      } catch (err) {
        if (!this.running) break;
        logger.error('PatternDetectionService: stream read error', {
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
        this.pollDeltaStream(exchange, symbol).catch((err) => {
          logger.error('PatternDetectionService: poll loop crashed', {
            error: String(err),
            exchange,
            symbol,
          });
        });
      }
    }

    logger.info('PatternDetectionService: started', { symbols });
  }

  async stop(): Promise<void> {
    this.running = false;

    this.icebergStates.clear();
    this.spoofCandidates.clear();
    this.absorptionTrackers.clear();
    this.totalBookDepth.clear();
    this.lastStreamIds.clear();

    logger.info('PatternDetectionService: stopped');
  }
}
