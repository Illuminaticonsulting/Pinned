/**
 * SymbolService.ts
 * Auto-syncs all available BloFin trading instruments.
 * Fetches the full instrument list on startup, refreshes periodically,
 * and categorizes symbols for the search UI.
 */

// ─── Constants ───────────────────────────────────────────────────────────────

const REST_PROXY = '/blofin-api';
const REFRESH_INTERVAL = 5 * 60_000; // 5 minutes
const STORAGE_KEY = 'pinned:symbols';
const FAVORITES_KEY = 'pinned:symbol-favorites';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface Instrument {
  instId: string;        // e.g. "BTC-USDT"
  baseCurrency: string;  // e.g. "BTC"
  quoteCurrency: string; // e.g. "USDT"
  contractValue: string;
  maxLeverage: string;
  tickSize: string;
  state: string;         // "live" | "suspend"
  instType: string;      // "SWAP"
  contractType: string;  // "linear"
}

export type SymbolCategory = 'favorites' | 'top' | 'defi' | 'layer1' | 'layer2' | 'meme' | 'ai' | 'gaming' | 'all';

export interface SymbolInfo {
  instId: string;
  base: string;
  quote: string;
  maxLeverage: number;
  tickSize: number;
  categories: SymbolCategory[];
  isLive: boolean;
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

function classifySymbol(base: string): SymbolCategory[] {
  const cats: SymbolCategory[] = [];
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

// ─── SymbolService (singleton) ───────────────────────────────────────────────

export class SymbolService {
  private static instance: SymbolService | null = null;
  private symbols: Map<string, SymbolInfo> = new Map();
  private favorites: Set<string> = new Set();
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private listeners: Set<() => void> = new Set();
  private loaded = false;

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

  /** Initialize: fetch instruments from BloFin, start refresh timer */
  async init(): Promise<void> {
    await this.fetchInstruments();
    this.refreshTimer = setInterval(() => this.fetchInstruments(), REFRESH_INTERVAL);
  }

  /** Get all live symbols */
  getSymbols(): SymbolInfo[] {
    return [...this.symbols.values()].filter(s => s.isLive);
  }

  /** Get symbols by category */
  getByCategory(cat: SymbolCategory): SymbolInfo[] {
    if (cat === 'favorites') {
      return this.getSymbols().filter(s => this.favorites.has(s.instId));
    }
    return this.getSymbols().filter(s => s.categories.includes(cat));
  }

  /** Search symbols by query (matches instId or base) */
  search(query: string): SymbolInfo[] {
    const q = query.toUpperCase().trim();
    if (!q) return this.getSymbols();
    return this.getSymbols().filter(s =>
      s.instId.includes(q) || s.base.includes(q)
    );
  }

  /** Get a specific symbol info */
  getSymbol(instId: string): SymbolInfo | undefined {
    return this.symbols.get(instId);
  }

  /** Check if a symbol is favorited */
  isFavorite(instId: string): boolean {
    return this.favorites.has(instId);
  }

  /** Toggle favorite status */
  toggleFavorite(instId: string): void {
    if (this.favorites.has(instId)) {
      this.favorites.delete(instId);
    } else {
      this.favorites.add(instId);
    }
    this.saveFavorites();
    this.notifyListeners();
  }

  /** Get total count */
  getCount(): number {
    return this.getSymbols().length;
  }

  /** Subscribe to symbol list changes (new listings/delistings) */
  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** Is the service loaded? */
  isLoaded(): boolean {
    return this.loaded;
  }

  destroy(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
  }

  // ── Private ────────────────────────────────────────────────────────────

  private async fetchInstruments(): Promise<void> {
    try {
      const url = `${REST_PROXY}/api/v1/market/instruments?instType=SWAP`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (json.code !== '0') throw new Error(`BloFin error: ${json.msg}`);

      const instruments = json.data as Instrument[];
      const prevCount = this.symbols.size;
      const newSymbols = new Map<string, SymbolInfo>();

      for (const inst of instruments) {
        const base = inst.baseCurrency;
        const quote = inst.quoteCurrency;
        newSymbols.set(inst.instId, {
          instId: inst.instId,
          base,
          quote,
          maxLeverage: Number(inst.maxLeverage),
          tickSize: Number(inst.tickSize),
          categories: classifySymbol(base),
          isLive: inst.state === 'live',
        });
      }

      this.symbols = newSymbols;
      this.loaded = true;
      this.saveToStorage();

      const newCount = this.symbols.size;
      if (prevCount > 0 && newCount !== prevCount) {
        console.log(`[SymbolService] Symbol list updated: ${prevCount} → ${newCount}`);
      } else {
        console.log(`[SymbolService] Loaded ${newCount} instruments`);
      }

      this.notifyListeners();
    } catch (err) {
      console.warn('[SymbolService] Failed to fetch instruments:', err);
      // If we have cached data, keep using it
      if (this.symbols.size === 0) {
        this.loadFromStorage();
      }
    }
  }

  private notifyListeners(): void {
    for (const cb of this.listeners) {
      try { cb(); } catch {}
    }
  }

  private saveToStorage(): void {
    try {
      const data = [...this.symbols.values()];
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch {}
  }

  private loadFromStorage(): void {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const data = JSON.parse(raw) as SymbolInfo[];
        for (const s of data) {
          this.symbols.set(s.instId, s);
        }
        this.loaded = true;
      }
    } catch {}

    try {
      const raw = localStorage.getItem(FAVORITES_KEY);
      if (raw) {
        const arr = JSON.parse(raw) as string[];
        this.favorites = new Set(arr);
      } else {
        // Default favorites
        this.favorites = new Set(['BTC-USDT', 'ETH-USDT', 'SOL-USDT', 'DOGE-USDT', 'ARB-USDT']);
      }
    } catch {}
  }

  private saveFavorites(): void {
    try {
      localStorage.setItem(FAVORITES_KEY, JSON.stringify([...this.favorites]));
    } catch {}
  }
}
