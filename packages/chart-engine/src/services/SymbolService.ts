/**
 * SymbolService.ts
 * Universal symbol service that searches TradingView's public symbol search API
 * for ANY symbol worldwide — stocks, crypto, forex, indices, futures, bonds, CFDs.
 * Also loads BloFin instruments for crypto perpetuals.
 */

// ─── Constants ───────────────────────────────────────────────────────────────

const TV_SEARCH_PROXY = '/tv-search';
const BLOFIN_REST = '/blofin-api';
const REFRESH_INTERVAL = 5 * 60_000;
const STORAGE_KEY = 'pinned:symbols';
const FAVORITES_KEY = 'pinned:symbol-favorites';
const RECENT_KEY = 'pinned:symbol-recent';
const MAX_RECENT = 20;

// ─── Types ───────────────────────────────────────────────────────────────────

export type SymbolCategory =
  | 'favorites' | 'recent' | 'top' | 'crypto' | 'stocks' | 'forex'
  | 'indices' | 'futures' | 'bonds' | 'cfd'
  | 'defi' | 'layer1' | 'layer2' | 'meme' | 'ai' | 'gaming' | 'all';

export type AssetType = 'crypto' | 'stock' | 'forex' | 'index' | 'futures' | 'bond' | 'cfd' | 'fund' | 'economic';

export interface SymbolInfo {
  instId: string;        // Normalized ID: "BTC-USDT", "AAPL", "EUR-USD"
  base: string;          // Base currency/ticker
  quote: string;         // Quote currency or exchange
  displayName: string;   // "BTC/USDT", "Apple Inc", "EUR/USD"
  description: string;   // Full description
  exchange: string;      // "BloFin", "NASDAQ", "FOREX"
  type: AssetType;       // Asset classification
  maxLeverage: number;
  tickSize: number;
  categories: SymbolCategory[];
  isLive: boolean;
  source: 'blofin' | 'binance' | 'bybit' | 'yahoo' | 'tradingview' | 'demo';
  tvSymbol?: string;     // TradingView symbol format e.g. "NASDAQ:AAPL"
  logoUrl?: string;      // Symbol logo URL
  country?: string;      // Country code
  currency?: string;     // Trading currency
}

export interface Instrument {
  instId: string;
  baseCurrency: string;
  quoteCurrency: string;
  contractValue: string;
  maxLeverage: string;
  tickSize: string;
  state: string;
  instType: string;
  contractType: string;
}

// ─── TradingView Search Response Types ───────────────────────────────────────

interface TVSearchResult {
  symbol: string;
  description: string;
  type: string;
  exchange: string;
  currency_code?: string;
  provider_id?: string;
  source2?: { key: string; name: string };
  country?: string;
  typespecs?: string[];
  prefix?: string;
  logoid?: string;
}

// ─── Category Classification ─────────────────────────────────────────────────

const TOP_COINS = new Set([
  'BTC', 'ETH', 'BNB', 'SOL', 'XRP', 'ADA', 'DOGE', 'AVAX', 'DOT', 'MATIC',
  'LINK', 'SHIB', 'UNI', 'ATOM', 'LTC', 'ETC', 'BCH', 'FIL', 'APT', 'ARB',
  'OP', 'NEAR', 'ICP', 'TRX', 'TON', 'SUI', 'SEI', 'INJ', 'WLD',
]);

const DEFI_COINS = new Set([
  'UNI', 'AAVE', 'LINK', 'MKR', 'SNX', 'CRV', 'COMP', 'YFI', 'SUSHI', 'BAL',
  '1INCH', 'DYDX', 'LDO', 'PENDLE', 'JUP', 'RAY', 'GMX', 'GNS', 'RDNT',
]);

const LAYER1_COINS = new Set([
  'BTC', 'ETH', 'SOL', 'ADA', 'DOT', 'AVAX', 'ATOM', 'NEAR', 'ICP', 'TON',
  'SUI', 'SEI', 'APT', 'FTM', 'ALGO', 'EGLD', 'HBAR', 'XLM', 'TRX', 'EOS',
]);

const LAYER2_COINS = new Set([
  'MATIC', 'ARB', 'OP', 'IMX', 'MNT', 'METIS', 'MANTA', 'ZK', 'STRK',
  'BLAST', 'MODE', 'SCROLL', 'ZRO', 'BASE',
]);

const MEME_COINS = new Set([
  'DOGE', 'SHIB', 'PEPE', 'WIF', 'BONK', 'FLOKI', 'MEME', 'BABYDOGE',
  'TURBO', 'PEOPLE', 'BOME', 'BRETT', 'NEIRO', 'POPCAT', 'MOG',
]);

const AI_COINS = new Set([
  'FET', 'AGIX', 'OCEAN', 'RNDR', 'TAO', 'WLD', 'AKT', 'ARKM', 'PRIME',
  'AI16Z', 'VIRTUAL', 'NEURAL', 'GPT', 'GRIFFAIN',
]);

const GAMING_COINS = new Set([
  'AXS', 'SAND', 'MANA', 'GALA', 'IMX', 'ENJ', 'ILV', 'RONIN', 'PIXEL',
  'PORTAL', 'XPRT', 'BEAM', 'YGG', 'SUPER',
]);

function classifyCrypto(base: string): SymbolCategory[] {
  const cats: SymbolCategory[] = ['crypto'];
  if (TOP_COINS.has(base)) cats.push('top');
  if (DEFI_COINS.has(base)) cats.push('defi');
  if (LAYER1_COINS.has(base)) cats.push('layer1');
  if (LAYER2_COINS.has(base)) cats.push('layer2');
  if (MEME_COINS.has(base)) cats.push('meme');
  if (AI_COINS.has(base)) cats.push('ai');
  if (GAMING_COINS.has(base)) cats.push('gaming');
  cats.push('all');
  return cats;
}

function tvTypeToAssetType(tvType: string): AssetType {
  switch (tvType) {
    case 'stock': return 'stock';
    case 'crypto': return 'crypto';
    case 'forex': return 'forex';
    case 'index': return 'index';
    case 'futures': return 'futures';
    case 'bond': return 'bond';
    case 'cfd': return 'cfd';
    case 'fund': return 'fund';
    case 'economic': return 'economic';
    default: return 'stock';
  }
}

function assetTypeToCategory(type: AssetType): SymbolCategory {
  switch (type) {
    case 'crypto': return 'crypto';
    case 'stock': return 'stocks';
    case 'forex': return 'forex';
    case 'index': return 'indices';
    case 'futures': return 'futures';
    case 'bond': return 'bonds';
    case 'cfd': return 'cfd';
    default: return 'all';
  }
}

// ─── SymbolService (singleton) ───────────────────────────────────────────────

export class SymbolService {
  private static instance: SymbolService | null = null;
  private symbols: Map<string, SymbolInfo> = new Map();
  private favorites: Set<string> = new Set();
  private recentSymbols: string[] = [];
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private listeners: Set<() => void> = new Set();
  private loaded = false;
  private searchCache: Map<string, { results: SymbolInfo[]; ts: number }> = new Map();
  private pendingSearch: AbortController | null = null;

  static getInstance(): SymbolService {
    if (!SymbolService.instance) {
      SymbolService.instance = new SymbolService();
    }
    return SymbolService.instance;
  }

  private constructor() {
    this.loadFromStorage();
  }

  // ── Public API ─────────────────────────────────────────────────────────

  async init(): Promise<void> {
    await this.fetchBloFinInstruments();
    this.refreshTimer = setInterval(() => this.fetchBloFinInstruments(), REFRESH_INTERVAL);
  }

  getSymbols(): SymbolInfo[] {
    return [...this.symbols.values()].filter(s => s.isLive);
  }

  getByCategory(cat: SymbolCategory): SymbolInfo[] {
    if (cat === 'favorites') {
      return this.getSymbols().filter(s => this.favorites.has(s.instId));
    }
    if (cat === 'recent') {
      return this.recentSymbols
        .map(id => this.symbols.get(id))
        .filter((s): s is SymbolInfo => !!s);
    }
    return this.getSymbols().filter(s => s.categories.includes(cat));
  }

  /** Local search (BloFin instruments only) */
  search(query: string): SymbolInfo[] {
    const q = query.toUpperCase().trim();
    if (!q) return this.getSymbols();
    return this.getSymbols().filter(s =>
      s.instId.includes(q) || s.base.includes(q) || s.displayName.toUpperCase().includes(q)
    );
  }

  /**
   * Universal search — queries TradingView's public symbol search API
   * to find ANY symbol worldwide: stocks, crypto, forex, indices, futures, bonds.
   */
  async searchUniversal(query: string, type?: string): Promise<SymbolInfo[]> {
    const q = query.trim();
    if (!q) return this.getSymbols().slice(0, 50);

    // Check cache (5s TTL)
    const cacheKey = `${q}|${type ?? ''}`;
    const cached = this.searchCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < 5000) return cached.results;

    // Cancel any pending search
    if (this.pendingSearch) {
      this.pendingSearch.abort();
    }
    this.pendingSearch = new AbortController();

    try {
      const localResults = this.search(q).slice(0, 10);

      // Query TradingView symbol search
      const params = new URLSearchParams({
        text: q,
        hl: '1',
        exchange: '',
        lang: 'en',
        search_type: type ?? '',
        domain: 'production',
        sort_by_country: 'US',
      });

      const res = await fetch(`${TV_SEARCH_PROXY}/symbol_search/v3/?${params}`, {
        signal: this.pendingSearch.signal,
        headers: { 'Accept': 'application/json' },
      });

      if (!res.ok) {
        console.warn(`[SymbolService] TV search failed: ${res.status}`);
        return localResults;
      }

      const data = await res.json();
      const tvResults: TVSearchResult[] = Array.isArray(data?.symbols) ? data.symbols : (Array.isArray(data) ? data : []);

      const results: SymbolInfo[] = [];
      const seen = new Set<string>();

      // Local BloFin results first
      for (const s of localResults) {
        results.push(s);
        seen.add(s.instId);
      }

      // TradingView results
      for (const tv of tvResults.slice(0, 40)) {
        const assetType = tvTypeToAssetType(tv.type);
        const instId = this.tvToInstId(tv);

        if (seen.has(instId)) continue;
        seen.add(instId);

        const categories: SymbolCategory[] = [assetTypeToCategory(assetType), 'all'];
        if (assetType === 'crypto') {
          const base = tv.symbol.split(/[\/\-]/)[0] ?? tv.symbol;
          categories.push(...classifyCrypto(base).filter(c => !categories.includes(c)));
        }

        const info: SymbolInfo = {
          instId,
          base: tv.symbol.split(/[\/\-]/)[0] ?? tv.symbol,
          quote: tv.currency_code ?? tv.symbol.split(/[\/\-]/)[1] ?? 'USD',
          displayName: tv.description || tv.symbol,
          description: `${tv.exchange}: ${tv.description || tv.symbol}`,
          exchange: tv.exchange,
          type: assetType,
          maxLeverage: 0,
          tickSize: 0.01,
          categories,
          isLive: true,
          source: assetType === 'crypto' ? 'binance' : 'yahoo',
          tvSymbol: `${tv.exchange}:${tv.symbol}`,
          logoUrl: tv.logoid ? `https://s3-symbol-logo.tradingview.com/${tv.logoid}.svg` : undefined,
          country: tv.country,
          currency: tv.currency_code,
        };

        // Also cache in our symbols map for later retrieval
        this.symbols.set(instId, info);
        results.push(info);
      }

      this.searchCache.set(cacheKey, { results, ts: Date.now() });
      return results;
    } catch (err: any) {
      if (err.name === 'AbortError') return [];
      console.warn('[SymbolService] Universal search error:', err);
      return this.search(q);
    } finally {
      this.pendingSearch = null;
    }
  }

  /** Convert a TradingView result to our instId format */
  private tvToInstId(tv: TVSearchResult): string {
    if (tv.type === 'crypto') {
      const sym = tv.symbol.replace('/', '-');
      if (sym.includes('-')) return sym;
      for (const q of ['USDT', 'USDC', 'USD', 'BTC', 'ETH', 'BUSD']) {
        if (sym.endsWith(q)) return `${sym.slice(0, -q.length)}-${q}`;
      }
      return sym;
    }
    if (tv.type === 'forex') {
      const sym = tv.symbol.replace('/', '-');
      if (sym.includes('-')) return sym;
      if (sym.length === 6) return `${sym.slice(0, 3)}-${sym.slice(3)}`;
      return sym;
    }
    return tv.symbol;
  }

  addRecent(instId: string): void {
    this.recentSymbols = [instId, ...this.recentSymbols.filter(s => s !== instId)].slice(0, MAX_RECENT);
    this.saveRecent();
  }

  getSymbol(instId: string): SymbolInfo | undefined {
    return this.symbols.get(instId);
  }

  isFavorite(instId: string): boolean {
    return this.favorites.has(instId);
  }

  toggleFavorite(instId: string): void {
    if (this.favorites.has(instId)) {
      this.favorites.delete(instId);
    } else {
      this.favorites.add(instId);
    }
    this.saveFavorites();
    this.notifyListeners();
  }

  getCount(): number {
    return this.getSymbols().length;
  }

  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  isLoaded(): boolean {
    return this.loaded;
  }

  destroy(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
  }

  // ── Private ────────────────────────────────────────────────────────────

  private async fetchBloFinInstruments(): Promise<void> {
    try {
      const url = `${BLOFIN_REST}/api/v1/market/instruments?instType=SWAP`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (json.code !== '0') throw new Error(`BloFin error: ${json.msg}`);

      const instruments = json.data as Instrument[];
      const prevCount = this.symbols.size;

      for (const inst of instruments) {
        const base = inst.baseCurrency;
        const quote = inst.quoteCurrency;
        this.symbols.set(inst.instId, {
          instId: inst.instId,
          base,
          quote,
          displayName: `${base}/${quote}`,
          description: `${base}/${quote} Perpetual`,
          exchange: 'BloFin',
          type: 'crypto',
          maxLeverage: Number(inst.maxLeverage),
          tickSize: Number(inst.tickSize),
          categories: classifyCrypto(base),
          isLive: inst.state === 'live',
          source: 'blofin',
        });
      }

      this.loaded = true;
      this.saveToStorage();
      console.log(`[SymbolService] Loaded ${this.symbols.size} instruments`);
      this.notifyListeners();
    } catch (err) {
      console.warn('[SymbolService] Failed to fetch instruments:', err);
      if (this.symbols.size === 0) this.loadFromStorage();
    }
  }

  private notifyListeners(): void {
    for (const cb of this.listeners) { try { cb(); } catch {} }
  }

  private saveToStorage(): void {
    try {
      const data = [...this.symbols.values()].filter(s => s.source === 'blofin');
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch {}
  }

  private loadFromStorage(): void {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const data = JSON.parse(raw) as SymbolInfo[];
        for (const s of data) this.symbols.set(s.instId, s);
        this.loaded = true;
      }
    } catch {}

    try {
      const raw = localStorage.getItem(FAVORITES_KEY);
      if (raw) {
        this.favorites = new Set(JSON.parse(raw) as string[]);
      } else {
        this.favorites = new Set(['BTC-USDT', 'ETH-USDT', 'SOL-USDT', 'AAPL', 'SPY']);
      }
    } catch {}

    try {
      const raw = localStorage.getItem(RECENT_KEY);
      if (raw) this.recentSymbols = JSON.parse(raw) as string[];
    } catch {}
  }

  private saveFavorites(): void {
    try { localStorage.setItem(FAVORITES_KEY, JSON.stringify([...this.favorites])); } catch {}
  }

  private saveRecent(): void {
    try { localStorage.setItem(RECENT_KEY, JSON.stringify(this.recentSymbols)); } catch {}
  }
}
