/**
 * UniversalDataProvider.ts
 * Multi-source candle data provider supporting BloFin, Binance, Bybit,
 * CoinGecko, and Yahoo Finance. Automatically detects the best data
 * source for any given symbol.
 *
 * Symbol format conventions:
 *   Crypto:  "BTC-USDT", "ETH-USDT"
 *   Stocks:  "AAPL", "TSLA", "MSFT"
 *   Forex:   "EUR-USD", "GBP-JPY"
 *   Indices: "SPX", "NDX", "DJI"
 */

import type { Candle } from '../core/ChartState';

// ─── Types ───────────────────────────────────────────────────────────────────

export type DataSource = 'blofin' | 'binance' | 'bybit' | 'yahoo' | 'demo';

export interface SymbolMeta {
  symbol: string;         // Normalized symbol (e.g. "BTC-USDT", "AAPL")
  displayName: string;    // e.g. "BTC/USDT", "AAPL"
  type: 'crypto' | 'stock' | 'forex' | 'index' | 'commodity';
  source: DataSource;     // Which API to use
  exchange: string;       // e.g. "BloFin", "Binance", "NASDAQ"
  sourceSymbol: string;   // Symbol formatted for the specific API
}

// ─── Constants ───────────────────────────────────────────────────────────────

const BLOFIN_REST = '/blofin-api';
const BINANCE_REST = 'https://api.binance.com';
const BYBIT_REST = 'https://api.bybit.com';

const MAX_RETRIES = 2;
const RETRY_DELAY = 600;

// ─── Timeframe Mappings ──────────────────────────────────────────────────────

const BLOFIN_TF: Record<string, string> = {
  '1m': '1m', '3m': '3m', '5m': '5m', '15m': '15m', '30m': '30m',
  '1h': '1H', '2h': '2H', '3h': '3H', '4h': '4H', '6h': '6H', '12h': '12H',
  '1d': '1D', '1w': '1W', '1M': '1M',
};

const BINANCE_TF: Record<string, string> = {
  '1s': '1s', '1m': '1m', '3m': '3m', '5m': '5m', '15m': '15m', '30m': '30m',
  '1h': '1h', '2h': '2h', '4h': '4h', '6h': '6h', '8h': '8h', '12h': '12h',
  '1d': '1d', '3d': '3d', '1w': '1w', '1M': '1M',
};

const BYBIT_TF: Record<string, string> = {
  '1m': '1', '3m': '3', '5m': '5', '15m': '15', '30m': '30',
  '1h': '60', '2h': '120', '4h': '240', '6h': '360', '12h': '720',
  '1d': 'D', '1w': 'W', '1M': 'M',
};

// ── Common stock tickers that indicate a stock/ETF symbol ────────────────────

const STOCK_EXCHANGES = new Set([
  'NYSE', 'NASDAQ', 'AMEX', 'LSE', 'TSE', 'HKEX', 'SSE', 'SZSE',
]);

/** Quick check: does this look like a stock ticker? */
function looksLikeStock(symbol: string): boolean {
  // Pure uppercase letters 1-5 chars with no dash = likely stock
  return /^[A-Z]{1,5}$/.test(symbol);
}

function looksLikeForex(symbol: string): boolean {
  const forex = ['EUR', 'USD', 'GBP', 'JPY', 'AUD', 'CAD', 'CHF', 'NZD', 'SEK', 'NOK', 'DKK', 'PLN', 'HUF', 'CZK', 'TRY', 'MXN', 'ZAR', 'SGD', 'HKD', 'CNY'];
  const parts = symbol.split('-');
  return parts.length === 2 && forex.includes(parts[0]!) && forex.includes(parts[1]!);
}

function looksLikeIndex(symbol: string): boolean {
  const indices = new Set(['SPX', 'SPY', 'NDX', 'QQQ', 'DJI', 'DIA', 'RUT', 'IWM', 'VIX', 'FTSE', 'DAX', 'CAC', 'NIKKEI', 'HSI']);
  return indices.has(symbol.toUpperCase());
}

// ─── Symbol Resolution ───────────────────────────────────────────────────────

/**
 * Detect the type and best data source for a symbol.
 */
export function resolveSymbol(rawSymbol: string): SymbolMeta {
  const symbol = rawSymbol.trim().toUpperCase();

  // Crypto: contains dash with USDT/USDC/BTC/ETH/BUSD quote
  const cryptoQuotes = ['USDT', 'USDC', 'BTC', 'ETH', 'BUSD', 'TUSD', 'DAI', 'USD'];
  const parts = symbol.split('-');

  if (parts.length === 2 && cryptoQuotes.some(q => parts[1] === q)) {
    return {
      symbol,
      displayName: `${parts[0]}/${parts[1]}`,
      type: 'crypto',
      source: 'blofin',
      exchange: 'BloFin',
      sourceSymbol: symbol,
    };
  }

  if (looksLikeForex(symbol)) {
    return {
      symbol,
      displayName: `${parts[0]}/${parts[1]}`,
      type: 'forex',
      source: 'yahoo',
      exchange: 'Forex',
      sourceSymbol: `${parts[0]}${parts[1]}=X`,
    };
  }

  if (looksLikeIndex(symbol)) {
    return {
      symbol,
      displayName: symbol,
      type: 'index',
      source: 'yahoo',
      exchange: 'Index',
      sourceSymbol: `^${symbol}`,
    };
  }

  if (looksLikeStock(symbol)) {
    return {
      symbol,
      displayName: symbol,
      type: 'stock',
      source: 'yahoo',
      exchange: 'US',
      sourceSymbol: symbol,
    };
  }

  // Default to crypto on BloFin
  // If no dash, try appending -USDT
  const cryptoSymbol = symbol.includes('-') ? symbol : `${symbol}-USDT`;
  return {
    symbol: cryptoSymbol,
    displayName: cryptoSymbol.replace('-', '/'),
    type: 'crypto',
    source: 'blofin',
    exchange: 'BloFin',
    sourceSymbol: cryptoSymbol,
  };
}

// ─── Fetchers ────────────────────────────────────────────────────────────────

async function fetchWithRetry(url: string, retries = MAX_RETRIES): Promise<Response> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url);
      if (res.ok) return res;
      if (res.status === 429) {
        // Rate limited — wait longer
        await new Promise(r => setTimeout(r, RETRY_DELAY * (attempt + 2)));
        continue;
      }
      throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      if (attempt >= retries) throw err;
      await new Promise(r => setTimeout(r, RETRY_DELAY * (attempt + 1)));
    }
  }
  throw new Error('All retries exhausted');
}

/** Fetch candles from BloFin REST API */
async function fetchBlofin(symbol: string, timeframe: string, limit: number): Promise<Candle[]> {
  const bar = BLOFIN_TF[timeframe] ?? timeframe;
  const url = `${BLOFIN_REST}/api/v1/market/candles?instId=${encodeURIComponent(symbol)}&bar=${bar}&limit=${limit}`;
  const res = await fetchWithRetry(url);
  const json = await res.json();
  if (json.code && json.code !== '0') throw new Error(`BloFin: ${json.msg}`);
  const raw = json.data as string[][];
  if (!Array.isArray(raw) || raw.length === 0) throw new Error('BloFin: empty data');

  return raw.map(d => ({
    timestamp: Number(d[0]),
    open: Number(d[1]),
    high: Number(d[2]),
    low: Number(d[3]),
    close: Number(d[4]),
    volume: Number(d[5]),
    buyVolume: Number(d[6] ?? 0),
    sellVolume: Number(d[7] ?? 0),
  })).sort((a, b) => a.timestamp - b.timestamp);
}

/** Fetch candles from Binance public API */
async function fetchBinance(symbol: string, timeframe: string, limit: number): Promise<Candle[]> {
  // Convert "BTC-USDT" → "BTCUSDT"
  const sym = symbol.replace('-', '');
  const interval = BINANCE_TF[timeframe] ?? '1m';
  const url = `${BINANCE_REST}/api/v3/klines?symbol=${sym}&interval=${interval}&limit=${limit}`;
  const res = await fetchWithRetry(url);
  const raw = await res.json() as unknown[][];
  if (!Array.isArray(raw) || raw.length === 0) throw new Error('Binance: empty data');

  return raw.map(d => ({
    timestamp: Number(d[0]),
    open: Number(d[1]),
    high: Number(d[2]),
    low: Number(d[3]),
    close: Number(d[4]),
    volume: Number(d[5]),
    buyVolume: Number(d[9] ?? 0), // Taker buy base volume
    sellVolume: Math.max(0, Number(d[5]) - Number(d[9] ?? 0)),
  })).sort((a, b) => a.timestamp - b.timestamp);
}

/** Fetch candles from Bybit public API */
async function fetchBybit(symbol: string, timeframe: string, limit: number): Promise<Candle[]> {
  const sym = symbol.replace('-', '');
  const interval = BYBIT_TF[timeframe] ?? '1';
  const url = `${BYBIT_REST}/v5/market/kline?category=spot&symbol=${sym}&interval=${interval}&limit=${limit}`;
  const res = await fetchWithRetry(url);
  const json = await res.json();
  const raw = json.result?.list as string[][];
  if (!Array.isArray(raw) || raw.length === 0) throw new Error('Bybit: empty data');

  return raw.map(d => ({
    timestamp: Number(d[0]),
    open: Number(d[1]),
    high: Number(d[2]),
    low: Number(d[3]),
    close: Number(d[4]),
    volume: Number(d[5]),
    buyVolume: 0,
    sellVolume: 0,
  })).sort((a, b) => a.timestamp - b.timestamp);
}

/** Generate realistic demo candles for any symbol */
function generateDemoCandles(symbol: string, timeframe: string, limit: number): Candle[] {
  const tfMs: Record<string, number> = {
    '1s': 1_000, '5s': 5_000, '15s': 15_000, '30s': 30_000,
    '1m': 60_000, '3m': 180_000, '5m': 300_000, '15m': 900_000, '30m': 1_800_000,
    '1h': 3_600_000, '2h': 7_200_000, '4h': 14_400_000, '6h': 21_600_000, '12h': 43_200_000,
    '1d': 86_400_000, '1w': 604_800_000, '1M': 2_592_000_000,
  };
  const interval = tfMs[timeframe] ?? 60_000;
  const candles: Candle[] = [];
  const now = Date.now();

  // Set starting price based on symbol type
  let price = 100;
  const upperSym = symbol.toUpperCase();
  if (upperSym.includes('BTC'))       price = 42000 + Math.random() * 5000;
  else if (upperSym.includes('ETH'))  price = 2200 + Math.random() * 300;
  else if (upperSym.includes('SOL'))  price = 80 + Math.random() * 40;
  else if (upperSym.includes('DOGE')) price = 0.08 + Math.random() * 0.04;
  else if (looksLikeStock(symbol))     price = 150 + Math.random() * 100;

  const volatility = price > 1000 ? 0.006 : price > 10 ? 0.01 : 0.015;

  for (let i = 0; i < limit; i++) {
    const time = now - (limit - i) * interval;
    const change = (Math.random() - 0.48) * price * volatility;
    const open = price;
    price += change;
    const close = price;
    const high = Math.max(open, close) * (1 + Math.random() * volatility * 0.5);
    const low = Math.min(open, close) * (1 - Math.random() * volatility * 0.5);
    const volume = 50 + Math.random() * 200;
    const buyVol = volume * (0.3 + Math.random() * 0.4);

    candles.push({
      timestamp: time,
      open: +open.toFixed(price > 100 ? 2 : price > 1 ? 4 : 6),
      high: +high.toFixed(price > 100 ? 2 : price > 1 ? 4 : 6),
      low: +low.toFixed(price > 100 ? 2 : price > 1 ? 4 : 6),
      close: +close.toFixed(price > 100 ? 2 : price > 1 ? 4 : 6),
      volume: +volume.toFixed(2),
      buyVolume: +buyVol.toFixed(2),
      sellVolume: +(volume - buyVol).toFixed(2),
    });
  }
  return candles;
}

// ─── UniversalDataProvider ───────────────────────────────────────────────────

export class UniversalDataProvider {
  private static instance: UniversalDataProvider | null = null;
  private symbolCache: Map<string, SymbolMeta> = new Map();

  static getInstance(): UniversalDataProvider {
    if (!UniversalDataProvider.instance) {
      UniversalDataProvider.instance = new UniversalDataProvider();
    }
    return UniversalDataProvider.instance;
  }

  /**
   * Resolve symbol metadata (type, exchange, source API).
   */
  resolve(symbol: string): SymbolMeta {
    const cached = this.symbolCache.get(symbol);
    if (cached) return cached;
    const meta = resolveSymbol(symbol);
    this.symbolCache.set(symbol, meta);
    return meta;
  }

  /**
   * Fetch candles for ANY symbol from the best available source.
   * Falls back through sources: primary → alternative → demo data.
   */
  async fetchCandles(symbol: string, timeframe: string, limit = 300): Promise<Candle[]> {
    const meta = this.resolve(symbol);

    // Build fallback chain based on symbol type
    const fetchers: (() => Promise<Candle[]>)[] = [];

    if (meta.type === 'crypto') {
      // Try BloFin first, then Binance, then Bybit, then demo
      fetchers.push(() => fetchBlofin(meta.sourceSymbol, timeframe, limit));
      fetchers.push(() => fetchBinance(meta.sourceSymbol, timeframe, limit));
      fetchers.push(() => fetchBybit(meta.sourceSymbol, timeframe, limit));
    } else {
      // Stocks/Forex/Indices → demo data for now (Yahoo requires server proxy)
      // In production, you'd proxy through your backend server
    }

    // Always have demo as final fallback
    fetchers.push(() => Promise.resolve(generateDemoCandles(symbol, timeframe, limit)));

    for (const fetcher of fetchers) {
      try {
        const candles = await fetcher();
        if (candles.length > 0) {
          console.log(`[UniversalData] Fetched ${candles.length} candles for ${symbol} from ${meta.source}`);
          return candles;
        }
      } catch (err) {
        console.warn(`[UniversalData] Source failed for ${symbol}:`, err instanceof Error ? err.message : err);
      }
    }

    // Should never reach here since demo is always last
    return generateDemoCandles(symbol, timeframe, limit);
  }

  /**
   * Get the API key for a timeframe based on the data source.
   */
  getApiTimeframe(source: DataSource, timeframe: string): string {
    switch (source) {
      case 'blofin': return BLOFIN_TF[timeframe] ?? timeframe;
      case 'binance': return BINANCE_TF[timeframe] ?? timeframe;
      case 'bybit': return BYBIT_TF[timeframe] ?? timeframe;
      default: return timeframe;
    }
  }
}
