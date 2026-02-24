/**
 * MultiChartLayout.ts
 * Manages 1-4 chart panes in grid layouts.
 * Supports: 1 (full), 2h (side-by-side), 2v (stacked), 3 (1+2), 4 (2×2).
 * Each pane hosts its own independent ChartPane with full charting capabilities.
 */

export type LayoutMode = '1' | '2h' | '2v' | '3L' | '3R' | '3T' | '3B' | '4';

export interface PaneConfig {
  id: string;
  symbol: string;
  timeframe: string;
  exchange: string;
}

const LAYOUT_ICONS: Record<LayoutMode, string> = {
  '1':  '⬜',
  '2h': '⬜⬜',
  '2v': '⬛⬛',
  '3L': '◧',
  '3R': '◨',
  '3T': '⬒',
  '3B': '⬓',
  '4':  '⊞',
};

const LAYOUT_LABELS: Record<LayoutMode, string> = {
  '1':  'Single',
  '2h': '2 Horizontal',
  '2v': '2 Vertical',
  '3L': '1 Left + 2 Right',
  '3R': '2 Left + 1 Right',
  '3T': '1 Top + 2 Bottom',
  '3B': '2 Top + 1 Bottom',
  '4':  '2×2 Grid',
};

export class MultiChartLayout {
  private container: HTMLElement;
  private layoutMode: LayoutMode = '1';
  private panes: Map<string, HTMLElement> = new Map();
  private activePaneId: string | null = null;
  private onPaneCreated: ((paneEl: HTMLElement, config: PaneConfig) => void) | null = null;
  private onPaneRemoved: ((paneId: string) => void) | null = null;
  private onPaneActivated: ((paneId: string) => void) | null = null;
  private paneConfigs: PaneConfig[] = [];
  private layoutSelectorEl: HTMLElement | null = null;
  private dividers: HTMLElement[] = [];

  constructor(container: HTMLElement) {
    this.container = container;
    this.container.classList.add('multi-chart-grid');
    this.paneConfigs = [{ id: 'pane-1', symbol: 'BTC-USDT', timeframe: '1m', exchange: 'blofin' }];
  }

  // ── Public API ─────────────────────────────────────────────────────────

  init(callbacks: {
    onPaneCreated: (el: HTMLElement, config: PaneConfig) => void;
    onPaneRemoved: (id: string) => void;
    onPaneActivated: (id: string) => void;
  }): void {
    this.onPaneCreated = callbacks.onPaneCreated;
    this.onPaneRemoved = callbacks.onPaneRemoved;
    this.onPaneActivated = callbacks.onPaneActivated;
    this.applyLayout();
  }

  getLayoutMode(): LayoutMode { return this.layoutMode; }
  getActivePaneId(): string | null { return this.activePaneId; }

  setLayout(mode: LayoutMode): void {
    if (mode === this.layoutMode) return;
    this.layoutMode = mode;
    this.applyLayout();
  }

  getPaneCount(): number {
    return this.getRequiredPaneCount(this.layoutMode);
  }

  /** Create the layout selector UI */
  createLayoutSelector(): HTMLElement {
    const el = document.createElement('div');
    el.className = 'layout-selector';

    const modes: LayoutMode[] = ['1', '2h', '2v', '3L', '3R', '3T', '3B', '4'];
    for (const mode of modes) {
      const btn = document.createElement('button');
      btn.className = `layout-btn${mode === this.layoutMode ? ' active' : ''}`;
      btn.dataset.layout = mode;
      btn.title = LAYOUT_LABELS[mode];
      btn.innerHTML = this.getLayoutSVG(mode);
      btn.addEventListener('click', () => this.setLayout(mode));
      el.appendChild(btn);
    }

    this.layoutSelectorEl = el;
    return el;
  }

  // ── Private ────────────────────────────────────────────────────────────

  private getRequiredPaneCount(mode: LayoutMode): number {
    switch (mode) {
      case '1': return 1;
      case '2h': case '2v': return 2;
      case '3L': case '3R': case '3T': case '3B': return 3;
      case '4': return 4;
    }
  }

  private applyLayout(): void {
    const required = this.getRequiredPaneCount(this.layoutMode);

    // Ensure we have enough pane configs
    while (this.paneConfigs.length < required) {
      const idx = this.paneConfigs.length + 1;
      this.paneConfigs.push({
        id: `pane-${idx}`,
        symbol: 'BTC-USDT',
        timeframe: '1m',
        exchange: 'blofin',
      });
    }

    // Remove excess panes
    const existing = [...this.panes.entries()];
    for (const [id, el] of existing) {
      const configIdx = this.paneConfigs.findIndex(c => c.id === id);
      if (configIdx >= required) {
        el.remove();
        this.panes.delete(id);
        this.onPaneRemoved?.(id);
      }
    }

    // Clear container
    this.container.innerHTML = '';
    this.dividers = [];

    // Apply CSS grid template
    this.container.dataset.layout = this.layoutMode;
    this.applyGridTemplate();

    // Create/reuse pane elements
    for (let i = 0; i < required; i++) {
      const config = this.paneConfigs[i]!;
      let paneEl = this.panes.get(config.id);

      if (!paneEl) {
        paneEl = this.createPaneElement(config);
        this.panes.set(config.id, paneEl);
        this.onPaneCreated?.(paneEl, config);
      }

      paneEl.style.gridArea = `pane${i + 1}`;
      this.container.appendChild(paneEl);

      // Add dividers between panes
      if (i < required - 1) {
        const divider = document.createElement('div');
        divider.className = 'pane-divider';
        this.dividers.push(divider);
      }
    }

    // Set first pane as active if none
    if (!this.activePaneId || !this.panes.has(this.activePaneId)) {
      this.activatePane(this.paneConfigs[0]!.id);
    }

    // Update selector buttons
    this.layoutSelectorEl?.querySelectorAll('.layout-btn').forEach(btn => {
      btn.classList.toggle('active', (btn as HTMLElement).dataset.layout === this.layoutMode);
    });
  }

  private applyGridTemplate(): void {
    switch (this.layoutMode) {
      case '1':
        this.container.style.gridTemplate = '"pane1" 1fr / 1fr';
        break;
      case '2h':
        this.container.style.gridTemplate = '"pane1 pane2" 1fr / 1fr 1fr';
        break;
      case '2v':
        this.container.style.gridTemplate = '"pane1" 1fr "pane2" 1fr / 1fr';
        break;
      case '3L':
        this.container.style.gridTemplate = '"pane1 pane2" 1fr "pane1 pane3" 1fr / 1fr 1fr';
        break;
      case '3R':
        this.container.style.gridTemplate = '"pane1 pane3" 1fr "pane2 pane3" 1fr / 1fr 1fr';
        break;
      case '3T':
        this.container.style.gridTemplate = '"pane1 pane1" 1fr "pane2 pane3" 1fr / 1fr 1fr';
        break;
      case '3B':
        this.container.style.gridTemplate = '"pane1 pane2" 1fr "pane3 pane3" 1fr / 1fr 1fr';
        break;
      case '4':
        this.container.style.gridTemplate = '"pane1 pane2" 1fr "pane3 pane4" 1fr / 1fr 1fr';
        break;
    }
  }

  private createPaneElement(config: PaneConfig): HTMLElement {
    const pane = document.createElement('div');
    pane.className = 'chart-pane';
    pane.dataset.paneId = config.id;

    // Pane header with symbol/timeframe badge
    const header = document.createElement('div');
    header.className = 'pane-header';
    header.innerHTML = `
      <span class="pane-symbol">${config.symbol}</span>
      <span class="pane-timeframe">${config.timeframe}</span>
      <div class="pane-controls">
        <button class="pane-btn pane-maximize" title="Maximize">⤢</button>
        <button class="pane-btn pane-close" title="Close">✕</button>
      </div>
    `;
    pane.appendChild(header);

    // Canvas container for this pane
    const canvasContainer = document.createElement('div');
    canvasContainer.className = 'pane-canvas-container';
    pane.appendChild(canvasContainer);

    // Click to activate
    pane.addEventListener('mousedown', () => this.activatePane(config.id));

    // Close button
    header.querySelector('.pane-close')?.addEventListener('click', (e) => {
      e.stopPropagation();
      if (this.panes.size <= 1) return;
      this.removePane(config.id);
    });

    // Maximize button
    header.querySelector('.pane-maximize')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.setLayout('1');
    });

    return pane;
  }

  private activatePane(id: string): void {
    if (this.activePaneId === id) return;
    this.activePaneId = id;

    this.panes.forEach((el, paneId) => {
      el.classList.toggle('active', paneId === id);
    });

    this.onPaneActivated?.(id);
  }

  private removePane(id: string): void {
    const el = this.panes.get(id);
    if (!el) return;

    el.remove();
    this.panes.delete(id);
    this.paneConfigs = this.paneConfigs.filter(c => c.id !== id);
    this.onPaneRemoved?.(id);

    // Downgrade layout
    const remaining = this.panes.size;
    if (remaining <= 1) this.setLayout('1');
    else if (remaining <= 2) this.setLayout('2h');
    else this.setLayout('3L');
  }

  /** Generate mini SVG icon for layout buttons */
  private getLayoutSVG(mode: LayoutMode): string {
    const s = 24; // viewbox size
    const g = 1;  // gap
    const r = 2;  // corner radius
    const fill = 'currentColor';

    const rect = (x: number, y: number, w: number, h: number) =>
      `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${fill}" opacity="0.6"/>`;

    switch (mode) {
      case '1':
        return `<svg viewBox="0 0 ${s} ${s}" width="18" height="18">${rect(1, 1, 22, 22)}</svg>`;
      case '2h':
        return `<svg viewBox="0 0 ${s} ${s}" width="18" height="18">${rect(1, 1, 10, 22)}${rect(13, 1, 10, 22)}</svg>`;
      case '2v':
        return `<svg viewBox="0 0 ${s} ${s}" width="18" height="18">${rect(1, 1, 22, 10)}${rect(1, 13, 22, 10)}</svg>`;
      case '3L':
        return `<svg viewBox="0 0 ${s} ${s}" width="18" height="18">${rect(1, 1, 10, 22)}${rect(13, 1, 10, 10)}${rect(13, 13, 10, 10)}</svg>`;
      case '3R':
        return `<svg viewBox="0 0 ${s} ${s}" width="18" height="18">${rect(1, 1, 10, 10)}${rect(1, 13, 10, 10)}${rect(13, 1, 10, 22)}</svg>`;
      case '3T':
        return `<svg viewBox="0 0 ${s} ${s}" width="18" height="18">${rect(1, 1, 22, 10)}${rect(1, 13, 10, 10)}${rect(13, 13, 10, 10)}</svg>`;
      case '3B':
        return `<svg viewBox="0 0 ${s} ${s}" width="18" height="18">${rect(1, 1, 10, 10)}${rect(13, 1, 10, 10)}${rect(1, 13, 22, 10)}</svg>`;
      case '4':
        return `<svg viewBox="0 0 ${s} ${s}" width="18" height="18">${rect(1, 1, 10, 10)}${rect(13, 1, 10, 10)}${rect(1, 13, 10, 10)}${rect(13, 13, 10, 10)}</svg>`;
    }
  }
}
