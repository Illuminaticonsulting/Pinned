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

const REST_BASE = 'https://api.mexc.com';
const WS_URL = 'wss://wbs.mexc.com/ws';

const TIMEFRAME_MAP: Record<Timeframe, string> = {
  '1m': '1m',
  '5m': '5m',
  '15m': '15m',
  '1h': '60m',
  '4h': '4h',
  '1d': '1d',
};

const MAX_RETRIES = 3;
const RETRY_BASE_MS = 500;
const PING_INTERVAL_MS = 20_000;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

/** Remove dash from symbol: BTC-USDT -> BTCUSDT */
function spotSymbol(symbol: string): string {
  return symbol.replace('-', '');
}

/** Contract symbol format: BTC-USDT -> BTC_USDT */
function contractSymbol(symbol: string): string {
  return symbol.replace('-', '_');
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchWithRetry(url: string, retries = MAX_RETRIES): Promise<unknown> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const res = await fetch(url);
      if (res.status === 429) {
        const wait = RETRY_BASE_MS * Math.pow(2, attempt);
        logger.warn('MEXC: rate limited, backing off', { url, wait, attempt });
        await sleep(wait);
        continue;
      }
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      }
      return await res.json();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < retries - 1) {
        const wait = RETRY_BASE_MS * Math.pow(2, attempt);
        logger.warn('MEXC: request failed, retrying', { url, attempt, error: lastError.message, wait });
        await sleep(wait);
      }
    }
  }
  throw lastError ?? new Error('MEXC: request failed after retries');
}

interface MexcSubscription {
  type: 'trades' | 'orderbook' | 'candles';
  symbol: string;
  timeframe?: Timeframe;
  param: string;
}

export class MexcAdapter extends EventEmitter implements ExchangeAdapter {
  readonly exchange: Exchange = 'mexc';

  private ws: WebSocket | null = null;
  private _connected = false;
  private subscriptions: MexcSubscription[] = [];
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
    logger.info('MEXC: disconnected');
  }

  /* ------------------------------------------------------------------ */
  /*  Subscriptions                                                      */
  /* ------------------------------------------------------------------ */

  subscribeTrades(symbol: string): void {
    const sym = spotSymbol(symbol);
    const param = `spot@public.deals.v3.api@${sym}`;
    this.addSubscription({ type: 'trades', symbol, param });
  }

  subscribeOrderbook(symbol: string): void {
    const sym = spotSymbol(symbol);
    const param = `spot@public.limit.v3.api@${sym}@400`;
    this.addSubscription({ type: 'orderbook', symbol, param });
  }

  subscribeCandles(symbol: string, timeframe: Timeframe): void {
    const sym = spotSymbol(symbol);
    const interval = TIMEFRAME_MAP[timeframe] ?? timeframe;
    const param = `spot@public.kline.v3.api@${sym}@${interval}`;
    this.addSubscription({ type: 'candles', symbol, timeframe, param });
  }

  unsubscribeTrades(symbol: string): void {
    const sym = spotSymbol(symbol);
    const param = `spot@public.deals.v3.api@${sym}`;
    this.removeSubscription(param);
  }

  unsubscribeOrderbook(symbol: string): void {
    const sym = spotSymbol(symbol);
    const param = `spot@public.limit.v3.api@${sym}@400`;
    this.removeSubscription(param);
  }

  unsubscribeCandles(symbol: string, timeframe: Timeframe): void {
    const sym = spotSymbol(symbol);
    const interval = TIMEFRAME_MAP[timeframe] ?? timeframe;
    const param = `spot@public.kline.v3.api@${sym}@${interval}`;
    this.removeSubscription(param);
  }

  /* ------------------------------------------------------------------ */
  /*  REST endpoints                                                     */
  /* ------------------------------------------------------------------ */

  async getHistoricalCandles(symbol: string, timeframe: Timeframe, limit = 200): Promise<Candle[]> {
    const sym = spotSymbol(symbol);
    const interval = TIMEFRAME_MAP[timeframe] ?? timeframe;
    const url = `${REST_BASE}/api/v3/klines?symbol=${sym}&interval=${interval}&limit=${limit}`;
    const data = (await fetchWithRetry(url)) as Array<Array<string | number>>;
    return data.map((d) => this.parseCandle(d, symbol, timeframe));
  }

  async getOrderbook(symbol: string): Promise<OrderbookSnapshot> {
    const sym = spotSymbol(symbol);
    const url = `${REST_BASE}/api/v3/depth?symbol=${sym}&limit=500`;
    const data = (await fetchWithRetry(url)) as {
      bids: Array<[string, string]>;
      asks: Array<[string, string]>;
      lastUpdateId?: number;
    };
    return {
      time: Date.now(),
      exchange: this.exchange,
      symbol,
      bids: data.bids.map(this.parseLevel),
      asks: data.asks.map(this.parseLevel),
    };
  }

  async getTicker(symbol: string): Promise<Ticker> {
    const sym = spotSymbol(symbol);
    const url = `${REST_BASE}/api/v3/ticker/24hr?symbol=${sym}`;
    const data = (await fetchWithRetry(url)) as Record<string, string>;
    return {
      symbol,
      exchange: this.exchange,
      lastPrice: Number(data.lastPrice),
      bid: Number(data.bidPrice),
      ask: Number(data.askPrice),
      volume24h: Number(data.volume ?? data.quoteVolume ?? 0),
      change24h: Number(data.priceChangePercent ?? 0),
      high24h: Number(data.highPrice ?? 0),
      low24h: Number(data.lowPrice ?? 0),
    };
  }

  async getFundingRate(symbol: string): Promise<FundingRate> {
    const sym = contractSymbol(symbol);
    const url = `${REST_BASE}/api/v1/contract/funding_rate/${sym}`;
    const data = (await fetchWithRetry(url)) as {
      data?: { fundingRate?: number; nextSettleTime?: number };
      success?: boolean;
    };
    const fr = data.data ?? {};
    return {
      time: Date.now(),
      exchange: this.exchange,
      symbol,
      rate: Number(fr.fundingRate ?? 0),
      nextFundingTime: Number(fr.nextSettleTime ?? 0),
    };
  }

  async getRecentTrades(symbol: string, limit = 100): Promise<Trade[]> {
    const sym = spotSymbol(symbol);
    const url = `${REST_BASE}/api/v3/trades?symbol=${sym}&limit=${limit}`;
    const data = (await fetchWithRetry(url)) as Array<Record<string, unknown>>;
    return data.map((t) => ({
      time: Number(t.time ?? t.quoteQty ?? Date.now()),
      price: Number(t.price),
      size: Number(t.qty),
      side: (t.isBuyerMaker ? 'sell' : 'buy') as 'buy' | 'sell',
      tradeId: String(t.id),
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
        logger.info('MEXC: WebSocket connected');
        resolve();
      };

      ws.once('open', onOpen);
      ws.once('error', onError);

      ws.on('message', (raw: WebSocket.Data) => this.handleMessage(raw));

      ws.on('close', (code: number, reason: Buffer) => {
        this._connected = false;
        this.clearTimers();
        const msg = reason.toString() || `code ${code}`;
        logger.warn('MEXC: WebSocket closed', { code, reason: msg });
        this.emit('disconnected', msg);
        if (!this.intentionalClose) {
          this.scheduleReconnect();
        }
      });

      ws.on('error', (err: Error) => {
        logger.error('MEXC: WebSocket error', { error: err.message });
        this.emit('error', err);
      });
    });
  }

  private handleMessage(raw: WebSocket.Data): void {
    const text = raw.toString();

    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(text) as Record<string, unknown>;
    } catch {
      logger.warn('MEXC: failed to parse WS message', { text: text.slice(0, 200) });
      return;
    }

    // Pong response
    if (msg.msg === 'PONG' || msg.method === 'PONG') return;

    // Subscription confirmation
    if (msg.msg === 'SUBSCRIPTION' || msg.code === 0) {
      logger.debug('MEXC: subscription confirmed', { msg });
      return;
    }

    const channel = msg.c as string | undefined;
    const data = msg.d as Record<string, unknown> | undefined;

    if (!channel || !data) return;

    try {
      if (channel.includes('public.deals')) {
        this.handleTrades(data, channel);
      } else if (channel.includes('public.limit')) {
        this.handleOrderbook(data, channel);
      } else if (channel.includes('public.kline')) {
        this.handleCandle(data, channel);
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      logger.error('MEXC: error handling message', { channel, error: error.message });
      this.emit('error', error);
    }
  }

  private handleTrades(data: Record<string, unknown>, channel: string): void {
    const symbol = this.extractSymbolFromChannel(channel);
    const origSymbol = this.findOriginalSymbol(symbol);
    const deals = data.deals as Array<Record<string, unknown>> | undefined;
    if (!deals) return;

    for (const t of deals) {
      const trade: Trade = {
        time: Number(t.t ?? Date.now()),
        price: Number(t.p),
        size: Number(t.v),
        side: Number(t.S) === 1 ? 'buy' : 'sell',
        tradeId: String(t.t ?? Date.now()),
        exchange: this.exchange,
        symbol: origSymbol,
      };
      this.emit('trade', trade);
    }
  }

  private handleOrderbook(data: Record<string, unknown>, channel: string): void {
    const symbol = this.extractSymbolFromChannel(channel);
    const origSymbol = this.findOriginalSymbol(symbol);
    const bids = (data.bids ?? data.b) as Array<{ p: string; v: string }> | string[][] | undefined;
    const asks = (data.asks ?? data.a) as Array<{ p: string; v: string }> | string[][] | undefined;

    const snapshot: OrderbookSnapshot = {
      time: Number(data.r ?? Date.now()),
      exchange: this.exchange,
      symbol: origSymbol,
      bids: this.parseMexcLevels(bids),
      asks: this.parseMexcLevels(asks),
    };
    this.emit('orderbook', snapshot);
  }

  private handleCandle(data: Record<string, unknown>, channel: string): void {
    const symbol = this.extractSymbolFromChannel(channel);
    const origSymbol = this.findOriginalSymbol(symbol);
    const sub = this.subscriptions.find((s) => s.type === 'candles' && spotSymbol(s.symbol) === symbol);
    const timeframe = sub?.timeframe ?? '1m';
    const k = data.k as Record<string, unknown> | undefined;
    if (!k) return;

    const candle: Candle = {
      time: Number(k.t ?? data.t ?? Date.now()),
      open: Number(k.o),
      high: Number(k.h),
      low: Number(k.l),
      close: Number(k.c),
      volume: Number(k.v ?? k.a ?? 0),
      buyVolume: 0,
      sellVolume: 0,
      exchange: this.exchange,
      symbol: origSymbol,
      timeframe,
    };
    this.emit('candle', candle);
  }

  /* ------------------------------------------------------------------ */
  /*  Helpers                                                            */
  /* ------------------------------------------------------------------ */

  private parseCandle(d: Array<string | number>, symbol: string, timeframe: Timeframe): Candle {
    return {
      time: Number(d[0]),
      open: Number(d[1]),
      high: Number(d[2]),
      low: Number(d[3]),
      close: Number(d[4]),
      volume: Number(d[5]),
      buyVolume: 0,
      sellVolume: 0,
      exchange: this.exchange,
      symbol,
      timeframe,
    };
  }

  private parseLevel(l: [string, string]): OrderbookLevel {
    return { price: Number(l[0]), size: Number(l[1]) };
  }

  private parseMexcLevels(levels: Array<{ p: string; v: string }> | string[][] | undefined): OrderbookLevel[] {
    if (!levels) return [];
    return levels.map((l) => {
      if (Array.isArray(l)) {
        return { price: Number(l[0]), size: Number(l[1]) };
      }
      return { price: Number(l.p), size: Number(l.v) };
    });
  }

  /** Extract the symbol portion from a MEXC channel string, e.g. spot@public.deals.v3.api@BTCUSDT -> BTCUSDT */
  private extractSymbolFromChannel(channel: string): string {
    const parts = channel.split('@');
    // For deals: spot@public.deals.v3.api@BTCUSDT  => parts[2] = BTCUSDT
    // For orderbook: spot@public.limit.v3.api@BTCUSDT@400 => parts[2] = BTCUSDT
    // For kline: spot@public.kline.v3.api@BTCUSDT@1m => parts[2] = BTCUSDT
    return parts[2] ?? '';
  }

  /** Find the original dashed symbol from subscriptions given the flat symbol */
  private findOriginalSymbol(flatSymbol: string): string {
    const sub = this.subscriptions.find((s) => spotSymbol(s.symbol) === flatSymbol);
    return sub?.symbol ?? flatSymbol;
  }

  /* ------------------------------------------------------------------ */
  /*  Subscription management                                            */
  /* ------------------------------------------------------------------ */

  private addSubscription(sub: MexcSubscription): void {
    const exists = this.subscriptions.some((s) => s.param === sub.param);
    if (exists) return;
    this.subscriptions.push(sub);
    if (this._connected && this.ws) {
      this.sendSubscribe([sub.param]);
    }
  }

  private removeSubscription(param: string): void {
    this.subscriptions = this.subscriptions.filter((s) => s.param !== param);
    if (this._connected && this.ws) {
      this.sendUnsubscribe([param]);
    }
  }

  private resubscribe(): void {
    if (this.subscriptions.length === 0) return;
    const params = this.subscriptions.map((s) => s.param);
    this.sendSubscribe(params);
  }

  private sendSubscribe(params: string[]): void {
    this.wsSend({ method: 'SUBSCRIPTION', params });
  }

  private sendUnsubscribe(params: string[]): void {
    this.wsSend({ method: 'UNSUBSCRIPTION', params });
  }

  private wsSend(payload: unknown): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(payload));
  }

  /* ------------------------------------------------------------------ */
  /*  Ping                                                               */
  /* ------------------------------------------------------------------ */

  private startPing(): void {
    this.pingTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.wsSend({ method: 'PING' });
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

    logger.info('MEXC: scheduling reconnect', { attempt: this.reconnectAttempts, delay });
    this.emit('reconnecting', this.reconnectAttempts);

    this.reconnectTimer = setTimeout(async () => {
      try {
        await this.initWebSocket();
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        logger.error('MEXC: reconnect failed', { error: error.message });
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
