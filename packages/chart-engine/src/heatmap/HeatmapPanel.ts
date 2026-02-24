/**
 * HeatmapPanel — High-level heatmap panel orchestrator.
 *
 * Creates the container with time-range controls, detects WebGL support,
 * instantiates the correct renderer, and synchronises with the main chart viewport.
 */

import { WebGLHeatmapRenderer } from './WebGLHeatmapRenderer';
import type { HeatmapAnnotation, HeatmapCellUpdate, HeatmapAxisConfig } from './WebGLHeatmapRenderer';
import { Canvas2DHeatmapFallback } from './Canvas2DHeatmapFallback';

// ─── Types ─────────────────────────────────────────────────────────────────────

export type TimeRange = '2m' | '5m' | '10m' | '30m' | '1h' | '2h';

interface HeatmapRenderer {
  init(container: HTMLElement): void;
  setData(blob: ArrayBuffer): void;
  updateCells(cells: HeatmapCellUpdate[]): void;
  addAnnotation(event: HeatmapAnnotation): void;
  setAxisConfig?(config: Partial<HeatmapAxisConfig>): void;
  resize(): void;
  destroy(): void;
}

export interface HeatmapPanelOptions {
  defaultTimeRange?: TimeRange;
  splitMode?: boolean;
}

// ─── Constants ─────────────────────────────────────────────────────────────────

const TIME_RANGES: { label: string; value: TimeRange }[] = [
  { label: '2m', value: '2m' },
  { label: '5m', value: '5m' },
  { label: '10m', value: '10m' },
  { label: '30m', value: '30m' },
  { label: '1h', value: '1h' },
  { label: '2h', value: '2h' },
];

// ─── Styles ────────────────────────────────────────────────────────────────────

const PANEL_STYLES = {
  wrapper: {
    display: 'flex',
    flexDirection: 'column',
    width: '100%',
    height: '100%',
    background: '#0a0e17',
    overflow: 'hidden',
    borderTop: '1px solid #374151',
  } as Partial<CSSStyleDeclaration>,
  toolbar: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    height: '32px',
    minHeight: '32px',
    padding: '0 8px',
    background: '#111827',
    borderBottom: '1px solid #374151',
    gap: '6px',
    flexShrink: '0',
  } as Partial<CSSStyleDeclaration>,
  toolbarTitle: {
    fontSize: '11px',
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
    color: '#6b7280',
    userSelect: 'none',
  } as Partial<CSSStyleDeclaration>,
  rangeGroup: {
    display: 'flex',
    gap: '2px',
    background: '#0a0e17',
    borderRadius: '4px',
    padding: '2px',
  } as Partial<CSSStyleDeclaration>,
  rangeBtn: {
    appearance: 'none',
    border: 'none',
    background: 'transparent',
    color: '#9ca3af',
    fontFamily: 'Inter, sans-serif',
    fontSize: '11px',
    fontWeight: '500',
    padding: '2px 8px',
    borderRadius: '3px',
    cursor: 'pointer',
    transition: 'all 150ms ease',
    userSelect: 'none',
  } as Partial<CSSStyleDeclaration>,
  rangeBtnActive: {
    color: '#fff',
    background: '#6366f1',
  } as Partial<CSSStyleDeclaration>,
  toggleBtn: {
    appearance: 'none',
    border: 'none',
    background: 'transparent',
    color: '#9ca3af',
    fontSize: '14px',
    cursor: 'pointer',
    padding: '2px 6px',
    borderRadius: '3px',
    transition: 'color 150ms ease',
  } as Partial<CSSStyleDeclaration>,
  rendererContainer: {
    flex: '1',
    position: 'relative',
    minHeight: '0',
    overflow: 'hidden',
  } as Partial<CSSStyleDeclaration>,
};

// ─── HeatmapPanel ──────────────────────────────────────────────────────────────

export class HeatmapPanel {
  private container: HTMLElement | null = null;
  private wrapperEl: HTMLDivElement | null = null;
  private rendererContainerEl: HTMLDivElement | null = null;
  private renderer: HeatmapRenderer | null = null;
  private timeRange: TimeRange;
  private visible = true;
  private splitMode: boolean;
  private rangeBtns: HTMLButtonElement[] = [];
  // Callbacks
  private onTimeRangeChange?: (range: TimeRange) => void;

  constructor(options: HeatmapPanelOptions = {}) {
    this.timeRange = options.defaultTimeRange ?? '5m';
    this.splitMode = options.splitMode ?? false;
  }

  // ── Public API ───────────────────────────────────────────────────────────

  mount(container: HTMLElement): void {
    this.container = container;
    this.buildDOM();
    this.initRenderer();
  }

  show(): void {
    this.visible = true;
    if (this.wrapperEl) {
      this.wrapperEl.style.display = 'flex';
    }
    this.renderer?.resize();
  }

  hide(): void {
    this.visible = false;
    if (this.wrapperEl) {
      this.wrapperEl.style.display = 'none';
    }
  }

  /** Feed binary heatmap data from DataManager (heatmapFull event). */
  setData(blob: ArrayBuffer): void {
    this.renderer?.setData(blob);
  }

  /** Feed incremental cell updates (heatmapDiff event). */
  updateCells(cells: HeatmapCellUpdate[]): void {
    this.renderer?.updateCells(cells);
  }

  /** Add annotation overlay event. */
  addAnnotation(event: HeatmapAnnotation): void {
    this.renderer?.addAnnotation(event);
  }

  /** Synchronize Y axis with main chart viewport price range. */
  syncPriceRange(priceMin: number, priceMax: number, priceStep: number, decimals: number): void {
    if (this.renderer && 'setAxisConfig' in this.renderer) {
      (this.renderer as WebGLHeatmapRenderer).setAxisConfig({ priceMin, priceMax, priceStep, decimals });
    }
  }

  /** Set selected time range and fire callback. */
  setTimeRange(range: TimeRange): void {
    this.timeRange = range;
    this.updateRangeButtons();
    this.onTimeRangeChange?.(range);
  }

  /** Register time range change handler. */
  onRangeChange(cb: (range: TimeRange) => void): void {
    this.onTimeRangeChange = cb;
  }

  /** Toggle between full panel and split view. */
  toggleSplitMode(): void {
    this.splitMode = !this.splitMode;
    if (this.wrapperEl) {
      this.wrapperEl.style.height = this.splitMode ? '50%' : '100%';
    }
    this.renderer?.resize();
  }

  destroy(): void {
    this.renderer?.destroy();
    this.renderer = null;
    if (this.wrapperEl && this.container) {
      this.container.removeChild(this.wrapperEl);
    }
    this.wrapperEl = null;
    this.rendererContainerEl = null;
    this.container = null;
    this.rangeBtns = [];
  }

  // ── Private ──────────────────────────────────────────────────────────────

  private buildDOM(): void {
    if (!this.container) return;

    // Wrapper
    this.wrapperEl = document.createElement('div');
    this.applyStyles(this.wrapperEl, PANEL_STYLES.wrapper);
    if (this.splitMode) this.wrapperEl.style.height = '50%';

    // Toolbar
    const toolbar = document.createElement('div');
    this.applyStyles(toolbar, PANEL_STYLES.toolbar);

    // Title
    const title = document.createElement('span');
    this.applyStyles(title, PANEL_STYLES.toolbarTitle);
    title.textContent = 'Heatmap';
    toolbar.appendChild(title);

    // Time range group
    const rangeGroup = document.createElement('div');
    this.applyStyles(rangeGroup, PANEL_STYLES.rangeGroup);

    for (const tr of TIME_RANGES) {
      const btn = document.createElement('button');
      this.applyStyles(btn, PANEL_STYLES.rangeBtn);
      if (tr.value === this.timeRange) {
        this.applyStyles(btn, PANEL_STYLES.rangeBtnActive);
      }
      btn.textContent = tr.label;
      btn.dataset.range = tr.value;
      btn.addEventListener('click', () => this.setTimeRange(tr.value));
      rangeGroup.appendChild(btn);
      this.rangeBtns.push(btn);
    }
    toolbar.appendChild(rangeGroup);

    // Toggle split/full button
    const toggleBtn = document.createElement('button');
    this.applyStyles(toggleBtn, PANEL_STYLES.toggleBtn);
    toggleBtn.textContent = '⬜';
    toggleBtn.title = 'Toggle split/full';
    toggleBtn.addEventListener('click', () => this.toggleSplitMode());
    toolbar.appendChild(toggleBtn);

    this.wrapperEl.appendChild(toolbar);

    // Renderer container
    this.rendererContainerEl = document.createElement('div');
    this.applyStyles(this.rendererContainerEl, PANEL_STYLES.rendererContainer);
    this.wrapperEl.appendChild(this.rendererContainerEl);

    this.container.appendChild(this.wrapperEl);

    if (!this.visible) {
      this.wrapperEl.style.display = 'none';
    }
  }

  private initRenderer(): void {
    if (!this.rendererContainerEl) return;

    // Detect WebGL2 support
    const testCanvas = document.createElement('canvas');
    const gl = testCanvas.getContext('webgl2');

    if (gl) {
      const webglRenderer = new WebGLHeatmapRenderer();
      webglRenderer.init(this.rendererContainerEl);

      if (webglRenderer.isWebGLSupported) {
        this.renderer = webglRenderer;
      } else {
        webglRenderer.destroy();
        this.useFallback();
      }
    } else {
      this.useFallback();
    }
  }

  private useFallback(): void {
    if (!this.rendererContainerEl) return;
    console.info('[HeatmapPanel] Using Canvas2D fallback renderer');
    const fallback = new Canvas2DHeatmapFallback();
    fallback.init(this.rendererContainerEl);
    this.renderer = fallback;
  }

  private updateRangeButtons(): void {
    for (const btn of this.rangeBtns) {
      const isActive = btn.dataset.range === this.timeRange;
      btn.style.color = isActive ? '#fff' : '#9ca3af';
      btn.style.background = isActive ? '#6366f1' : 'transparent';
    }
  }

  private applyStyles(el: HTMLElement, styles: Partial<CSSStyleDeclaration>): void {
    Object.assign(el.style, styles);
  }
}
