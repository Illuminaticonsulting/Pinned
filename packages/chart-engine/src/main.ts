import './styles.css';

import { MultiChartLayout, type LayoutMode, type PaneConfig } from './layout/MultiChartLayout';
import { ChartPane } from './layout/ChartPane';
import { ToolBar } from './ui/ToolBar';
import { PropertiesPanel } from './ui/PropertiesPanel';
import { getToolByShortcut } from './drawing/DrawingTools';
import { SymbolService } from './services/SymbolService';
import { SymbolSearch, createSymbolButton } from './ui/SymbolSearch';
import { SyncControls } from './ui/SyncControls';
import { ShareService, ShareDialog } from './services/ShareService';

// ─── Constants ───────────────────────────────────────────────────────────────

const TIMEFRAMES = ['1m', '5m', '15m', '1h', '4h', '1d'];

// ─── PinnedApp ───────────────────────────────────────────────────────────────

class PinnedApp {
  private root: HTMLElement;
  private layout: MultiChartLayout | null = null;
  private toolbar: ToolBar | null = null;
  private propertiesPanel: PropertiesPanel | null = null;
  private panes: Map<string, ChartPane> = new Map();
  private activePaneId: string | null = null;
  private activeSymbol = 'BTC-USDT';
  private activeTimeframe = '1m';
  private symbolService: SymbolService;
  private symbolSearch: SymbolSearch | null = null;
  private syncControls: SyncControls;

  constructor(rootEl: HTMLElement) {
    this.root = rootEl;
    this.symbolService = SymbolService.getInstance();
    this.syncControls = new SyncControls();
  }

  // ── Bootstrap ────────────────────────────────────────────────────────────

  async init() {
    // Check for shared link state
    const shared = ShareService.parseShareLink();
    if (shared?.symbol) {
      this.activeSymbol = shared.symbol;
      this.activeTimeframe = shared.timeframe || '1m';
    }

    this.renderShell();
    this.createLayout();
    this.createToolbar();
    this.createPropertiesPanel();
    this.bindKeyboardShortcuts();

    // Init symbol service (fetches all BloFin instruments)
    await this.symbolService.init();
    this.updateSymbolCount();

    // Auto-refresh symbol count when list changes
    this.symbolService.onChange(() => this.updateSymbolCount());
  }

  // ── UI Shell ─────────────────────────────────────────────────────────────

  private renderShell() {
    this.root.innerHTML = /* html */ `
      <div class="pinned-layout">
        <!-- Top Bar -->
        <header class="top-bar">
          <div class="top-bar__left">
            <div class="logo">
              <span class="logo-icon">
                <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
                  <rect x="2" y="6" width="3" height="10" rx="1" fill="url(#logoGrad)"/>
                  <rect x="7.5" y="2" width="3" height="14" rx="1" fill="url(#logoGrad)"/>
                  <rect x="13" y="4" width="3" height="12" rx="1" fill="url(#logoGrad)"/>
                  <defs><linearGradient id="logoGrad" x1="0" y1="0" x2="18" y2="18">
                    <stop offset="0" stop-color="#6366f1"/><stop offset="1" stop-color="#3b82f6"/>
                  </linearGradient></defs>
                </svg>
              </span>
              <span class="logo-text">Pinned</span>
            </div>

            <div class="top-bar__divider"></div>

            <!-- Symbol Button (replaces select) -->
            <div id="symbolButtonMount"></div>

            <div class="top-bar__divider"></div>

            <!-- Timeframes -->
            <div class="timeframe-group" id="timeframeGroup">
              ${TIMEFRAMES.map(
                (tf) =>
                  `<button class="tf-btn ${tf === this.activeTimeframe ? 'active' : ''}" data-tf="${tf}">${tf}</button>`,
              ).join('')}
            </div>

            <div class="top-bar__divider"></div>

            <!-- Sync Controls Mount -->
            <div id="syncControlsMount"></div>
          </div>

          <div class="top-bar__center">
            <div id="layoutSelectorMount"></div>
          </div>

          <div class="top-bar__right">
            <!-- Symbol Count Badge -->
            <div class="symbol-count-badge" id="symbolCountBadge" title="Auto-synced trading pairs">
              <span class="scb-dot"></span>
              <span class="scb-count" id="symbolCount">—</span>
              <span class="scb-label">pairs</span>
            </div>

            <div class="top-bar__divider"></div>

            <!-- Share Button -->
            <button class="top-action-btn" id="shareBtn" title="Share chart (Ctrl+Shift+S)">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <circle cx="12" cy="4" r="2" stroke="currentColor" stroke-width="1.3"/>
                <circle cx="4" cy="8" r="2" stroke="currentColor" stroke-width="1.3"/>
                <circle cx="12" cy="12" r="2" stroke="currentColor" stroke-width="1.3"/>
                <path d="M5.8 7.1l4.4-2.2M5.8 8.9l4.4 2.2" stroke="currentColor" stroke-width="1.3"/>
              </svg>
              <span>Share</span>
            </button>

            <!-- Screenshot Button -->
            <button class="top-action-btn" id="screenshotBtn" title="Download screenshot (Ctrl+Shift+P)">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <rect x="2" y="4" width="12" height="9" rx="2" stroke="currentColor" stroke-width="1.3"/>
                <circle cx="8" cy="8.5" r="2.5" stroke="currentColor" stroke-width="1.3"/>
                <path d="M5.5 4V3a.5.5 0 01.5-.5h4a.5.5 0 01.5.5v1" stroke="currentColor" stroke-width="1.3"/>
              </svg>
            </button>

            <!-- Indicators -->
            <button class="top-action-btn" id="indicatorToggle" title="Indicators">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M2 14L6 6l3 4 2-6 3 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
            </button>

            <!-- Settings -->
            <button class="top-action-btn" id="settingsBtn" title="Settings">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 10a2 2 0 100-4 2 2 0 000 4z" stroke="currentColor" stroke-width="1.5"/><path d="M13.5 8c0-.3-.2-.6-.4-.8l1-1.5-.8-1.4-1.7.4c-.4-.3-.9-.5-1.4-.6L9.8 2.5H8.2l-.4 1.6c-.5.1-1 .3-1.4.6l-1.7-.4-.8 1.4 1 1.5c-.2.2-.4.5-.4.8s.2.6.4.8l-1 1.5.8 1.4 1.7-.4c.4.3.9.5 1.4.6l.4 1.6h1.6l.4-1.6c.5-.1 1-.3 1.4-.6l1.7.4.8-1.4-1-1.5c.2-.2.4-.5.4-.8z" stroke="currentColor" stroke-width="1.5"/></svg>
            </button>
          </div>
        </header>

        <!-- Main Area -->
        <div class="main-area">
          <!-- Toolbar Mount (left side) -->
          <div id="toolbarMount" class="toolbar-mount"></div>

          <!-- Chart Area with Multi-Chart Grid -->
          <div class="chart-area" id="chartArea">
            <div id="multiChartMount" class="multi-chart-mount"></div>
          </div>

          <!-- Properties Panel Mount -->
          <div id="propertiesPanelMount" class="properties-mount"></div>
        </div>
      </div>

      <!-- Toast Container -->
      <div class="toast-container" id="toastContainer"></div>
    `;

    this.mountSymbolButton();
    this.mountSyncControls();
    this.bindUIEvents();
  }

  // ── Symbol Button & Search ───────────────────────────────────────────────

  private mountSymbolButton(): void {
    const mount = this.root.querySelector<HTMLElement>('#symbolButtonMount')!;
    const btn = createSymbolButton(this.activeSymbol, () => this.openSymbolSearch());
    mount.appendChild(btn);
  }

  private openSymbolSearch(): void {
    if (!this.symbolSearch) {
      this.symbolSearch = new SymbolSearch({
        onSelect: (symbol) => this.handleSymbolChange(symbol),
        currentSymbol: this.activeSymbol,
      });
    }
    this.symbolSearch.open();
  }

  private handleSymbolChange(symbol: string): void {
    this.activeSymbol = symbol;
    this.updateSymbolButton();

    const pane = this.getActivePane();
    if (pane) pane.setSymbol(symbol);

    // Sync to other panes if enabled
    if (this.syncControls.isSyncSymbol()) {
      for (const [id, p] of this.panes) {
        if (id !== this.activePaneId) {
          p.setSymbol(symbol);
        }
      }
    }
  }

  private updateSymbolButton(): void {
    const nameEl = this.root.querySelector('.symbol-button__name');
    if (nameEl) nameEl.textContent = this.activeSymbol.replace('-', '/');
  }

  // ── Sync Controls ───────────────────────────────────────────────────────

  private mountSyncControls(): void {
    const mount = this.root.querySelector<HTMLElement>('#syncControlsMount')!;
    const el = this.syncControls.createControls();
    mount.appendChild(el);
  }

  // ── Layout Management ────────────────────────────────────────────────────

  private createLayout() {
    const mount = this.root.querySelector<HTMLElement>('#multiChartMount')!;
    const selectorMount = this.root.querySelector<HTMLElement>('#layoutSelectorMount')!;

    this.layout = new MultiChartLayout(mount);
    this.layout.init({
      onPaneCreated: (paneEl: HTMLElement, config: PaneConfig) => {
        const pane = new ChartPane(paneEl, config);
        this.panes.set(config.id, pane);
        if (!this.activePaneId) {
          this.activePaneId = config.id;
        }
      },
      onPaneRemoved: (id: string) => {
        const pane = this.panes.get(id);
        if (pane) {
          pane.destroy();
          this.panes.delete(id);
        }
        if (this.activePaneId === id) {
          this.activePaneId = this.panes.keys().next().value ?? null;
        }
      },
      onPaneActivated: (id: string) => {
        this.activePaneId = id;
        // Update top bar to reflect active pane's symbol/timeframe
        const pane = this.panes.get(id);
        if (pane) {
          const cfg = pane.getConfig();
          this.activeSymbol = cfg.symbol;
          this.activeTimeframe = cfg.timeframe;
          this.updateTopBarSelections();
        }
      },
    });

    // Mount layout selector in top bar
    const selectorEl = this.layout.createLayoutSelector();
    selectorMount.appendChild(selectorEl);
  }

  private createToolbar() {
    const mount = this.root.querySelector<HTMLElement>('#toolbarMount')!;
    this.toolbar = new ToolBar(mount, (toolId: string | null) => {
      const pane = this.getActivePane();
      if (pane) {
        pane.setDrawingTool(toolId);
      }
    });
  }

  private createPropertiesPanel() {
    this.propertiesPanel = new PropertiesPanel(
      // onChange callback: (drawingId, props)
      (drawingId: string, props: Partial<import('./core/ChartState').DrawingProperties>) => {
        const pane = this.getActivePane();
        if (!pane) return;
        const drawings = pane.state.getState().activeDrawings;
        pane.state.setState({
          activeDrawings: drawings.map((d) =>
            d.id === drawingId
              ? { ...d, properties: { ...d.properties, ...props }, updatedAt: Date.now() }
              : d,
          ),
        });
      },
      // onDelete callback: (drawingId)
      (drawingId: string) => {
        const pane = this.getActivePane();
        if (!pane) return;
        pane.drawingManager.deleteDrawing(drawingId);
      },
    );
  }

  // ── UI Events ────────────────────────────────────────────────────────────

  private bindUIEvents() {
    // Timeframe buttons
    const tfGroup = this.root.querySelector('#timeframeGroup')!;
    tfGroup.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('.tf-btn');
      if (!btn) return;
      this.activeTimeframe = btn.dataset.tf!;
      tfGroup.querySelectorAll('.tf-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');

      const pane = this.getActivePane();
      if (pane) pane.setTimeframe(this.activeTimeframe);

      // Sync to other panes if enabled
      if (this.syncControls.isSyncTimeframe()) {
        for (const [id, p] of this.panes) {
          if (id !== this.activePaneId) {
            p.setTimeframe(this.activeTimeframe);
          }
        }
      }
    });

    // Share button
    const shareBtn = this.root.querySelector('#shareBtn');
    shareBtn?.addEventListener('click', () => this.openShareDialog());

    // Screenshot button
    const ssBtn = this.root.querySelector('#screenshotBtn');
    ssBtn?.addEventListener('click', () => this.takeScreenshot());
  }

  // ── Share ────────────────────────────────────────────────────────────────

  private openShareDialog(): void {
    const pane = this.getActivePane();
    if (!pane) return;
    const paneEl = this.root.querySelector(`.chart-pane[data-pane-id="${this.activePaneId}"]`) as HTMLElement;
    if (!paneEl) return;

    const dialog = new ShareDialog({
      paneEl,
      symbol: this.activeSymbol,
      timeframe: this.activeTimeframe,
      layout: this.layout?.getLayoutMode() || '1',
      drawings: pane.state.getState().activeDrawings || [],
      onToast: (msg) => this.showToast(msg),
    });
    dialog.open();
  }

  private async takeScreenshot(): Promise<void> {
    const pane = this.getActivePane();
    if (!pane) return;
    const paneEl = this.root.querySelector(`.chart-pane[data-pane-id="${this.activePaneId}"]`) as HTMLElement;
    if (!paneEl) return;

    try {
      const ok = await ShareService.copyImageToClipboard({
        paneEl,
        symbol: this.activeSymbol,
        timeframe: this.activeTimeframe,
      });
      this.showToast(ok ? 'Screenshot copied to clipboard' : 'Screenshot downloaded');
    } catch {
      this.showToast('Screenshot failed');
    }
  }

  // ── Keyboard Shortcuts ───────────────────────────────────────────────────

  private bindKeyboardShortcuts() {
    window.addEventListener('keydown', (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

      const key = e.key.toUpperCase();

      // Ctrl+K or / = open symbol search
      if (key === '/' || ((e.ctrlKey || e.metaKey) && key === 'K')) {
        e.preventDefault();
        this.openSymbolSearch();
        return;
      }

      // Ctrl+Shift+S = share
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && key === 'S') {
        e.preventDefault();
        this.openShareDialog();
        return;
      }

      // Ctrl+Shift+P = screenshot
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && key === 'P') {
        e.preventDefault();
        this.takeScreenshot();
        return;
      }

      // Escape = deselect tool
      if (key === 'ESCAPE') {
        const pane = this.getActivePane();
        if (pane) pane.setDrawingTool(null);
        if (this.toolbar) this.toolbar.setActiveTool(null);
        return;
      }

      // Delete/Backspace = delete selected drawing
      if (key === 'DELETE' || key === 'BACKSPACE') {
        const pane = this.getActivePane();
        if (!pane) return;
        const selectedId = pane.drawingManager.getSelectedDrawingId();
        if (selectedId) {
          pane.drawingManager.deleteDrawing(selectedId);
          return;
        }
      }

      // Undo / Redo
      if ((e.ctrlKey || e.metaKey) && key === 'Z' && !e.shiftKey) {
        e.preventDefault();
        const pane = this.getActivePane();
        if (pane) pane.commandStack.undo();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && (key === 'Z' && e.shiftKey || key === 'Y')) {
        e.preventDefault();
        const pane = this.getActivePane();
        if (pane) pane.commandStack.redo();
        return;
      }

      // Tool shortcuts
      const toolId = getToolByShortcut(key);
      if (toolId) {
        const pane = this.getActivePane();
        if (pane) {
          pane.setDrawingTool(toolId);
          if (this.toolbar) this.toolbar.setActiveTool(toolId);
        }
        return;
      }
    });
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private getActivePane(): ChartPane | null {
    if (!this.activePaneId) return null;
    return this.panes.get(this.activePaneId) ?? null;
  }

  private updateTopBarSelections() {
    // Update symbol button text
    this.updateSymbolButton();

    this.root.querySelectorAll('.tf-btn').forEach((btn) => {
      btn.classList.toggle('active', (btn as HTMLElement).dataset.tf === this.activeTimeframe);
    });
  }

  private updateSymbolCount(): void {
    const el = this.root.querySelector('#symbolCount');
    if (el) el.textContent = `${this.symbolService.getCount()}`;
  }

  private showToast(message: string, duration = 2000) {
    const container = document.getElementById('toastContainer');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = message;
    container.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('toast--visible'));
    setTimeout(() => {
      toast.classList.remove('toast--visible');
      toast.addEventListener('transitionend', () => toast.remove());
    }, duration);
  }

  destroy() {
    for (const pane of this.panes.values()) pane.destroy();
    this.panes.clear();
    this.symbolService.destroy();
  }
}

// ─── Bootstrap ───────────────────────────────────────────────────────────────

const appRoot = document.getElementById('app');
if (appRoot) {
  const app = new PinnedApp(appRoot);
  app.init();
}
