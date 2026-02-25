/**
 * ChartState.ts
 * Central state manager for the Pinned chart engine.
 * Implements a type-safe publish/subscribe pattern with batched updates.
 */

// ─── Core Data Types ───────────────────────────────────────────────────────────

/** OHLCV candle data */
export interface Candle {
  readonly timestamp: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
  readonly buyVolume?: number;
  readonly sellVolume?: number;
  readonly tradeCount?: number;
}

/** A single price level within a footprint candle */
export interface FootprintLevel {
  readonly price: number;
  readonly bidVolume: number;
  readonly askVolume: number;
  readonly delta: number;
  readonly tradeCount: number;
}

/** Footprint (order flow) data for a single candle */
export interface FootprintCandle {
  readonly timestamp: number;
  readonly levels: FootprintLevel[];
  readonly totalBidVolume: number;
  readonly totalAskVolume: number;
  readonly totalDelta: number;
  readonly poc: number; // Point of control price
}

/** A single row in a volume profile */
export interface VolumeProfileRow {
  readonly price: number;
  readonly totalVolume: number;
  readonly buyVolume: number;
  readonly sellVolume: number;
}

/** Session or visible-range volume profile */
export interface VolumeProfile {
  readonly rows: VolumeProfileRow[];
  readonly poc: number;
  readonly valueAreaHigh: number;
  readonly valueAreaLow: number;
  readonly totalVolume: number;
}

/** A 2D point on the chart (time + price) */
export interface ChartPoint {
  readonly time: number;
  readonly price: number;
}

/** Arbitrary key-value properties for drawings */
export interface DrawingProperties {
  color?: string;
  lineWidth?: number;
  lineStyle?: 'solid' | 'dashed' | 'dotted';
  fillColor?: string;
  fillOpacity?: number;
  fontSize?: number;
  text?: string;
  levels?: number[]; // Fibonacci levels
  extendLeft?: boolean;
  extendRight?: boolean;
  showLabels?: boolean;
  [key: string]: unknown;
}

/** Supported drawing tool types */
export type DrawingType =
  | 'trendline'
  | 'horizontal_line'
  | 'vertical_line'
  | 'ray'
  | 'extended_line'
  | 'parallel_channel'
  | 'fibonacci_retracement'
  | 'fibonacci_extension'
  | 'rectangle'
  | 'ellipse'
  | 'text'
  | 'price_range'
  | 'date_range'
  | 'measure'
  | 'anchored_vwap';

/** A user-created drawing on the chart */
export interface Drawing {
  readonly id: string;
  readonly type: DrawingType;
  readonly points: ChartPoint[];
  readonly properties: DrawingProperties;
  readonly selected: boolean;
  readonly locked: boolean;
  readonly visible: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
}

// ─── Chart Types ───────────────────────────────────────────────────────────────

export type ChartType = 'candles' | 'hollow' | 'bars' | 'line' | 'area' | 'heikinashi' | 'baseline';

// ─── Chart State Shape ─────────────────────────────────────────────────────────

export interface ChartStateData {
  symbol: string;
  exchange: string;
  timeframe: string;
  chartType: ChartType;
  candles: Candle[];
  visibleRange: { startTime: number; endTime: number };
  priceRange: { low: number; high: number };
  cursor: { x: number; y: number; visible: boolean };
  crosshairEnabled: boolean;
  autoScale: boolean;
  atLiveEdge: boolean;
  selectedDrawingTool: string | null;
  activeDrawings: Drawing[];
  indicators: Map<string, boolean>;
  footprintData: Map<number, FootprintCandle>;
  volumeProfile: VolumeProfile | null;
  liveCandle: Candle | null;
}

// ─── Subscriber Types ──────────────────────────────────────────────────────────

type StateKey = keyof ChartStateData;

type SubscriptionCallback<K extends StateKey> = (
  value: ChartStateData[K],
  previousValue: ChartStateData[K],
) => void;

interface Subscription {
  readonly id: number;
  readonly key: StateKey;
  readonly callback: SubscriptionCallback<any>;
}

// ─── Default State ─────────────────────────────────────────────────────────────

function createDefaultState(): ChartStateData {
  return {
    symbol: 'BTC/USDT',
    exchange: 'binance',
    timeframe: '1m',
    chartType: 'candles',
    candles: [],
    visibleRange: { startTime: 0, endTime: 0 },
    priceRange: { low: 0, high: 0 },
    cursor: { x: 0, y: 0, visible: false },
    crosshairEnabled: true,
    autoScale: true,
    atLiveEdge: true,
    selectedDrawingTool: null,
    activeDrawings: [],
    indicators: new Map<string, boolean>(),
    footprintData: new Map<number, FootprintCandle>(),
    volumeProfile: null,
    liveCandle: null,
  };
}

// ─── ChartState Class ──────────────────────────────────────────────────────────

/**
 * Central state manager for the chart engine.
 *
 * Provides a type-safe publish/subscribe mechanism that notifies listeners
 * when specific state keys change. Supports batched (transactional) updates
 * so that multiple mutations fire only a single round of notifications.
 *
 * @example
 * ```ts
 * const state = new ChartState();
 * state.subscribe('candles', (candles, prev) => renderCandles(candles));
 * state.setState({ candles: newCandles });
 * ```
 */
export class ChartState {
  private state: ChartStateData;
  private subscriptions: Map<StateKey, Subscription[]> = new Map();
  private nextSubId = 1;

  /** When > 0 we are inside a transaction – defer notifications. */
  private transactionDepth = 0;

  /** Keys that changed during the current transaction. */
  private pendingKeys: Set<StateKey> = new Set();

  /** Previous values captured at transaction start for each changed key. */
  private transactionPrevValues: Map<StateKey, unknown> = new Map();

  constructor(initial?: Partial<ChartStateData>) {
    this.state = { ...createDefaultState(), ...initial };
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Subscribe to changes on a specific state key.
   *
   * @param key - The state property to observe.
   * @param callback - Invoked with (newValue, previousValue) when the key changes.
   * @returns An unsubscribe function.
   */
  subscribe<K extends StateKey>(
    key: K,
    callback: SubscriptionCallback<K>,
  ): () => void {
    const id = this.nextSubId++;
    const sub: Subscription = { id, key, callback };

    if (!this.subscriptions.has(key)) {
      this.subscriptions.set(key, []);
    }
    this.subscriptions.get(key)!.push(sub);

    return () => {
      const subs = this.subscriptions.get(key);
      if (subs) {
        const idx = subs.findIndex((s) => s.id === id);
        if (idx !== -1) subs.splice(idx, 1);
      }
    };
  }

  /**
   * Merge a partial update into the state and notify subscribers of changed keys.
   *
   * If called inside a transaction the notifications are deferred until
   * {@link commit} is invoked.
   *
   * @param partial - An object containing only the keys to update.
   */
  setState(partial: Partial<ChartStateData>): void {
    const changedKeys: StateKey[] = [];
    const prevValues = new Map<StateKey, unknown>();

    for (const rawKey of Object.keys(partial) as StateKey[]) {
      const newValue = (partial as any)[rawKey];
      const oldValue = (this.state as any)[rawKey];

      if (!this.shallowEqual(oldValue, newValue)) {
        // Capture previous value only once per transaction per key.
        if (this.transactionDepth > 0 && !this.transactionPrevValues.has(rawKey)) {
          this.transactionPrevValues.set(rawKey, this.cloneValue(oldValue));
        }

        // Always capture for non-transactional notifications
        prevValues.set(rawKey, this.cloneValue(oldValue));

        (this.state as any)[rawKey] = newValue;
        changedKeys.push(rawKey);
      }
    }

    if (this.transactionDepth > 0) {
      for (const k of changedKeys) this.pendingKeys.add(k);
    } else {
      for (const key of changedKeys) {
        this.notify(key, (this.state as any)[key], prevValues.get(key));
      }
    }
  }

  /**
   * Return an immutable snapshot of the current state.
   *
   * Primitive values are returned as-is; arrays and Maps are shallow-copied
   * to prevent external mutation.
   */
  getState(): Readonly<ChartStateData> {
    return Object.freeze({ ...this.state });
  }

  /**
   * Get the current value of a single state key.
   *
   * @param key - The state property to read.
   */
  get<K extends StateKey>(key: K): ChartStateData[K] {
    return this.state[key];
  }

  // ── Batched / Transactional Updates ─────────────────────────────────────────

  /**
   * Begin a transaction. All {@link setState} calls between {@link begin}
   * and {@link commit} will accumulate changed keys but will not fire
   * subscriber callbacks until {@link commit} is called.
   *
   * Transactions can be nested; notifications fire on the outermost commit.
   */
  begin(): void {
    this.transactionDepth++;
  }

  /**
   * Commit the current transaction and fire deferred notifications.
   *
   * If nested, only the outermost commit triggers notifications.
   */
  commit(): void {
    if (this.transactionDepth <= 0) {
      throw new Error('ChartState.commit() called without matching begin()');
    }

    this.transactionDepth--;

    if (this.transactionDepth === 0) {
      const keys = new Set(this.pendingKeys);
      const prevValues = new Map(this.transactionPrevValues);
      this.pendingKeys.clear();
      this.transactionPrevValues.clear();

      for (const key of keys) {
        const prev = prevValues.get(key);
        this.notify(key, (this.state as any)[key], prev);
      }
    }
  }

  /**
   * Convenience helper that executes `fn` inside a begin/commit block.
   *
   * @param fn - A synchronous function that may call {@link setState} multiple times.
   */
  transaction(fn: () => void): void {
    this.begin();
    try {
      fn();
    } finally {
      this.commit();
    }
  }

  /**
   * Remove all subscriptions.
   */
  clearSubscriptions(): void {
    this.subscriptions.clear();
  }

  /**
   * Reset the state to defaults, notifying subscribers of every changed key.
   */
  reset(): void {
    this.setState(createDefaultState());
  }

  // ── Private Helpers ─────────────────────────────────────────────────────────

  /**
   * Fire callbacks for a specific key.
   */
  private notify(key: StateKey, newValue: unknown, previousValue: unknown): void {
    const subs = this.subscriptions.get(key);
    if (!subs || subs.length === 0) return;

    // Iterate over a copy to allow unsubscribing during notification.
    for (const sub of [...subs]) {
      try {
        sub.callback(newValue, previousValue);
      } catch (err) {
        console.error(`[ChartState] Subscriber error on key "${key}":`, err);
      }
    }
  }

  /**
   * Shallow equality check – handles primitives, arrays (by reference),
   * and plain objects (top-level keys).
   */
  private shallowEqual(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (a == null || b == null) return false;
    if (typeof a !== typeof b) return false;

    // Map reference equality
    if (a instanceof Map || b instanceof Map) return a === b;

    // Array reference equality (caller should supply new array for change)
    if (Array.isArray(a) || Array.isArray(b)) return a === b;

    // Plain objects: shallow compare
    if (typeof a === 'object' && typeof b === 'object') {
      const keysA = Object.keys(a as Record<string, unknown>);
      const keysB = Object.keys(b as Record<string, unknown>);
      if (keysA.length !== keysB.length) return false;
      for (const k of keysA) {
        if ((a as any)[k] !== (b as any)[k]) return false;
      }
      return true;
    }

    return false;
  }

  /**
   * Clone a value for capturing previous state in transactions.
   */
  private cloneValue(value: unknown): unknown {
    if (value == null || typeof value !== 'object') return value;
    if (value instanceof Map) return new Map(value);
    if (Array.isArray(value)) return [...value];
    return { ...(value as Record<string, unknown>) };
  }
}
