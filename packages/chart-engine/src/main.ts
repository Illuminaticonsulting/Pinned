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
import { LiveOrderFlowService } from './services/LiveOrderFlowService';
import { HeatmapPanel } from './heatmap/HeatmapPanel';
import { OrderFlowSidebar } from './ui/OrderFlowSidebar';

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

  // ── OrderFlow components ─────────────────────────────────────────────
  private liveService: LiveOrderFlowService;
  private heatmapPanel: HeatmapPanel | null = null;
  private orderFlowSidebar: OrderFlowSidebar | null = null;
  private liveUnsubscribers: (() => void)[] = [];

  // Toggle states
  private showHeatmap = false;
  private showOrderbook = false;
  private showVolumeProfile = false;
  private showFootprint = false;
  private showPatterns = true;

  constructor(rootEl: HTMLElement) {
    this.root = rootEl;
    this.symbolService = SymbolService.getInstance();
    this.syncControls = new SyncControls();
    this.liveService = LiveOrderFlowService.getInstance();
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
    this.createHeatmapPanel();
    this.createOrderFlowSidebar();
    this.bindKeyboardShortcuts();
    this.connectLiveOrderFlow();

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

            <div class="top-bar__divider"></div>

            <!-- OrderFlow Toggle Buttons -->
            <div class="of-toggle-group">
              <button class="of-toggle-btn" id="toggleHeatmap" title="Toggle Heatmap (VolBook)">
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><rect x="1" y="1" width="4" height="4" rx="0.5" fill="currentColor" opacity="0.3"/><rect x="5" y="1" width="4" height="4" rx="0.5" fill="currentColor" opacity="0.6"/><rect x="9" y="1" width="4" height="4" rx="0.5" fill="currentColor" opacity="0.9"/><rect x="1" y="5" width="4" height="4" rx="0.5" fill="currentColor" opacity="0.5"/><rect x="5" y="5" width="4" height="4" rx="0.5" fill="currentColor" opacity="0.8"/><rect x="9" y="5" width="4" height="4" rx="0.5" fill="currentColor" opacity="0.4"/><rect x="1" y="9" width="4" height="4" rx="0.5" fill="currentColor" opacity="0.7"/><rect x="5" y="9" width="4" height="4" rx="0.5" fill="currentColor" opacity="0.2"/><rect x="9" y="9" width="4" height="4" rx="0.5" fill="currentColor" opacity="0.6"/></svg>
                <span>Heatmap</span>
              </button>
              <button class="of-toggle-btn" id="toggleOrderbook" title="Toggle OrderBook + Trades Sidebar">
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><rect x="1" y="1" width="5" height="2" rx="0.5" fill="#ef4444" opacity="0.7"/><rect x="1" y="4" width="7" height="2" rx="0.5" fill="#ef4444" opacity="0.5"/><rect x="1" y="8" width="6" height="2" rx="0.5" fill="#22c55e" opacity="0.5"/><rect x="1" y="11" width="4" height="2" rx="0.5" fill="#22c55e" opacity="0.7"/></svg>
                <span>DOM</span>
              </button>
              <button class="of-toggle-btn" id="toggleVP" title="Toggle Volume Profile">
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><rect x="1" y="1" width="3" height="12" rx="0.5" fill="currentColor" opacity="0.3"/><rect x="5" y="3" width="5" height="8" rx="0.5" fill="currentColor" opacity="0.5"/><rect x="11" y="5" width="2" height="4" rx="0.5" fill="currentColor" opacity="0.7"/></svg>
                <span>VP</span>
              </button>
              <button class="of-toggle-btn" id="toggleFootprint" title="Toggle Footprint Candles">
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><rect x="3" y="1" width="8" height="12" rx="1" stroke="currentColor" stroke-width="1" fill="none"/><line x1="7" y1="1" x2="7" y2="13" stroke="currentColor" stroke-width="0.5" opacity="0.4"/><line x1="3" y1="5" x2="11" y2="5" stroke="currentColor" stroke-width="0.5" opacity="0.3"/><line x1="3" y1="9" x2="11" y2="9" stroke="currentColor" stroke-width="0.5" opacity="0.3"/></svg>
                <span>FP</span>
              </button>
              <button class="of-toggle-btn active" id="togglePatterns" title="Toggle Pattern Detection (Iceberg/Spoof/Absorption)">
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><circle cx="7" cy="7" r="5" stroke="currentColor" stroke-width="1.3"/><circle cx="7" cy="7" r="2" fill="currentColor"/></svg>
                <span>Detect</span>
              </button>
            </div>

            <div class="top-bar__divider"></div>

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

          <!-- Chart + Heatmap vertical split -->
          <div class="chart-heatmap-area" id="chartHeatmapArea">
            <!-- Chart Area with Multi-Chart Grid -->
            <div class="chart-area" id="chartArea">
              <div id="multiChartMount" class="multi-chart-mount"></div>
            </div>

            <!-- Heatmap Panel Mount (below chart, toggleable) -->
            <div id="heatmapPanelMount" class="heatmap-panel-mount" style="display:none"></div>
          </div>

          <!-- OrderFlow Sidebar Mount (right side, toggleable) -->
          <div id="orderFlowSidebarMount" class="of-sidebar-mount"></div>

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

    // Update live orderflow for new symbol
    this.onSymbolChanged();
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

    // ── OrderFlow Toggle Buttons ──────────────────────────────────────────
    this.bindToggle('toggleHeatmap', () => this.toggleHeatmap());
    this.bindToggle('toggleOrderbook', () => this.toggleOrderbook());
    this.bindToggle('toggleVP', () => this.toggleVolumeProfile());
    this.bindToggle('toggleFootprint', () => this.toggleFootprint());
    this.bindToggle('togglePatterns', () => this.togglePatterns());
  }

  private bindToggle(id: string, handler: () => void): void {
    const btn = this.root.querySelector(`#${id}`);
    btn?.addEventListener('click', handler);
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

  // ── Heatmap Panel ──────────────────────────────────────────────────────

  private createHeatmapPanel(): void {
    const mount = this.root.querySelector<HTMLElement>('#heatmapPanelMount');
    if (!mount) return;

    this.heatmapPanel = new HeatmapPanel({ defaultTimeRange: '5m' });
    this.heatmapPanel.mount(mount);
    this.heatmapPanel.hide();
  }

  // ── OrderFlow Sidebar ──────────────────────────────────────────────────

  private createOrderFlowSidebar(): void {
    const mount = this.root.querySelector<HTMLElement>('#orderFlowSidebarMount');
    if (!mount) return;

    this.orderFlowSidebar = new OrderFlowSidebar();
    this.orderFlowSidebar.mount(mount);
  }

  // ── Live OrderFlow Connection ──────────────────────────────────────────

  private connectLiveOrderFlow(): void {
    // Connect to server WebSocket
    this.liveService.setSymbol('blofin', this.activeSymbol);
    this.liveService.connect();

    // Wire orderbook updates to sidebar
    const unsubOB = this.liveService.on('orderbook', (snapshot) => {
      this.orderFlowSidebar?.updateOrderbook(snapshot);
    });
    this.liveUnsubscribers.push(unsubOB);

    // Wire trade updates to sidebar
    const unsubTrade = this.liveService.on('trade', (trade) => {
      this.orderFlowSidebar?.addTrade({
        time: trade.time,
        price: trade.price,
        size: trade.size,
        side: trade.side,
      });
    });
    this.liveUnsubscribers.push(unsubTrade);

    // Wire big trade updates to sidebar
    const unsubBigTrade = this.liveService.on('bigTrade', (bt) => {
      this.orderFlowSidebar?.addBigTrade({
        exchange: bt.exchange,
        symbol: bt.symbol,
        side: bt.side,
        price: bt.price,
        quantity: bt.totalSize,
        usdValue: 0,
        timestamp: bt.time,
      });
    });
    this.liveUnsubscribers.push(unsubBigTrade);

    // Wire heatmap data
    const unsubHeatFull = this.liveService.on('heatmapFull', (blob) => {
      this.heatmapPanel?.setData(blob);
    });
    this.liveUnsubscribers.push(unsubHeatFull);

    const unsubHeatDiff = this.liveService.on('heatmapDiff', (update) => {
      if (update.cells) {
        this.heatmapPanel?.updateCells(
          update.cells.map((c) => ({
            priceIndex: c.priceIndex,
            timeIndex: c.timeIndex,
            intensity: c.intensity,
          })),
        );
      }
    });
    this.liveUnsubscribers.push(unsubHeatDiff);

    // Wire pattern events to sidebar & chart annotations
    const unsubPattern = this.liveService.on('pattern', (ev) => {
      // Add to sidebar pattern feed
      this.orderFlowSidebar?.addPattern({
        type: ev.type,
        time: ev.time,
        price: ev.price,
        confidence: ev.confidence,
        direction: ev.direction,
        estimatedSize: ev.estimatedSize,
      });

      // Add annotation to active chart pane
      const pane = this.getActivePane();
      if (pane && this.showPatterns) {
        pane.addPatternEvent({
          type: ev.type,
          time: ev.time,
          price: ev.price,
          confidence: ev.confidence,
          direction: ev.direction,
          estimatedSize: ev.estimatedSize,
        });
      }

      // Update absorption meter for absorption events
      if (ev.type === 'absorption') {
        const gauge = Math.min(Math.round(ev.confidence * 100), 100);
        this.orderFlowSidebar?.setAbsorption(gauge);
      }
    });
    this.liveUnsubscribers.push(unsubPattern);
  }

  // ── Toggle Methods ─────────────────────────────────────────────────────

  private toggleHeatmap(): void {
    this.showHeatmap = !this.showHeatmap;
    const mount = this.root.querySelector<HTMLElement>('#heatmapPanelMount');
    const btn = this.root.querySelector('#toggleHeatmap');

    if (this.showHeatmap) {
      if (mount) mount.style.display = 'block';
      this.heatmapPanel?.show();
      btn?.classList.add('active');
    } else {
      this.heatmapPanel?.hide();
      if (mount) mount.style.display = 'none';
      btn?.classList.remove('active');
    }
  }

  private toggleOrderbook(): void {
    this.showOrderbook = !this.showOrderbook;
    const btn = this.root.querySelector('#toggleOrderbook');
    const mount = this.root.querySelector<HTMLElement>('#orderFlowSidebarMount');

    if (this.showOrderbook) {
      mount?.classList.add('visible');
      this.orderFlowSidebar?.show();
      btn?.classList.add('active');
    } else {
      this.orderFlowSidebar?.hide();
      mount?.classList.remove('visible');
      btn?.classList.remove('active');
    }
  }

  private toggleVolumeProfile(): void {
    this.showVolumeProfile = !this.showVolumeProfile;
    const btn = this.root.querySelector('#toggleVP');
    btn?.classList.toggle('active', this.showVolumeProfile);

    for (const pane of this.panes.values()) {
      pane.setVolumeProfile(this.showVolumeProfile);
    }
  }

  private toggleFootprint(): void {
    this.showFootprint = !this.showFootprint;
    const btn = this.root.querySelector('#toggleFootprint');
    btn?.classList.toggle('active', this.showFootprint);

    for (const pane of this.panes.values()) {
      pane.setFootprint(this.showFootprint);
    }
  }

  private togglePatterns(): void {
    this.showPatterns = !this.showPatterns;
    const btn = this.root.querySelector('#togglePatterns');
    btn?.classList.toggle('active', this.showPatterns);

    for (const pane of this.panes.values()) {
      pane.setAnnotations(this.showPatterns);
    }
  }

  // ── Symbol change: update live service ─────────────────────────────────

  private onSymbolChanged(): void {
    this.liveService.setSymbol('blofin', this.activeSymbol);

    // Clear pattern events on symbol change
    for (const pane of this.panes.values()) {
      pane.clearPatternEvents();
    }
  }

  destroy() {
    // Cleanup live subscriptions
    for (const unsub of this.liveUnsubscribers) unsub();
    this.liveUnsubscribers = [];
    this.liveService.destroy();
    this.heatmapPanel?.destroy();
    this.orderFlowSidebar?.destroy();
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
