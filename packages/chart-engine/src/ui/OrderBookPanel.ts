/**
 * OrderBookPanel — Live order book sidebar panel with DOM ladder.
 *
 * Displays 20 levels above and below current price (40 visible),
 * with size bars, flash animations, wall highlighting, and an
 * absorption meter gauge.
 */

import type { OrderbookSnapshot, BookLevel } from '../core/DataManager';

// ─── Types ─────────────────────────────────────────────────────────────────────

interface LevelRow {
  el: HTMLDivElement;
  priceEl: HTMLSpanElement;
  sizeBarEl: HTMLDivElement;
  sizeTextEl: HTMLSpanElement;
  lastSize: number;
}

type AggregationStep = 0.1 | 1 | 5 | 10 | 50 | 100;

// ─── Constants ─────────────────────────────────────────────────────────────────

const VISIBLE_LEVELS = 20;  // each side
const AGGREGATION_STEPS: AggregationStep[] = [0.1, 1, 5, 10, 50, 100];
const ABSORPTION_DECAY_RATE = 0.10; // 10% per second
const ABSORPTION_DECAY_INTERVAL = 100; // ms

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
  absorptionContainer: {
    padding: '6px 8px',
    borderBottom: '1px solid #374151',
    flexShrink: '0',
  } as Partial<CSSStyleDeclaration>,
  absorptionLabel: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    fontSize: '10px',
    color: '#6b7280',
    marginBottom: '3px',
  } as Partial<CSSStyleDeclaration>,
  absorptionBarOuter: {
    height: '6px',
    background: '#1f2937',
    borderRadius: '3px',
    overflow: 'hidden',
  } as Partial<CSSStyleDeclaration>,
  absorptionBarInner: {
    height: '100%',
    width: '0%',
    borderRadius: '3px',
    transition: 'width 200ms ease, background 200ms ease',
    background: '#22c55e',
  } as Partial<CSSStyleDeclaration>,
  aggregationRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '4px 8px',
    borderBottom: '1px solid #374151',
    flexShrink: '0',
  } as Partial<CSSStyleDeclaration>,
  aggLabel: {
    fontSize: '10px',
    color: '#6b7280',
  } as Partial<CSSStyleDeclaration>,
  aggBtnGroup: {
    display: 'flex',
    gap: '2px',
  } as Partial<CSSStyleDeclaration>,
  aggBtn: {
    appearance: 'none',
    border: '1px solid #374151',
    background: 'transparent',
    color: '#9ca3af',
    fontSize: '10px',
    padding: '1px 5px',
    borderRadius: '3px',
    cursor: 'pointer',
    transition: 'all 150ms ease',
  } as Partial<CSSStyleDeclaration>,
  aggBtnActive: {
    background: '#6366f1',
    color: '#fff',
    borderColor: '#6366f1',
  } as Partial<CSSStyleDeclaration>,
  ladder: {
    flex: '1',
    overflow: 'hidden',
    display: 'flex',
    flexDirection: 'column',
  } as Partial<CSSStyleDeclaration>,
  levelRow: {
    display: 'flex',
    alignItems: 'center',
    height: '22px',
    padding: '0 8px',
    position: 'relative',
    transition: 'background 150ms ease, box-shadow 400ms ease-out',
    flexShrink: '0',
    cursor: 'pointer',
    borderBottom: '1px solid rgba(148, 163, 184, 0.03)',
  } as Partial<CSSStyleDeclaration>,
  levelRowHover: {
    background: 'rgba(255, 255, 255, 0.04)',
  } as Partial<CSSStyleDeclaration>,
  spreadRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    height: '28px',
    background: 'linear-gradient(90deg, rgba(244, 63, 94, 0.06) 0%, rgba(16, 185, 129, 0.06) 100%)',
    fontWeight: '700',
    fontSize: '12px',
    color: '#f1f5f9',
    borderTop: '1px solid rgba(148, 163, 184, 0.08)',
    borderBottom: '1px solid rgba(148, 163, 184, 0.08)',
    flexShrink: '0',
    letterSpacing: '0.02em',
  } as Partial<CSSStyleDeclaration>,
  priceText: {
    width: '50%',
    textAlign: 'right',
    paddingRight: '6px',
    zIndex: '2',
    position: 'relative',
  } as Partial<CSSStyleDeclaration>,
  sizeText: {
    width: '50%',
    textAlign: 'left',
    paddingLeft: '6px',
    zIndex: '2',
    position: 'relative',
  } as Partial<CSSStyleDeclaration>,
  sizeBar: {
    position: 'absolute',
    top: '0',
    height: '100%',
    opacity: '0.25',
    transition: 'width 150ms ease',
    zIndex: '1',
  } as Partial<CSSStyleDeclaration>,
};

// ─── OrderBookPanel ────────────────────────────────────────────────────────────

export class OrderBookPanel {
  private container: HTMLElement | null = null;
  private wrapperEl: HTMLDivElement | null = null;

  // DOM refs
  private ladderEl: HTMLDivElement | null = null;
  private spreadRowEl: HTMLDivElement | null = null;
  private absorptionBarInner: HTMLDivElement | null = null;
  private absorptionValueEl: HTMLSpanElement | null = null;
  private aggBtns: HTMLButtonElement[] = [];

  // State
  private askRows: LevelRow[] = [];
  private bidRows: LevelRow[] = [];
  private aggregation: AggregationStep = 0.1;
  private prevSnapshot: OrderbookSnapshot | null = null;
  private absorptionValue = 0;
  private absorptionDecayTimer: ReturnType<typeof setInterval> | null = null;
  private destroyed = false;
  private decimals = 2;

  // ── Public API ───────────────────────────────────────────────────────────

  mount(container: HTMLElement): void {
    this.container = container;
    this.buildDOM();
    this.startAbsorptionDecay();
  }

  update(snapshot: OrderbookSnapshot): void {
    if (this.destroyed) return;

    // Determine decimal places from prices
    if (snapshot.bids.length > 0) {
      const priceStr = snapshot.bids[0].price.toString();
      const dotIdx = priceStr.indexOf('.');
      this.decimals = dotIdx >= 0 ? priceStr.length - dotIdx - 1 : 0;
      this.decimals = Math.max(this.decimals, 2);
    }

    // Aggregate levels
    const asks = this.aggregateLevels(snapshot.asks, this.aggregation);
    const bids = this.aggregateLevels(snapshot.bids, this.aggregation);

    // Sort asks ascending, bids descending
    asks.sort((a, b) => a.price - b.price);
    bids.sort((a, b) => b.price - a.price);

    // Take top N
    const visibleAsks = asks.slice(0, VISIBLE_LEVELS).reverse(); // show lowest ask at bottom
    const visibleBids = bids.slice(0, VISIBLE_LEVELS);

    // Compute max size for bar scaling
    const allSizes = [...visibleAsks, ...visibleBids].map((l) => l.quantity);
    const maxSize = Math.max(...allSizes, 1);
    const avgSize = allSizes.reduce((a, b) => a + b, 0) / allSizes.length || 1;

    // Previous data for diff animations
    const prevAsks = this.prevSnapshot ? this.aggregateLevels(this.prevSnapshot.asks, this.aggregation) : [];
    const prevBids = this.prevSnapshot ? this.aggregateLevels(this.prevSnapshot.bids, this.aggregation) : [];
    const prevMap = new Map<number, number>();
    for (const l of [...prevAsks, ...prevBids]) prevMap.set(l.price, l.quantity);

    // Update ask rows
    this.updateRows(this.askRows, visibleAsks, maxSize, avgSize, prevMap, 'ask');

    // Update spread
    const bestAsk = asks.length > 0 ? asks[0].price : 0;
    const bestBid = bids.length > 0 ? bids[0].price : 0;
    const spread = bestAsk - bestBid;
    if (this.spreadRowEl) {
      this.spreadRowEl.textContent = `${bestBid.toFixed(this.decimals)} — ${bestAsk.toFixed(this.decimals)}  (${spread.toFixed(this.decimals)})`;
    }

    // Update bid rows
    this.updateRows(this.bidRows, visibleBids, maxSize, avgSize, prevMap, 'bid');

    this.prevSnapshot = snapshot;
  }

  setAbsorption(value: number): void {
    this.absorptionValue = Math.max(0, Math.min(100, value));
    this.renderAbsorption();
  }

  destroy(): void {
    this.destroyed = true;
    if (this.absorptionDecayTimer) clearInterval(this.absorptionDecayTimer);
    if (this.wrapperEl && this.container) {
      this.container.removeChild(this.wrapperEl);
    }
    this.wrapperEl = null;
    this.ladderEl = null;
    this.container = null;
    this.askRows = [];
    this.bidRows = [];
  }

  // ── DOM Construction ─────────────────────────────────────────────────────

  private buildDOM(): void {
    if (!this.container) return;

    this.wrapperEl = document.createElement('div');
    this.applyStyles(this.wrapperEl, STYLES.container);

    // Absorption meter
    this.buildAbsorptionMeter();

    // Aggregation toggle
    this.buildAggregationRow();

    // Ladder
    this.ladderEl = document.createElement('div');
    this.applyStyles(this.ladderEl, STYLES.ladder);

    // Ask rows (top)
    for (let i = 0; i < VISIBLE_LEVELS; i++) {
      const row = this.createLevelRow('ask');
      this.askRows.push(row);
      this.ladderEl.appendChild(row.el);
    }

    // Spread row
    this.spreadRowEl = document.createElement('div');
    this.applyStyles(this.spreadRowEl, STYLES.spreadRow);
    this.spreadRowEl.textContent = '—';
    this.ladderEl.appendChild(this.spreadRowEl);

    // Bid rows (bottom)
    for (let i = 0; i < VISIBLE_LEVELS; i++) {
      const row = this.createLevelRow('bid');
      this.bidRows.push(row);
      this.ladderEl.appendChild(row.el);
    }

    this.wrapperEl.appendChild(this.ladderEl);
    this.container.appendChild(this.wrapperEl);
  }

  private buildAbsorptionMeter(): void {
    if (!this.wrapperEl) return;

    const container = document.createElement('div');
    this.applyStyles(container, STYLES.absorptionContainer);

    const labelRow = document.createElement('div');
    this.applyStyles(labelRow, STYLES.absorptionLabel);

    const labelText = document.createElement('span');
    labelText.textContent = 'ABSORPTION';
    labelRow.appendChild(labelText);

    this.absorptionValueEl = document.createElement('span');
    this.absorptionValueEl.textContent = '0';
    this.absorptionValueEl.style.fontWeight = '600';
    this.absorptionValueEl.style.color = '#e5e7eb';
    labelRow.appendChild(this.absorptionValueEl);

    container.appendChild(labelRow);

    const barOuter = document.createElement('div');
    this.applyStyles(barOuter, STYLES.absorptionBarOuter);

    this.absorptionBarInner = document.createElement('div');
    this.applyStyles(this.absorptionBarInner, STYLES.absorptionBarInner);
    barOuter.appendChild(this.absorptionBarInner);

    container.appendChild(barOuter);
    this.wrapperEl.appendChild(container);
  }

  private buildAggregationRow(): void {
    if (!this.wrapperEl) return;

    const row = document.createElement('div');
    this.applyStyles(row, STYLES.aggregationRow);

    const label = document.createElement('span');
    this.applyStyles(label, STYLES.aggLabel);
    label.textContent = 'Group:';
    row.appendChild(label);

    const btnGroup = document.createElement('div');
    this.applyStyles(btnGroup, STYLES.aggBtnGroup);

    for (const step of AGGREGATION_STEPS) {
      const btn = document.createElement('button');
      this.applyStyles(btn, STYLES.aggBtn);
      if (step === this.aggregation) {
        this.applyStyles(btn, STYLES.aggBtnActive);
      }
      btn.textContent = step.toString();
      btn.dataset.step = step.toString();
      btn.addEventListener('click', () => this.setAggregation(step));
      btnGroup.appendChild(btn);
      this.aggBtns.push(btn);
    }

    row.appendChild(btnGroup);
    this.wrapperEl.appendChild(row);
  }

  private createLevelRow(side: 'ask' | 'bid'): LevelRow {
    const el = document.createElement('div');
    this.applyStyles(el, STYLES.levelRow);
    el.addEventListener('mouseenter', () => { el.style.background = 'rgba(255, 255, 255, 0.04)'; });
    el.addEventListener('mouseleave', () => { el.style.background = ''; });

    const priceEl = document.createElement('span');
    this.applyStyles(priceEl, STYLES.priceText);
    priceEl.style.color = side === 'ask' ? '#f43f5e' : '#10b981';

    const sizeBarEl = document.createElement('div');
    this.applyStyles(sizeBarEl, STYLES.sizeBar);
    sizeBarEl.style.background = side === 'ask' ? '#f43f5e' : '#10b981';
    if (side === 'ask') {
      sizeBarEl.style.right = '50%';
    } else {
      sizeBarEl.style.left = '50%';
    }

    const sizeTextEl = document.createElement('span');
    this.applyStyles(sizeTextEl, STYLES.sizeText);

    el.appendChild(sizeBarEl);
    el.appendChild(priceEl);
    el.appendChild(sizeTextEl);

    return { el, priceEl, sizeBarEl, sizeTextEl, lastSize: 0 };
  }

  // ── Updates ──────────────────────────────────────────────────────────────

  private updateRows(
    rows: LevelRow[],
    levels: BookLevel[],
    maxSize: number,
    avgSize: number,
    prevMap: Map<number, number>,
    side: 'ask' | 'bid',
  ): void {
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const level = levels[i];

      if (!level) {
        row.el.style.visibility = 'hidden';
        continue;
      }
      row.el.style.visibility = 'visible';

      row.priceEl.textContent = level.price.toFixed(this.decimals);
      row.sizeTextEl.textContent = this.formatSize(level.quantity);

      // Size bar width
      const pct = Math.min((level.quantity / maxSize) * 100, 100);
      row.sizeBarEl.style.width = `${pct}%`;

      // Wall highlighting
      row.el.style.fontWeight = '';
      row.el.style.background = '';
      if (level.quantity > avgSize * 5) {
        row.el.style.fontWeight = '700';
        row.el.style.background = side === 'ask'
          ? 'rgba(239, 68, 68, 0.15)'
          : 'rgba(34, 197, 94, 0.15)';
      } else if (level.quantity > avgSize * 2) {
        row.el.style.fontWeight = '600';
        row.el.style.background = side === 'ask'
          ? 'rgba(239, 68, 68, 0.06)'
          : 'rgba(34, 197, 94, 0.06)';
      }

      // Flash animation on size change
      const prevSize = prevMap.get(level.price) ?? 0;
      if (prevSize > 0 && level.quantity !== prevSize) {
        const increased = level.quantity > prevSize;
        this.flashRow(row.el, increased);
      }

      row.lastSize = level.quantity;
    }
  }

  private flashRow(el: HTMLDivElement, increased: boolean): void {
    const flashColor = increased
      ? 'rgba(250, 204, 21, 0.18)'
      : 'rgba(148, 163, 184, 0.06)';

    el.style.transition = 'none';
    el.style.boxShadow = `inset 0 0 0 100px ${flashColor}`;
    // Force reflow
    void el.offsetWidth;
    el.style.transition = 'box-shadow 500ms cubic-bezier(0.4, 0, 0.2, 1)';
    el.style.boxShadow = 'none';
  }

  // ── Absorption ───────────────────────────────────────────────────────────

  private renderAbsorption(): void {
    if (!this.absorptionBarInner || !this.absorptionValueEl) return;

    this.absorptionBarInner.style.width = `${this.absorptionValue}%`;
    this.absorptionValueEl.textContent = Math.round(this.absorptionValue).toString();

    // Color: green → yellow → red
    let color: string;
    if (this.absorptionValue < 33) {
      color = '#22c55e';
    } else if (this.absorptionValue < 66) {
      color = '#f59e0b';
    } else {
      color = '#ef4444';
    }
    this.absorptionBarInner.style.background = color;
  }

  private startAbsorptionDecay(): void {
    this.absorptionDecayTimer = setInterval(() => {
      if (this.absorptionValue > 0) {
        // Decay 10% per second → 1% per 100ms
        this.absorptionValue = Math.max(0, this.absorptionValue - (ABSORPTION_DECAY_RATE * (ABSORPTION_DECAY_INTERVAL / 1000) * 100));
        this.renderAbsorption();
      }
    }, ABSORPTION_DECAY_INTERVAL);
  }

  // ── Aggregation ──────────────────────────────────────────────────────────

  private setAggregation(step: AggregationStep): void {
    this.aggregation = step;
    for (const btn of this.aggBtns) {
      const isActive = parseFloat(btn.dataset.step ?? '0') === step;
      btn.style.background = isActive ? '#6366f1' : 'transparent';
      btn.style.color = isActive ? '#fff' : '#9ca3af';
      btn.style.borderColor = isActive ? '#6366f1' : '#374151';
    }
    // Re-render with current data
    if (this.prevSnapshot) this.update(this.prevSnapshot);
  }

  private aggregateLevels(levels: BookLevel[], step: AggregationStep): BookLevel[] {
    if (step <= 0.1) return levels.map((l) => ({ ...l }));

    const aggregated = new Map<number, number>();
    for (const lev of levels) {
      const bucket = Math.floor(lev.price / step) * step;
      aggregated.set(bucket, (aggregated.get(bucket) ?? 0) + lev.quantity);
    }

    return Array.from(aggregated.entries()).map(([price, quantity]) => ({ price, quantity }));
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private formatSize(size: number): string {
    if (size >= 1_000_000) return `${(size / 1_000_000).toFixed(2)}M`;
    if (size >= 1_000) return `${(size / 1_000).toFixed(2)}K`;
    if (size >= 1) return size.toFixed(2);
    return size.toFixed(4);
  }

  private applyStyles(el: HTMLElement, styles: Partial<CSSStyleDeclaration>): void {
    Object.assign(el.style, styles);
  }
}
