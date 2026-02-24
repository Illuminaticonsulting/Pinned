/**
 * Canvas2DHeatmapFallback — Canvas 2D fallback renderer for heatmap
 * when WebGL is unavailable.
 *
 * Same interface as WebGLHeatmapRenderer, uses ImageData for pixel
 * manipulation with dirty-rectangle optimization.
 * Performance target: handle 500K cells at 4fps.
 */

import type { HeatmapAnnotation, HeatmapCellUpdate, HeatmapAxisConfig } from './WebGLHeatmapRenderer';

// ─── Constants ─────────────────────────────────────────────────────────────────

const DEFAULT_WIDTH = 1024;
const DEFAULT_HEIGHT = 600;
const LEGEND_WIDTH = 32;
const AXIS_FONT = '11px JetBrains Mono, monospace';

// Pre-computed color LUT (256 entries × 3 channels)
const COLOR_LUT = new Uint8Array(256 * 3);

(() => {
  // Build the color lookup table once at module load
  const stops: [number, number, number, number][] = [
    [0x0a, 0x0e, 0x17, 0],
    [0x1e, 0x40, 0xaf, 1],
    [0x3b, 0x82, 0xf6, 50],
    [0x06, 0xb6, 0xd4, 100],
    [0xea, 0xb3, 0x08, 150],
    [0xf9, 0x73, 0x16, 200],
    [0xef, 0x44, 0x44, 255],
  ];

  COLOR_LUT[0] = stops[0]![0];
  COLOR_LUT[1] = stops[0]![1];
  COLOR_LUT[2] = stops[0]![2];

  for (let v = 1; v <= 255; v++) {
    let segIdx = 0;
    for (let s = 1; s < stops.length; s++) {
      if (v <= stops[s]![3]) { segIdx = s; break; }
    }
    const [r0, g0, b0, t0] = stops[segIdx - 1]!;
    const [r1, g1, b1, t1] = stops[segIdx]!;
    const t = t1 === t0 ? 1 : (v - t0) / (t1 - t0);
    const idx = v * 3;
    COLOR_LUT[idx] = Math.round(r0 + (r1 - r0) * t);
    COLOR_LUT[idx + 1] = Math.round(g0 + (g1 - g0) * t);
    COLOR_LUT[idx + 2] = Math.round(b0 + (b1 - b0) * t);
  }
})();

// ─── Dirty Rectangle Tracker ───────────────────────────────────────────────────

interface DirtyRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

class DirtyRegion {
  private rects: DirtyRect[] = [];
  private fullDirty = false;

  markFull(): void {
    this.fullDirty = true;
    this.rects = [];
  }

  markCell(x: number, y: number): void {
    if (this.fullDirty) return;
    // Merge into last rect if adjacent, otherwise push new
    const last = this.rects[this.rects.length - 1];
    if (last && Math.abs(x - last.x1) <= 1 && Math.abs(y - last.y1) <= 1) {
      last.x1 = Math.max(last.x1, x + 1);
      last.y1 = Math.max(last.y1, y + 1);
      last.x0 = Math.min(last.x0, x);
      last.y0 = Math.min(last.y0, y);
    } else {
      this.rects.push({ x0: x, y0: y, x1: x + 1, y1: y + 1 });
    }
  }

  isDirty(): boolean {
    return this.fullDirty || this.rects.length > 0;
  }

  isFullDirty(): boolean {
    return this.fullDirty;
  }

  getRects(): DirtyRect[] {
    return this.rects;
  }

  clear(): void {
    this.fullDirty = false;
    this.rects = [];
  }
}

// ─── Canvas2DHeatmapFallback ───────────────────────────────────────────────────

export class Canvas2DHeatmapFallback {
  // DOM
  private container: HTMLElement | null = null;
  private wrapper: HTMLDivElement | null = null;
  private heatCanvas: HTMLCanvasElement | null = null;
  private overlayCanvas: HTMLCanvasElement | null = null;
  private legendCanvas: HTMLCanvasElement | null = null;

  // State
  private dataWidth = DEFAULT_WIDTH;
  private dataHeight = DEFAULT_HEIGHT;
  private cpuData: Uint8Array = new Uint8Array(DEFAULT_WIDTH * DEFAULT_HEIGHT);
  private imageData: ImageData | null = null;
  private heatCtx: CanvasRenderingContext2D | null = null;
  private dirty = new DirtyRegion();
  private annotations: HeatmapAnnotation[] = [];
  private axisConfig: HeatmapAxisConfig = {
    priceMin: 0,
    priceMax: 100000,
    priceStep: 10,
    timeOrigin: Date.now(),
    timeStep: 1000,
    decimals: 2,
  };
  private resizeObserver: ResizeObserver | null = null;
  private destroyed = false;

  // ── Public API ───────────────────────────────────────────────────────────

  init(container: HTMLElement): void {
    this.container = container;

    this.wrapper = document.createElement('div');
    Object.assign(this.wrapper.style, {
      position: 'relative',
      width: '100%',
      height: '100%',
      overflow: 'hidden',
      background: '#0a0e17',
    } as CSSStyleDeclaration);
    container.appendChild(this.wrapper);

    // Heatmap canvas
    this.heatCanvas = document.createElement('canvas');
    Object.assign(this.heatCanvas.style, {
      position: 'absolute',
      top: '0',
      left: '0',
      width: `calc(100% - ${LEGEND_WIDTH}px)`,
      height: '100%',
      imageRendering: 'pixelated',
    } as CSSStyleDeclaration);
    this.wrapper.appendChild(this.heatCanvas);
    this.heatCtx = this.heatCanvas.getContext('2d', { willReadFrequently: true })!;

    // Overlay canvas for axes / annotations
    this.overlayCanvas = document.createElement('canvas');
    Object.assign(this.overlayCanvas.style, {
      position: 'absolute',
      top: '0',
      left: '0',
      width: `calc(100% - ${LEGEND_WIDTH}px)`,
      height: '100%',
      pointerEvents: 'none',
    } as CSSStyleDeclaration);
    this.wrapper.appendChild(this.overlayCanvas);

    // Legend
    this.legendCanvas = document.createElement('canvas');
    Object.assign(this.legendCanvas.style, {
      position: 'absolute',
      top: '0',
      right: '0',
      width: `${LEGEND_WIDTH}px`,
      height: '100%',
    } as CSSStyleDeclaration);
    this.wrapper.appendChild(this.legendCanvas);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);

    this.resize();
    this.drawLegend();
  }

  setData(blob: ArrayBuffer): void {
    const headerSize = 8;
    if (blob.byteLength < headerSize) return;

    const view = new DataView(blob);
    const width = view.getUint32(0, true);
    const height = view.getUint32(4, true);
    const pixelData = new Uint8Array(blob, headerSize, width * height);
    this.setFullData(pixelData, width, height);
  }

  setFullData(data: Uint8Array, width: number, height: number): void {
    this.dataWidth = width;
    this.dataHeight = height;
    this.cpuData = new Uint8Array(data);

    // Rebuild ImageData at data dimensions (we'll draw scaled)
    this.imageData = new ImageData(width, height);
    this.writeAllPixels();
    this.dirty.markFull();
    this.render();
  }

  updateCells(cells: HeatmapCellUpdate[]): void {
    if (!this.imageData) {
      this.imageData = new ImageData(this.dataWidth, this.dataHeight);
      this.writeAllPixels();
    }

    const pixels = this.imageData.data;

    for (const cell of cells) {
      const { priceIndex, timeIndex, intensity } = cell;
      if (
        priceIndex < 0 || priceIndex >= this.dataWidth ||
        timeIndex < 0 || timeIndex >= this.dataHeight
      ) continue;

      const dataIdx = timeIndex * this.dataWidth + priceIndex;
      this.cpuData[dataIdx] = intensity & 0xff;

      const pixelIdx = dataIdx * 4;
      const lutIdx = (intensity & 0xff) * 3;
      pixels[pixelIdx] = COLOR_LUT[lutIdx]!;
      pixels[pixelIdx + 1] = COLOR_LUT[lutIdx + 1]!;
      pixels[pixelIdx + 2] = COLOR_LUT[lutIdx + 2]!;
      pixels[pixelIdx + 3] = intensity < 1 ? 0 : 255;

      this.dirty.markCell(priceIndex, timeIndex);
    }

    this.render();
  }

  addAnnotation(event: HeatmapAnnotation): void {
    this.annotations.push(event);
    this.drawOverlay();
  }

  setAxisConfig(config: Partial<HeatmapAxisConfig>): void {
    Object.assign(this.axisConfig, config);
    this.drawOverlay();
  }

  resize(): void {
    if (this.destroyed || !this.wrapper) return;

    const rect = this.wrapper.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const heatW = Math.floor(rect.width - LEGEND_WIDTH);
    const h = Math.floor(rect.height);

    if (this.heatCanvas) {
      this.heatCanvas.width = heatW * dpr;
      this.heatCanvas.height = h * dpr;
    }
    if (this.overlayCanvas) {
      this.overlayCanvas.width = heatW * dpr;
      this.overlayCanvas.height = h * dpr;
    }
    if (this.legendCanvas) {
      this.legendCanvas.width = LEGEND_WIDTH * dpr;
      this.legendCanvas.height = h * dpr;
    }

    this.dirty.markFull();
    this.render();
    this.drawLegend();
  }

  destroy(): void {
    this.destroyed = true;
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
    if (this.wrapper && this.container) {
      this.container.removeChild(this.wrapper);
    }
    this.heatCanvas = null;
    this.overlayCanvas = null;
    this.legendCanvas = null;
    this.heatCtx = null;
    this.imageData = null;
    this.wrapper = null;
    this.container = null;
    this.annotations = [];
  }

  // ── Private ──────────────────────────────────────────────────────────────

  private writeAllPixels(): void {
    if (!this.imageData) return;
    const pixels = this.imageData.data;
    const len = this.dataWidth * this.dataHeight;

    for (let i = 0; i < len; i++) {
      const v = this.cpuData[i]!;
      const lutIdx = v * 3;
      const px = i * 4;
      pixels[px] = COLOR_LUT[lutIdx]!;
      pixels[px + 1] = COLOR_LUT[lutIdx + 1]!;
      pixels[px + 2] = COLOR_LUT[lutIdx + 2]!;
      pixels[px + 3] = v < 1 ? 0 : 255;
    }
  }

  private render(): void {
    if (!this.heatCtx || !this.heatCanvas || !this.imageData || this.destroyed) return;

    const ctx = this.heatCtx;
    const displayW = this.heatCanvas.width;
    const displayH = this.heatCanvas.height;

    if (this.dirty.isFullDirty()) {
      // Full repaint: draw ImageData to an offscreen canvas then scale
      const offscreen = document.createElement('canvas');
      offscreen.width = this.dataWidth;
      offscreen.height = this.dataHeight;
      const offCtx = offscreen.getContext('2d')!;
      offCtx.putImageData(this.imageData, 0, 0);

      ctx.clearRect(0, 0, displayW, displayH);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(offscreen, 0, 0, displayW, displayH);
    } else if (this.dirty.isDirty()) {
      // Dirty rect repaint — only update changed regions
      const scaleX = displayW / this.dataWidth;
      const scaleY = displayH / this.dataHeight;
      const rects = this.dirty.getRects();

      for (const r of rects) {
        const sx = Math.floor(r.x0 * scaleX);
        const sy = Math.floor(r.y0 * scaleY);
        const sw = Math.ceil((r.x1 - r.x0) * scaleX) + 1;
        const sh = Math.ceil((r.y1 - r.y0) * scaleY) + 1;

        // Draw the dirty region from the full image via offscreen crop
        const cropW = r.x1 - r.x0;
        const cropH = r.y1 - r.y0;
        const offscreen = document.createElement('canvas');
        offscreen.width = cropW;
        offscreen.height = cropH;
        const offCtx = offscreen.getContext('2d')!;

        // Extract region from ImageData
        const regionData = new ImageData(cropW, cropH);
        for (let dy = 0; dy < cropH; dy++) {
          for (let dx = 0; dx < cropW; dx++) {
            const srcIdx = ((r.y0 + dy) * this.dataWidth + (r.x0 + dx)) * 4;
            const dstIdx = (dy * cropW + dx) * 4;
            regionData.data[dstIdx] = this.imageData.data[srcIdx]!;
            regionData.data[dstIdx + 1] = this.imageData.data[srcIdx + 1]!;
            regionData.data[dstIdx + 2] = this.imageData.data[srcIdx + 2]!;
            regionData.data[dstIdx + 3] = this.imageData.data[srcIdx + 3]!;
          }
        }
        offCtx.putImageData(regionData, 0, 0);

        ctx.imageSmoothingEnabled = false;
        ctx.clearRect(sx, sy, sw, sh);
        ctx.drawImage(offscreen, sx, sy, sw, sh);
      }
    }

    this.dirty.clear();
    this.drawOverlay();
  }

  private drawOverlay(): void {
    if (!this.overlayCanvas) return;
    const dpr = window.devicePixelRatio || 1;
    const ctx = this.overlayCanvas.getContext('2d');
    if (!ctx) return;

    const w = this.overlayCanvas.width / dpr;
    const h = this.overlayCanvas.height / dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    this.drawPriceAxis(ctx, w, h);
    this.drawTimeAxis(ctx, w, h);
    this.drawAnnotations(ctx, w, h);
  }

  private drawPriceAxis(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    const { priceMin, priceMax, priceStep, decimals } = this.axisConfig;
    const range = priceMax - priceMin;
    if (range <= 0) return;

    ctx.font = AXIS_FONT;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';

    const labelCount = Math.floor(range / priceStep);
    const maxLabels = Math.min(labelCount, 30);
    const step = labelCount > 0 ? Math.ceil(labelCount / maxLabels) * priceStep : priceStep;

    for (let price = priceMin; price <= priceMax; price += step) {
      const y = h - ((price - priceMin) / range) * h;
      if (y < 10 || y > h - 10) continue;

      ctx.strokeStyle = 'rgba(156, 163, 175, 0.15)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();

      ctx.fillStyle = '#9ca3af';
      ctx.fillText(price.toFixed(decimals), 4, y);
    }
  }

  private drawTimeAxis(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    const { timeOrigin, timeStep } = this.axisConfig;
    if (timeStep <= 0) return;

    ctx.font = AXIS_FONT;
    ctx.fillStyle = '#6b7280';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';

    const colWidth = w / this.dataHeight;
    const labelInterval = Math.max(1, Math.floor(80 / colWidth));

    for (let col = 0; col < this.dataHeight; col += labelInterval) {
      const x = (col / this.dataHeight) * w;
      const ts = timeOrigin + col * timeStep;
      const d = new Date(ts);
      const hh = String(d.getHours()).padStart(2, '0');
      const mm = String(d.getMinutes()).padStart(2, '0');
      const ss = String(d.getSeconds()).padStart(2, '0');
      ctx.fillText(`${hh}:${mm}:${ss}`, x, h - 2);
    }
  }

  private drawAnnotations(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    for (const ann of this.annotations) {
      const x = (ann.timeIndex / this.dataHeight) * w;
      const y = h - (ann.priceIndex / this.dataWidth) * h;

      const colors: Record<string, string> = {
        iceberg: '#3b82f6',
        spoof: '#f97316',
        absorption: '#22c55e',
        custom: '#a855f7',
      };
      const color = ann.color ?? colors[ann.type] ?? '#a855f7';

      ctx.beginPath();
      ctx.arc(x, y, 5, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.5;
      ctx.stroke();

      if (ann.label) {
        ctx.font = '10px Inter, sans-serif';
        ctx.fillStyle = color;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.fillText(ann.label, x, y + 8);
      }
    }
  }

  private drawLegend(): void {
    if (!this.legendCanvas) return;
    const dpr = window.devicePixelRatio || 1;
    const ctx = this.legendCanvas.getContext('2d');
    if (!ctx) return;

    const w = this.legendCanvas.width / dpr;
    const h = this.legendCanvas.height / dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    ctx.fillStyle = '#111827';
    ctx.fillRect(0, 0, w, h);

    const barX = 4;
    const barW = w - 8;
    const barTop = 24;
    const barBottom = h - 24;
    const barH = barBottom - barTop;

    for (let i = 0; i < barH; i++) {
      const intensity = Math.round(((barH - i) / barH) * 255);
      const lutIdx = intensity * 3;
      ctx.fillStyle = `rgb(${COLOR_LUT[lutIdx]},${COLOR_LUT[lutIdx + 1]},${COLOR_LUT[lutIdx + 2]})`;
      ctx.fillRect(barX, barTop + i, barW, 1);
    }

    ctx.strokeStyle = '#374151';
    ctx.lineWidth = 1;
    ctx.strokeRect(barX, barTop, barW, barH);

    ctx.font = '9px JetBrains Mono, monospace';
    ctx.fillStyle = '#9ca3af';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText('High', w / 2, barTop - 4);
    ctx.textBaseline = 'top';
    ctx.fillText('Low', w / 2, barBottom + 4);
  }
}
