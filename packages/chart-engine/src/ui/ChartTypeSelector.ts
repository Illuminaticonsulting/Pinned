/**
 * ChartTypeSelector.ts
 * TradingView-style chart type dropdown selector with visual icons.
 */

import type { ChartType } from '../core/ChartState';

export interface ChartTypeSelectorOptions {
  onSelect: (type: ChartType) => void;
  current?: ChartType;
}

interface ChartTypeEntry {
  type: ChartType;
  label: string;
  icon: string; // SVG path data
}

const CHART_TYPES: ChartTypeEntry[] = [
  {
    type: 'candles',
    label: 'Candlestick',
    icon: '<rect x="5" y="2" width="6" height="12" rx="1" fill="#22c55e"/><line x1="8" y1="0" x2="8" y2="16" stroke="#22c55e" stroke-width="1.5"/>',
  },
  {
    type: 'hollow',
    label: 'Hollow Candles',
    icon: '<rect x="5" y="2" width="6" height="12" rx="1" fill="none" stroke="#22c55e" stroke-width="1.5"/><line x1="8" y1="0" x2="8" y2="16" stroke="#22c55e" stroke-width="1.5"/>',
  },
  {
    type: 'bars',
    label: 'OHLC Bars',
    icon: '<line x1="8" y1="1" x2="8" y2="15" stroke="#3b82f6" stroke-width="1.5"/><line x1="4" y1="5" x2="8" y2="5" stroke="#3b82f6" stroke-width="1.5"/><line x1="8" y1="11" x2="12" y2="11" stroke="#3b82f6" stroke-width="1.5"/>',
  },
  {
    type: 'line',
    label: 'Line',
    icon: '<polyline points="1,12 5,8 9,10 13,3 15,5" fill="none" stroke="#3b82f6" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>',
  },
  {
    type: 'area',
    label: 'Area',
    icon: '<defs><linearGradient id="ag" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3b82f6" stop-opacity="0.4"/><stop offset="1" stop-color="#3b82f6" stop-opacity="0"/></linearGradient></defs><polygon points="1,12 5,8 9,10 13,3 15,5 15,15 1,15" fill="url(#ag)"/><polyline points="1,12 5,8 9,10 13,3 15,5" fill="none" stroke="#3b82f6" stroke-width="1.5" stroke-linecap="round"/>',
  },
  {
    type: 'heikinashi',
    label: 'Heikin Ashi',
    icon: '<rect x="5" y="3" width="6" height="10" rx="1" fill="#f59e0b"/><line x1="8" y1="0" x2="8" y2="16" stroke="#f59e0b" stroke-width="1.5"/>',
  },
  {
    type: 'baseline',
    label: 'Baseline',
    icon: '<line x1="0" y1="8" x2="16" y2="8" stroke="#64748b" stroke-width="0.5" stroke-dasharray="2,2"/><polyline points="1,10 5,5 9,7 13,3 15,6" fill="none" stroke="#22c55e" stroke-width="1.5"/><polyline points="1,10 5,12 9,14" fill="none" stroke="#ef4444" stroke-width="1.5"/>',
  },
];

export class ChartTypeSelector {
  private overlay: HTMLElement | null = null;
  private current: ChartType;
  private onSelect: (type: ChartType) => void;
  private btnEl: HTMLButtonElement | null = null;

  constructor(opts: ChartTypeSelectorOptions) {
    this.current = opts.current ?? 'candles';
    this.onSelect = opts.onSelect;
  }

  /** Create the top-bar button */
  createButton(): HTMLElement {
    this.btnEl = document.createElement('button');
    this.btnEl.className = 'ct-btn';
    this.btnEl.title = 'Chart Type';
    this.updateButtonIcon();
    this.btnEl.addEventListener('click', () => this.toggle());
    return this.btnEl;
  }

  setCurrent(type: ChartType): void {
    this.current = type;
    this.updateButtonIcon();
  }

  private updateButtonIcon(): void {
    if (!this.btnEl) return;
    const entry = CHART_TYPES.find(t => t.type === this.current) ?? CHART_TYPES[0]!;
    this.btnEl.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 16 16">${entry.icon}</svg>
      <svg class="ct-btn-arrow" width="8" height="8" viewBox="0 0 8 8" fill="none">
        <path d="M2 3L4 5L6 3" stroke="currentColor" stroke-width="1" stroke-linecap="round"/>
      </svg>
    `;
  }

  private toggle(): void {
    if (this.overlay) { this.close(); return; }
    this.open();
  }

  private open(): void {
    this.overlay = document.createElement('div');
    this.overlay.className = 'ct-overlay';
    this.overlay.addEventListener('mousedown', (e) => {
      if (e.target === this.overlay) this.close();
    });

    const panel = document.createElement('div');
    panel.className = 'ct-panel';

    // Position below button using fixed positioning
    if (this.btnEl) {
      const rect = this.btnEl.getBoundingClientRect();
      panel.style.position = 'fixed';
      panel.style.top = `${rect.bottom + 4}px`;
      panel.style.left = `${rect.left}px`;
      panel.style.zIndex = '99999';
    }

    panel.innerHTML = `
      <div class="ct-panel-header">Chart Type</div>
      ${CHART_TYPES.map(t => `
        <button class="ct-panel-item${t.type === this.current ? ' ct-panel-item--active' : ''}" data-type="${t.type}">
          <svg width="16" height="16" viewBox="0 0 16 16">${t.icon}</svg>
          <span>${t.label}</span>
        </button>
      `).join('')}
    `;

    panel.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLElement>('.ct-panel-item');
      if (!btn) return;
      const type = btn.dataset.type as ChartType;
      this.current = type;
      this.updateButtonIcon();
      this.onSelect(type);
      this.close();
    });

    this.overlay.appendChild(panel);
    document.body.appendChild(this.overlay);
  }

  private close(): void {
    this.overlay?.remove();
    this.overlay = null;
  }
}
