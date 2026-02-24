/**
 * ChartPane.ts
 * Self-contained chart pane with its own viewport, render engine, input handler,
 * drawing manager, and state. Multiple panes can coexist independently.
 */

import { ChartState, type ChartStateData, type Candle, type Drawing } from '../core/ChartState';
import { Viewport } from '../core/Viewport';
import { RenderEngine } from '../core/RenderEngine';
import { InputHandler } from '../core/InputHandler';
import { DrawingManager } from '../drawing/DrawingManager';
import { CommandStack } from '../core/CommandStack';
import { renderGrid } from '../renderers/GridRenderer';
import { renderCandlesticks } from '../renderers/CandlestickRenderer';
import { renderCrosshair } from '../renderers/CrosshairRenderer';
import { renderDrawings } from '../drawing/DrawingRenderer';
import { DataService } from '../services/DataService';
import type { PaneConfig } from './MultiChartLayout';

export class ChartPane {
  readonly id: string;
  readonly state: ChartState;
  readonly viewport: Viewport;
  readonly renderEngine: RenderEngine;
  readonly inputHandler: InputHandler;
  readonly drawingManager: DrawingManager;
  readonly commandStack: CommandStack;

  private container: HTMLElement;
  private canvasContainer: HTMLElement;
  private config: PaneConfig;
  private resizeObserver: ResizeObserver;
  private destroyed = false;
  private dataService: DataService;
  private unsubscribeLive: (() => void) | null = null;
  private loading = false;

  constructor(paneEl: HTMLElement, config: PaneConfig) {
    this.id = config.id;
    this.config = config;
    this.container = paneEl;
    this.canvasContainer = paneEl.querySelector('.pane-canvas-container')!;
    this.dataService = DataService.getInstance();

    // Initialize core systems
    this.state = new ChartState({
      symbol: config.symbol,
      exchange: config.exchange,
      timeframe: config.timeframe,
    });

    this.viewport = new Viewport(
      this.canvasContainer.clientWidth || 800,
      this.canvasContainer.clientHeight || 600,
      window.devicePixelRatio || 1,
    );
    this.viewport.setTimeframe(config.timeframe);

    // RenderEngine requires (container, viewport, getState)
    this.renderEngine = new RenderEngine(
      this.canvasContainer,
      this.viewport,
      () => this.state.getState(),
    );

    this.commandStack = new CommandStack();
    this.drawingManager = new DrawingManager(this.state, this.commandStack);

    // InputHandler requires the topmost canvas from the render engine
    const topCanvas = this.renderEngine.getTopCanvas();
    this.inputHandler = new InputHandler(
      topCanvas,
      this.viewport,
      () => this.state.getState(),
    );

    // Register renderers on layers
    this.registerRenderers();

    // Wire input events
    this.wireInputEvents();

    // Resize observer
    this.resizeObserver = new ResizeObserver(() => this.handleResize());
    this.resizeObserver.observe(this.canvasContainer);

    // Initial resize
    this.handleResize();

    // Show loading indicator while fetching
    this.showLoading();

    // Fetch real candle data from BloFin API
    this.loadCandles();

    // Start render loop
    this.startRenderLoop();
  }

  // ── Public API ─────────────────────────────────────────────────────────

  setSymbol(symbol: string): void {
    this.config.symbol = symbol;
    this.state.setState({ symbol });
    this.updatePaneHeader();
    this.loadCandles(); // Refetch candles for new symbol
  }

  setTimeframe(timeframe: string): void {
    this.config.timeframe = timeframe;
    this.state.setState({ timeframe });
    this.viewport.setTimeframe(timeframe);
    this.updatePaneHeader();
    this.loadCandles(); // Refetch candles for new timeframe
  }

  setDrawingTool(tool: string | null): void {
    this.state.setState({ selectedDrawingTool: tool });
    if (tool) {
      this.inputHandler.setMode('DRAW');
      this.drawingManager.startDrawing(tool);
    } else {
      this.inputHandler.setMode('NAVIGATE');
    }
  }

  getConfig(): PaneConfig {
    return { ...this.config };
  }

  destroy(): void {
    this.destroyed = true;
    if (this.unsubscribeLive) {
      this.unsubscribeLive();
      this.unsubscribeLive = null;
    }
    this.hideLiveDot();
    this.resizeObserver.disconnect();
    this.inputHandler.destroy();
    this.renderEngine.destroy();
  }

  // ── Private Setup ──────────────────────────────────────────────────────

  private registerRenderers(): void {
    // Layer 0 - Grid  (LayerRenderer = (ctx, viewport, state) => void)
    this.renderEngine.registerRenderer(0, (ctx, vp, st) => {
      renderGrid(ctx, vp, st);
    });

    // Layer 1 - Candlesticks
    this.renderEngine.registerRenderer(1, (ctx, vp, st) => {
      renderCandlesticks(ctx, vp, st);
    });

    // Layer 3 - Drawings
    this.renderEngine.registerRenderer(3, (ctx, vp, st) => {
      const pending = this.drawingManager.getPendingDrawing?.() ?? null;
      renderDrawings(ctx, vp, st, pending);
    });

    // Layer 5 - Crosshair
    this.renderEngine.registerRenderer(5, (ctx, vp, st) => {
      renderCrosshair(ctx, vp, st);
    });
  }

  private wireInputEvents(): void {
    // Pan — payload is PanEvent { deltaX, deltaY }
    this.inputHandler.on('pan', (e) => {
      this.viewport.pan(e.deltaX, e.deltaY);
      this.renderEngine.markAllDirty();
    });

    // Zoom — payload is ZoomEvent { factor, centerX, centerY, axis }
    this.inputHandler.on('zoom', (e) => {
      this.viewport.zoom(e.factor, e.centerX);
      const st = this.state.getState();
      if (st.autoScale && st.candles.length > 0) {
        this.viewport.fitPriceRange(st.candles);
      }
      this.renderEngine.markAllDirty();
    });

    // Cursor move — payload is CursorMoveEvent { x, y, time, price }
    this.inputHandler.on('cursorMove', (e) => {
      this.state.setState({
        cursor: { x: e.x, y: e.y, visible: true },
      });
      this.renderEngine.markDirty(5);
    });

    // Click for drawing — payload is { time, price, pointIndex }
    this.inputHandler.on('drawPoint', (e) => {
      this.drawingManager.addPoint(e.time, e.price);
      this.renderEngine.markDirty(3);
    });

    // Drawing complete — payload is void
    this.inputHandler.on('drawComplete', () => {
      this.drawingManager.finishDrawing();
      this.state.setState({ selectedDrawingTool: null });
      this.renderEngine.markDirty(3);
    });

    // Drawing cancel — payload is void
    this.inputHandler.on('drawCancel', () => {
      // Reset the active tool to cancel any in-progress drawing
      this.drawingManager.setActiveTool(null);
      this.state.setState({ selectedDrawingTool: null });
      this.renderEngine.markDirty(3);
    });

    // Select drawing — payload is { drawing: Drawing | null }
    this.inputHandler.on('selectDrawing', (e) => {
      if (e.drawing) {
        this.drawingManager.selectDrawing(e.drawing.id);
      } else {
        this.drawingManager.deselectAll();
      }
      this.renderEngine.markDirty(3);
    });

    // Drawing drag (move) — payload is DrawingDragEvent
    this.inputHandler.on('drawingDrag', (e) => {
      const timeDelta = e.currentPoint.time - e.startPoint.time;
      const priceDelta = e.currentPoint.price - e.startPoint.price;
      this.drawingManager.updateMoveDrawing(timeDelta, priceDelta);
      this.renderEngine.markDirty(3);
    });
  }

  private handleResize(): void {
    const rect = this.canvasContainer.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const dpr = window.devicePixelRatio || 1;
    this.viewport.resize(rect.width, rect.height, dpr);
    this.renderEngine.resize(rect.width, rect.height);

    const st = this.state.getState();
    if (st.autoScale && st.candles.length > 0) {
      this.viewport.fitPriceRange(st.candles);
    }

    this.renderEngine.markAllDirty();
  }

  private startRenderLoop(): void {
    this.renderEngine.start();
  }

  private updatePaneHeader(): void {
    const header = this.container.querySelector('.pane-header');
    if (!header) return;
    const sym = header.querySelector('.pane-symbol');
    const tf = header.querySelector('.pane-timeframe');
    if (sym) sym.textContent = this.config.symbol;
    if (tf) tf.textContent = this.config.timeframe;
  }

  /** Fetch real candle data from BloFin, then subscribe to live updates */
  private async loadCandles(): Promise<void> {
    if (this.destroyed) return;

    // Unsubscribe previous live feed
    if (this.unsubscribeLive) {
      this.unsubscribeLive();
      this.unsubscribeLive = null;
    }
    this.hideLiveDot();

    this.loading = true;
    this.showLoading();

    try {
      const candles = await this.dataService.fetchCandles(
        this.config.symbol,
        this.config.timeframe,
        300,
      );

      if (this.destroyed) return;

      this.state.setState({ candles });

      // Fit viewport to data
      if (candles.length > 0) {
        const first = candles[0]!;
        const last = candles[candles.length - 1]!;
        this.viewport.setVisibleRange(first.timestamp, last.timestamp);
        this.viewport.fitPriceRange(candles);
      }

      this.renderEngine.markAllDirty();

      // Subscribe to live candle updates
      this.subscribeLive();
    } catch (err) {
      console.error('[ChartPane] Failed to load candles:', err);
    } finally {
      this.loading = false;
      this.hideLoading();
    }
  }

  /** Subscribe to live WebSocket candle stream */
  private subscribeLive(): void {
    this.unsubscribeLive = this.dataService.subscribe({
      symbol: this.config.symbol,
      timeframe: this.config.timeframe,
      onCandle: (candle) => {
        if (this.destroyed) return;

        const st = this.state.getState();
        const candles = [...st.candles];

        // Update or append candle
        const lastIdx = candles.length - 1;
        if (lastIdx >= 0 && candles[lastIdx]!.timestamp === candle.timestamp) {
          // Update existing candle (in-progress bar)
          candles[lastIdx] = candle;
        } else {
          // New candle
          candles.push(candle);
          // Keep max 500 candles in memory
          if (candles.length > 500) candles.shift();
        }

        this.state.setState({ candles });

        // Auto-scale price if enabled
        if (st.autoScale) {
          this.viewport.fitPriceRange(candles);
        }

        this.renderEngine.markDirty(0); // grid
        this.renderEngine.markDirty(1); // candles
      },
    });

    // Show live indicator dot in header
    this.showLiveDot();
  }

  /** Show loading overlay on the chart pane */
  private showLoading(): void {
    let overlay = this.container.querySelector('.pane-loading') as HTMLElement | null;
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.className = 'pane-loading';
      overlay.innerHTML = `
        <div class="pane-loading-spinner"></div>
        <div class="pane-loading-text">Loading ${this.config.symbol}...</div>
      `;
      this.canvasContainer.appendChild(overlay);
    }
  }

  /** Hide the loading overlay */
  private hideLoading(): void {
    const overlay = this.container.querySelector('.pane-loading');
    if (overlay) overlay.remove();
  }

  /** Show green live dot in pane header */
  private showLiveDot(): void {
    const header = this.container.querySelector('.pane-header');
    if (!header || header.querySelector('.pane-live-dot')) return;
    const dot = document.createElement('span');
    dot.className = 'pane-live-dot';
    dot.title = 'Live data';
    const tf = header.querySelector('.pane-timeframe');
    if (tf) {
      tf.after(dot);
    } else {
      header.appendChild(dot);
    }
  }

  /** Remove live dot from pane header */
  private hideLiveDot(): void {
    const dot = this.container.querySelector('.pane-live-dot');
    if (dot) dot.remove();
  }

}
