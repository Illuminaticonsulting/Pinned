/**
 * LiveOrderFlowService.ts
 * Connects to the Pinned server WebSocket (port 3002) to receive live
 * orderflow data: heatmap frames, orderbook snapshots, trades, patterns,
 * OFI, big trades, and footprint data.
 *
 * Singleton — shared across all chart panes and panels.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export interface OrderbookLevel {
  price: number;
  size: number;
}

export interface OrderbookSnapshot {
  exchange: string;
  symbol: string;
  bids: { price: number; quantity: number }[];
  asks: { price: number; quantity: number }[];
  timestamp: number;
}

export interface LiveTrade {
  time: number;
  price: number;
  size: number;
  side: 'buy' | 'sell';
  exchange: string;
  symbol: string;
}

export interface PatternEvent {
  type: 'iceberg' | 'spoof' | 'absorption';
  time: number;
  price: number;
  exchange: string;
  symbol: string;
  confidence: number;
  estimatedSize?: number;
  direction: 'bid' | 'ask';
  duration?: number;
}

export interface BigTrade {
  time: number;
  price: number;
  totalSize: number;
  side: 'buy' | 'sell';
  tradeCount: number;
  exchange: string;
  symbol: string;
}

export interface OFIData {
  time: number;
  value: number;
  cumulative: number;
}

export interface HeatmapDiffCell {
  priceIndex: number;
  timeIndex: number;
  intensity: number;
  maxSize: number;
}

export interface HeatmapUpdate {
  type: 'full' | 'diff';
  cells?: HeatmapDiffCell[];
  priceMin: number;
  priceMax: number;
  timeStart: number;
  timeEnd: number;
  tickSize: number;
  timeStep: number;
}

// ─── Event System ────────────────────────────────────────────────────────────

export interface OrderFlowEventMap {
  orderbook: OrderbookSnapshot;
  trade: LiveTrade;
  pattern: PatternEvent;
  bigTrade: BigTrade;
  ofi: OFIData;
  heatmapFull: ArrayBuffer;
  heatmapDiff: HeatmapUpdate;
  connected: void;
  disconnected: void;
}

type EventCallback<T> = (payload: T) => void;

// ─── Constants ───────────────────────────────────────────────────────────────

const DEFAULT_WS_URL = 'ws://localhost:3002';
const PING_INTERVAL = 25_000;
const RECONNECT_BASE = 2_000;
const RECONNECT_MAX = 30_000;

// ─── LiveOrderFlowService ────────────────────────────────────────────────────

export class LiveOrderFlowService {
  private static instance: LiveOrderFlowService | null = null;

  private ws: WebSocket | null = null;
  private wsUrl: string;
  private state: 'disconnected' | 'connecting' | 'connected' = 'disconnected';
  private intentionalClose = false;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  // Event listeners
  private listeners = new Map<string, Set<EventCallback<any>>>();

  // Subscribed channels on server
  private subscribedChannels = new Set<string>();

  // Current symbol tracking
  private activeSymbol = 'BTC-USDT';
  private activeExchange = 'blofin';

  // Cached latest data
  private latestOrderbook: OrderbookSnapshot | null = null;
  private tradeBuffer: LiveTrade[] = [];
  private patternBuffer: PatternEvent[] = [];
  private ofiBuffer: OFIData[] = [];

  private constructor() {
    // Try to derive WS URL from current location
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.hostname;
    // If running on localhost with Vite dev server, connect to server directly
    if (host === 'localhost' || host === '127.0.0.1') {
      this.wsUrl = DEFAULT_WS_URL;
    } else {
      this.wsUrl = `${protocol}//${window.location.host}/ws`;
    }
  }

  static getInstance(): LiveOrderFlowService {
    if (!LiveOrderFlowService.instance) {
      LiveOrderFlowService.instance = new LiveOrderFlowService();
    }
    return LiveOrderFlowService.instance;
  }

  // ── Event Emitter ──────────────────────────────────────────────────────

  on<K extends keyof OrderFlowEventMap>(
    event: K,
    callback: EventCallback<OrderFlowEventMap[K]>,
  ): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(callback);
    return () => this.off(event, callback);
  }

  off<K extends keyof OrderFlowEventMap>(
    event: K,
    callback: EventCallback<OrderFlowEventMap[K]>,
  ): void {
    this.listeners.get(event)?.delete(callback);
  }

  private emit<K extends keyof OrderFlowEventMap>(
    event: K,
    payload: OrderFlowEventMap[K],
  ): void {
    const cbs = this.listeners.get(event);
    if (!cbs) return;
    for (const cb of cbs) {
      try {
        cb(payload);
      } catch (err) {
        console.error(`[LiveOrderFlow] Error in "${String(event)}" listener:`, err);
      }
    }
  }

  // ── Connection Management ──────────────────────────────────────────────

  connect(): void {
    if (this.state !== 'disconnected') return;
    this.state = 'connecting';
    this.intentionalClose = false;

    try {
      this.ws = new WebSocket(this.wsUrl);
      this.ws.binaryType = 'arraybuffer';
    } catch {
      console.warn('[LiveOrderFlow] WebSocket construction failed');
      this.state = 'disconnected';
      this.scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
      this.state = 'connected';
      this.reconnectAttempts = 0;
      console.log('[LiveOrderFlow] Connected to server');
      this.startPing();

      // Subscribe to orderflow channels for active symbol
      this.subscribeSymbol(this.activeExchange, this.activeSymbol);

      this.emit('connected', undefined as any);
    };

    this.ws.onmessage = (ev: MessageEvent) => {
      if (ev.data instanceof ArrayBuffer) {
        this.handleBinaryMessage(ev.data);
      } else {
        this.handleTextMessage(ev.data as string);
      }
    };

    this.ws.onclose = () => {
      this.state = 'disconnected';
      this.clearTimers();
      console.log('[LiveOrderFlow] Disconnected');
      this.emit('disconnected', undefined as any);
      if (!this.intentionalClose) {
        this.scheduleReconnect();
      }
    };

    this.ws.onerror = () => {
      console.warn('[LiveOrderFlow] WebSocket error');
    };
  }

  disconnect(): void {
    this.intentionalClose = true;
    this.clearTimers();
    if (this.ws) {
      this.ws.close(1000, 'Client disconnect');
      this.ws = null;
    }
    this.state = 'disconnected';
  }

  isConnected(): boolean {
    return this.state === 'connected';
  }

  // ── Symbol Management ──────────────────────────────────────────────────

  setSymbol(exchange: string, symbol: string): void {
    if (this.activeExchange === exchange && this.activeSymbol === symbol) return;

    // Unsubscribe from previous
    this.unsubscribeSymbol(this.activeExchange, this.activeSymbol);

    this.activeExchange = exchange;
    this.activeSymbol = symbol;

    // Clear cached data for previous symbol
    this.latestOrderbook = null;
    this.tradeBuffer = [];
    this.patternBuffer = [];

    // Subscribe to new symbol
    if (this.state === 'connected') {
      this.subscribeSymbol(exchange, symbol);
    }
  }

  getActiveSymbol(): string {
    return this.activeSymbol;
  }

  // ── Data Accessors ─────────────────────────────────────────────────────

  getLatestOrderbook(): OrderbookSnapshot | null {
    return this.latestOrderbook;
  }

  getRecentTrades(): LiveTrade[] {
    return this.tradeBuffer;
  }

  getRecentPatterns(): PatternEvent[] {
    return this.patternBuffer;
  }

  getOFIBuffer(): OFIData[] {
    return this.ofiBuffer;
  }

  // ── Channel Management ─────────────────────────────────────────────────

  private subscribeSymbol(exchange: string, symbol: string): void {
    const channels = [
      `orderbook:${exchange}:${symbol}`,
      `trades:${exchange}:${symbol}`,
      `heatmap:${exchange}:${symbol}`,
      `patterns:${exchange}:${symbol}`,
      `bigtrades:${exchange}:${symbol}`,
      `ofi:${exchange}:${symbol}`,
    ];
    for (const ch of channels) this.subscribedChannels.add(ch);

    if (this.state === 'connected') {
      this.wsSend({ type: 'subscribe', channels });
    }
  }

  private unsubscribeSymbol(exchange: string, symbol: string): void {
    const channels = [
      `orderbook:${exchange}:${symbol}`,
      `trades:${exchange}:${symbol}`,
      `heatmap:${exchange}:${symbol}`,
      `patterns:${exchange}:${symbol}`,
      `bigtrades:${exchange}:${symbol}`,
      `ofi:${exchange}:${symbol}`,
    ];
    for (const ch of channels) this.subscribedChannels.delete(ch);

    if (this.state === 'connected') {
      this.wsSend({ type: 'unsubscribe', channels });
    }
  }

  // ── Message Handling ───────────────────────────────────────────────────

  private handleTextMessage(raw: string): void {
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    switch (msg.type) {
      case 'orderbook': {
        const snap = this.parseOrderbook(msg.data);
        if (snap) {
          this.latestOrderbook = snap;
          this.emit('orderbook', snap);
        }
        break;
      }
      case 'trade': {
        const trade = msg.data as LiveTrade;
        this.tradeBuffer.push(trade);
        if (this.tradeBuffer.length > 2000) {
          this.tradeBuffer = this.tradeBuffer.slice(-1500);
        }
        this.emit('trade', trade);
        break;
      }
      case 'pattern_event': {
        const pattern = msg.data as PatternEvent;
        this.patternBuffer.push(pattern);
        if (this.patternBuffer.length > 200) {
          this.patternBuffer = this.patternBuffer.slice(-150);
        }
        this.emit('pattern', pattern);
        break;
      }
      case 'big_trade': {
        const bigTrade = msg.data as BigTrade;
        this.emit('bigTrade', bigTrade);
        break;
      }
      case 'ofi': {
        const ofi = msg.data as OFIData;
        this.ofiBuffer.push(ofi);
        if (this.ofiBuffer.length > 300) {
          this.ofiBuffer.shift();
        }
        this.emit('ofi', ofi);
        break;
      }
      case 'heatmap_diff': {
        const update = msg.data as HeatmapUpdate;
        this.emit('heatmapDiff', update);
        break;
      }
      case 'pong':
        break;
      default:
        break;
    }
  }

  private handleBinaryMessage(data: ArrayBuffer): void {
    // Binary frames = full heatmap blob
    this.emit('heatmapFull', data);
  }

  private parseOrderbook(data: any): OrderbookSnapshot | null {
    if (!data) return null;
    return {
      exchange: data.exchange ?? this.activeExchange,
      symbol: data.symbol ?? this.activeSymbol,
      bids: (data.bids ?? []).map((l: any) => ({
        price: Number(l.price ?? l[0]),
        quantity: Number(l.size ?? l.quantity ?? l[1]),
      })),
      asks: (data.asks ?? []).map((l: any) => ({
        price: Number(l.price ?? l[0]),
        quantity: Number(l.size ?? l.quantity ?? l[1]),
      })),
      timestamp: data.time ?? data.timestamp ?? Date.now(),
    };
  }

  // ── WebSocket Helpers ──────────────────────────────────────────────────

  private wsSend(data: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }

  private startPing(): void {
    this.pingTimer = setInterval(() => {
      this.wsSend({ type: 'ping', ts: Date.now() });
    }, PING_INTERVAL);
  }

  private scheduleReconnect(): void {
    this.reconnectAttempts++;
    const delay = Math.min(
      RECONNECT_BASE * Math.pow(2, this.reconnectAttempts - 1),
      RECONNECT_MAX,
    );
    console.log(`[LiveOrderFlow] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private clearTimers(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  destroy(): void {
    this.disconnect();
    this.listeners.clear();
    this.tradeBuffer = [];
    this.patternBuffer = [];
    this.ofiBuffer = [];
    this.latestOrderbook = null;
    LiveOrderFlowService.instance = null;
  }
}
