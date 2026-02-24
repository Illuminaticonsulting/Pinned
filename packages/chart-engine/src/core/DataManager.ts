/**
 * DataManager.ts
 * Manages data loading (REST) and real-time streaming (WebSocket) for the
 * Pinned chart engine.
 *
 * Responsibilities:
 * - Fetch historical candles via REST.
 * - Maintain a persistent WebSocket connection with auto-reconnect.
 * - Parse and route incoming messages (candle, trade, orderbook, heatmap, signals, etc.).
 * - Provide an EventEmitter interface for consumers to react to data updates.
 */

import type { Candle, FootprintCandle, FootprintLevel } from './ChartState';

// ─── Data Types ────────────────────────────────────────────────────────────────

/** Single order-book price level. */
export interface BookLevel {
  price: number;
  quantity: number;
}

/** Current state of the order book. */
export interface OrderbookSnapshot {
  exchange: string;
  symbol: string;
  bids: BookLevel[];
  asks: BookLevel[];
  timestamp: number;
}

/** AI / quant signal data. */
export interface Signal {
  id: string;
  type: string;
  direction: 'long' | 'short' | 'neutral';
  confidence: number;
  price: number;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

/** Big-trade alert. */
export interface BigTrade {
  exchange: string;
  symbol: string;
  side: 'buy' | 'sell';
  price: number;
  quantity: number;
  usdValue: number;
  timestamp: number;
}

/** Pattern event from heatmap analysis. */
export interface PatternEvent {
  type: string;
  startPrice: number;
  endPrice: number;
  startTime: number;
  endTime: number;
  confidence: number;
  metadata?: Record<string, unknown>;
}

/** Order Flow Imbalance data point. */
export interface OFIDataPoint {
  timestamp: number;
  value: number;
}

/** Funding rate snapshot. */
export interface FundingData {
  exchange: string;
  symbol: string;
  rate: number;
  nextFundingTime: number;
  timestamp: number;
}

/** Heatmap cell update (from diff messages). */
export interface HeatmapCell {
  price: number;
  quantity: number;
}

// ─── WebSocket Message Types ───────────────────────────────────────────────────

interface WSMessage {
  type: string;
  channel?: string;
  data?: unknown;
}

// ─── Event Map ─────────────────────────────────────────────────────────────────

export interface DataEventMap {
  candle: Candle;
  trade: { price: number; quantity: number; side: 'buy' | 'sell'; timestamp: number };
  orderbook: OrderbookSnapshot;
  signal: Signal;
  bigTrade: BigTrade;
  patternEvent: PatternEvent;
  ofi: OFIDataPoint;
  funding: FundingData;
  heatmapFull: ArrayBuffer;
  heatmapDiff: HeatmapCell[];
  footprint: FootprintCandle;
  connected: void;
  disconnected: { code: number; reason: string };
  error: Error;
}

type EventCallback<T> = (payload: T) => void;

// ─── Constants ─────────────────────────────────────────────────────────────────

/** Default REST API base URL – can be overridden in constructor options. */
const DEFAULT_API_BASE = '/api/v1';

/** WebSocket ping interval in milliseconds. */
const HEARTBEAT_INTERVAL_MS = 30_000;

/** Initial reconnect delay in milliseconds. */
const RECONNECT_BASE_MS = 1_000;

/** Maximum reconnect delay in milliseconds. */
const RECONNECT_MAX_MS = 30_000;

/** Maximum OFI buffer length. */
const OFI_BUFFER_SIZE = 300;

// ─── Configuration ─────────────────────────────────────────────────────────────

export interface DataManagerOptions {
  /** REST API base URL (default: /api/v1). */
  apiBase?: string;
  /** WebSocket URL (e.g. wss://api.pinned.dev/ws). */
  wsUrl: string;
  /** Authentication token sent on WS connect. */
  authToken?: string;
}

// ─── DataManager ───────────────────────────────────────────────────────────────

/**
 * Central data layer for the Pinned chart engine.
 *
 * @example
 * ```ts
 * const dm = new DataManager({ wsUrl: 'wss://api.pinned.dev/ws', authToken });
 * const candles = await dm.loadHistoricalCandles('binance', 'BTC/USDT', '1m', 500);
 * dm.connectWebSocket();
 * dm.on('candle', (c) => updateChart(c));
 * ```
 */
export class DataManager {
  private readonly apiBase: string;
  private readonly wsUrl: string;
  private readonly authToken: string | undefined;

  /** Active WebSocket instance. */
  private ws: WebSocket | null = null;

  /** Whether the user explicitly called disconnect. */
  private intentionalClose = false;

  /** Reconnect state. */
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  /** Heartbeat timer. */
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  /** Event listeners. */
  private listeners: Map<string, Set<EventCallback<any>>> = new Map();

  /** Currently subscribed channels. */
  private subscribedChannels: Set<string> = new Set();

  // ── Stateful data stores ───────────────────────────────────────────────────

  /** Latest orderbook snapshot. */
  private orderbook: OrderbookSnapshot | null = null;

  /** Footprint data keyed by candle open timestamp. */
  private footprints: Map<number, FootprintCandle> = new Map();

  /** OFI ring buffer (last N values). */
  private ofiBuffer: OFIDataPoint[] = [];

  /** Latest funding data. */
  private funding: FundingData | null = null;

  /** Latest heatmap binary blob. */
  private heatmapBlob: ArrayBuffer | null = null;

  constructor(options: DataManagerOptions) {
    this.apiBase = options.apiBase ?? DEFAULT_API_BASE;
    this.wsUrl = options.wsUrl;
    this.authToken = options.authToken;
  }

  // ── Event Emitter ──────────────────────────────────────────────────────────

  /**
   * Subscribe to a data event.
   *
   * @param event    - Event name (e.g. "candle", "trade").
   * @param callback - Listener function.
   * @returns Unsubscribe function.
   */
  on<K extends keyof DataEventMap>(
    event: K,
    callback: EventCallback<DataEventMap[K]>,
  ): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(callback);
    return () => this.off(event, callback);
  }

  /**
   * Remove an event listener.
   */
  off<K extends keyof DataEventMap>(
    event: K,
    callback: EventCallback<DataEventMap[K]>,
  ): void {
    this.listeners.get(event)?.delete(callback);
  }

  private emit<K extends keyof DataEventMap>(event: K, payload: DataEventMap[K]): void {
    const cbs = this.listeners.get(event);
    if (!cbs) return;
    for (const cb of cbs) {
      try {
        cb(payload);
      } catch (err) {
        console.error(`[DataManager] Error in "${String(event)}" listener:`, err);
      }
    }
  }

  // ── REST API ───────────────────────────────────────────────────────────────

  /**
   * Fetch historical candle data from the REST API.
   *
   * @param exchange  - Exchange identifier (e.g. "binance").
   * @param symbol    - Trading pair (e.g. "BTC/USDT").
   * @param timeframe - Candlestick timeframe (e.g. "1m", "5m", "1h").
   * @param limit     - Maximum number of candles to retrieve.
   * @returns Array of {@link Candle} objects sorted by ascending timestamp.
   */
  async loadHistoricalCandles(
    exchange: string,
    symbol: string,
    timeframe: string,
    limit: number = 500,
  ): Promise<Candle[]> {
    const params = new URLSearchParams({
      exchange,
      symbol,
      timeframe,
      limit: String(limit),
    });

    const url = `${this.apiBase}/charts/candles?${params.toString()}`;

    const response = await fetch(url, {
      headers: this.buildHeaders(),
    });

    if (!response.ok) {
      throw new Error(
        `[DataManager] Failed to load candles: ${response.status} ${response.statusText}`,
      );
    }

    const json = (await response.json()) as {
      data: Array<{
        t: number;
        o: number;
        h: number;
        l: number;
        c: number;
        v: number;
        bv?: number;
        sv?: number;
        tc?: number;
      }>;
    };

    return json.data.map((d) => ({
      timestamp: d.t,
      open: d.o,
      high: d.h,
      low: d.l,
      close: d.c,
      volume: d.v,
      buyVolume: d.bv,
      sellVolume: d.sv,
      tradeCount: d.tc,
    }));
  }

  // ── WebSocket ──────────────────────────────────────────────────────────────

  /**
   * Open a WebSocket connection to the streaming server.
   * Handles authentication, heartbeat, and auto-reconnect.
   */
  connectWebSocket(): void {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    this.intentionalClose = false;

    try {
      this.ws = new WebSocket(this.wsUrl);
      this.ws.binaryType = 'arraybuffer';
    } catch (err) {
      console.error('[DataManager] WebSocket construction failed:', err);
      this.scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
      this.reconnectAttempts = 0;

      // Authenticate.
      if (this.authToken) {
        this.wsSend({ type: 'auth', token: this.authToken });
      }

      // Re-subscribe to previously subscribed channels.
      if (this.subscribedChannels.size > 0) {
        this.wsSend({ type: 'subscribe', channels: [...this.subscribedChannels] });
      }

      // Start heartbeat.
      this.startHeartbeat();

      this.emit('connected', undefined as any);
    };

    this.ws.onmessage = (ev: MessageEvent) => {
      if (ev.data instanceof ArrayBuffer) {
        this.handleBinaryMessage(ev.data);
      } else {
        this.handleTextMessage(ev.data as string);
      }
    };

    this.ws.onclose = (ev: CloseEvent) => {
      this.stopHeartbeat();
      this.emit('disconnected', { code: ev.code, reason: ev.reason });

      if (!this.intentionalClose) {
        this.scheduleReconnect();
      }
    };

    this.ws.onerror = () => {
      this.emit('error', new Error('[DataManager] WebSocket error'));
    };
  }

  /**
   * Close the WebSocket connection gracefully.
   */
  disconnectWebSocket(): void {
    this.intentionalClose = true;
    this.stopHeartbeat();
    this.clearReconnectTimer();

    if (this.ws) {
      this.ws.close(1000, 'Client disconnect');
      this.ws = null;
    }
  }

  /**
   * Subscribe to one or more streaming channels.
   *
   * @param channels - Channel identifiers (e.g. ["candles:binance:BTC/USDT:1m", "trades:binance:BTC/USDT"]).
   */
  subscribe(channels: string[]): void {
    for (const ch of channels) this.subscribedChannels.add(ch);
    if (this.isConnected()) {
      this.wsSend({ type: 'subscribe', channels });
    }
  }

  /**
   * Unsubscribe from streaming channels.
   *
   * @param channels - Channel identifiers to unsubscribe from.
   */
  unsubscribe(channels: string[]): void {
    for (const ch of channels) this.subscribedChannels.delete(ch);
    if (this.isConnected()) {
      this.wsSend({ type: 'unsubscribe', channels });
    }
  }

  /**
   * @returns `true` if the WebSocket is currently open.
   */
  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  // ── Data Accessors ─────────────────────────────────────────────────────────

  /**
   * @returns The most recent order-book snapshot, or `null` if none received.
   */
  getLatestOrderbook(): OrderbookSnapshot | null {
    return this.orderbook;
  }

  /**
   * Retrieve footprint data for a specific candle.
   *
   * @param timestamp - Candle open timestamp (epoch ms).
   */
  getFootprintForCandle(timestamp: number): FootprintCandle | undefined {
    return this.footprints.get(timestamp);
  }

  /**
   * @returns The last {@link OFI_BUFFER_SIZE} OFI data points.
   */
  getOFIBuffer(): readonly OFIDataPoint[] {
    return this.ofiBuffer;
  }

  /**
   * @returns Latest funding rate data, or `null`.
   */
  getLatestFunding(): FundingData | null {
    return this.funding;
  }

  /**
   * @returns The latest full heatmap binary blob, or `null`.
   */
  getHeatmapBlob(): ArrayBuffer | null {
    return this.heatmapBlob;
  }

  /**
   * Clean up all resources. Call when disposing the chart.
   */
  destroy(): void {
    this.disconnectWebSocket();
    this.listeners.clear();
    this.footprints.clear();
    this.ofiBuffer = [];
    this.orderbook = null;
    this.funding = null;
    this.heatmapBlob = null;
  }

  // ── Internal: Message Routing ──────────────────────────────────────────────

  private handleTextMessage(raw: string): void {
    let msg: WSMessage;
    try {
      msg = JSON.parse(raw);
    } catch {
      console.warn('[DataManager] Failed to parse WS message:', raw.slice(0, 200));
      return;
    }

    switch (msg.type) {
      case 'candle':
        this.handleCandle(msg.data);
        break;
      case 'trade':
        this.handleTrade(msg.data);
        break;
      case 'orderbook':
        this.handleOrderbook(msg.data);
        break;
      case 'signal':
        this.handleSignal(msg.data);
        break;
      case 'big_trade':
        this.handleBigTrade(msg.data);
        break;
      case 'pattern_event':
        this.handlePatternEvent(msg.data);
        break;
      case 'ofi':
        this.handleOFI(msg.data);
        break;
      case 'funding':
        this.handleFunding(msg.data);
        break;
      case 'heatmap_diff':
        this.handleHeatmapDiff(msg.data);
        break;
      case 'pong':
        // Heartbeat response – no action needed.
        break;
      default:
        // Unknown message types are silently ignored.
        break;
    }
  }

  private handleBinaryMessage(data: ArrayBuffer): void {
    // Binary messages are treated as full heatmap snapshots.
    this.heatmapBlob = data;
    this.emit('heatmapFull', data);
  }

  // ── Individual Message Handlers ────────────────────────────────────────────

  private handleCandle(data: unknown): void {
    const d = data as {
      t: number; o: number; h: number; l: number; c: number; v: number;
      bv?: number; sv?: number; tc?: number;
    };
    const candle: Candle = {
      timestamp: d.t,
      open: d.o,
      high: d.h,
      low: d.l,
      close: d.c,
      volume: d.v,
      buyVolume: d.bv,
      sellVolume: d.sv,
      tradeCount: d.tc,
    };
    this.emit('candle', candle);
  }

  private handleTrade(data: unknown): void {
    const d = data as { p: number; q: number; s: 'buy' | 'sell'; t: number };
    const trade = { price: d.p, quantity: d.q, side: d.s, timestamp: d.t };
    this.emit('trade', trade);

    // Aggregate trade into footprint for the corresponding candle.
    this.aggregateTradeToFootprint(trade);
  }

  private handleOrderbook(data: unknown): void {
    const d = data as OrderbookSnapshot;
    this.orderbook = d;
    this.emit('orderbook', d);
  }

  private handleSignal(data: unknown): void {
    const d = data as Signal;
    this.emit('signal', d);
  }

  private handleBigTrade(data: unknown): void {
    const d = data as BigTrade;
    this.emit('bigTrade', d);
  }

  private handlePatternEvent(data: unknown): void {
    const d = data as PatternEvent;
    this.emit('patternEvent', d);
  }

  private handleOFI(data: unknown): void {
    const d = data as OFIDataPoint;
    this.ofiBuffer.push(d);
    if (this.ofiBuffer.length > OFI_BUFFER_SIZE) {
      this.ofiBuffer.shift();
    }
    this.emit('ofi', d);
  }

  private handleFunding(data: unknown): void {
    const d = data as FundingData;
    this.funding = d;
    this.emit('funding', d);
  }

  private handleHeatmapDiff(data: unknown): void {
    const cells = data as HeatmapCell[];
    this.emit('heatmapDiff', cells);
  }

  // ── Footprint Aggregation ──────────────────────────────────────────────────

  /**
   * Aggregate an individual trade into the footprint candle for its time bucket.
   * The caller is responsible for providing the correct candle timestamp
   * (floor to timeframe interval). For simplicity we use 1-minute buckets
   * and consumers can override by re-bucketing upstream.
   */
  private aggregateTradeToFootprint(trade: {
    price: number;
    quantity: number;
    side: 'buy' | 'sell';
    timestamp: number;
  }): void {
    // Floor to nearest minute.
    const bucketTs = Math.floor(trade.timestamp / 60_000) * 60_000;

    let fp = this.footprints.get(bucketTs);
    if (!fp) {
      fp = {
        timestamp: bucketTs,
        levels: [],
        totalBidVolume: 0,
        totalAskVolume: 0,
        totalDelta: 0,
        poc: trade.price,
      };
    }

    // Find or create level.
    const mutableLevels = [...fp.levels];
    let level = mutableLevels.find((l) => l.price === trade.price);
    if (!level) {
      level = { price: trade.price, bidVolume: 0, askVolume: 0, delta: 0, tradeCount: 0 };
      mutableLevels.push(level);
    }

    // Update level.
    const updatedLevel: FootprintLevel = {
      price: level.price,
      bidVolume: level.bidVolume + (trade.side === 'buy' ? 0 : trade.quantity),
      askVolume: level.askVolume + (trade.side === 'buy' ? trade.quantity : 0),
      delta: level.delta + (trade.side === 'buy' ? trade.quantity : -trade.quantity),
      tradeCount: level.tradeCount + 1,
    };

    const idx = mutableLevels.indexOf(level);
    mutableLevels[idx] = updatedLevel;

    // Recalculate aggregates.
    let totalBid = 0;
    let totalAsk = 0;
    let totalDelta = 0;
    let pocPrice = mutableLevels[0]?.price ?? 0;
    let pocVolume = 0;

    for (const l of mutableLevels) {
      totalBid += l.bidVolume;
      totalAsk += l.askVolume;
      totalDelta += l.delta;
      const vol = l.bidVolume + l.askVolume;
      if (vol > pocVolume) {
        pocVolume = vol;
        pocPrice = l.price;
      }
    }

    const updatedFp: FootprintCandle = {
      timestamp: bucketTs,
      levels: mutableLevels,
      totalBidVolume: totalBid,
      totalAskVolume: totalAsk,
      totalDelta: totalDelta,
      poc: pocPrice,
    };

    this.footprints.set(bucketTs, updatedFp);
    this.emit('footprint', updatedFp);
  }

  // ── WebSocket Helpers ──────────────────────────────────────────────────────

  private wsSend(data: Record<string, unknown>): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.wsSend({ type: 'ping', ts: Date.now() });
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  // ── Reconnection ──────────────────────────────────────────────────────────

  private scheduleReconnect(): void {
    this.clearReconnectTimer();
    const delay = Math.min(
      RECONNECT_BASE_MS * Math.pow(2, this.reconnectAttempts),
      RECONNECT_MAX_MS,
    );
    this.reconnectAttempts++;

    console.info(`[DataManager] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})…`);

    this.reconnectTimer = setTimeout(() => {
      this.connectWebSocket();
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  // ── Misc ───────────────────────────────────────────────────────────────────

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.authToken) {
      headers['Authorization'] = `Bearer ${this.authToken}`;
    }
    return headers;
  }
}
