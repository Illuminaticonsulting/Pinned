/**
 * DataService.ts
 * Fetches real candle data from BloFin public API and streams
 * live updates via WebSocket. Falls back to demo data if offline.
 */

import type { Candle } from '../core/ChartState';

// ─── Constants ───────────────────────────────────────────────────────────────

const REST_PROXY = '/blofin-api'; // Vite proxy → https://openapi.blofin.com
const WS_URL = 'wss://openapi.blofin.com/ws/public';
const MAX_RETRIES = 2;
const RETRY_DELAY = 800;
const PING_INTERVAL = 25_000;
const RECONNECT_BASE = 2_000;
const RECONNECT_MAX = 30_000;

const TIMEFRAME_MAP: Record<string, string> = {
  '1m': '1m',
  '5m': '5m',
  '15m': '15m',
  '1h': '1H',
  '4h': '4H',
  '1d': '1D',
};

function blofinTf(tf: string): string {
  return TIMEFRAME_MAP[tf] ?? tf;
}

function reverseTf(bar: string): string {
  const rev: Record<string, string> = {
    '1m': '1m', '5m': '5m', '15m': '15m',
    '1H': '1h', '4H': '4h', '1D': '1d',
  };
  return rev[bar] ?? '1m';
}

// ─── Types ───────────────────────────────────────────────────────────────────

export interface CandleSubscription {
  symbol: string;
  timeframe: string;
  onCandle: (candle: Candle) => void;
}

type ConnectionState = 'disconnected' | 'connecting' | 'connected';

// ─── DataService (singleton) ─────────────────────────────────────────────────

export class DataService {
  private static instance: DataService | null = null;

  private ws: WebSocket | null = null;
  private state: ConnectionState = 'disconnected';
  private subscriptions: Map<string, CandleSubscription> = new Map();
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private intentionalClose = false;

  static getInstance(): DataService {
    if (!DataService.instance) {
      DataService.instance = new DataService();
    }
    return DataService.instance;
  }

  // ── REST: Fetch Historical Candles ─────────────────────────────────────

  async fetchCandles(
    symbol: string,
    timeframe: string,
    limit = 300,
  ): Promise<Candle[]> {
    const bar = blofinTf(timeframe);
    const url = `${REST_PROXY}/api/v1/market/candles?instId=${encodeURIComponent(symbol)}&bar=${bar}&limit=${limit}`;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        const json = await res.json();
        if (json.code && json.code !== '0') {
          throw new Error(`BloFin error ${json.code}: ${json.msg}`);
        }

        const raw = json.data as string[][];
        if (!Array.isArray(raw) || raw.length === 0) {
          throw new Error('Empty candle data');
        }

        // BloFin returns newest-first; reverse to chronological
        const candles: Candle[] = raw
          .map((d) => ({
            timestamp: Number(d[0]),
            open: Number(d[1]),
            high: Number(d[2]),
            low: Number(d[3]),
            close: Number(d[4]),
            volume: Number(d[5]),
            buyVolume: Number(d[6] ?? 0),
            sellVolume: Number(d[7] ?? 0),
          }))
          .sort((a, b) => a.timestamp - b.timestamp);

        console.log(
          `[DataService] Fetched ${candles.length} candles for ${symbol} ${timeframe}`,
        );
        return candles;
      } catch (err) {
        console.warn(
          `[DataService] Fetch attempt ${attempt + 1} failed:`,
          err instanceof Error ? err.message : err,
        );
        if (attempt < MAX_RETRIES) {
          await new Promise((r) => setTimeout(r, RETRY_DELAY * (attempt + 1)));
        }
      }
    }

    // Fallback to demo candles
    console.warn('[DataService] All fetches failed, generating demo candles');
    return this.generateDemoCandles(symbol, timeframe, limit);
  }

  // ── WebSocket: Live Candle Streaming ───────────────────────────────────

  subscribe(sub: CandleSubscription): () => void {
    const key = `${sub.symbol}:${sub.timeframe}`;
    this.subscriptions.set(key, sub);

    if (this.state === 'disconnected') {
      this.connect();
    } else if (this.state === 'connected') {
      this.sendSubscribe(sub.symbol, sub.timeframe);
    }

    // Return unsubscribe function
    return () => {
      this.subscriptions.delete(key);
      if (this.state === 'connected') {
        this.sendUnsubscribe(sub.symbol, sub.timeframe);
      }
      if (this.subscriptions.size === 0) {
        this.disconnect();
      }
    };
  }

  // ── Connection Management ──────────────────────────────────────────────

  private connect(): void {
    if (this.state !== 'disconnected') return;
    this.state = 'connecting';
    this.intentionalClose = false;

    try {
      this.ws = new WebSocket(WS_URL);
    } catch {
      console.warn('[DataService] WebSocket construction failed');
      this.state = 'disconnected';
      return;
    }

    this.ws.onopen = () => {
      this.state = 'connected';
      this.reconnectAttempts = 0;
      console.log('[DataService] WebSocket connected');
      this.startPing();
      // Resubscribe all
      for (const sub of this.subscriptions.values()) {
        this.sendSubscribe(sub.symbol, sub.timeframe);
      }
    };

    this.ws.onmessage = (event) => {
      this.handleMessage(event.data as string);
    };

    this.ws.onclose = () => {
      this.state = 'disconnected';
      this.clearTimers();
      if (!this.intentionalClose && this.subscriptions.size > 0) {
        this.scheduleReconnect();
      }
    };

    this.ws.onerror = (err) => {
      console.warn('[DataService] WebSocket error', err);
    };
  }

  private disconnect(): void {
    this.intentionalClose = true;
    this.clearTimers();
    if (this.ws) {
      this.ws.close(1000);
      this.ws = null;
    }
    this.state = 'disconnected';
  }

  private handleMessage(raw: string): void {
    if (raw === 'pong') return;

    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    // Subscription confirmation
    if (msg.event === 'subscribe' || msg.event === 'unsubscribe') return;
    if (msg.event === 'error') {
      console.warn('[DataService] WS error:', msg.code, msg.msg);
      return;
    }

    const arg = msg.arg;
    const data = msg.data;
    if (!arg?.channel || !data?.length) return;

    const channel: string = arg.channel;
    if (!channel.startsWith('candle')) return;

    const tfKey = channel.replace('candle', '');
    const timeframe = reverseTf(tfKey);
    const symbol: string = arg.instId ?? '';
    const key = `${symbol}:${timeframe}`;
    const sub = this.subscriptions.get(key);
    if (!sub) return;

    for (const d of data as string[][]) {
      const candle: Candle = {
        timestamp: Number(d[0]),
        open: Number(d[1]),
        high: Number(d[2]),
        low: Number(d[3]),
        close: Number(d[4]),
        volume: Number(d[5]),
        buyVolume: Number(d[6] ?? 0),
        sellVolume: Number(d[7] ?? 0),
      };
      sub.onCandle(candle);
    }
  }

  private sendSubscribe(symbol: string, timeframe: string): void {
    const bar = blofinTf(timeframe);
    this.wsSend({
      op: 'subscribe',
      args: [{ channel: `candle${bar}`, instId: symbol }],
    });
  }

  private sendUnsubscribe(symbol: string, timeframe: string): void {
    const bar = blofinTf(timeframe);
    this.wsSend({
      op: 'unsubscribe',
      args: [{ channel: `candle${bar}`, instId: symbol }],
    });
  }

  private wsSend(payload: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
    }
  }

  private startPing(): void {
    this.pingTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send('ping');
      }
    }, PING_INTERVAL);
  }

  private scheduleReconnect(): void {
    this.reconnectAttempts++;
    const delay = Math.min(
      RECONNECT_BASE * Math.pow(2, this.reconnectAttempts - 1),
      RECONNECT_MAX,
    );
    console.log(`[DataService] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private clearTimers(): void {
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
  }

  // ── Demo Candle Fallback ───────────────────────────────────────────────

  private generateDemoCandles(
    _symbol: string,
    timeframe: string,
    count: number,
  ): Candle[] {
    const tfMs: Record<string, number> = {
      '1m': 60_000, '5m': 300_000, '15m': 900_000,
      '1h': 3_600_000, '4h': 14_400_000, '1d': 86_400_000,
    };
    const candles: Candle[] = [];
    const now = Date.now();
    const interval = tfMs[timeframe] ?? 60_000;
    let price = 42000 + Math.random() * 5000;

    for (let i = 0; i < count; i++) {
      const time = now - (count - i) * interval;
      const change = (Math.random() - 0.48) * price * 0.008;
      const open = price;
      price += change;
      const close = price;
      const high = Math.max(open, close) + Math.random() * Math.abs(change) * 0.5;
      const low = Math.min(open, close) - Math.random() * Math.abs(change) * 0.5;
      const volume = 50 + Math.random() * 200;
      const buyVol = volume * (0.3 + Math.random() * 0.4);

      candles.push({
        timestamp: time,
        open: +open.toFixed(2),
        high: +high.toFixed(2),
        low: +low.toFixed(2),
        close: +close.toFixed(2),
        volume: +volume.toFixed(2),
        buyVolume: +buyVol.toFixed(2),
        sellVolume: +(volume - buyVol).toFixed(2),
      });
    }

    return candles;
  }
}
