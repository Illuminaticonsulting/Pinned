/**
 * RenderEngine.ts
 * Multi-layer Canvas rendering engine for the Pinned chart platform.
 *
 * Creates a stack of six canvas elements – one per visual layer – and drives
 * an efficient requestAnimationFrame loop that only redraws dirty layers.
 *
 * Layer 0: Grid        – background, gridlines, axis labels
 * Layer 1: Candles     – candlestick bodies/wicks or footprint cells
 * Layer 2: Indicators  – VWAP, VP histogram, delta, etc.
 * Layer 3: Drawings    – user-created lines, fibs, rectangles
 * Layer 4: Annotations – AI signals, pattern markers, iceberg/spoof icons
 * Layer 5: Crosshair   – cursor lines, price/time labels
 */

import type { ChartStateData } from './ChartState';
import type { Viewport } from './Viewport';

// ─── Types ─────────────────────────────────────────────────────────────────────

/**
 * A renderer function registered on a specific layer.
 * It receives the 2D context of that layer's canvas, the current viewport,
 * and a readonly snapshot of the chart state.
 */
export type LayerRenderer = (
  ctx: CanvasRenderingContext2D,
  viewport: Viewport,
  state: Readonly<ChartStateData>,
) => void;

/** Human-readable layer names for readability and profiling output. */
export const LAYER_NAMES: readonly string[] = [
  'Grid',
  'Candles',
  'Indicators',
  'Drawings',
  'Annotations',
  'Crosshair',
] as const;

export const LAYER_COUNT = LAYER_NAMES.length;

/** Per-layer profiling statistics. */
export interface LayerStats {
  readonly name: string;
  /** Last render duration in milliseconds. */
  lastRenderMs: number;
  /** Exponential moving average render duration (ms). */
  avgRenderMs: number;
  /** Total number of times this layer was rendered. */
  renderCount: number;
}

// ─── RenderEngine ──────────────────────────────────────────────────────────────

/**
 * Orchestrates multi-layer canvas rendering with dirty-flag optimisation.
 *
 * Usage:
 * ```ts
 * const engine = new RenderEngine(container, viewport, chartState.getState);
 * engine.registerRenderer(1, drawCandles);
 * engine.start();
 * ```
 */
export class RenderEngine {
  /** The DOM element that contains all canvas layers. */
  private readonly container: HTMLElement;

  /** Viewport reference for coordinate transforms. */
  private viewport: Viewport;

  /** State accessor – called each frame to get the latest state snapshot. */
  private getState: () => Readonly<ChartStateData>;

  /** Canvas elements, one per layer. */
  private canvases: HTMLCanvasElement[] = [];

  /** 2D rendering contexts, one per layer. */
  private contexts: CanvasRenderingContext2D[] = [];

  /** Dirty flags – when true the layer needs a redraw. */
  private dirty: boolean[] = [];

  /** Registered renderers per layer (multiple renderers per layer allowed). */
  private renderers: LayerRenderer[][] = [];

  /** Per-layer profiling stats. */
  private stats: LayerStats[] = [];

  /** requestAnimationFrame handle (0 when stopped). */
  private rafHandle = 0;

  /** Whether the render loop is running. */
  private running = false;

  /** Timestamp of the last frame (for FPS calculation). */
  private lastFrameTime = 0;

  /** Rolling FPS counter. */
  private fps = 0;
  private frameTimeSamples: number[] = [];
  private readonly FPS_SAMPLE_COUNT = 60;

  /** Current logical dimensions. */
  private logicalWidth = 0;
  private logicalHeight = 0;

  /** Device pixel ratio. */
  private dpr = 1;

  /**
   * @param container - A DOM element that will host the stacked canvases.
   * @param viewport  - The shared {@link Viewport} instance.
   * @param getState  - A function returning the current {@link ChartStateData}.
   */
  constructor(
    container: HTMLElement,
    viewport: Viewport,
    getState: () => Readonly<ChartStateData>,
  ) {
    this.container = container;
    this.viewport = viewport;
    this.getState = getState;
    this.dpr = typeof window !== 'undefined' ? window.devicePixelRatio : 1;

    this.createCanvases();
  }

  // ── Canvas Setup ───────────────────────────────────────────────────────────

  /**
   * Create the six stacked canvas elements and append them to the container.
   */
  private createCanvases(): void {
    // Ensure the container is a positioning context.
    const pos = getComputedStyle(this.container).position;
    if (pos === 'static') {
      this.container.style.position = 'relative';
    }

    for (let i = 0; i < LAYER_COUNT; i++) {
      const canvas = document.createElement('canvas');
      canvas.style.position = 'absolute';
      canvas.style.top = '0';
      canvas.style.left = '0';
      canvas.style.width = '100%';
      canvas.style.height = '100%';
      canvas.style.zIndex = String(i);
      canvas.dataset.layer = LAYER_NAMES[i];

      // Only the topmost layer should receive pointer events.
      canvas.style.pointerEvents = i === LAYER_COUNT - 1 ? 'auto' : 'none';

      const ctx = canvas.getContext('2d', { alpha: i !== 0 });
      if (!ctx) throw new Error(`Failed to get 2D context for layer ${i} (${LAYER_NAMES[i]})`);

      this.container.appendChild(canvas);
      this.canvases.push(canvas);
      this.contexts.push(ctx);
      this.dirty.push(true);
      this.renderers.push([]);
      this.stats.push({
        name: LAYER_NAMES[i],
        lastRenderMs: 0,
        avgRenderMs: 0,
        renderCount: 0,
      });
    }

    // Initial sizing.
    this.resize(this.container.clientWidth, this.container.clientHeight);
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Register a renderer on a specific layer.
   *
   * Multiple renderers may be registered per layer; they will be invoked in
   * registration order.
   *
   * @param layer    - Layer index (0–5).
   * @param renderer - Render function.
   */
  registerRenderer(layer: number, renderer: LayerRenderer): void {
    this.assertLayer(layer);
    this.renderers[layer].push(renderer);
    this.dirty[layer] = true;
  }

  /**
   * Remove a previously registered renderer.
   *
   * @param layer    - Layer index.
   * @param renderer - The exact function reference that was registered.
   */
  unregisterRenderer(layer: number, renderer: LayerRenderer): void {
    this.assertLayer(layer);
    const idx = this.renderers[layer].indexOf(renderer);
    if (idx !== -1) this.renderers[layer].splice(idx, 1);
  }

  /**
   * Mark a specific layer as needing a redraw on the next frame.
   *
   * @param layer - Layer index (0–5).
   */
  markDirty(layer: number): void {
    this.assertLayer(layer);
    this.dirty[layer] = true;
  }

  /**
   * Mark all layers as dirty, forcing a full redraw on the next frame.
   */
  markAllDirty(): void {
    for (let i = 0; i < LAYER_COUNT; i++) {
      this.dirty[i] = true;
    }
  }

  /**
   * Resize all canvas layers. Handles DPI scaling.
   *
   * @param width  - New logical (CSS) width.
   * @param height - New logical (CSS) height.
   */
  resize(width: number, height: number): void {
    this.logicalWidth = width;
    this.logicalHeight = height;
    this.dpr = typeof window !== 'undefined' ? window.devicePixelRatio : 1;

    const physicalW = Math.round(width * this.dpr);
    const physicalH = Math.round(height * this.dpr);

    for (let i = 0; i < LAYER_COUNT; i++) {
      const canvas = this.canvases[i];
      canvas.width = physicalW;
      canvas.height = physicalH;
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;

      // Scale the context so renderers can work in logical pixels.
      this.contexts[i].setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    }

    this.markAllDirty();
  }

  /**
   * Start the render loop.
   */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastFrameTime = performance.now();
    this.tick(this.lastFrameTime);
  }

  /**
   * Stop the render loop.
   */
  stop(): void {
    this.running = false;
    if (this.rafHandle) {
      cancelAnimationFrame(this.rafHandle);
      this.rafHandle = 0;
    }
  }

  /**
   * @returns The current estimated frames per second.
   */
  getFps(): number {
    return this.fps;
  }

  /**
   * @returns Per-layer profiling statistics.
   */
  getStats(): readonly LayerStats[] {
    return this.stats;
  }

  /**
   * @returns The topmost canvas element (layer 5 – Crosshair).
   *          This is the element that should receive input events.
   */
  getTopCanvas(): HTMLCanvasElement {
    return this.canvases[LAYER_COUNT - 1];
  }

  /**
   * @param layer - Layer index.
   * @returns The canvas element of the requested layer.
   */
  getCanvas(layer: number): HTMLCanvasElement {
    this.assertLayer(layer);
    return this.canvases[layer];
  }

  /**
   * Destroy all canvases and stop the render loop. Call when unmounting.
   */
  destroy(): void {
    this.stop();
    for (const canvas of this.canvases) {
      canvas.remove();
    }
    this.canvases = [];
    this.contexts = [];
    this.renderers = [];
  }

  // ── Render Loop ────────────────────────────────────────────────────────────

  /**
   * Internal animation frame callback.
   */
  private tick = (now: number): void => {
    if (!this.running) return;

    this.rafHandle = requestAnimationFrame(this.tick);

    // FPS tracking
    const frameDelta = now - this.lastFrameTime;
    this.lastFrameTime = now;
    this.updateFps(frameDelta);

    // Snapshot state once per frame.
    const state = this.getState();

    let anyDirty = false;
    for (let i = 0; i < LAYER_COUNT; i++) {
      if (!this.dirty[i]) continue;
      anyDirty = true;

      const ctx = this.contexts[i];
      const t0 = performance.now();

      // Clear the canvas (in logical space, context is pre-scaled).
      ctx.clearRect(0, 0, this.logicalWidth, this.logicalHeight);

      // Invoke all renderers registered for this layer.
      for (const renderer of this.renderers[i]) {
        try {
          renderer(ctx, this.viewport, state);
        } catch (err) {
          console.error(`[RenderEngine] Error in renderer for layer ${i} (${LAYER_NAMES[i]}):`, err);
        }
      }

      const renderMs = performance.now() - t0;
      this.updateLayerStats(i, renderMs);

      this.dirty[i] = false;
    }

    // Warn when a frame takes too long.
    if (anyDirty && frameDelta > 16.67) {
      // Only log occasionally to avoid console spam.
      if (Math.random() < 0.05) {
        console.warn(
          `[RenderEngine] Dropped frame: ${frameDelta.toFixed(1)}ms (target 16.67ms)`,
        );
      }
    }
  };

  // ── Internal Helpers ───────────────────────────────────────────────────────

  /**
   * Update FPS rolling average.
   */
  private updateFps(frameDeltaMs: number): void {
    this.frameTimeSamples.push(frameDeltaMs);
    if (this.frameTimeSamples.length > this.FPS_SAMPLE_COUNT) {
      this.frameTimeSamples.shift();
    }
    const avg =
      this.frameTimeSamples.reduce((a, b) => a + b, 0) / this.frameTimeSamples.length;
    this.fps = avg > 0 ? 1000 / avg : 0;
  }

  /**
   * Update per-layer profiling statistics.
   */
  private updateLayerStats(layer: number, renderMs: number): void {
    const s = this.stats[layer];
    s.lastRenderMs = renderMs;
    s.renderCount++;
    // Exponential moving average (α = 0.1).
    s.avgRenderMs = s.avgRenderMs === 0 ? renderMs : s.avgRenderMs * 0.9 + renderMs * 0.1;
  }

  /**
   * Validate a layer index.
   */
  private assertLayer(layer: number): void {
    if (layer < 0 || layer >= LAYER_COUNT) {
      throw new RangeError(
        `Invalid layer index ${layer}. Must be 0–${LAYER_COUNT - 1}.`,
      );
    }
  }
}
