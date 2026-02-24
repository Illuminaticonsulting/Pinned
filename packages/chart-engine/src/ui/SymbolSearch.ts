/**
 * SymbolSearch.ts
 * TradingView-style symbol search modal with categories, favorites,
 * instant search, and keyboard navigation.
 */

import { SymbolService, type SymbolInfo, type SymbolCategory } from '../services/SymbolService';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface SymbolSearchOptions {
  onSelect: (symbol: string) => void;
  currentSymbol?: string;
}

// ─── Category Config ─────────────────────────────────────────────────────────

const CATEGORIES: { key: SymbolCategory; label: string; icon: string }[] = [
  { key: 'favorites', label: 'Favorites', icon: '★' },
  { key: 'top',       label: 'Top',       icon: '🏆' },
  { key: 'defi',      label: 'DeFi',      icon: '⬡' },
  { key: 'layer1',    label: 'L1',        icon: '◆' },
  { key: 'layer2',    label: 'L2',        icon: '◇' },
  { key: 'meme',      label: 'Meme',      icon: '🐸' },
  { key: 'ai',        label: 'AI',        icon: '⚡' },
  { key: 'gaming',    label: 'Gaming',    icon: '🎮' },
  { key: 'all',       label: 'All',       icon: '∞' },
];

// ─── SymbolSearch ────────────────────────────────────────────────────────────

export class SymbolSearch {
  private overlay: HTMLElement | null = null;
  private modal: HTMLElement | null = null;
  private input: HTMLInputElement | null = null;
  private resultList: HTMLElement | null = null;
  private activeCategory: SymbolCategory = 'favorites';
  private query = '';
  private highlightIdx = 0;
  private filteredSymbols: SymbolInfo[] = [];
  private opts: SymbolSearchOptions;
  private symbolService: SymbolService;
  private isOpen = false;

  constructor(opts: SymbolSearchOptions) {
    this.opts = opts;
    this.symbolService = SymbolService.getInstance();
  }

  // ── Public ─────────────────────────────────────────────────────────────

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
    if (this.isOpen) this.close();
    else this.open();
  }

  // ── Render ─────────────────────────────────────────────────────────────

  private render(): void {
    // Overlay
    this.overlay = document.createElement('div');
    this.overlay.className = 'symbol-search-overlay';
    this.overlay.addEventListener('click', (e) => {
      if (e.target === this.overlay) this.close();
    });

    // Modal
    this.modal = document.createElement('div');
    this.modal.className = 'symbol-search-modal';
    this.modal.innerHTML = `
      <div class="ss-header">
        <div class="ss-search-wrap">
          <svg class="ss-search-icon" width="16" height="16" viewBox="0 0 16 16" fill="none">
            <circle cx="7" cy="7" r="5" stroke="currentColor" stroke-width="1.5"/>
            <path d="M11 11l3.5 3.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
          </svg>
          <input class="ss-input" type="text" placeholder="Search 342+ symbols..." spellcheck="false" autocomplete="off"/>
          <kbd class="ss-kbd">ESC</kbd>
        </div>
        <div class="ss-categories">
          ${CATEGORIES.map(c => `
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
        <span class="ss-hint"><kbd>★</kbd> click to favorite</span>
      </div>
    `;

    this.overlay.appendChild(this.modal);
    document.body.appendChild(this.overlay);

    // Cache refs
    this.input = this.modal.querySelector('.ss-input')!;
    this.resultList = this.modal.querySelector('.ss-results')!;

    // Wire events
    this.input.addEventListener('input', () => {
      this.query = this.input!.value;
      this.highlightIdx = 0;
      this.updateResults();
    });

    this.modal.querySelector('.ss-categories')!.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLElement>('.ss-cat');
      if (!btn) return;
      this.activeCategory = btn.dataset.cat as SymbolCategory;
      this.highlightIdx = 0;
      this.query = '';
      if (this.input) this.input.value = '';
      this.modal!.querySelectorAll('.ss-cat').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      this.updateResults();
    });

    // Initial render
    this.updateResults();
  }

  private updateResults(): void {
    if (!this.resultList) return;

    // Get filtered symbols
    let symbols: SymbolInfo[];
    if (this.query) {
      symbols = this.symbolService.search(this.query);
    } else {
      symbols = this.symbolService.getByCategory(this.activeCategory);
    }

    // Sort: favorites first, then alphabetical
    symbols.sort((a, b) => {
      const aFav = this.symbolService.isFavorite(a.instId) ? 0 : 1;
      const bFav = this.symbolService.isFavorite(b.instId) ? 0 : 1;
      if (aFav !== bFav) return aFav - bFav;
      return a.instId.localeCompare(b.instId);
    });

    this.filteredSymbols = symbols;
    this.highlightIdx = Math.min(this.highlightIdx, symbols.length - 1);

    if (symbols.length === 0) {
      this.resultList.innerHTML = `
        <div class="ss-empty">
          <div class="ss-empty-icon">🔍</div>
          <div class="ss-empty-text">No symbols found</div>
        </div>
      `;
      return;
    }

    this.resultList.innerHTML = symbols.map((s, i) => `
      <div class="ss-item${i === this.highlightIdx ? ' highlighted' : ''}${s.instId === this.opts.currentSymbol ? ' current' : ''}"
           data-symbol="${s.instId}" data-idx="${i}">
        <button class="ss-fav-btn${this.symbolService.isFavorite(s.instId) ? ' active' : ''}" data-fav="${s.instId}" title="Toggle favorite">★</button>
        <div class="ss-item-info">
          <span class="ss-item-base">${s.base}</span>
          <span class="ss-item-quote">/${s.quote}</span>
        </div>
        <div class="ss-item-meta">
          <span class="ss-item-leverage">${s.maxLeverage}×</span>
          <span class="ss-item-type">PERP</span>
        </div>
        ${s.categories.filter(c => c !== 'all').map(c => 
          `<span class="ss-item-tag">${c}</span>`
        ).slice(0, 2).join('')}
      </div>
    `).join('');

    // Wire click events
    this.resultList.querySelectorAll('.ss-item').forEach(el => {
      el.addEventListener('click', (e) => {
        // Check if star was clicked
        const favBtn = (e.target as HTMLElement).closest('.ss-fav-btn');
        if (favBtn) {
          e.stopPropagation();
          const instId = (favBtn as HTMLElement).dataset.fav!;
          this.symbolService.toggleFavorite(instId);
          this.updateResults();
          return;
        }
        const symbol = (el as HTMLElement).dataset.symbol!;
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

    // Scroll highlighted into view
    const highlighted = this.resultList.querySelector('.ss-item.highlighted');
    if (highlighted) {
      highlighted.scrollIntoView({ block: 'nearest' });
    }
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
          this.opts.onSelect(this.filteredSymbols[this.highlightIdx].instId);
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
 * Create the symbol button for the top bar (replaces <select>)
 */
export function createSymbolButton(symbol: string, onClick: () => void): HTMLElement {
  const btn = document.createElement('button');
  btn.className = 'symbol-button';
  btn.id = 'symbolButton';
  btn.innerHTML = `
    <span class="symbol-button__name">${symbol.replace('-', '/')}</span>
    <span class="symbol-button__badge">PERP</span>
    <svg class="symbol-button__arrow" width="10" height="10" viewBox="0 0 10 10" fill="none">
      <path d="M2.5 4L5 6.5L7.5 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
  `;
  btn.addEventListener('click', onClick);
  return btn;
}
