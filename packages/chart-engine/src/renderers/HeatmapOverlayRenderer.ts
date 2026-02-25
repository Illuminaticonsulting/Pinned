/**
 * HeatmapOverlayRenderer.ts
 * Renders an order-book depth heatmap directly on the chart canvas (Layer 1),
 * synchronized with the chart's viewport coordinates — replacing the old
 * separate-panel approach. Uses Canvas2D with a pre-computed color LUT for
 * maximum compatibility and zero WebGL context overhead.
 *
 * The heatmap sits BEHIND the candlesticks, showing bid/ask depth as colored
 * cells that align perfectly with the price axis and time axis.
 */

import type { Viewport } from '../core/Viewport';
import type { ChartStateData } from '../core/ChartState';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface HeatmapCell {
  time: number;       // Epoch ms (maps to a candle timestamp)
  price: number;      // Actual price level
  intensity: number;  // 0-255
}

export interface HeatmapFrame {
  cells: HeatmapCell[];
  priceStep: number;       // Price increment per row
  timeStep: number;        // Time increment per column (ms)
  priceMin: number;
  priceMax: number;
  timeMin: number;         // Earliest timestamp
  timeMax: number;         // Latest timestamp
}

// ─── Color LUT ───────────────────────────────────────────────────────────────

/** Pre-computed 256-entry RGBA color lookup table (matches heatmap spec). */
const COLOR_LUT: Uint32Array = (() => {
  const lut = new Uint32Array(256);
  const canvas = typeof document !== 'undefined'
    ? document.createElement('canvas')
    : null;

  // Inline color stops: dark → blue → cyan → yellow → orange → red
  const stops: [number, number, number, number][] = [
    [0x0a, 0x0e, 0x17, 0],     // bg
    [0x1e, 0x40, 0xaf, 1],     // blue-dark
    [0x3b, 0x82, 0xf6, 50],    // blue-light
    [0x06, 0xb6, 0xd4, 100],   // cyan
    [0xea, 0xb3, 0x08, 150],   // yellow
    [0xf9, 0x73, 0x16, 200],   // orange
    [0xef, 0x44, 0x44, 255],   // red
  ];

  function lerpColor(idx: number): [number, number, number, number] {
    if (idx === 0) return [0, 0, 0, 0]; // fully transparent for 0

    for (let i = 0; i < stops.length - 1; i++) {
      const [r1, g1, b1, t1] = stops[i]!;
      const [r2, g2, b2, t2] = stops[i + 1]!;
      if (idx >= t1 && idx <= t2) {
        const t = t2 === t1 ? 0 : (idx - t1) / (t2 - t1);
        return [
          Math.round(r1 + (r2 - r1) * t),
          Math.round(g1 + (g2 - g1) * t),
          Math.round(b1 + (b2 - b1) * t),
          Math.min(255, Math.round(60 + idx * 0.65)), // alpha ramps up
        ];
      }
    }
    return [0xef, 0x44, 0x44, 255]; // red fallback
  }

  for (let i = 0; i < 256; i++) {
    const [r, g, b, a] = lerpColor(i);
    // Store as RGBA bytes in a Uint32 (little-endian: ABGR)
    lut[i] = (a << 24) | (b << 16) | (g << 8) | r;
  }

  return lut;
})();

// ─── Constants ───────────────────────────────────────────────────────────────

const RIGHT_MARGIN = 80;
const BOTTOM_MARGIN = 28;

// ─── HeatmapOverlay State ────────────────────────────────────────────────────

/** Singleton state holder for heatmap data that persists across render calls. */
class HeatmapDataStore {
  private static instance: HeatmapDataStore | null = null;

  /** Raw cell data indexed by `${time}:${price}` → intensity */
  private cellMap: Map<string, number> = new Map();

  /** Current frame metadata */
  priceStep = 1;
  timeStep = 60_000;
  priceMin = 0;
  priceMax = 100_000;
  timeMin = 0;
  timeMax = 0;
  enabled = false;
  opacity = 0.6;

  /** Whether data has been updated since last render */
  dirty = true;

  /** Offscreen canvas for the rasterized heatmap */
  private offscreen: OffscreenCanvas | HTMLCanvasElement | null = null;
  private offCtx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null = null;
  private offW = 0;
  private offH = 0;

  static getInstance(): HeatmapDataStore {
    if (!HeatmapDataStore.instance) {
      HeatmapDataStore.instance = new HeatmapDataStore();
    }
    return HeatmapDataStore.instance;
  }

  /** Set complete heatmap frame data */
  setFrame(frame: HeatmapFrame): void {
    this.cellMap.clear();
    this.priceStep = frame.priceStep;
    this.timeStep = frame.timeStep;
    this.priceMin = frame.priceMin;
    this.priceMax = frame.priceMax;
    this.timeMin = frame.timeMin;
    this.timeMax = frame.timeMax;

    for (const cell of frame.cells) {
      if (cell.intensity > 0) {
        this.cellMap.set(`${cell.time}:${cell.price}`, cell.intensity);
      }
    }
    this.dirty = true;
  }

  /** Feed binary heatmap blob (from WebSocket) */
  setBlob(blob: ArrayBuffer): void {
    const view = new DataView(blob);
    if (blob.byteLength < 48) return; // minimal header

    // Header: width(u32), height(u32), priceMin(f64), priceMax(f64), priceStep(f64), timeMin(f64), timeMax(f64)
    const width = view.getUint32(0, true);
    const height = view.getUint32(4, true);
    this.priceMin = view.getFloat64(8, true);
    this.priceMax = view.getFloat64(16, true);
    this.priceStep = view.getFloat64(24, true);
    this.timeMin = view.getFloat64(32, true);
    this.timeMax = view.getFloat64(40, true);
    this.timeStep = width > 0 ? (this.timeMax - this.timeMin) / width : 60_000;

    // Pixel data (1 byte per cell, row-major)
    const headerSize = 48;
    const pixels = new Uint8Array(blob, headerSize);

    this.cellMap.clear();
    for (let row = 0; row < height && row * width < pixels.length; row++) {
      const price = this.priceMin + row * this.priceStep;
      for (let col = 0; col < width; col++) {
        const idx = row * width + col;
        const intensity = pixels[idx] ?? 0;
        if (intensity > 0) {
          const time = this.timeMin + col * this.timeStep;
          this.cellMap.set(`${time}:${price}`, intensity);
        }
      }
    }
    this.dirty = true;
  }

  /** Update individual cells (incremental from WebSocket diffs) */
  updateCells(cells: HeatmapCell[]): void {
    for (const cell of cells) {
      if (cell.intensity > 0) {
        this.cellMap.set(`${cell.time}:${cell.price}`, cell.intensity);
      } else {
        this.cellMap.delete(`${cell.time}:${cell.price}`);
      }
    }
    this.dirty = true;
  }

  /** Get all cell data as iterable */
  getCells(): IterableIterator<[string, number]> {
    return this.cellMap.entries();
  }

  getCellCount(): number {
    return this.cellMap.size;
  }

  clear(): void {
    this.cellMap.clear();
    this.dirty = true;
  }

  /** Set display opacity (0 = fully transparent, 1 = opaque) */
  setOpacity(val: number): void {
    this.opacity = Math.max(0, Math.min(1, val));
    this.dirty = true;
  }

  setEnabled(val: boolean): void {
    this.enabled = val;
    this.dirty = true;
  }

  isEnabled(): boolean {
    return this.enabled;
  }
}

// ─── Export Store Access ─────────────────────────────────────────────────────

export const heatmapStore = HeatmapDataStore.getInstance();

// ─── Renderer ────────────────────────────────────────────────────────────────

/**
 * Render the heatmap overlay directly on the chart canvas.
 * Must be called BEFORE candlestick rendering on Layer 1 so candles draw on top.
 *
 * Performance: iterates only visible cells using spatial culling.
 * Each cell is rendered as a filled rectangle with color from the pre-computed LUT.
 */
export function renderHeatmapOverlay(
  ctx: CanvasRenderingContext2D,
  viewport: Viewport,
  _state: Readonly<ChartStateData>,
): void {
  const store = HeatmapDataStore.getInstance();
  if (!store.enabled || store.getCellCount() === 0) return;

  const { width, height } = viewport.getLogicalSize();
  const chartW = width - RIGHT_MARGIN;
  const chartH = height - BOTTOM_MARGIN;

  const { start: startTime, end: endTime } = viewport.getVisibleTimeRange();
  const { low: priceLow, high: priceHigh } = viewport.getVisiblePriceRange();

  const priceStep = store.priceStep;
  const timeStep = store.timeStep;

  if (priceStep <= 0 || timeStep <= 0) return;

  // Calculate cell dimensions in pixels
  const tpp = viewport.getTimePerPixel();
  const ppp = viewport.getPricePerPixel();
  const cellW = Math.max(1, tpp > 0 ? timeStep / tpp : 1);
  const cellH = Math.max(1, ppp > 0 ? priceStep / ppp : 1);

  // Skip if cells are too tiny to see (< 0.5px)
  if (cellW < 0.5 && cellH < 0.5) return;

  ctx.save();
  ctx.globalAlpha = store.opacity;

  // Clip to chart area
  ctx.beginPath();
  ctx.rect(0, 0, chartW, chartH);
  ctx.clip();

  // Use ImageData for bulk pixel rendering when cells are small
  if (cellW <= 3 && cellH <= 3) {
    renderHeatmapPixelMode(ctx, viewport, store, chartW, chartH, startTime, endTime, priceLow, priceHigh);
  } else {
    renderHeatmapRectMode(ctx, viewport, store, chartW, chartH, cellW, cellH, startTime, endTime, priceLow, priceHigh);
  }

  ctx.restore();
}

/**
 * Render heatmap cells as individual filled rectangles.
 * Used when cells are large enough to be visible individually.
 */
function renderHeatmapRectMode(
  ctx: CanvasRenderingContext2D,
  viewport: Viewport,
  store: HeatmapDataStore,
  chartW: number,
  chartH: number,
  cellW: number,
  cellH: number,
  startTime: number,
  endTime: number,
  priceLow: number,
  priceHigh: number,
): void {
  const priceStep = store.priceStep;
  const timeStep = store.timeStep;

  // Batch by color to minimize fillStyle changes
  const colorBuckets: Map<number, [number, number][]> = new Map();

  for (const [key, intensity] of store.getCells()) {
    const [timeStr, priceStr] = key.split(':');
    const time = Number(timeStr);
    const price = Number(priceStr);

    // Cull: skip cells outside visible range (with 1-cell margin)
    if (time < startTime - timeStep || time > endTime + timeStep) continue;
    if (price < priceLow - priceStep || price > priceHigh + priceStep) continue;

    const x = viewport.timeToX(time) - cellW * 0.5;
    const y = viewport.priceToY(price) - cellH * 0.5;

    // Skip if completely off-screen
    if (x + cellW < 0 || x > chartW || y + cellH < 0 || y > chartH) continue;

    if (!colorBuckets.has(intensity)) {
      colorBuckets.set(intensity, []);
    }
    colorBuckets.get(intensity)!.push([x, y]);
  }

  // Draw batched by color
  for (const [intensity, positions] of colorBuckets) {
    const rgba = COLOR_LUT[intensity]!;
    const r = rgba & 0xff;
    const g = (rgba >> 8) & 0xff;
    const b = (rgba >> 16) & 0xff;
    const a = ((rgba >> 24) & 0xff) / 255;
    ctx.fillStyle = `rgba(${r},${g},${b},${a})`;

    for (const [x, y] of positions) {
      ctx.fillRect(x, y, cellW, cellH);
    }
  }
}

/**
 * Render heatmap using ImageData for very dense/small cells.
 * Much faster than individual fillRect calls when there are thousands of cells.
 */
function renderHeatmapPixelMode(
  ctx: CanvasRenderingContext2D,
  viewport: Viewport,
  store: HeatmapDataStore,
  chartW: number,
  chartH: number,
  startTime: number,
  endTime: number,
  priceLow: number,
  priceHigh: number,
): void {
  const w = Math.ceil(chartW);
  const h = Math.ceil(chartH);
  if (w <= 0 || h <= 0) return;

  const imageData = ctx.createImageData(w, h);
  const pixels = new Uint32Array(imageData.data.buffer);

  const priceStep = store.priceStep;
  const timeStep = store.timeStep;

  for (const [key, intensity] of store.getCells()) {
    const [timeStr, priceStr] = key.split(':');
    const time = Number(timeStr);
    const price = Number(priceStr);

    // Cull outside visible range
    if (time < startTime - timeStep || time > endTime + timeStep) continue;
    if (price < priceLow - priceStep || price > priceHigh + priceStep) continue;

    const px = Math.round(viewport.timeToX(time));
    const py = Math.round(viewport.priceToY(price));

    if (px < 0 || px >= w || py < 0 || py >= h) continue;

    const pixelIndex = py * w + px;
    const color = COLOR_LUT[intensity]!;

    // Alpha-blend: simple "over" composite
    const existing = pixels[pixelIndex]!;
    if (existing === 0) {
      pixels[pixelIndex] = color;
    } else {
      // Blend — new color over existing
      const srcA = ((color >> 24) & 0xff) / 255;
      const dstA = ((existing >> 24) & 0xff) / 255;
      const outA = srcA + dstA * (1 - srcA);
      if (outA > 0) {
        const blend = (sc: number, dc: number) =>
          Math.round((sc * srcA + dc * dstA * (1 - srcA)) / outA);
        const r = blend(color & 0xff, existing & 0xff);
        const g = blend((color >> 8) & 0xff, (existing >> 8) & 0xff);
        const b = blend((color >> 16) & 0xff, (existing >> 16) & 0xff);
        const a = Math.round(outA * 255);
        pixels[pixelIndex] = (a << 24) | (b << 16) | (g << 8) | r;
      }
    }
  }

  ctx.putImageData(imageData, 0, 0);
}
