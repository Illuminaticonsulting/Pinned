import './styles.css';

import { MultiChartLayout, type LayoutMode, type PaneConfig } from './layout/MultiChartLayout';
import { ChartPane } from './layout/ChartPane';
import { ToolBar } from './ui/ToolBar';
import { PropertiesPanel } from './ui/PropertiesPanel';
import { getToolByShortcut } from './drawing/DrawingTools';
import { SymbolService } from './services/SymbolService';
import { SymbolSearch, createSymbolButton } from './ui/SymbolSearch';
// SyncControls now integrated into MultiChartLayout
import { ShareService, ShareDialog } from './services/ShareService';
import { LiveOrderFlowService } from './services/LiveOrderFlowService';
import { HeatmapPanel } from './heatmap/HeatmapPanel';
import { OrderFlowSidebar } from './ui/OrderFlowSidebar';

// ─── New Feature Imports ─────────────────────────────────────────────────────
import { CommandPalette, type CommandAction } from './ui/CommandPalette';
import { ChartTypeSelector } from './ui/ChartTypeSelector';
import { ContextMenu, type ContextMenuItem } from './ui/ContextMenu';
import type { ChartType } from './core/ChartState';
import { ReplayMode } from './ui/ReplayMode';
import { TradeJournal } from './ui/TradeJournal';
import { AIChartAnalyst } from './ui/AIChartAnalyst';
import { AdaptiveLayoutMemory } from './ui/AdaptiveLayoutMemory';
import { HotkeyMacros, type MacroAction } from './ui/HotkeyMacros';
import { IndicatorConflictDetector } from './ui/IndicatorConflictDetector';
import { SessionStatsDashboard } from './ui/SessionStatsDashboard';
import { SmartAlerts } from './ui/SmartAlerts';
import { SplitComparison } from './ui/SplitComparison';
import { TimeframeSelector, getTimeframeApiKey } from './ui/TimeframeSelector';
import { SettingsPanel } from './ui/SettingsPanel';
import { heatmapStore } from './renderers/HeatmapOverlayRenderer';
import type { HeatmapCell } from './renderers/HeatmapOverlayRenderer';

// ─── Constants ───────────────────────────────────────────────────────────────

// TIMEFRAMES constant removed — TimeframeSelector handles all timeframes

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
  private timeframeSelector: TimeframeSelector | null = null;
  private chartTypeSelector: ChartTypeSelector | null = null;
  private contextMenu: ContextMenu | null = null;
  // Sync controls are now part of MultiChartLayout

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

  // ── New Feature Components ───────────────────────────────────────────
  private commandPalette: CommandPalette;
  private replayMode: ReplayMode | null = null;
  private tradeJournal: TradeJournal;
  private aiAnalyst: AIChartAnalyst | null = null;
  private adaptiveLayout: AdaptiveLayoutMemory;
  private hotkeyMacros: HotkeyMacros;
  private conflictDetector: IndicatorConflictDetector;
  private _keydownHandler: ((e: KeyboardEvent) => void) | null = null;
  private sessionStats: SessionStatsDashboard;
  private smartAlerts: SmartAlerts;
  private splitComparison: SplitComparison;
  private settingsPanel: SettingsPanel;

  constructor(rootEl: HTMLElement) {
    this.root = rootEl;
    this.symbolService = SymbolService.getInstance();
    this.liveService = LiveOrderFlowService.getInstance();

    // ── Init new feature components ─────────────────────────────────────
    this.commandPalette = new CommandPalette();

    this.tradeJournal = new TradeJournal({
      onGetChartSnapshot: async () => {
        // Capture active pane as data URL
        const pane = this.getActivePane();
        if (!pane) return '';
        const paneEl = this.root.querySelector(`.chart-pane[data-pane-id="${this.activePaneId}"]`) as HTMLElement;
        if (!paneEl) return '';
        const canvas = paneEl.querySelector('canvas');
        return canvas?.toDataURL('image/png') ?? '';
      },
      getCurrentPrice: () => {
        const pane = this.getActivePane();
        if (!pane) return 0;
        const candles = pane.state.getState().candles;
        return candles.length > 0 ? candles[candles.length - 1].close : 0;
      },
      getCurrentSymbol: () => this.activeSymbol,
      getCurrentTimeframe: () => this.activeTimeframe,
    });

    this.adaptiveLayout = new AdaptiveLayoutMemory({
      onSuggestHide: (panelId, label, days) => {
        this.showToast(`💡 "${label}" hasn't been used in ${days} days. Consider hiding it.`, 5000);
      },
      onAutoHide: (panelId) => {
        // Auto-hide the panel
        if (panelId === 'heatmap' && this.showHeatmap) this.toggleHeatmap();
        if (panelId === 'orderbook' && this.showOrderbook) this.toggleOrderbook();
        if (panelId === 'volumeProfile' && this.showVolumeProfile) this.toggleVolumeProfile();
        if (panelId === 'footprint' && this.showFootprint) this.toggleFootprint();
      },
    });

    this.hotkeyMacros = new HotkeyMacros((action: MacroAction) => {
      this.executeMacroAction(action);
    });

    this.conflictDetector = new IndicatorConflictDetector((warnings) => {
      // Warnings are auto-displayed via toast notifications in the detector
    });

    this.sessionStats = new SessionStatsDashboard();

    this.smartAlerts = new SmartAlerts({
      getCurrentPrice: () => {
        const pane = this.getActivePane();
        if (!pane) return 0;
        const candles = pane.state.getState().candles;
        return candles.length > 0 ? candles[candles.length - 1].close : 0;
      },
      getCurrentSymbol: () => this.activeSymbol,
      getAverageVolume: () => {
        const pane = this.getActivePane();
        if (!pane) return 0;
        const candles = pane.state.getState().candles;
        const recent = candles.slice(-20);
        if (recent.length === 0) return 0;
        return recent.reduce((s, c) => s + c.volume, 0) / recent.length;
      },
      onToast: (msg, dur) => this.showToast(msg, dur),
    });

    this.splitComparison = new SplitComparison({
      fetchCandles: async (symbol, timeframe, start, end) => {
        try {
          const params = new URLSearchParams({ instId: symbol, bar: timeframe });
          if (start) params.set('after', start.toString());
          if (end) params.set('before', end.toString());
          const res = await fetch(`/blofin-api/api/v1/market/candles?${params}`);
          const json = await res.json();
          if (json?.data) {
            return json.data.map((d: string[]) => ({
              time: parseInt(d[0]), open: parseFloat(d[1]),
              high: parseFloat(d[2]), low: parseFloat(d[3]),
              close: parseFloat(d[4]), volume: parseFloat(d[5]),
            }));
          }
          return [];
        } catch { return []; }
      },
      getCurrentSymbol: () => this.activeSymbol,
      getCurrentTimeframe: () => this.activeTimeframe,
      onToast: (msg, dur) => this.showToast(msg, dur),
    });

    this.settingsPanel = new SettingsPanel({
      onSettingsChange: (settings) => {
        // Apply settings to active pane
        // Could broadcast to all panes in the future
        document.documentElement.style.setProperty('--candle-up', settings.candleUpColor);
        document.documentElement.style.setProperty('--candle-down', settings.candleDownColor);
      },
    });
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
    this.createReplayBar();
    this.bindKeyboardShortcuts();
    this.connectLiveOrderFlow();
    this.registerAdaptivePanels();
    this.registerCommandPaletteActions();

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

            <!-- Chart Type -->
            <div id="chartTypeSelectorMount"></div>

            <div class="top-bar__divider"></div>

            <!-- Timeframes -->
            <div id="timeframeSelectorMount"></div>

            <div class="top-bar__divider"></div>

            <!-- Sync is now in layoutSelector dropdown -->
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

        <!-- Replay Bar (bottom, toggleable) -->
        <div id="replayBarMount" class="replay-bar-mount" style="display:none"></div>
      </div>

      <!-- Toast Container -->
      <div class="toast-container" id="toastContainer"></div>
    `;

    this.mountSymbolButton();
    this.mountChartTypeSelector();
    this.mountTimeframeSelector();
    this.bindUIEvents();
    this.contextMenu = new ContextMenu();
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

  /** Open symbol search with an initial character pre-filled (type-to-search) */
  private openSymbolSearchWithChar(char: string): void {
    this.openSymbolSearch();
    // Pre-fill the search input with the typed character
    setTimeout(() => {
      const input = document.querySelector<HTMLInputElement>('.ss-input');
      if (input) {
        input.value = char;
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }, 50);
  }

  private mountChartTypeSelector(): void {
    const mount = this.root.querySelector<HTMLElement>('#chartTypeSelectorMount');
    if (!mount) return;

    this.chartTypeSelector = new ChartTypeSelector({
      current: 'candles',
      onSelect: (type: ChartType) => {
        // Update all panes (or active pane)
        const pane = this.getActivePane();
        if (pane) {
          pane.state.setState({ chartType: type });
          pane.renderEngine.markAllDirty();
        }
      },
    });

    const btn = this.chartTypeSelector.createButton();
    mount.appendChild(btn);
  }

  private mountTimeframeSelector(): void {
    const mount = this.root.querySelector<HTMLElement>('#timeframeSelectorMount');
    if (!mount) return;

    this.timeframeSelector = new TimeframeSelector({
      currentTimeframe: this.activeTimeframe,
      onSelect: (tf) => {
        this.activeTimeframe = tf;
        const pane = this.getActivePane();
        if (pane) pane.setTimeframe(tf);

        // Sync to other panes if enabled
        if (this.layout?.isSyncTimeframe()) {
          for (const [id, p] of this.panes) {
            if (id !== this.activePaneId) {
              p.setTimeframe(tf);
            }
          }
        }

        this.sessionStats.recordEvent({ type: 'change_timeframe', timeframe: tf, timestamp: Date.now() });
      },
    });

    const strip = this.timeframeSelector.createTopBarStrip();
    mount.appendChild(strip);
  }

  private handleSymbolChange(symbol: string): void {
    this.activeSymbol = symbol;
    this.updateSymbolButton();

    const pane = this.getActivePane();
    if (pane) pane.setSymbol(symbol);

    // Sync to other panes if enabled
    if (this.layout?.isSyncSymbol()) {
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
    if (!nameEl) return;

    // Try to get a proper display name from SymbolService
    const info = this.symbolService.getSymbol(this.activeSymbol);
    if (info) {
      // For crypto: "BTC/USDT", for stocks: "AAPL", for gold: show description
      nameEl.textContent = info.type === 'crypto'
        ? this.activeSymbol.replace('-', '/')
        : info.base || this.activeSymbol;
    } else {
      nameEl.textContent = this.activeSymbol.replace('-', '/');
    }
  }

  // ── Sync Controls (integrated into MultiChartLayout) ──────────────────

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
    // Timeframe selection is now handled by TimeframeSelector component

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

    // Indicator toggle — opens command palette filtered to indicators
    const indicatorBtn = this.root.querySelector('#indicatorToggle');
    indicatorBtn?.addEventListener('click', () => {
      this.commandPalette.open();
      // After opening, pre-fill search with "indicator" to filter
      setTimeout(() => {
        const input = document.querySelector<HTMLInputElement>('.cmd-palette-input');
        if (input) { input.value = 'indicator'; input.dispatchEvent(new Event('input')); }
      }, 50);
    });

    // Settings button — opens real settings panel
    const settingsBtn = this.root.querySelector('#settingsBtn');
    settingsBtn?.addEventListener('click', () => {
      this.settingsPanel.toggle();
    });

    // Right-click context menu on chart area
    const chartArea = this.root.querySelector('#chartArea');
    chartArea?.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const me = e as MouseEvent;
      this.showContextMenu(me.clientX, me.clientY);
    });
  }

  private showContextMenu(x: number, y: number): void {
    if (!this.contextMenu) return;
    const pane = this.getActivePane();
    const indicators = pane?.state.getState().indicators ?? new Map<string, boolean>();

    const indicatorItems: ContextMenuItem[] = [
      { label: 'EMA 9', checked: indicators.get('ema9') ?? false, action: () => this.toggleIndicator('ema9') },
      { label: 'EMA 21', checked: indicators.get('ema21') ?? false, action: () => this.toggleIndicator('ema21') },
      { label: 'EMA 50', checked: indicators.get('ema50') ?? false, action: () => this.toggleIndicator('ema50') },
      { label: 'EMA 200', checked: indicators.get('ema200') ?? false, action: () => this.toggleIndicator('ema200') },
      { label: '', separator: true },
      { label: 'SMA 20', checked: indicators.get('sma20') ?? false, action: () => this.toggleIndicator('sma20') },
      { label: 'SMA 50', checked: indicators.get('sma50') ?? false, action: () => this.toggleIndicator('sma50') },
      { label: 'SMA 200', checked: indicators.get('sma200') ?? false, action: () => this.toggleIndicator('sma200') },
      { label: '', separator: true },
      { label: 'Bollinger Bands', checked: indicators.get('bollingerBands') ?? false, action: () => this.toggleIndicator('bollingerBands') },
      { label: 'RSI (14)', checked: indicators.get('rsi') ?? false, action: () => this.toggleIndicator('rsi') },
      { label: 'MACD', checked: indicators.get('macd') ?? false, action: () => this.toggleIndicator('macd') },
      { label: 'VWAP', checked: indicators.get('vwap') ?? false, action: () => this.toggleIndicator('vwap') },
    ];

    const chartTypeItems: ContextMenuItem[] = (
      ['candles', 'hollow', 'bars', 'line', 'area', 'heikinashi', 'baseline'] as ChartType[]
    ).map((ct) => ({
      label: ct.charAt(0).toUpperCase() + ct.slice(1),
      checked: (pane?.state.getState().chartType ?? 'candles') === ct,
      action: () => {
        if (pane) {
          pane.state.setState({ chartType: ct });
          pane.renderEngine.markAllDirty();
        }
        this.chartTypeSelector?.setCurrent(ct);
      },
    }));

    const items: ContextMenuItem[] = [
      { label: 'Chart Type', icon: '📊', submenu: chartTypeItems },
      { label: 'Indicators', icon: '📈', submenu: indicatorItems },
      { label: '', separator: true },
      { label: 'Reset Zoom', icon: '🔄', shortcut: '⌘0', action: () => {
        if (pane) {
          pane.renderEngine.markAllDirty();
        }
      }},
      { label: 'Fit All Data', icon: '↔', action: () => {
        if (pane) {
          pane.renderEngine.markAllDirty();
        }
      }},
      { label: '', separator: true },
      { label: 'Screenshot', icon: '📸', shortcut: '⌘⇧P', action: () => this.takeScreenshot() },
      { label: 'Share Chart', icon: '🔗', shortcut: '⌘⇧S', action: () => this.openShareDialog() },
    ];

    this.contextMenu.show(x, y, items);
  }

  private toggleIndicator(key: string): void {
    const pane = this.getActivePane();
    if (!pane) return;
    const indicators = pane.state.getState().indicators;
    const current = indicators.get(key) ?? false;
    indicators.set(key, !current);
    pane.state.setState({ indicators: new Map(indicators) });
    pane.renderEngine.markAllDirty();
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
    this._keydownHandler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

      const key = e.key.toUpperCase();

      // ⌘K = open Command Palette (override old symbol search)
      if ((e.ctrlKey || e.metaKey) && key === 'K') {
        e.preventDefault();
        this.commandPalette.toggle();
        return;
      }

      // / = open symbol search (keep original behavior)
      if (key === '/') {
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

      // Shift+J = open journal dashboard (check before plain J)
      if (e.shiftKey && key === 'J') {
        e.preventDefault();
        this.tradeJournal.openDashboard();
        return;
      }

      // J = open trade journal entry
      if (key === 'J' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        this.tradeJournal.openNewEntry();
        this.sessionStats.recordEvent({ type: 'place_trade', detail: 'journal_entry', timestamp: Date.now() });
        return;
      }

      // Shift+R = toggle replay mode (R is reserved for Ray drawing tool)
      if (e.shiftKey && key === 'R') {
        e.preventDefault();
        this.toggleReplayMode();
        return;
      }

      // Shift+S = session stats
      if (e.shiftKey && key === 'S') {
        e.preventDefault();
        this.sessionStats.openDashboard();
        return;
      }

      // Shift+M = macro editor
      if (e.shiftKey && key === 'M') {
        e.preventDefault();
        this.hotkeyMacros.openEditor();
        return;
      }

      // Shift+A = smart alerts manager
      if (e.shiftKey && key === 'A') {
        e.preventDefault();
        this.smartAlerts.openManager();
        return;
      }

      // Shift+C = split comparison
      if (e.shiftKey && key === 'C') {
        e.preventDefault();
        this.splitComparison.open();
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
          this.sessionStats.recordEvent({ type: 'draw_tool', detail: toolId, timestamp: Date.now() });
        }
        return;
      }

      // Type-to-search: any single alphanumeric key on canvas opens symbol search
      // with that character pre-filled (like TradingView)
      if (!e.ctrlKey && !e.metaKey && !e.altKey && /^[A-Z0-9]$/.test(key)) {
        e.preventDefault();
        this.openSymbolSearchWithChar(e.key);
        return;
      }
    };
    window.addEventListener('keydown', this._keydownHandler);
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private getActivePane(): ChartPane | null {
    if (!this.activePaneId) return null;
    return this.panes.get(this.activePaneId) ?? null;
  }

  private updateTopBarSelections() {
    // Update symbol button text
    this.updateSymbolButton();

    // Update timeframe selector
    this.timeframeSelector?.setCurrent(this.activeTimeframe);

    // Update chart type selector
    const pane = this.getActivePane();
    if (pane) {
      const ct = pane.state.getState().chartType ?? 'candles';
      this.chartTypeSelector?.setCurrent(ct);
    }
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

    // Wire heatmap data → integrated canvas overlay + legacy panel
    const unsubHeatFull = this.liveService.on('heatmapFull', (blob) => {
      // Feed to integrated canvas heatmap renderer
      heatmapStore.setBlob(blob);
      // Also feed to legacy panel if still mounted
      this.heatmapPanel?.setData(blob);

      // Mark candle layer dirty so heatmap redraws
      for (const pane of this.panes.values()) {
        pane.renderEngine.markDirty(1);
      }
    });
    this.liveUnsubscribers.push(unsubHeatFull);

    const unsubHeatDiff = this.liveService.on('heatmapDiff', (update) => {
      if (update.cells) {
        // Feed to integrated canvas heatmap
        heatmapStore.updateCells(
          update.cells.map((c: { priceIndex: number; timeIndex: number; intensity: number; price?: number; time?: number }) => ({
            time: c.time ?? heatmapStore.timeMin + c.timeIndex * heatmapStore.timeStep,
            price: c.price ?? heatmapStore.priceMin + c.priceIndex * heatmapStore.priceStep,
            intensity: c.intensity,
          })),
        );
        // Also feed to legacy panel
        this.heatmapPanel?.updateCells(
          update.cells.map((c: { priceIndex: number; timeIndex: number; intensity: number }) => ({
            priceIndex: c.priceIndex,
            timeIndex: c.timeIndex,
            intensity: c.intensity,
          })),
        );
        // Mark candle layer dirty
        for (const pane of this.panes.values()) {
          pane.renderEngine.markDirty(1);
        }
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

    // Toggle integrated canvas heatmap on all panes
    heatmapStore.setEnabled(this.showHeatmap);
    for (const pane of this.panes.values()) {
      pane.setHeatmapOverlay(this.showHeatmap);
    }

    if (this.showHeatmap) {
      if (mount) mount.style.display = 'block';
      this.heatmapPanel?.show();
      btn?.classList.add('active');
      this.adaptiveLayout.recordActivation('heatmap');
    } else {
      this.heatmapPanel?.hide();
      if (mount) mount.style.display = 'none';
      btn?.classList.remove('active');
      this.adaptiveLayout.recordDeactivation('heatmap');
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
      this.adaptiveLayout.recordActivation('orderbook');
    } else {
      this.orderFlowSidebar?.hide();
      mount?.classList.remove('visible');
      btn?.classList.remove('active');
      this.adaptiveLayout.recordDeactivation('orderbook');
    }
  }

  private toggleVolumeProfile(): void {
    this.showVolumeProfile = !this.showVolumeProfile;
    const btn = this.root.querySelector('#toggleVP');
    btn?.classList.toggle('active', this.showVolumeProfile);

    for (const pane of this.panes.values()) {
      pane.setVolumeProfile(this.showVolumeProfile);
    }

    if (this.showVolumeProfile) this.adaptiveLayout.recordActivation('volumeProfile');
    else this.adaptiveLayout.recordDeactivation('volumeProfile');
  }

  private toggleFootprint(): void {
    this.showFootprint = !this.showFootprint;
    const btn = this.root.querySelector('#toggleFootprint');
    btn?.classList.toggle('active', this.showFootprint);

    for (const pane of this.panes.values()) {
      pane.setFootprint(this.showFootprint);
    }

    if (this.showFootprint) this.adaptiveLayout.recordActivation('footprint');
    else this.adaptiveLayout.recordDeactivation('footprint');
  }

  private togglePatterns(): void {
    this.showPatterns = !this.showPatterns;
    const btn = this.root.querySelector('#togglePatterns');
    btn?.classList.toggle('active', this.showPatterns);

    for (const pane of this.panes.values()) {
      pane.setAnnotations(this.showPatterns);
    }

    if (this.showPatterns) this.adaptiveLayout.recordActivation('patterns');
    else this.adaptiveLayout.recordDeactivation('patterns');
  }

  // ── Symbol change: update live service ─────────────────────────────────

  private onSymbolChanged(): void {
    this.liveService.setSymbol('blofin', this.activeSymbol);

    // Clear pattern events on symbol change
    for (const pane of this.panes.values()) {
      pane.clearPatternEvents();
    }

    // Track in session stats
    this.sessionStats.recordEvent({
      type: 'view_symbol',
      symbol: this.activeSymbol,
      timestamp: Date.now(),
    });
  }

  // ── Replay Mode ──────────────────────────────────────────────────────

  private createReplayBar(): void {
    const mount = this.root.querySelector<HTMLElement>('#replayBarMount');
    if (!mount) return;

    this.replayMode = new ReplayMode({
      onRevealCandle: (candles) => {
        const pane = this.getActivePane();
        if (pane) {
          pane.state.setState({ candles });
        }
      },
      onStateChange: (_state) => {
        // Could update UI indicators here
      },
      fetchCandles: async (startTs, endTs) => {
        const pane = this.getActivePane();
        if (!pane) return [];
        // Fetch via DataService
        try {
          const resp = await fetch(
            `/blofin-api/api/v1/market/candles?instId=${this.activeSymbol}&bar=${this.activeTimeframe}&begin=${startTs}&end=${endTs}&limit=300`,
          );
          const json = await resp.json();
          if (json.data) {
            return json.data.map((d: string[]) => ({
              timestamp: parseInt(d[0]),
              open: parseFloat(d[1]),
              high: parseFloat(d[2]),
              low: parseFloat(d[3]),
              close: parseFloat(d[4]),
              volume: parseFloat(d[5]),
            }));
          }
        } catch { /* ignore */ }
        return [];
      },
    });

    this.replayMode.mount(mount);
  }

  private toggleReplayMode(): void {
    const mount = this.root.querySelector<HTMLElement>('#replayBarMount');
    if (!mount || !this.replayMode) return;

    if (this.replayMode.isActive()) {
      this.replayMode.stop();
      mount.style.display = 'none';
    } else {
      mount.style.display = 'block';
      this.replayMode.show();
      this.showToast('Replay Mode — Set date range and press Play');
    }
  }

  // ── Adaptive Layout Panels ────────────────────────────────────────────

  private registerAdaptivePanels(): void {
    this.adaptiveLayout.registerPanel('heatmap', 'Heatmap');
    this.adaptiveLayout.registerPanel('orderbook', 'DOM / OrderBook');
    this.adaptiveLayout.registerPanel('volumeProfile', 'Volume Profile');
    this.adaptiveLayout.registerPanel('footprint', 'Footprint');
    this.adaptiveLayout.registerPanel('patterns', 'Pattern Detection');
    this.adaptiveLayout.startMonitoring();
  }

  // ── Macro Executor ─────────────────────────────────────────────────────

  private executeMacroAction(action: MacroAction): void {
    switch (action.type) {
      case 'set_tool': {
        const pane = this.getActivePane();
        if (pane) {
          pane.setDrawingTool(action.tool);
          if (this.toolbar) this.toolbar.setActiveTool(action.tool);
        }
        break;
      }
      case 'toggle_panel': {
        if (action.panel === 'heatmap' && this.showHeatmap !== action.enabled) this.toggleHeatmap();
        if (action.panel === 'orderbook' && this.showOrderbook !== action.enabled) this.toggleOrderbook();
        if (action.panel === 'volumeProfile' && this.showVolumeProfile !== action.enabled) this.toggleVolumeProfile();
        if (action.panel === 'footprint' && this.showFootprint !== action.enabled) this.toggleFootprint();
        if (action.panel === 'patterns' && this.showPatterns !== action.enabled) this.togglePatterns();
        break;
      }
      case 'set_timeframe': {
        this.activeTimeframe = action.timeframe;
        const pane = this.getActivePane();
        if (pane) pane.setTimeframe(action.timeframe);
        this.updateTopBarSelections();
        break;
      }
      case 'set_symbol': {
        this.handleSymbolChange(action.symbol);
        break;
      }
      case 'add_indicator': {
        this.showToast(`Added ${action.indicator}${action.params?.period ? ` (${action.params.period})` : ''}`);
        this.conflictDetector.addIndicator({
          id: action.indicator,
          name: action.indicator.toUpperCase(),
          params: action.params as Record<string, number | string> | undefined,
        });
        break;
      }
      default:
        break;
    }
  }

  // ── Command Palette Actions ────────────────────────────────────────────

  private registerCommandPaletteActions(): void {
    const actions: CommandAction[] = [
      // ── Navigation ─────────────────────────────────────────────────
      {
        id: 'nav:symbol_search',
        label: 'Search Symbol',
        description: 'Open symbol search to change trading pair',
        category: 'navigation',
        icon: '🔍',
        shortcut: '/',
        keywords: ['symbol', 'search', 'pair', 'instrument', 'ticker'],
        execute: () => this.openSymbolSearch(),
      },
      ...['1s','5s','15s','30s','1m','3m','5m','15m','30m','45m','1h','2h','3h','4h','6h','8h','12h','1d','2d','3d','1w','2w','1M','3M','6M','12M'].map((tf) => ({
        id: `nav:timeframe_${tf}`,
        label: `Set Timeframe: ${tf}`,
        description: `Switch to ${tf} timeframe`,
        category: 'navigation' as const,
        icon: '⏱',
        keywords: ['timeframe', 'tf', 'interval', tf],
        execute: () => {
          this.activeTimeframe = tf;
          const pane = this.getActivePane();
          if (pane) pane.setTimeframe(tf);
          this.updateTopBarSelections();
          this.sessionStats.recordEvent({ type: 'change_timeframe', timeframe: tf, timestamp: Date.now() });
        },
      })),

      // ── OrderFlow ──────────────────────────────────────────────────
      {
        id: 'of:heatmap',
        label: 'Toggle Heatmap',
        description: 'Show/hide the volume heatmap panel',
        category: 'orderflow',
        icon: '🟥',
        keywords: ['heatmap', 'heat', 'volbook'],
        execute: () => this.toggleHeatmap(),
      },
      {
        id: 'of:orderbook',
        label: 'Toggle DOM/OrderBook',
        description: 'Show/hide the orderbook & trades sidebar',
        category: 'orderflow',
        icon: '📊',
        keywords: ['dom', 'orderbook', 'order', 'book', 'depth'],
        execute: () => this.toggleOrderbook(),
      },
      {
        id: 'of:volume_profile',
        label: 'Toggle Volume Profile',
        description: 'Show/hide volume profile on chart',
        category: 'orderflow',
        icon: '📈',
        shortcut: 'VP',
        keywords: ['volume', 'profile', 'vp', 'poc', 'value area'],
        execute: () => this.toggleVolumeProfile(),
      },
      {
        id: 'of:footprint',
        label: 'Toggle Footprint',
        description: 'Show/hide footprint (cluster) candles',
        category: 'orderflow',
        icon: '🕯',
        shortcut: 'FP',
        keywords: ['footprint', 'fp', 'cluster', 'orderflow'],
        execute: () => this.toggleFootprint(),
      },
      {
        id: 'of:patterns',
        label: 'Toggle Pattern Detection',
        description: 'Show/hide iceberg/spoof/absorption detection',
        category: 'orderflow',
        icon: '🎯',
        keywords: ['pattern', 'detect', 'iceberg', 'spoof', 'absorption'],
        execute: () => this.togglePatterns(),
      },

      // ── Chart Types ─────────────────────────────────────────────────
      ...(['candles', 'hollow', 'bars', 'line', 'area', 'heikinashi', 'baseline'] as ChartType[]).map((ct) => ({
        id: `chart:${ct}`,
        label: `Chart Type: ${ct.charAt(0).toUpperCase() + ct.slice(1)}`,
        description: `Switch to ${ct} chart style`,
        category: 'navigation' as const,
        icon: '📊',
        keywords: ['chart', 'type', 'style', ct],
        execute: () => {
          const pane = this.getActivePane();
          if (pane) {
            pane.state.setState({ chartType: ct });
            pane.renderEngine.markAllDirty();
          }
          this.chartTypeSelector?.setCurrent(ct);
        },
      })),

      // ── Indicators ─────────────────────────────────────────────────
      ...[
        { key: 'ema9', label: 'EMA 9', icon: '〰️' },
        { key: 'ema21', label: 'EMA 21', icon: '〰️' },
        { key: 'ema50', label: 'EMA 50', icon: '〰️' },
        { key: 'ema200', label: 'EMA 200', icon: '〰️' },
        { key: 'sma20', label: 'SMA 20', icon: '📈' },
        { key: 'sma50', label: 'SMA 50', icon: '📈' },
        { key: 'sma100', label: 'SMA 100', icon: '📈' },
        { key: 'sma200', label: 'SMA 200', icon: '📈' },
        { key: 'bollingerBands', label: 'Bollinger Bands', icon: '📉' },
        { key: 'rsi', label: 'RSI (14)', icon: '📊' },
        { key: 'macd', label: 'MACD (12/26/9)', icon: '📊' },
        { key: 'vwap', label: 'VWAP', icon: '📏' },
        { key: 'anchoredVwap', label: 'Anchored VWAP', icon: '📏' },
        { key: 'cumDelta', label: 'Cumulative Delta', icon: '🔺' },
        { key: 'ofi', label: 'Order Flow Imbalance', icon: '⚡' },
        { key: 'fundingRate', label: 'Funding Rate', icon: '💰' },
      ].map((ind) => ({
        id: `indicator:${ind.key}`,
        label: `Indicator: ${ind.label}`,
        description: `Toggle ${ind.label} indicator`,
        category: 'orderflow' as const,
        icon: ind.icon,
        keywords: ['indicator', 'overlay', 'study', ind.label.toLowerCase(), ind.key],
        execute: () => {
          const pane = this.getActivePane();
          if (!pane) return;
          const indicators = pane.state.getState().indicators;
          const current = indicators.get(ind.key) ?? false;
          indicators.set(ind.key, !current);
          pane.state.setState({ indicators: new Map(indicators) });
          pane.renderEngine.markAllDirty();
          this.showToast(`${ind.label} ${!current ? 'ON' : 'OFF'}`);
        },
      })),

      // ── Drawing Tools ──────────────────────────────────────────────
      ...[
        { id: 'trendline', label: 'Trend Line', shortcut: 'T', icon: '📏' },
        { id: 'horizontal', label: 'Horizontal Line', shortcut: 'H', icon: '➖' },
        { id: 'vertical', label: 'Vertical Line', shortcut: 'V', icon: '|' },
        { id: 'ray', label: 'Ray', shortcut: 'R', icon: '↗' },
        { id: 'rectangle', label: 'Rectangle', icon: '▭' },
        { id: 'fibRetracement', label: 'Fibonacci Retracement', shortcut: 'F', icon: '🌀' },
        { id: 'fibExtension', label: 'Fibonacci Extension', icon: '🌀' },
        { id: 'pitchfork', label: 'Pitchfork', icon: '🔱' },
      ].map((tool) => ({
        id: `draw:${tool.id}`,
        label: `Draw: ${tool.label}`,
        description: `Select the ${tool.label.toLowerCase()} drawing tool`,
        category: 'drawing' as const,
        icon: tool.icon,
        shortcut: tool.shortcut,
        keywords: ['draw', 'drawing', 'tool', tool.label.toLowerCase()],
        execute: () => {
          const pane = this.getActivePane();
          if (pane) {
            pane.setDrawingTool(tool.id);
            if (this.toolbar) this.toolbar.setActiveTool(tool.id);
          }
        },
      })),

      // ── Layout ─────────────────────────────────────────────────────
      ...(['1','2h','2v','3v','3h','3L','3R','3T','3B','4','4L','4R','4T','4B','4v','4h','5a','5b','5c','6a','6b','8a','8b'] as LayoutMode[]).map((mode) => ({
        id: `layout:${mode}`,
        label: `Layout: ${MultiChartLayout.getLabel(mode)}`,
        description: `Switch to ${MultiChartLayout.getLabel(mode)} chart layout`,
        category: 'layout' as const,
        icon: '⊞',
        keywords: ['layout', 'grid', 'pane', 'split', mode],
        execute: () => {
          this.layout?.setLayout(mode);
        },
      })),

      // ── Replay ─────────────────────────────────────────────────────
      {
        id: 'replay:toggle',
        label: 'Toggle Replay Mode',
        description: 'Start/stop historical bar-by-bar replay',
        category: 'replay',
        icon: '⏪',
        shortcut: '⇧R',
        keywords: ['replay', 'playback', 'rewind', 'practice', 'historical'],
        execute: () => this.toggleReplayMode(),
      },
      {
        id: 'journal:new',
        label: 'New Journal Entry',
        description: 'Log a new trade in your journal',
        category: 'journal',
        icon: '📝',
        shortcut: 'J',
        keywords: ['journal', 'trade', 'log', 'entry', 'note'],
        execute: () => this.tradeJournal.openNewEntry(),
      },
      {
        id: 'journal:dashboard',
        label: 'Journal Dashboard',
        description: 'View trade journal stats and history',
        category: 'journal',
        icon: '📊',
        shortcut: '⇧J',
        keywords: ['journal', 'dashboard', 'stats', 'history', 'performance'],
        execute: () => this.tradeJournal.openDashboard(),
      },

      // ── Session Stats ──────────────────────────────────────────────
      {
        id: 'stats:dashboard',
        label: 'Session Statistics',
        description: 'View session stats, heatmap calendar, symbol time',
        category: 'settings',
        icon: '📊',
        shortcut: '⇧S',
        keywords: ['session', 'stats', 'statistics', 'calendar', 'heatmap', 'activity'],
        execute: () => this.sessionStats.openDashboard(),
      },

      // ── Macros ─────────────────────────────────────────────────────
      {
        id: 'macros:editor',
        label: 'Hotkey Macros',
        description: 'Create/edit keyboard macro sequences',
        category: 'settings',
        icon: '⌨️',
        shortcut: '⇧M',
        keywords: ['macro', 'hotkey', 'shortcut', 'sequence', 'script'],
        execute: () => this.hotkeyMacros.openEditor(),
      },

      // ── Share ──────────────────────────────────────────────────────
      {
        id: 'share:dialog',
        label: 'Share Chart',
        description: 'Share current chart as link or image',
        category: 'settings',
        icon: '🔗',
        shortcut: '⌘⇧S',
        keywords: ['share', 'link', 'export'],
        execute: () => this.openShareDialog(),
      },
      {
        id: 'share:screenshot',
        label: 'Take Screenshot',
        description: 'Copy chart screenshot to clipboard',
        category: 'settings',
        icon: '📸',
        shortcut: '⌘⇧P',
        keywords: ['screenshot', 'capture', 'image', 'copy', 'clipboard'],
        execute: () => this.takeScreenshot(),
      },

      // ── Alerts ─────────────────────────────────────────────────────
      {
        id: 'alerts:manager',
        label: 'Smart Alerts',
        description: 'Open alert manager for price, volume, and pattern alerts',
        category: 'settings',
        icon: '🔔',
        shortcut: '⇧A',
        keywords: ['alert', 'alarm', 'notification', 'price', 'volume', 'pattern'],
        execute: () => this.smartAlerts.openManager(),
      },
      {
        id: 'alerts:price_above',
        label: 'Alert: Price Above',
        description: 'Create a price-above alert at current price + 1%',
        category: 'settings',
        icon: '↑',
        keywords: ['alert', 'price', 'above'],
        execute: () => {
          const price = this.smartAlerts['callbacks'].getCurrentPrice();
          if (price > 0) {
            this.smartAlerts.createPriceAlert(price * 1.01, 'above');
            this.showToast(`Alert set: above ${(price * 1.01).toFixed(2)}`);
          }
        },
      },
      {
        id: 'alerts:price_below',
        label: 'Alert: Price Below',
        description: 'Create a price-below alert at current price - 1%',
        category: 'settings',
        icon: '↓',
        keywords: ['alert', 'price', 'below'],
        execute: () => {
          const price = this.smartAlerts['callbacks'].getCurrentPrice();
          if (price > 0) {
            this.smartAlerts.createPriceAlert(price * 0.99, 'below');
            this.showToast(`Alert set: below ${(price * 0.99).toFixed(2)}`);
          }
        },
      },

      // ── Comparison ─────────────────────────────────────────────────
      {
        id: 'compare:open',
        label: 'Split Comparison',
        description: 'Compare price action across two time periods',
        category: 'settings',
        icon: '⚡',
        shortcut: '⇧C',
        keywords: ['compare', 'comparison', 'split', 'overlay', 'correlation'],
        execute: () => this.splitComparison.open(),
      },
    ];

    this.commandPalette.registerActions(actions);
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

    // Cleanup new features
    this.commandPalette.destroy();
    this.replayMode?.destroy();
    this.tradeJournal.destroy();
    this.hotkeyMacros.destroy();
    this.conflictDetector.destroy();
    this.sessionStats.endSession();
    this.adaptiveLayout.stopMonitoring();
    this.smartAlerts.destroy();
    this.splitComparison.destroy();
    this.settingsPanel.close();
    this.contextMenu?.hide();

    // Cleanup keyboard listener
    if (this._keydownHandler) {
      window.removeEventListener('keydown', this._keydownHandler);
    }
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

// layoutLabel is now MultiChartLayout.getLabel()

// ─── Bootstrap ───────────────────────────────────────────────────────────────

const appRoot = document.getElementById('app');
if (appRoot) {
  const app = new PinnedApp(appRoot);
  app.init();
}
