import './styles.css';

import { MultiChartLayout, type LayoutMode, type PaneConfig } from './layout/MultiChartLayout';
import { ChartPane } from './layout/ChartPane';
import { ToolBar } from './ui/ToolBar';
import { PropertiesPanel } from './ui/PropertiesPanel';
import { getToolByShortcut } from './drawing/DrawingTools';

// ─── Types ───────────────────────────────────────────────────────────────────

interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const SYMBOLS = ['BTC-USDT', 'ETH-USDT', 'SOL-USDT', 'DOGE-USDT', 'ARB-USDT', 'MATIC-USDT'];
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
  private ws: WebSocket | null = null;

  constructor(rootEl: HTMLElement) {
    this.root = rootEl;
  }

  // ── Bootstrap ────────────────────────────────────────────────────────────

  async init() {
    this.renderShell();
    this.createLayout();
    this.createToolbar();
    this.createPropertiesPanel();
    this.bindKeyboardShortcuts();
  }

  // ── UI Shell ─────────────────────────────────────────────────────────────

  private renderShell() {
    this.root.innerHTML = /* html */ `
      <div class="pinned-layout">
        <!-- Top Bar -->
        <header class="top-bar">
          <div class="top-bar__left">
            <div class="logo">Pinned</div>
            <div class="symbol-selector">
              <select id="symbolSelect" class="symbol-select">
                ${SYMBOLS.map(
                  (s) =>
                    `<option value="${s}" ${s === this.activeSymbol ? 'selected' : ''}>${s}</option>`,
                ).join('')}
              </select>
            </div>
            <div class="timeframe-group" id="timeframeGroup">
              ${TIMEFRAMES.map(
                (tf) =>
                  `<button class="tf-btn ${tf === this.activeTimeframe ? 'active' : ''}" data-tf="${tf}">${tf}</button>`,
              ).join('')}
            </div>
          </div>
          <div class="top-bar__center">
            <div id="layoutSelectorMount"></div>
          </div>
          <div class="top-bar__right">
            <button class="icon-btn" id="indicatorToggle" title="Indicators">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M2 14L6 6l3 4 2-6 3 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
            </button>
            <button class="icon-btn" id="settingsBtn" title="Settings">
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

    this.bindUIEvents();
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
    // Symbol selector
    const symbolSelect = this.root.querySelector<HTMLSelectElement>('#symbolSelect')!;
    symbolSelect.addEventListener('change', (e) => {
      this.activeSymbol = (e.target as HTMLSelectElement).value;
      const pane = this.getActivePane();
      if (pane) pane.setSymbol(this.activeSymbol);
    });

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
    });
  }

  // ── Keyboard Shortcuts ───────────────────────────────────────────────────

  private bindKeyboardShortcuts() {
    window.addEventListener('keydown', (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

      const key = e.key.toUpperCase();

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
    const symbolSelect = this.root.querySelector<HTMLSelectElement>('#symbolSelect');
    if (symbolSelect) symbolSelect.value = this.activeSymbol;

    this.root.querySelectorAll('.tf-btn').forEach((btn) => {
      btn.classList.toggle('active', (btn as HTMLElement).dataset.tf === this.activeTimeframe);
    });
  }

  private showToast(message: string, duration = 1500) {
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
    if (this.ws) { this.ws.close(); this.ws = null; }
  }
}

// ─── Bootstrap ───────────────────────────────────────────────────────────────

const appRoot = document.getElementById('app');
if (appRoot) {
  const app = new PinnedApp(appRoot);
  app.init();
}
