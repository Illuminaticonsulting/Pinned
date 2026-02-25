/**
 * SymbolSearch.ts
 * TradingView-quality universal symbol search modal.
 * Searches ANY symbol worldwide via TradingView's public search API —
 * stocks, crypto, forex, indices, futures, bonds, ETFs, CFDs.
 *
 * Features:
 * - Debounced universal search with 200ms delay
 * - Asset type filter tabs (All, Stocks, Crypto, Forex, Indices, Futures)
 * - Symbol logos from TradingView CDN
 * - Asset type badges with color coding
 * - Favorites with star toggle
 * - Recent symbols section
 * - Full keyboard navigation (↑/↓/Enter/Esc)
 * - Exchange & description display
 */

import { SymbolService, type SymbolInfo, type SymbolCategory } from '../services/SymbolService';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface SymbolSearchOptions {
  onSelect: (symbol: string) => void;
  currentSymbol?: string;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const SEARCH_DEBOUNCE = 200;

const TYPE_TABS: { key: string; label: string; searchType: string }[] = [
  { key: 'all',     label: 'All',       searchType: '' },
  { key: 'stocks',  label: 'Stocks',    searchType: 'stock' },
  { key: 'crypto',  label: 'Crypto',    searchType: 'crypto' },
  { key: 'forex',   label: 'Forex',     searchType: 'forex' },
  { key: 'indices', label: 'Indices',   searchType: 'index' },
  { key: 'futures', label: 'Futures',   searchType: 'futures' },
  { key: 'bonds',   label: 'Bonds',     searchType: 'bond' },
];

const ASSET_BADGE_COLORS: Record<string, string> = {
  crypto:  '#f59e0b',
  stock:   '#3b82f6',
  forex:   '#10b981',
  index:   '#8b5cf6',
  futures: '#ef4444',
  bond:    '#6366f1',
  cfd:     '#ec4899',
  fund:    '#14b8a6',
  economic:'#64748b',
};

const CATEGORY_FILTERS: { key: SymbolCategory; label: string; icon: string }[] = [
  { key: 'favorites', label: 'Favorites', icon: '★' },
  { key: 'recent',    label: 'Recent',    icon: '🕐' },
  { key: 'top',       label: 'Top',       icon: '🏆' },
  { key: 'defi',      label: 'DeFi',      icon: '⬡' },
  { key: 'layer1',    label: 'L1',        icon: '◆' },
  { key: 'layer2',    label: 'L2',        icon: '◇' },
  { key: 'meme',      label: 'Meme',      icon: '🐸' },
  { key: 'ai',        label: 'AI',        icon: '⚡' },
  { key: 'gaming',    label: 'Gaming',    icon: '🎮' },
];

// ─── SymbolSearch Class ──────────────────────────────────────────────────────

export class SymbolSearch {
  private overlay: HTMLElement | null = null;
  private modal: HTMLElement | null = null;
  private input: HTMLInputElement | null = null;
  private resultList: HTMLElement | null = null;
  private activeTypeTab = 'all';
  private activeCategory: SymbolCategory = 'favorites';
  private query = '';
  private highlightIdx = 0;
  private filteredSymbols: SymbolInfo[] = [];
  private opts: SymbolSearchOptions;
  private symbolService: SymbolService;
  private isOpen = false;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private isSearching = false;

  constructor(opts: SymbolSearchOptions) {
    this.opts = opts;
    this.symbolService = SymbolService.getInstance();
  }

  open(): void {
    if (this.isOpen) return;
    this.isOpen = true;
    this.render();
    requestAnimationFrame(() => {
      this.overlay?.classList.add('open');
      this.input?.focus();
    });
    document.addEventListener('keydown', this.handleGlobalKey);
  }

  close(): void {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.overlay?.classList.remove('open');
    document.removeEventListener('keydown', this.handleGlobalKey);
    setTimeout(() => {
      this.overlay?.remove();
      this.overlay = null;
      this.modal = null;
      this.input = null;
      this.resultList = null;
    }, 200);
  }

  toggle(): void {
    if (this.isOpen) this.close(); else this.open();
  }

  // ── Render ─────────────────────────────────────────────────────────────

  private render(): void {
    this.overlay = document.createElement('div');
    this.overlay.className = 'symbol-search-overlay';
    this.overlay.addEventListener('click', (e) => {
      if (e.target === this.overlay) this.close();
    });

    this.modal = document.createElement('div');
    this.modal.className = 'symbol-search-modal';
    this.modal.innerHTML = `
      <div class="ss-header">
        <div class="ss-search-wrap">
          <svg class="ss-search-icon" width="16" height="16" viewBox="0 0 16 16" fill="none">
            <circle cx="7" cy="7" r="5" stroke="currentColor" stroke-width="1.5"/>
            <path d="M11 11l3.5 3.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
          </svg>
          <input class="ss-input" type="text" placeholder="Search any symbol — stocks, crypto, forex, indices..." spellcheck="false" autocomplete="off"/>
          <kbd class="ss-kbd">ESC</kbd>
        </div>
        <div class="ss-type-tabs">
          ${TYPE_TABS.map(t => `
            <button class="ss-type-tab${t.key === this.activeTypeTab ? ' active' : ''}" data-type="${t.key}">
              ${t.label}
            </button>
          `).join('')}
        </div>
        <div class="ss-categories">
          ${CATEGORY_FILTERS.map(c => `
            <button class="ss-cat${c.key === this.activeCategory ? ' active' : ''}" data-cat="${c.key}">
              <span class="ss-cat-icon">${c.icon}</span>
              <span class="ss-cat-label">${c.label}</span>
            </button>
          `).join('')}
        </div>
      </div>
      <div class="ss-results" id="ssResults">
        <div class="ss-loading">Loading symbols...</div>
      </div>
      <div class="ss-footer">
        <span class="ss-hint"><kbd>↑</kbd><kbd>↓</kbd> navigate</span>
        <span class="ss-hint"><kbd>↵</kbd> select</span>
        <span class="ss-hint">Search any ticker — AAPL, BTC, EUR/USD, SPX...</span>
      </div>
    `;

    this.overlay.appendChild(this.modal);
    document.body.appendChild(this.overlay);

    this.input = this.modal.querySelector('.ss-input')!;
    this.resultList = this.modal.querySelector('.ss-results')!;

    // Input search with debounce
    this.input.addEventListener('input', () => {
      this.query = this.input!.value;
      this.highlightIdx = 0;
      if (this.debounceTimer) clearTimeout(this.debounceTimer);
      if (this.query.length > 0) {
        this.showSearching();
        this.debounceTimer = setTimeout(() => this.performSearch(), SEARCH_DEBOUNCE);
      } else {
        this.updateLocalResults();
      }
    });

    // Type tabs
    this.modal.querySelector('.ss-type-tabs')!.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLElement>('.ss-type-tab');
      if (!btn) return;
      this.activeTypeTab = btn.dataset.type!;
      this.modal!.querySelectorAll('.ss-type-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      this.highlightIdx = 0;
      if (this.query) {
        this.performSearch();
      } else {
        this.updateLocalResults();
      }
    });

    // Category filters
    this.modal.querySelector('.ss-categories')!.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLElement>('.ss-cat');
      if (!btn) return;
      this.activeCategory = btn.dataset.cat as SymbolCategory;
      this.highlightIdx = 0;
      this.query = '';
      if (this.input) this.input.value = '';
      this.modal!.querySelectorAll('.ss-cat').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      this.updateLocalResults();
    });

    this.updateLocalResults();
  }

  private showSearching(): void {
    if (!this.resultList) return;
    this.isSearching = true;
    // Show a subtle spinner in the existing results
    const existingSpinner = this.resultList.querySelector('.ss-searching');
    if (!existingSpinner) {
      const spinner = document.createElement('div');
      spinner.className = 'ss-searching';
      spinner.textContent = 'Searching worldwide...';
      this.resultList.prepend(spinner);
    }
  }

  private async performSearch(): Promise<void> {
    if (!this.query) {
      this.updateLocalResults();
      return;
    }

    try {
      const tab = TYPE_TABS.find(t => t.key === this.activeTypeTab);
      const searchType = tab?.searchType ?? '';
      const results = await this.symbolService.searchUniversal(this.query, searchType);
      this.isSearching = false;
      this.filteredSymbols = results;
      this.highlightIdx = Math.min(this.highlightIdx, results.length - 1);
      this.renderResults(results);
    } catch {
      this.isSearching = false;
      this.updateLocalResults();
    }
  }

  private updateLocalResults(): void {
    let symbols: SymbolInfo[];
    if (this.query) {
      symbols = this.symbolService.search(this.query);
    } else {
      symbols = this.symbolService.getByCategory(this.activeCategory);
    }

    // Filter by type tab
    if (this.activeTypeTab !== 'all') {
      const typeMap: Record<string, string> = {
        stocks: 'stock', crypto: 'crypto', forex: 'forex',
        indices: 'index', futures: 'futures', bonds: 'bond',
      };
      const filterType = typeMap[this.activeTypeTab];
      if (filterType) {
        symbols = symbols.filter(s => s.type === filterType);
      }
    }

    symbols.sort((a, b) => {
      const aFav = this.symbolService.isFavorite(a.instId) ? 0 : 1;
      const bFav = this.symbolService.isFavorite(b.instId) ? 0 : 1;
      if (aFav !== bFav) return aFav - bFav;
      return a.instId.localeCompare(b.instId);
    });

    this.filteredSymbols = symbols;
    this.highlightIdx = Math.min(this.highlightIdx, symbols.length - 1);
    this.renderResults(symbols);
  }

  private renderResults(symbols: SymbolInfo[]): void {
    if (!this.resultList) return;

    if (symbols.length === 0) {
      this.resultList.innerHTML = `
        <div class="ss-empty">
          <div class="ss-empty-icon">🔍</div>
          <div class="ss-empty-text">No symbols found</div>
          <div class="ss-empty-hint">Try searching for "AAPL", "BTC", "EUR/USD", or "SPX"</div>
        </div>
      `;
      return;
    }

    this.resultList.innerHTML = symbols.map((s, i) => {
      const badgeColor = ASSET_BADGE_COLORS[s.type] ?? '#64748b';
      const typeLabel = s.type.charAt(0).toUpperCase() + s.type.slice(1);
      const isFav = this.symbolService.isFavorite(s.instId);
      const isCurrent = s.instId === this.opts.currentSymbol;
      const logoHtml = s.logoUrl
        ? `<img class="ss-item-logo" src="${s.logoUrl}" onerror="this.style.display='none'" alt=""/>`
        : `<div class="ss-item-logo-placeholder">${(s.base || s.instId).charAt(0)}</div>`;

      return `
        <div class="ss-item${i === this.highlightIdx ? ' highlighted' : ''}${isCurrent ? ' current' : ''}"
             data-symbol="${s.instId}" data-idx="${i}">
          <button class="ss-fav-btn${isFav ? ' active' : ''}" data-fav="${s.instId}" title="Toggle favorite">★</button>
          ${logoHtml}
          <div class="ss-item-info">
            <div class="ss-item-row1">
              <span class="ss-item-base">${s.base || s.instId}</span>
              ${s.quote ? `<span class="ss-item-quote">/${s.quote}</span>` : ''}
              <span class="ss-item-badge" style="background:${badgeColor}">${typeLabel}</span>
            </div>
            <div class="ss-item-row2">
              <span class="ss-item-desc">${s.displayName || s.description || ''}</span>
              <span class="ss-item-exchange">${s.exchange}</span>
            </div>
          </div>
          ${s.maxLeverage > 0 ? `<span class="ss-item-leverage">${s.maxLeverage}×</span>` : ''}
          ${s.country ? `<span class="ss-item-country">${s.country}</span>` : ''}
        </div>
      `;
    }).join('');

    // Wire events
    this.resultList.querySelectorAll('.ss-item').forEach(el => {
      el.addEventListener('click', (e) => {
        const favBtn = (e.target as HTMLElement).closest('.ss-fav-btn');
        if (favBtn) {
          e.stopPropagation();
          const instId = (favBtn as HTMLElement).dataset.fav!;
          this.symbolService.toggleFavorite(instId);
          this.renderResults(this.filteredSymbols);
          return;
        }
        const symbol = (el as HTMLElement).dataset.symbol!;
        this.symbolService.addRecent(symbol);
        this.opts.onSelect(symbol);
        this.close();
      });

      el.addEventListener('mouseenter', () => {
        const idx = Number((el as HTMLElement).dataset.idx);
        this.highlightIdx = idx;
        this.resultList!.querySelectorAll('.ss-item').forEach((item, j) => {
          item.classList.toggle('highlighted', j === idx);
        });
      });
    });

    const highlighted = this.resultList.querySelector('.ss-item.highlighted');
    if (highlighted) highlighted.scrollIntoView({ block: 'nearest' });
  }

  // ── Keyboard ───────────────────────────────────────────────────────────

  private handleGlobalKey = (e: KeyboardEvent): void => {
    if (!this.isOpen) return;

    switch (e.key) {
      case 'Escape':
        e.preventDefault();
        this.close();
        break;
      case 'ArrowDown':
        e.preventDefault();
        this.highlightIdx = Math.min(this.highlightIdx + 1, this.filteredSymbols.length - 1);
        this.updateHighlight();
        break;
      case 'ArrowUp':
        e.preventDefault();
        this.highlightIdx = Math.max(this.highlightIdx - 1, 0);
        this.updateHighlight();
        break;
      case 'Enter':
        e.preventDefault();
        if (this.filteredSymbols[this.highlightIdx]) {
          const sym = this.filteredSymbols[this.highlightIdx];
          this.symbolService.addRecent(sym.instId);
          this.opts.onSelect(sym.instId);
          this.close();
        }
        break;
    }
  };

  private updateHighlight(): void {
    if (!this.resultList) return;
    this.resultList.querySelectorAll('.ss-item').forEach((el, i) => {
      el.classList.toggle('highlighted', i === this.highlightIdx);
    });
    const highlighted = this.resultList.querySelector('.ss-item.highlighted');
    if (highlighted) highlighted.scrollIntoView({ block: 'nearest' });
  }
}

/**
 * Create the symbol button for the top bar
 */
export function createSymbolButton(symbol: string, onClick: () => void): HTMLElement {
  const btn = document.createElement('button');
  btn.className = 'symbol-button';
  btn.id = 'symbolButton';
  btn.innerHTML = `
    <span class="symbol-button__name">${symbol.replace('-', '/')}</span>
    <svg class="symbol-button__arrow" width="10" height="10" viewBox="0 0 10 10" fill="none">
      <path d="M2.5 4L5 6.5L7.5 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
  `;
  btn.addEventListener('click', onClick);
  return btn;
}
