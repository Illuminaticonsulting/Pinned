import { EventEmitter } from 'events';
import WebSocket from 'ws';
import {
  Candle,
  Trade,
  OrderbookSnapshot,
  OrderbookLevel,
  Ticker,
  FundingRate,
  Timeframe,
  Exchange,
} from '@pinned/shared-types';
import { ExchangeAdapter } from './types';
import { logger } from '../utils/logger';

const REST_BASE = 'https://openapi.blofin.com';
const WS_URL = 'wss://openapi.blofin.com/ws/public';

const TIMEFRAME_MAP: Record<Timeframe, string> = {
  '1m': '1m',
  '5m': '5m',
  '15m': '15m',
  '1h': '1H',
  '4h': '4H',
  '1d': '1D',
};

const MAX_RETRIES = 3;
const RETRY_BASE_MS = 500;
const PING_INTERVAL_MS = 25_000;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

interface Subscription {
  channel: string;
  instId: string;
}

async function fetchWithRetry(url: string, retries = MAX_RETRIES): Promise<unknown> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const res = await fetch(url);
      if (res.status === 429) {
        const wait = RETRY_BASE_MS * Math.pow(2, attempt);
        logger.warn('BloFin: rate limited, backing off', { url, wait, attempt });
        await sleep(wait);
        continue;
      }
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      }
      const json = await res.json() as { code?: string; msg?: string; data?: unknown };
      if (json.code && json.code !== '0') {
        throw new Error(`BloFin API error ${json.code}: ${json.msg ?? 'unknown'}`);
      }
      return json.data;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < retries - 1) {
        const wait = RETRY_BASE_MS * Math.pow(2, attempt);
        logger.warn('BloFin: request failed, retrying', { url, attempt, error: lastError.message, wait });
        await sleep(wait);
      }
    }
  }
  throw lastError ?? new Error('BloFin: request failed after retries');
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export class BloFinAdapter extends EventEmitter implements ExchangeAdapter {
  readonly exchange: Exchange = 'blofin';

  private ws: WebSocket | null = null;
  private _connected = false;
  private subscriptions: Subscription[] = [];
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private intentionalClose = false;

  get connected(): boolean {
    return this._connected;
  }

  /* ------------------------------------------------------------------ */
  /*  Connection lifecycle                                               */
  /* ------------------------------------------------------------------ */

  async connect(): Promise<void> {
    if (this._connected) return;
    this.intentionalClose = false;
    return this.initWebSocket();
  }

  async disconnect(): Promise<void> {
    this.intentionalClose = true;
    this.clearTimers();
    if (this.ws) {
      this.ws.close(1000, 'client disconnect');
      this.ws = null;
    }
    this._connected = false;
    this.emit('disconnected', 'client disconnect');
    logger.info('BloFin: disconnected');
  }

  /* ------------------------------------------------------------------ */
  /*  Subscriptions                                                      */
  /* ------------------------------------------------------------------ */

  subscribeTrades(symbol: string): void {
    this.addSubscription({ channel: 'trades', instId: symbol });
  }

  subscribeOrderbook(symbol: string): void {
    this.addSubscription({ channel: 'books400', instId: symbol });
  }

  subscribeCandles(symbol: string, timeframe: Timeframe): void {
    const bar = TIMEFRAME_MAP[timeframe] ?? timeframe;
    this.addSubscription({ channel: `candle${bar}`, instId: symbol });
  }

  unsubscribeTrades(symbol: string): void {
    this.removeSubscription({ channel: 'trades', instId: symbol });
  }

  unsubscribeOrderbook(symbol: string): void {
    this.removeSubscription({ channel: 'books400', instId: symbol });
  }

  unsubscribeCandles(symbol: string, timeframe: Timeframe): void {
    const bar = TIMEFRAME_MAP[timeframe] ?? timeframe;
    this.removeSubscription({ channel: `candle${bar}`, instId: symbol });
  }

  /* ------------------------------------------------------------------ */
  /*  REST endpoints                                                     */
  /* ------------------------------------------------------------------ */

  async getHistoricalCandles(symbol: string, timeframe: Timeframe, limit = 200): Promise<Candle[]> {
    const bar = TIMEFRAME_MAP[timeframe] ?? timeframe;
    const url = `${REST_BASE}/api/v1/market/candles?instId=${encodeURIComponent(symbol)}&bar=${bar}&limit=${limit}`;
    const data = (await fetchWithRetry(url)) as string[][];
    return data.map((d) => this.parseCandle(d, symbol, timeframe));
  }

  async getOrderbook(symbol: string): Promise<OrderbookSnapshot> {
    const url = `${REST_BASE}/api/v1/market/books?instId=${encodeURIComponent(symbol)}&sz=400`;
    const data = (await fetchWithRetry(url)) as Array<{ bids: string[][]; asks: string[][]; ts: string }>;
    const book = data[0];
    return {
      time: Number(book.ts),
      exchange: this.exchange,
      symbol,
      bids: book.bids.map(this.parseLevel),
      asks: book.asks.map(this.parseLevel),
    };
  }

  async getTicker(symbol: string): Promise<Ticker> {
    const url = `${REST_BASE}/api/v1/market/tickers?instId=${encodeURIComponent(symbol)}`;
    const data = (await fetchWithRetry(url)) as Array<Record<string, string>>;
    const t = data[0];
    return {
      symbol,
      exchange: this.exchange,
      lastPrice: Number(t.last),
      bid: Number(t.bidPx),
      ask: Number(t.askPx),
      volume24h: Number(t.vol24h ?? t.volCcy24h ?? 0),
      change24h: Number(t.change24h ?? 0),
      high24h: Number(t.high24h ?? 0),
      low24h: Number(t.low24h ?? 0),
    };
  }

  async getFundingRate(symbol: string): Promise<FundingRate> {
    const url = `${REST_BASE}/api/v1/market/funding-rate?instId=${encodeURIComponent(symbol)}`;
    const data = (await fetchWithRetry(url)) as Array<Record<string, string>>;
    const f = data[0];
    return {
      time: Date.now(),
      exchange: this.exchange,
      symbol,
      rate: Number(f.fundingRate),
      nextFundingTime: Number(f.nextFundingTime),
    };
  }

  async getRecentTrades(symbol: string, limit = 100): Promise<Trade[]> {
    const url = `${REST_BASE}/api/v1/market/trades?instId=${encodeURIComponent(symbol)}&limit=${limit}`;
    const data = (await fetchWithRetry(url)) as Array<Record<string, string>>;
    return data.map((t) => ({
      time: Number(t.ts),
      price: Number(t.px),
      size: Number(t.sz),
      side: t.side === 'buy' ? 'buy' as const : 'sell' as const,
      tradeId: String(t.tradeId),
      exchange: this.exchange,
      symbol,
    }));
  }

  /* ------------------------------------------------------------------ */
  /*  WebSocket internals                                                */
  /* ------------------------------------------------------------------ */

  private initWebSocket(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(WS_URL);
      this.ws = ws;

      const onError = (err: Error) => {
        ws.removeListener('open', onOpen);
        reject(err);
      };

      const onOpen = () => {
        ws.removeListener('error', onError);
        this._connected = true;
        this.reconnectAttempts = 0;
        this.startPing();
        this.resubscribe();
        this.emit('connected');
        logger.info('BloFin: WebSocket connected');
        resolve();
      };

      ws.once('open', onOpen);
      ws.once('error', onError);

      ws.on('message', (raw: WebSocket.Data) => this.handleMessage(raw));

      ws.on('close', (code: number, reason: Buffer) => {
        this._connected = false;
        this.clearTimers();
        const msg = reason.toString() || `code ${code}`;
        logger.warn('BloFin: WebSocket closed', { code, reason: msg });
        this.emit('disconnected', msg);
        if (!this.intentionalClose) {
          this.scheduleReconnect();
        }
      });

      ws.on('error', (err: Error) => {
        logger.error('BloFin: WebSocket error', { error: err.message });
        this.emit('error', err);
      });
    });
  }

  private handleMessage(raw: WebSocket.Data): void {
    const text = raw.toString();

    // pong response
    if (text === 'pong') return;

    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(text) as Record<string, unknown>;
    } catch {
      logger.warn('BloFin: failed to parse WS message', { text: text.slice(0, 200) });
      return;
    }

    // subscription confirmations
    if (msg.event === 'subscribe' || msg.event === 'unsubscribe') {
      logger.debug(`BloFin: ${msg.event}`, { arg: msg.arg });
      return;
    }

    if (msg.event === 'error') {
      logger.error('BloFin: WS error event', { code: msg.code, msg: msg.msg });
      this.emit('error', new Error(`WS error ${msg.code}: ${msg.msg}`));
      return;
    }

    const arg = msg.arg as { channel?: string; instId?: string } | undefined;
    const data = msg.data as unknown[] | undefined;
    if (!arg?.channel || !data) return;

    const channel = arg.channel;
    const instId = arg.instId ?? '';

    try {
      if (channel === 'trades') {
        this.handleTrades(data as Record<string, string>[], instId);
      } else if (channel === 'books400') {
        this.handleOrderbook(data as Array<{ bids: string[][]; asks: string[][]; ts: string }>, instId);
      } else if (channel.startsWith('candle')) {
        const tfKey = channel.replace('candle', '');
        const timeframe = this.reverseTimeframe(tfKey);
        this.handleCandle(data as string[][], instId, timeframe);
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      logger.error('BloFin: error handling message', { channel, error: error.message });
      this.emit('error', error);
    }
  }

  private handleTrades(data: Record<string, string>[], symbol: string): void {
    for (const t of data) {
      const trade: Trade = {
        time: Number(t.ts),
        price: Number(t.px),
        size: Number(t.sz),
        side: t.side === 'buy' ? 'buy' : 'sell',
        tradeId: String(t.tradeId),
        exchange: this.exchange,
        symbol,
      };
      this.emit('trade', trade);
    }
  }

  private handleOrderbook(
    data: Array<{ bids: string[][]; asks: string[][]; ts: string }>,
    symbol: string,
  ): void {
    const book = data[0];
    if (!book) return;
    const snapshot: OrderbookSnapshot = {
      time: Number(book.ts),
      exchange: this.exchange,
      symbol,
      bids: book.bids.map(this.parseLevel),
      asks: book.asks.map(this.parseLevel),
    };
    this.emit('orderbook', snapshot);
  }

  private handleCandle(data: string[][], symbol: string, timeframe: Timeframe): void {
    for (const d of data) {
      this.emit('candle', this.parseCandle(d, symbol, timeframe));
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Helpers                                                            */
  /* ------------------------------------------------------------------ */

  private parseCandle(d: string[], symbol: string, timeframe: Timeframe): Candle {
    return {
      time: Number(d[0]),
      open: Number(d[1]),
      high: Number(d[2]),
      low: Number(d[3]),
      close: Number(d[4]),
      volume: Number(d[5]),
      buyVolume: Number(d[6] ?? 0),
      sellVolume: Number(d[7] ?? 0),
      exchange: this.exchange,
      symbol,
      timeframe,
    };
  }

  private parseLevel(l: string[]): OrderbookLevel {
    return { price: Number(l[0]), size: Number(l[1]) };
  }

  private reverseTimeframe(key: string): Timeframe {
    const reverse: Record<string, Timeframe> = {
      '1m': '1m',
      '5m': '5m',
      '15m': '15m',
      '1H': '1h',
      '4H': '4h',
      '1D': '1d',
    };
    return reverse[key] ?? '1m';
  }

  /* ------------------------------------------------------------------ */
  /*  Subscription management                                            */
  /* ------------------------------------------------------------------ */

  private addSubscription(sub: Subscription): void {
    const exists = this.subscriptions.some(
      (s) => s.channel === sub.channel && s.instId === sub.instId,
    );
    if (exists) return;
    this.subscriptions.push(sub);
    if (this._connected && this.ws) {
      this.sendSubscribe([sub]);
    }
  }

  private removeSubscription(sub: Subscription): void {
    this.subscriptions = this.subscriptions.filter(
      (s) => !(s.channel === sub.channel && s.instId === sub.instId),
    );
    if (this._connected && this.ws) {
      this.sendUnsubscribe([sub]);
    }
  }

  private resubscribe(): void {
    if (this.subscriptions.length === 0) return;
    this.sendSubscribe(this.subscriptions);
  }

  private sendSubscribe(subs: Subscription[]): void {
    this.wsSend({ op: 'subscribe', args: subs });
  }

  private sendUnsubscribe(subs: Subscription[]): void {
    this.wsSend({ op: 'unsubscribe', args: subs });
  }

  private wsSend(payload: unknown): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(payload));
  }

  /* ------------------------------------------------------------------ */
  /*  Ping / pong                                                        */
  /* ------------------------------------------------------------------ */

  private startPing(): void {
    this.pingTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send('ping');
      }
    }, PING_INTERVAL_MS);
  }

  /* ------------------------------------------------------------------ */
  /*  Reconnect                                                          */
  /* ------------------------------------------------------------------ */

  private scheduleReconnect(): void {
    this.reconnectAttempts++;
    const base = Math.min(RECONNECT_BASE_MS * Math.pow(2, this.reconnectAttempts - 1), RECONNECT_MAX_MS);
    const jitter = Math.random() * base * 0.3;
    const delay = Math.round(base + jitter);

    logger.info('BloFin: scheduling reconnect', { attempt: this.reconnectAttempts, delay });
    this.emit('reconnecting', this.reconnectAttempts);

    this.reconnectTimer = setTimeout(async () => {
      try {
        await this.initWebSocket();
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        logger.error('BloFin: reconnect failed', { error: error.message });
        this.emit('error', error);
        if (!this.intentionalClose) {
          this.scheduleReconnect();
        }
      }
    }, delay);
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
}
