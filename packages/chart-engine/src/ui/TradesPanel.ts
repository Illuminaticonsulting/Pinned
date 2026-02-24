/**
 * TradesPanel — Recent trades panel (right sidebar tab).
 *
 * Shows a scrolling list of recent trades with virtual scrolling,
 * big-trade aggregation display, and filter controls.
 */

import type { BigTrade } from '../core/DataManager';

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface Trade {
  time: number;       // ms timestamp
  price: number;
  size: number;
  side: 'buy' | 'sell';
}

interface TradeItem {
  type: 'trade' | 'bigTrade';
  data: Trade | BigTrade;
}

type TradeFilter = 'all' | 'buy' | 'sell';

// ─── Constants ─────────────────────────────────────────────────────────────────

/** Maximum trades kept in the buffer before trimming. */
const MAX_BUFFER = 2000;
const ROW_HEIGHT = 22;
const BIG_TRADE_ROW_HEIGHT = 32;

const STYLES = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
    fontSize: '11px',
    color: '#e5e7eb',
    userSelect: 'none',
    overflow: 'hidden',
  } as Partial<CSSStyleDeclaration>,
  filterBar: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '4px 8px',
    borderBottom: '1px solid #374151',
    flexShrink: '0',
    gap: '4px',
  } as Partial<CSSStyleDeclaration>,
  filterBtnGroup: {
    display: 'flex',
    gap: '2px',
  } as Partial<CSSStyleDeclaration>,
  filterBtn: {
    appearance: 'none',
    border: '1px solid #374151',
    background: 'transparent',
    color: '#9ca3af',
    fontSize: '10px',
    padding: '2px 6px',
    borderRadius: '3px',
    cursor: 'pointer',
    transition: 'all 150ms ease',
  } as Partial<CSSStyleDeclaration>,
  filterBtnActive: {
    background: '#6366f1',
    color: '#fff',
    borderColor: '#6366f1',
  } as Partial<CSSStyleDeclaration>,
  minSizeInput: {
    width: '56px',
    background: '#0a0e17',
    color: '#e5e7eb',
    border: '1px solid #374151',
    borderRadius: '3px',
    fontSize: '10px',
    padding: '2px 4px',
    outline: 'none',
    fontFamily: "'JetBrains Mono', monospace",
  } as Partial<CSSStyleDeclaration>,
  scrollContainer: {
    flex: '1',
    overflowY: 'auto',
    overflowX: 'hidden',
    position: 'relative',
  } as Partial<CSSStyleDeclaration>,
  viewport: {
    position: 'relative',
    width: '100%',
  } as Partial<CSSStyleDeclaration>,
  tradeRow: {
    display: 'flex',
    alignItems: 'center',
    height: `${ROW_HEIGHT}px`,
    padding: '0 8px',
    gap: '6px',
    transition: 'background 200ms ease',
    position: 'absolute',
    left: '0',
    right: '0',
  } as Partial<CSSStyleDeclaration>,
  bigTradeRow: {
    display: 'flex',
    alignItems: 'center',
    height: `${BIG_TRADE_ROW_HEIGHT}px`,
    padding: '0 8px',
    gap: '6px',
    position: 'absolute',
    left: '0',
    right: '0',
    borderRadius: '4px',
    margin: '0 4px',
  } as Partial<CSSStyleDeclaration>,
  timeText: {
    color: '#6b7280',
    fontSize: '10px',
    flexShrink: '0',
    width: '68px',
  } as Partial<CSSStyleDeclaration>,
  priceText: {
    fontWeight: '500',
    flexShrink: '0',
    width: '72px',
    textAlign: 'right',
  } as Partial<CSSStyleDeclaration>,
  sizeText: {
    flex: '1',
    textAlign: 'right',
  } as Partial<CSSStyleDeclaration>,
  badge: {
    fontSize: '8px',
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
    padding: '1px 4px',
    borderRadius: '2px',
    flexShrink: '0',
  } as Partial<CSSStyleDeclaration>,
};

// ─── TradesPanel ───────────────────────────────────────────────────────────────

export class TradesPanel {
  private container: HTMLElement | null = null;
  private wrapperEl: HTMLDivElement | null = null;
  private scrollContainer: HTMLDivElement | null = null;
  private viewportEl: HTMLDivElement | null = null;

  // State
  private items: TradeItem[] = [];
  private filter: TradeFilter = 'all';
  private minSize = 0;
  private autoScroll = true;
  private destroyed = false;

  // Virtual scroll
  private renderedRows: Map<number, HTMLDivElement> = new Map();
  private scrollTop = 0;
  private containerHeight = 0;

  // DOM refs
  private filterBtns: HTMLButtonElement[] = [];
  private minSizeInput: HTMLInputElement | null = null;

  // ── Public API ───────────────────────────────────────────────────────────

  mount(container: HTMLElement): void {
    this.container = container;
    this.buildDOM();
  }

  addTrade(trade: Trade): void {
    if (this.destroyed) return;
    this.items.push({ type: 'trade', data: trade });
    this.trimBuffer();
    this.renderVirtualScroll();
    this.maybeAutoScroll();
  }

  addBigTrade(bigTrade: BigTrade): void {
    if (this.destroyed) return;

    // Aggregated big trade entry
    const item: TradeItem = {
      type: 'bigTrade',
      data: bigTrade,
    };
    this.items.push(item);
    this.trimBuffer();
    this.renderVirtualScroll();
    this.maybeAutoScroll();
  }

  destroy(): void {
    this.destroyed = true;
    if (this.wrapperEl && this.container) {
      this.container.removeChild(this.wrapperEl);
    }
    this.wrapperEl = null;
    this.scrollContainer = null;
    this.viewportEl = null;
    this.container = null;
    this.items = [];
    this.renderedRows.clear();
  }

  // ── DOM Construction ─────────────────────────────────────────────────────

  private buildDOM(): void {
    if (!this.container) return;

    this.wrapperEl = document.createElement('div');
    this.applyStyles(this.wrapperEl, STYLES.container);

    // Filter bar
    const filterBar = document.createElement('div');
    this.applyStyles(filterBar, STYLES.filterBar);

    // Filter buttons
    const btnGroup = document.createElement('div');
    this.applyStyles(btnGroup, STYLES.filterBtnGroup);

    const filters: { label: string; value: TradeFilter }[] = [
      { label: 'All', value: 'all' },
      { label: 'Buy', value: 'buy' },
      { label: 'Sell', value: 'sell' },
    ];

    for (const f of filters) {
      const btn = document.createElement('button');
      this.applyStyles(btn, STYLES.filterBtn);
      if (f.value === this.filter) this.applyStyles(btn, STYLES.filterBtnActive);
      btn.textContent = f.label;
      btn.dataset.filter = f.value;
      btn.addEventListener('click', () => this.setFilter(f.value));
      btnGroup.appendChild(btn);
      this.filterBtns.push(btn);
    }
    filterBar.appendChild(btnGroup);

    // Min size input
    const sizeLabel = document.createElement('span');
    sizeLabel.textContent = 'Min:';
    sizeLabel.style.fontSize = '10px';
    sizeLabel.style.color = '#6b7280';
    filterBar.appendChild(sizeLabel);

    this.minSizeInput = document.createElement('input');
    this.applyStyles(this.minSizeInput, STYLES.minSizeInput);
    this.minSizeInput.type = 'number';
    this.minSizeInput.placeholder = '0';
    this.minSizeInput.value = '0';
    this.minSizeInput.addEventListener('input', () => {
      this.minSize = parseFloat(this.minSizeInput!.value) || 0;
      this.renderVirtualScroll();
    });
    filterBar.appendChild(this.minSizeInput);

    this.wrapperEl.appendChild(filterBar);

    // Scroll container
    this.scrollContainer = document.createElement('div');
    this.applyStyles(this.scrollContainer, STYLES.scrollContainer);

    this.scrollContainer.addEventListener('scroll', () => {
      this.scrollTop = this.scrollContainer!.scrollTop;

      // Detect if user scrolled away from bottom
      const sh = this.scrollContainer!.scrollHeight;
      const ch = this.scrollContainer!.clientHeight;
      this.autoScroll = sh - this.scrollTop - ch < 30;

      this.renderVirtualScroll();
    });

    // Viewport (full height spacer)
    this.viewportEl = document.createElement('div');
    this.applyStyles(this.viewportEl, STYLES.viewport);
    this.scrollContainer.appendChild(this.viewportEl);

    this.wrapperEl.appendChild(this.scrollContainer);
    this.container.appendChild(this.wrapperEl);

    // Get container height
    requestAnimationFrame(() => {
      if (this.scrollContainer) {
        this.containerHeight = this.scrollContainer.clientHeight;
      }
    });
  }

  // ── Filter ───────────────────────────────────────────────────────────────

  private setFilter(filter: TradeFilter): void {
    this.filter = filter;
    for (const btn of this.filterBtns) {
      const isActive = btn.dataset.filter === filter;
      btn.style.background = isActive ? '#6366f1' : 'transparent';
      btn.style.color = isActive ? '#fff' : '#9ca3af';
      btn.style.borderColor = isActive ? '#6366f1' : '#374151';
    }
    this.renderVirtualScroll();
  }

  // ── Virtual Scroll Rendering ─────────────────────────────────────────────

  private getFilteredItems(): TradeItem[] {
    return this.items.filter((item) => {
      if (item.type === 'bigTrade') return true;

      const trade = item.data as Trade;
      if (this.filter === 'buy' && trade.side !== 'buy') return false;
      if (this.filter === 'sell' && trade.side !== 'sell') return false;
      if (trade.size < this.minSize) return false;
      return true;
    });
  }

  private renderVirtualScroll(): void {
    if (!this.viewportEl || !this.scrollContainer) return;

    const filtered = this.getFilteredItems();

    // Calculate total height
    let totalHeight = 0;
    const rowPositions: number[] = [];
    for (const item of filtered) {
      rowPositions.push(totalHeight);
      totalHeight += item.type === 'bigTrade' ? BIG_TRADE_ROW_HEIGHT : ROW_HEIGHT;
    }

    this.viewportEl.style.height = `${totalHeight}px`;
    this.containerHeight = this.scrollContainer.clientHeight;

    // Find visible range
    const scrollTop = this.scrollContainer.scrollTop;
    const visibleTop = scrollTop;
    const visibleBottom = scrollTop + this.containerHeight;

    let startIdx = 0;
    let endIdx = filtered.length;

    // Binary search for start
    for (let i = 0; i < filtered.length; i++) {
      const pos = rowPositions[i]!;
      const h = filtered[i]!.type === 'bigTrade' ? BIG_TRADE_ROW_HEIGHT : ROW_HEIGHT;
      if (pos + h >= visibleTop) { startIdx = i; break; }
    }

    // Find end
    for (let i = startIdx; i < filtered.length; i++) {
      if (rowPositions[i]! > visibleBottom) { endIdx = i; break; }
    }

    // Buffer extra rows
    startIdx = Math.max(0, startIdx - 5);
    endIdx = Math.min(filtered.length, endIdx + 5);

    // Remove off-screen rows
    const activeIndices = new Set<number>();
    for (let i = startIdx; i < endIdx; i++) activeIndices.add(i);

    for (const [idx, el] of this.renderedRows) {
      if (!activeIndices.has(idx)) {
        el.remove();
        this.renderedRows.delete(idx);
      }
    }

    // Render visible rows
    for (let i = startIdx; i < endIdx; i++) {
      if (this.renderedRows.has(i)) continue;

      const item = filtered[i]!;
      const el = this.createTradeRowEl(item, rowPositions[i]!);
      this.viewportEl.appendChild(el);
      this.renderedRows.set(i, el);
    }
  }

  private createTradeRowEl(item: TradeItem, top: number): HTMLDivElement {
    if (item.type === 'bigTrade') {
      return this.createBigTradeRow(item.data as BigTrade, top);
    }
    return this.createNormalTradeRow(item.data as Trade, top);
  }

  private createNormalTradeRow(trade: Trade, top: number): HTMLDivElement {
    const row = document.createElement('div');
    this.applyStyles(row, STYLES.tradeRow);
    row.style.top = `${top}px`;

    const isBuy = trade.side === 'buy';

    // Time
    const timeEl = document.createElement('span');
    this.applyStyles(timeEl, STYLES.timeText);
    timeEl.textContent = this.formatTime(trade.time);
    row.appendChild(timeEl);

    // Price
    const priceEl = document.createElement('span');
    this.applyStyles(priceEl, STYLES.priceText);
    priceEl.style.color = isBuy ? '#22c55e' : '#ef4444';
    priceEl.textContent = trade.price.toFixed(2);
    row.appendChild(priceEl);

    // Size
    const sizeEl = document.createElement('span');
    this.applyStyles(sizeEl, STYLES.sizeText);
    sizeEl.textContent = this.formatSize(trade.size);
    row.appendChild(sizeEl);

    return row;
  }

  private createBigTradeRow(trade: BigTrade, top: number): HTMLDivElement {
    const row = document.createElement('div');
    this.applyStyles(row, STYLES.bigTradeRow);
    row.style.top = `${top}px`;

    const isBuy = trade.side === 'buy';
    row.style.background = isBuy
      ? 'rgba(34, 197, 94, 0.08)'
      : 'rgba(239, 68, 68, 0.08)';
    row.style.border = `1px solid ${isBuy ? 'rgba(34, 197, 94, 0.2)' : 'rgba(239, 68, 68, 0.2)'}`;
    row.style.boxShadow = `0 0 8px ${isBuy ? 'rgba(34, 197, 94, 0.1)' : 'rgba(239, 68, 68, 0.1)'}`;

    // Time
    const timeEl = document.createElement('span');
    this.applyStyles(timeEl, STYLES.timeText);
    timeEl.textContent = this.formatTime(trade.timestamp);
    row.appendChild(timeEl);

    // Price
    const priceEl = document.createElement('span');
    this.applyStyles(priceEl, STYLES.priceText);
    priceEl.style.color = isBuy ? '#22c55e' : '#ef4444';
    priceEl.style.fontWeight = '700';
    priceEl.textContent = trade.price.toFixed(2);
    row.appendChild(priceEl);

    // Size
    const sizeEl = document.createElement('span');
    this.applyStyles(sizeEl, STYLES.sizeText);
    sizeEl.style.fontWeight = '600';
    sizeEl.textContent = this.formatSize(trade.quantity);
    row.appendChild(sizeEl);

    // Badge
    const badge = document.createElement('span');
    this.applyStyles(badge, STYLES.badge);
    badge.style.background = isBuy ? 'rgba(34, 197, 94, 0.2)' : 'rgba(239, 68, 68, 0.2)';
    badge.style.color = isBuy ? '#22c55e' : '#ef4444';
    badge.textContent = 'AGG';
    row.appendChild(badge);

    return row;
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private trimBuffer(): void {
    if (this.items.length > MAX_BUFFER) {
      this.items = this.items.slice(this.items.length - MAX_BUFFER);
      // Clear all rendered rows since indices shifted
      for (const el of this.renderedRows.values()) el.remove();
      this.renderedRows.clear();
    }
  }

  private maybeAutoScroll(): void {
    if (this.autoScroll && this.scrollContainer) {
      requestAnimationFrame(() => {
        if (this.scrollContainer) {
          this.scrollContainer.scrollTop = this.scrollContainer.scrollHeight;
        }
      });
    }
  }

  private formatTime(ts: number): string {
    const d = new Date(ts);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    const ms = String(d.getMilliseconds()).padStart(3, '0');
    return `${hh}:${mm}:${ss}.${ms}`;
  }

  private formatSize(size: number): string {
    if (size >= 1_000_000) return `${(size / 1_000_000).toFixed(2)}M`;
    if (size >= 1_000) return `${(size / 1_000).toFixed(2)}K`;
    if (size >= 1) return size.toFixed(4);
    return size.toFixed(6);
  }

  private applyStyles(el: HTMLElement, styles: Partial<CSSStyleDeclaration>): void {
    Object.assign(el.style, styles);
  }
}
