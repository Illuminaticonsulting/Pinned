/**
 * MultiChartLayout.ts
 * TradingView-style multi-chart layout with dropdown selector and integrated
 * sync controls. Supports 1-8 panes across 23 grid arrangements.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export type LayoutMode = string;

export interface PaneConfig {
  id: string;
  symbol: string;
  timeframe: string;
  exchange: string;
}

interface LayoutDef {
  id: string;
  count: number;
  cols: number;
  rows: number;
  /** [col, row, colSpan, rowSpan] for each pane */
  panes: [number, number, number, number][];
}

interface SyncState {
  symbol: boolean;
  interval: boolean;
  crosshair: boolean;
  time: boolean;
}

// ─── Layout Definitions ──────────────────────────────────────────────────────

const LAYOUTS: LayoutDef[] = [
  // 1 pane
  { id: '1', count: 1, cols: 1, rows: 1, panes: [[0,0,1,1]] },

  // 2 panes
  { id: '2h', count: 2, cols: 2, rows: 1, panes: [[0,0,1,1],[1,0,1,1]] },
  { id: '2v', count: 2, cols: 1, rows: 2, panes: [[0,0,1,1],[0,1,1,1]] },

  // 3 panes
  { id: '3v', count: 3, cols: 3, rows: 1, panes: [[0,0,1,1],[1,0,1,1],[2,0,1,1]] },
  { id: '3h', count: 3, cols: 1, rows: 3, panes: [[0,0,1,1],[0,1,1,1],[0,2,1,1]] },
  { id: '3L', count: 3, cols: 2, rows: 2, panes: [[0,0,1,2],[1,0,1,1],[1,1,1,1]] },
  { id: '3R', count: 3, cols: 2, rows: 2, panes: [[0,0,1,1],[0,1,1,1],[1,0,1,2]] },
  { id: '3T', count: 3, cols: 2, rows: 2, panes: [[0,0,2,1],[0,1,1,1],[1,1,1,1]] },
  { id: '3B', count: 3, cols: 2, rows: 2, panes: [[0,0,1,1],[1,0,1,1],[0,1,2,1]] },

  // 4 panes
  { id: '4',  count: 4, cols: 2, rows: 2, panes: [[0,0,1,1],[1,0,1,1],[0,1,1,1],[1,1,1,1]] },
  { id: '4L', count: 4, cols: 2, rows: 3, panes: [[0,0,1,3],[1,0,1,1],[1,1,1,1],[1,2,1,1]] },
  { id: '4R', count: 4, cols: 2, rows: 3, panes: [[0,0,1,1],[0,1,1,1],[0,2,1,1],[1,0,1,3]] },
  { id: '4T', count: 4, cols: 3, rows: 2, panes: [[0,0,3,1],[0,1,1,1],[1,1,1,1],[2,1,1,1]] },
  { id: '4B', count: 4, cols: 3, rows: 2, panes: [[0,0,1,1],[1,0,1,1],[2,0,1,1],[0,1,3,1]] },
  { id: '4v', count: 4, cols: 4, rows: 1, panes: [[0,0,1,1],[1,0,1,1],[2,0,1,1],[3,0,1,1]] },
  { id: '4h', count: 4, cols: 1, rows: 4, panes: [[0,0,1,1],[0,1,1,1],[0,2,1,1],[0,3,1,1]] },

  // 5 panes
  { id: '5a', count: 5, cols: 3, rows: 2, panes: [[0,0,1,2],[1,0,1,1],[2,0,1,1],[1,1,1,1],[2,1,1,1]] },
  { id: '5b', count: 5, cols: 3, rows: 2, panes: [[0,0,1,1],[1,0,1,1],[2,0,1,2],[0,1,1,1],[1,1,1,1]] },
  { id: '5c', count: 5, cols: 2, rows: 3, panes: [[0,0,2,1],[0,1,1,1],[1,1,1,1],[0,2,1,1],[1,2,1,1]] },

  // 6 panes
  { id: '6a', count: 6, cols: 3, rows: 2, panes: [[0,0,1,1],[1,0,1,1],[2,0,1,1],[0,1,1,1],[1,1,1,1],[2,1,1,1]] },
  { id: '6b', count: 6, cols: 2, rows: 3, panes: [[0,0,1,1],[1,0,1,1],[0,1,1,1],[1,1,1,1],[0,2,1,1],[1,2,1,1]] },

  // 8 panes
  { id: '8a', count: 8, cols: 4, rows: 2, panes: [[0,0,1,1],[1,0,1,1],[2,0,1,1],[3,0,1,1],[0,1,1,1],[1,1,1,1],[2,1,1,1],[3,1,1,1]] },
  { id: '8b', count: 8, cols: 2, rows: 4, panes: [[0,0,1,1],[1,0,1,1],[0,1,1,1],[1,1,1,1],[0,2,1,1],[1,2,1,1],[0,3,1,1],[1,3,1,1]] },
];

const LAYOUT_MAP = new Map<string, LayoutDef>(LAYOUTS.map((l) => [l.id, l]));

// Group by pane count, sorted
const LAYOUT_GROUPS: [number, LayoutDef[]][] = (() => {
  const map = new Map<number, LayoutDef[]>();
  for (const l of LAYOUTS) {
    if (!map.has(l.count)) map.set(l.count, []);
    map.get(l.count)!.push(l);
  }
  return [...map.entries()].sort((a, b) => a[0] - b[0]);
})();

const SYNC_KEY = 'pinned:layout-sync';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Generate CSS grid-template from a LayoutDef */
function gridTemplateFromDef(def: LayoutDef): string {
  const grid: string[][] = Array.from({ length: def.rows }, () =>
    Array.from({ length: def.cols }, () => '.'),
  );
  def.panes.forEach(([c, r, cs, rs], i) => {
    for (let dr = 0; dr < rs; dr++)
      for (let dc = 0; dc < cs; dc++)
        grid[r + dr][c + dc] = `pane${i + 1}`;
  });
  const rows = grid.map((row) => `"${row.join(' ')}" 1fr`).join(' ');
  return `${rows} / ${Array(def.cols).fill('1fr').join(' ')}`;
}

/** Generate an SVG icon preview for a layout */
function layoutSVG(def: LayoutDef, size: 'sm' | 'lg' = 'sm'): string {
  const VW = 30, VH = 20, PAD = 1.5, GAP = 1.5, R = 1.5;
  const cellW = (VW - 2 * PAD - GAP * (def.cols - 1)) / def.cols;
  const cellH = (VH - 2 * PAD - GAP * (def.rows - 1)) / def.rows;
  let rects = '';
  for (const [c, r, cs, rs] of def.panes) {
    const x = PAD + c * (cellW + GAP);
    const y = PAD + r * (cellH + GAP);
    const w = cs * cellW + (cs - 1) * GAP;
    const h = rs * cellH + (rs - 1) * GAP;
    rects += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" rx="${R}" fill="currentColor" opacity="0.55"/>`;
  }
  const [sw, sh] = size === 'lg' ? [28, 19] : [22, 15];
  return `<svg viewBox="0 0 ${VW} ${VH}" width="${sw}" height="${sh}">${rects}</svg>`;
}

/** Human-readable label for a layout mode */
function layoutLabel(id: string): string {
  const LABELS: Record<string, string> = {
    '1': 'Single', '2h': '2 Columns', '2v': '2 Rows',
    '3v': '3 Columns', '3h': '3 Rows', '3L': '1 Left + 2 Right',
    '3R': '2 Left + 1 Right', '3T': '1 Top + 2 Bottom', '3B': '2 Top + 1 Bottom',
    '4': '2×2 Grid', '4L': '1 Left + 3 Right', '4R': '3 Left + 1 Right',
    '4T': '1 Top + 3 Bottom', '4B': '3 Top + 1 Bottom', '4v': '4 Columns', '4h': '4 Rows',
    '5a': '1 Left + 2×2', '5b': '2×2 + 1 Right', '5c': '1 Top + 2×2',
    '6a': '3×2 Grid', '6b': '2×3 Grid',
    '8a': '4×2 Grid', '8b': '2×4 Grid',
  };
  return LABELS[id] ?? id;
}

// ─── MultiChartLayout ────────────────────────────────────────────────────────

export class MultiChartLayout {
  private container: HTMLElement;
  private layoutMode: LayoutMode = '1';
  private panes: Map<string, HTMLElement> = new Map();
  private activePaneId: string | null = null;
  private onPaneCreated: ((el: HTMLElement, cfg: PaneConfig) => void) | null = null;
  private onPaneRemoved: ((id: string) => void) | null = null;
  private onPaneActivated: ((id: string) => void) | null = null;
  private paneConfigs: PaneConfig[] = [];

  // Selector UI
  private selectorWrapper: HTMLElement | null = null;
  private triggerBtn: HTMLElement | null = null;
  private dropdown: HTMLElement | null = null;
  private dropdownOpen = false;

  // Sync
  private sync: SyncState;

  // Event handlers (stored for cleanup)
  private _escHandler: ((e: KeyboardEvent) => void) | null = null;
  private _clickOutside: ((e: MouseEvent) => void) | null = null;

  constructor(container: HTMLElement) {
    this.container = container;
    this.container.classList.add('multi-chart-grid');
    this.paneConfigs = [{ id: 'pane-1', symbol: 'BTC-USDT', timeframe: '1m', exchange: 'blofin' }];
    this.sync = this.loadSync();
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
    if (!LAYOUT_MAP.has(mode) || mode === this.layoutMode) return;
    this.layoutMode = mode;
    this.applyLayout();
    this.updateTriggerIcon();
    this.highlightActive();
  }

  getPaneCount(): number {
    return LAYOUT_MAP.get(this.layoutMode)?.count ?? 1;
  }

  // Sync accessors
  isSyncSymbol(): boolean { return this.sync.symbol; }
  isSyncTimeframe(): boolean { return this.sync.interval; }
  isSyncCrosshair(): boolean { return this.sync.crosshair; }
  isSyncTime(): boolean { return this.sync.time; }

  static getLabel(mode: LayoutMode): string { return layoutLabel(mode); }

  // ── Layout Selector (dropdown trigger) ─────────────────────────────────

  createLayoutSelector(): HTMLElement {
    this.selectorWrapper = document.createElement('div');
    this.selectorWrapper.className = 'layout-selector-wrapper';

    this.triggerBtn = document.createElement('button');
    this.triggerBtn.className = 'layout-trigger-btn';
    this.triggerBtn.title = 'Chart layout';
    this.triggerBtn.innerHTML =
      `<span class="layout-trigger-icon">${layoutSVG(LAYOUT_MAP.get(this.layoutMode)!, 'lg')}</span>` +
      '<span class="layout-trigger-caret">▾</span>';
    this.triggerBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggleDropdown();
    });

    this.selectorWrapper.appendChild(this.triggerBtn);
    return this.selectorWrapper;
  }

  // ── Dropdown ───────────────────────────────────────────────────────────

  private toggleDropdown(): void {
    this.dropdownOpen ? this.closeDropdown() : this.openDropdown();
  }

  private openDropdown(): void {
    if (this.dropdownOpen) return;
    this.dropdownOpen = true;
    this.triggerBtn?.classList.add('open');

    if (!this.dropdown) this.dropdown = this.buildDropdown();

    // Append to body so the dropdown isn't clipped by parent overflow
    document.body.appendChild(this.dropdown);

    // Position below trigger button
    this.positionDropdown();
    requestAnimationFrame(() => this.dropdown?.classList.add('open'));

    // Close handlers
    this._escHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') this.closeDropdown();
    };
    this._clickOutside = (e: MouseEvent) => {
      if (!this.selectorWrapper?.contains(e.target as Node) && !this.dropdown?.contains(e.target as Node)) this.closeDropdown();
    };
    document.addEventListener('keydown', this._escHandler);
    setTimeout(() => document.addEventListener('mousedown', this._clickOutside!), 0);
  }

  private positionDropdown(): void {
    if (!this.triggerBtn || !this.dropdown) return;
    const rect = this.triggerBtn.getBoundingClientRect();
    this.dropdown.style.position = 'fixed';
    this.dropdown.style.top = `${rect.bottom + 6}px`;
    this.dropdown.style.left = `${rect.left + rect.width / 2}px`;
    this.dropdown.style.transform = 'translateX(-50%)';
  }

  private closeDropdown(): void {
    if (!this.dropdownOpen) return;
    this.dropdownOpen = false;
    this.triggerBtn?.classList.remove('open');
    this.dropdown?.classList.remove('open');

    if (this._escHandler) document.removeEventListener('keydown', this._escHandler);
    if (this._clickOutside) document.removeEventListener('mousedown', this._clickOutside);

    // Remove after animation
    const dd = this.dropdown;
    setTimeout(() => dd?.remove(), 200);
    this.dropdown = null;
  }

  private buildDropdown(): HTMLElement {
    const dd = document.createElement('div');
    dd.className = 'layout-dropdown';

    const scroll = document.createElement('div');
    scroll.className = 'layout-dropdown-scroll';

    // ── Layout groups ─────────────────────────────────────────────────
    for (const [count, defs] of LAYOUT_GROUPS) {
      const group = document.createElement('div');
      group.className = 'layout-group';

      const countLabel = document.createElement('span');
      countLabel.className = 'layout-group-count';
      countLabel.textContent = String(count);
      group.appendChild(countLabel);

      const options = document.createElement('div');
      options.className = 'layout-group-options';

      for (const def of defs) {
        const btn = document.createElement('button');
        btn.className = `layout-option${def.id === this.layoutMode ? ' active' : ''}`;
        btn.dataset.layout = def.id;
        btn.title = layoutLabel(def.id);
        btn.innerHTML = layoutSVG(def);
        btn.addEventListener('click', () => {
          this.setLayout(def.id);
          this.closeDropdown();
        });
        options.appendChild(btn);
      }

      group.appendChild(options);
      scroll.appendChild(group);
    }

    dd.appendChild(scroll);

    // ── Sync section ──────────────────────────────────────────────────
    const syncSection = document.createElement('div');
    syncSection.className = 'layout-sync';

    const syncTitle = document.createElement('div');
    syncTitle.className = 'layout-sync-title';
    syncTitle.textContent = 'SYNC IN LAYOUT';
    syncSection.appendChild(syncTitle);

    const syncOptions: { key: keyof SyncState; label: string; info: string }[] = [
      { key: 'symbol', label: 'Symbol', info: 'Sync instrument across all panes' },
      { key: 'interval', label: 'Interval', info: 'Sync timeframe across all panes' },
      { key: 'crosshair', label: 'Crosshair', info: 'Sync crosshair position across panes' },
      { key: 'time', label: 'Time', info: 'Sync time scroll across panes' },
    ];

    for (const opt of syncOptions) {
      const row = document.createElement('div');
      row.className = 'layout-sync-row';

      const label = document.createElement('span');
      label.className = 'layout-sync-label';
      label.innerHTML = `${opt.label} <span class="layout-sync-info" title="${opt.info}">ⓘ</span>`;
      row.appendChild(label);

      const toggle = document.createElement('label');
      toggle.className = 'layout-toggle';

      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = this.sync[opt.key];
      input.addEventListener('change', () => {
        this.sync[opt.key] = input.checked;
        this.saveSync();
      });
      toggle.appendChild(input);

      const track = document.createElement('span');
      track.className = 'layout-toggle-track';
      const thumb = document.createElement('span');
      thumb.className = 'layout-toggle-thumb';
      track.appendChild(thumb);
      toggle.appendChild(track);

      row.appendChild(toggle);
      syncSection.appendChild(row);
    }

    dd.appendChild(syncSection);
    return dd;
  }

  private updateTriggerIcon(): void {
    const icon = this.triggerBtn?.querySelector('.layout-trigger-icon');
    if (icon) {
      icon.innerHTML = layoutSVG(LAYOUT_MAP.get(this.layoutMode)!, 'lg');
    }
  }

  private highlightActive(): void {
    this.dropdown?.querySelectorAll('.layout-option').forEach((btn) => {
      btn.classList.toggle('active', (btn as HTMLElement).dataset.layout === this.layoutMode);
    });
  }

  // ── Layout Application ─────────────────────────────────────────────────

  private applyLayout(): void {
    const def = LAYOUT_MAP.get(this.layoutMode);
    if (!def) return;

    const required = def.count;

    // Ensure enough pane configs
    while (this.paneConfigs.length < required) {
      const idx = this.paneConfigs.length + 1;
      this.paneConfigs.push({ id: `pane-${idx}`, symbol: 'BTC-USDT', timeframe: '1m', exchange: 'blofin' });
    }

    // Remove excess panes
    const existing = [...this.panes.entries()];
    for (const [id, el] of existing) {
      const idx = this.paneConfigs.findIndex((c) => c.id === id);
      if (idx >= required) {
        el.remove();
        this.panes.delete(id);
        this.onPaneRemoved?.(id);
      }
    }

    // Clear container and apply grid
    this.container.innerHTML = '';
    this.container.dataset.layout = this.layoutMode;
    this.container.style.gridTemplate = gridTemplateFromDef(def);

    // Create / reuse pane elements
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
    }

    // Activate first pane if needed
    if (!this.activePaneId || !this.panes.has(this.activePaneId)) {
      this.activatePane(this.paneConfigs[0]!.id);
    }
  }

  private createPaneElement(config: PaneConfig): HTMLElement {
    const pane = document.createElement('div');
    pane.className = 'chart-pane';
    pane.dataset.paneId = config.id;

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

    const canvasContainer = document.createElement('div');
    canvasContainer.className = 'pane-canvas-container';
    pane.appendChild(canvasContainer);

    // Activate on click
    pane.addEventListener('mousedown', () => this.activatePane(config.id));

    header.querySelector('.pane-close')?.addEventListener('click', (e) => {
      e.stopPropagation();
      if (this.panes.size <= 1) return;
      this.removePane(config.id);
    });

    header.querySelector('.pane-maximize')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.setLayout('1');
    });

    return pane;
  }

  private activatePane(id: string): void {
    if (this.activePaneId === id) return;
    this.activePaneId = id;
    this.panes.forEach((el, paneId) => el.classList.toggle('active', paneId === id));
    this.onPaneActivated?.(id);
  }

  private removePane(id: string): void {
    const el = this.panes.get(id);
    if (!el) return;
    el.remove();
    this.panes.delete(id);
    this.paneConfigs = this.paneConfigs.filter((c) => c.id !== id);
    this.onPaneRemoved?.(id);

    // Fall back to a simpler layout
    const remaining = this.panes.size;
    if (remaining <= 1) this.setLayout('1');
    else if (remaining <= 2) this.setLayout('2h');
    else if (remaining <= 3) this.setLayout('3L');
    else this.setLayout('4');
  }

  // ── Sync Persistence ───────────────────────────────────────────────────

  private loadSync(): SyncState {
    try {
      const raw = localStorage.getItem(SYNC_KEY);
      if (raw) return { symbol: false, interval: false, crosshair: true, time: false, ...JSON.parse(raw) };
    } catch { /* ignore */ }
    return { symbol: false, interval: false, crosshair: true, time: false };
  }

  private saveSync(): void {
    try { localStorage.setItem(SYNC_KEY, JSON.stringify(this.sync)); } catch { /* ignore */ }
  }

  // ── Cleanup ────────────────────────────────────────────────────────────

  destroy(): void {
    this.closeDropdown();
    for (const pane of this.panes.values()) pane.remove();
    this.panes.clear();
    this.container.innerHTML = '';
  }
}
