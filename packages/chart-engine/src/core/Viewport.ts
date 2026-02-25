/**
 * Viewport.ts
 * Viewport transform mathematics for the Pinned chart engine.
 *
 * Handles all coordinate-space conversions between chart domain space
 * (time × price) and screen pixel space, including DPI scaling, zooming,
 * panning, and auto-fit.
 */

import type { Candle } from './ChartState';

// ─── Timeframe Helpers ─────────────────────────────────────────────────────────

/** Map common timeframe strings to their duration in milliseconds. */
const TIMEFRAME_MS: Record<string, number> = {
  // Seconds
  '1s': 1_000,
  '5s': 5_000,
  '10s': 10_000,
  '15s': 15_000,
  '30s': 30_000,
  // Minutes
  '1m': 60_000,
  '3m': 180_000,
  '5m': 300_000,
  '15m': 900_000,
  '30m': 1_800_000,
  '45m': 2_700_000,
  // Hours
  '1h': 3_600_000,
  '2h': 7_200_000,
  '3h': 10_800_000,
  '4h': 14_400_000,
  '6h': 21_600_000,
  '8h': 28_800_000,
  '12h': 43_200_000,
  // Days
  '1d': 86_400_000,
  '2d': 172_800_000,
  '3d': 259_200_000,
  // Weeks
  '1w': 604_800_000,
  '2w': 1_209_600_000,
  // Months (30d approx)
  '1M': 2_592_000_000,
  '3M': 7_776_000_000,
  '6M': 15_552_000_000,
  '12M': 31_536_000_000,
};

/**
 * Parse a timeframe string (e.g. "5m", "4h") into milliseconds.
 * Falls back to 60 000 ms (1 minute) if the string is unrecognised.
 */
function parseTimeframeMs(tf: string): number {
  return TIMEFRAME_MS[tf] ?? 60_000;
}

// ─── Viewport Class ────────────────────────────────────────────────────────────

/**
 * Manages the mapping between chart domain coordinates (time, price) and
 * screen-pixel coordinates, accounting for device-pixel ratio.
 *
 * All public pixel values are in **CSS pixels** (logical pixels).
 * Internally the viewport stores DPI-scaled dimensions so renderers can
 * draw at full retina resolution.
 *
 * @example
 * ```ts
 * const vp = new Viewport(800, 600);
 * vp.setVisibleRange(startMs, endMs);
 * vp.setPriceRange(29_000, 31_000);
 * const px = vp.timeToX(candle.timestamp);
 * const py = vp.priceToY(candle.close);
 * ```
 */
export class Viewport {
  /** Logical (CSS) width of the chart area in pixels. */
  private logicalWidth: number;
  /** Logical (CSS) height of the chart area in pixels. */
  private logicalHeight: number;
  /** Device pixel ratio for retina / HiDPI displays. */
  private dpr: number;

  /** Visible time range in epoch milliseconds. */
  private startTime = 0;
  private endTime = 0;

  /** Visible price range. */
  private priceLow = 0;
  private priceHigh = 0;

  /** Current timeframe string (used for candle width calculations). */
  private timeframe = '1m';

  /** Auto-scale padding factor (fraction of price range added above/below). */
  private readonly PRICE_PADDING = 0.10;

  /** Cached min/max time spans (invalidated on timeframe change). */
  private _cachedMinTimeSpan = 0;
  private _cachedMaxTimeSpan = 0;
  private _cachedTimeframe = '';

  /** Minimum visible time span to prevent over-zoom (10 candles). */
  private get minTimeSpan(): number {
    if (this._cachedTimeframe !== this.timeframe) {
      const tfMs = parseTimeframeMs(this.timeframe);
      this._cachedMinTimeSpan = tfMs * 10;
      this._cachedMaxTimeSpan = tfMs * 10_000;
      this._cachedTimeframe = this.timeframe;
    }
    return this._cachedMinTimeSpan;
  }

  /** Maximum visible time span (10 000 candles). */
  private get maxTimeSpan(): number {
    if (this._cachedTimeframe !== this.timeframe) {
      const tfMs = parseTimeframeMs(this.timeframe);
      this._cachedMinTimeSpan = tfMs * 10;
      this._cachedMaxTimeSpan = tfMs * 10_000;
      this._cachedTimeframe = this.timeframe;
    }
    return this._cachedMaxTimeSpan;
  }

  /**
   * @param width  - Logical (CSS) pixel width.
   * @param height - Logical (CSS) pixel height.
   * @param dpr    - Device pixel ratio (defaults to `window.devicePixelRatio` if available).
   */
  constructor(width: number, height: number, dpr?: number) {
    this.logicalWidth = width;
    this.logicalHeight = height;
    this.dpr = dpr ?? (typeof window !== 'undefined' ? window.devicePixelRatio : 1);
  }

  // ── Transform: Domain → Pixel ──────────────────────────────────────────────

  /**
   * Convert an epoch-millisecond timestamp to a CSS-pixel X coordinate.
   *
   * @param timestamp - Epoch milliseconds.
   * @returns X position in logical pixels.
   */
  timeToX(timestamp: number): number {
    const span = this.endTime - this.startTime;
    if (span === 0) return 0;
    return ((timestamp - this.startTime) / span) * this.logicalWidth;
  }

  /**
   * Convert a CSS-pixel X coordinate to an epoch-millisecond timestamp.
   *
   * @param x - Logical pixel X.
   * @returns Epoch milliseconds.
   */
  xToTime(x: number): number {
    const span = this.endTime - this.startTime;
    return this.startTime + (x / this.logicalWidth) * span;
  }

  /**
   * Convert a price value to a CSS-pixel Y coordinate.
   * Higher prices map to lower Y values (screen origin is top-left).
   *
   * @param price - Price value.
   * @returns Y position in logical pixels.
   */
  priceToY(price: number): number {
    const span = this.priceHigh - this.priceLow;
    if (span === 0) return this.logicalHeight / 2;
    return ((this.priceHigh - price) / span) * this.logicalHeight;
  }

  /**
   * Convert a CSS-pixel Y coordinate to a price value.
   *
   * @param y - Logical pixel Y.
   * @returns Price value.
   */
  yToPrice(y: number): number {
    const span = this.priceHigh - this.priceLow;
    return this.priceHigh - (y / this.logicalHeight) * span;
  }

  // ── Range Setters ──────────────────────────────────────────────────────────

  /**
   * Set the visible time range.
   *
   * @param startTime - Start epoch ms (left edge of chart).
   * @param endTime   - End epoch ms (right edge of chart).
   */
  setVisibleRange(startTime: number, endTime: number): void {
    this.startTime = startTime;
    this.endTime = endTime;
  }

  /**
   * Set the visible price range.
   *
   * @param low  - Lowest visible price.
   * @param high - Highest visible price.
   */
  setPriceRange(low: number, high: number): void {
    this.priceLow = low;
    this.priceHigh = high;
  }

  /**
   * Set the current timeframe (affects candle width and snap calculations).
   *
   * @param tf - Timeframe string, e.g. "1m", "5m", "1h".
   */
  setTimeframe(tf: string): void {
    this.timeframe = tf;
  }

  // ── Resize ─────────────────────────────────────────────────────────────────

  /**
   * Update canvas dimensions (logical CSS pixels). Recalculates DPI.
   *
   * @param width  - New logical width.
   * @param height - New logical height.
   * @param dpr    - Optional new device pixel ratio.
   */
  resize(width: number, height: number, dpr?: number): void {
    this.logicalWidth = width;
    this.logicalHeight = height;
    if (dpr !== undefined) this.dpr = dpr;
  }

  // ── Range Getters ──────────────────────────────────────────────────────────

  /**
   * @returns The currently visible time range.
   */
  getVisibleTimeRange(): { start: number; end: number } {
    return { start: this.startTime, end: this.endTime };
  }

  /**
   * @returns The currently visible price range.
   */
  getVisiblePriceRange(): { low: number; high: number } {
    return { low: this.priceLow, high: this.priceHigh };
  }

  // ── Derived Metrics ────────────────────────────────────────────────────────

  /**
   * Pixels per candle at the current zoom level and timeframe.
   */
  getCandleWidth(): number {
    const tfMs = parseTimeframeMs(this.timeframe);
    const span = this.endTime - this.startTime;
    if (span === 0) return 0;
    return (tfMs / span) * this.logicalWidth;
  }

  /**
   * Milliseconds represented by a single CSS pixel on the time axis.
   */
  getTimePerPixel(): number {
    const span = this.endTime - this.startTime;
    if (this.logicalWidth === 0) return 0;
    return span / this.logicalWidth;
  }

  /**
   * Price units represented by a single CSS pixel on the price axis.
   */
  getPricePerPixel(): number {
    const span = this.priceHigh - this.priceLow;
    if (this.logicalHeight === 0) return 0;
    return span / this.logicalHeight;
  }

  /**
   * @returns Current device pixel ratio.
   */
  getDevicePixelRatio(): number {
    return this.dpr;
  }

  /**
   * @returns Physical (backing-store) canvas width.
   */
  getPhysicalWidth(): number {
    return Math.round(this.logicalWidth * this.dpr);
  }

  /**
   * @returns Physical (backing-store) canvas height.
   */
  getPhysicalHeight(): number {
    return Math.round(this.logicalHeight * this.dpr);
  }

  /**
   * @returns Logical (CSS) dimensions.
   */
  getLogicalSize(): { width: number; height: number } {
    return { width: this.logicalWidth, height: this.logicalHeight };
  }

  // ── Zoom & Pan ─────────────────────────────────────────────────────────────

  /**
   * Zoom the time and/or price axis around a screen point.
   *
   * A factor > 1 zooms in (narrower time range), < 1 zooms out.
   *
   * @param factor  - Zoom multiplier.
   * @param centerX - CSS-pixel X to zoom around.
   * @param centerY - Optional CSS-pixel Y to zoom price axis around.
   * @param axis    - Which axis to zoom: 'time', 'price', or 'both'.
   */
  zoom(factor: number, centerX: number, centerY?: number, axis: 'time' | 'price' | 'both' = 'both'): void {
    // Time axis zoom
    if (axis === 'time' || axis === 'both') {
      const anchorTime = this.xToTime(centerX);
      const leftDt = anchorTime - this.startTime;
      const rightDt = this.endTime - anchorTime;

      let newStart = anchorTime - leftDt / factor;
      let newEnd = anchorTime + rightDt / factor;

      // Clamp to acceptable range
      const span = newEnd - newStart;
      if (span < this.minTimeSpan) {
        const mid = (newStart + newEnd) / 2;
        newStart = mid - this.minTimeSpan / 2;
        newEnd = mid + this.minTimeSpan / 2;
      } else if (span > this.maxTimeSpan) {
        const mid = (newStart + newEnd) / 2;
        newStart = mid - this.maxTimeSpan / 2;
        newEnd = mid + this.maxTimeSpan / 2;
      }

      this.startTime = newStart;
      this.endTime = newEnd;
    }

    // Price axis zoom
    if (centerY !== undefined && (axis === 'price' || axis === 'both')) {
      const anchorPrice = this.yToPrice(centerY);
      const lowDp = anchorPrice - this.priceLow;
      const highDp = this.priceHigh - anchorPrice;

      this.priceLow = anchorPrice - lowDp / factor;
      this.priceHigh = anchorPrice + highDp / factor;
    }
  }

  /**
   * Pan the viewport by a pixel delta.
   *
   * @param deltaX - Horizontal CSS-pixel shift (positive = pan right / forward in time).
   * @param deltaY - Vertical CSS-pixel shift (positive = pan down / lower prices up).
   */
  pan(deltaX: number, deltaY: number): void {
    const timeDelta = this.getTimePerPixel() * deltaX;
    this.startTime -= timeDelta;
    this.endTime -= timeDelta;

    const priceDelta = this.getPricePerPixel() * deltaY;
    this.priceLow += priceDelta;
    this.priceHigh += priceDelta;
  }

  // ── Auto-Fit ───────────────────────────────────────────────────────────────

  /**
   * Automatically set the price range to fit the given candles with padding.
   * Uses binary search to find visible range boundaries for O(log n) performance.
   *
   * @param candles - Full candle array (must be sorted by timestamp).
   * @param padding - Fraction of range to add as padding (default 0.10 = 10 %).
   */
  fitPriceRange(candles: Candle[], padding: number = this.PRICE_PADDING): void {
    if (candles.length === 0) return;

    // Binary search for first candle >= startTime
    let lo = 0, hi = candles.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (candles[mid]!.timestamp < this.startTime) lo = mid + 1;
      else hi = mid;
    }
    const startIdx = lo;

    // Binary search for last candle <= endTime
    lo = startIdx;
    hi = candles.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (candles[mid]!.timestamp <= this.endTime) lo = mid + 1;
      else hi = mid;
    }
    const endIdx = lo;

    if (startIdx >= endIdx) return;

    let low = Infinity;
    let high = -Infinity;
    for (let i = startIdx; i < endIdx; i++) {
      const c = candles[i]!;
      if (c.low < low) low = c.low;
      if (c.high > high) high = c.high;
    }

    const range = high - low || high * 0.01 || 1;
    this.priceLow = low - range * padding;
    this.priceHigh = high + range * padding;
  }

  // ── Snap Functions ─────────────────────────────────────────────────────────

  /**
   * Snap a timestamp to the nearest candle open time for the given timeframe.
   *
   * @param time      - Epoch milliseconds.
   * @param timeframe - Timeframe string (e.g. "5m").
   * @returns Snapped epoch milliseconds.
   */
  snapTimeToCandle(time: number, timeframe: string): number {
    const tfMs = parseTimeframeMs(timeframe);
    return Math.round(time / tfMs) * tfMs;
  }

  /**
   * Snap a price to the nearest tick.
   *
   * @param price    - Raw price.
   * @param tickSize - Minimum tick increment (e.g. 0.01).
   * @returns Snapped price.
   */
  snapPriceToTick(price: number, tickSize: number): number {
    if (tickSize <= 0) return price;
    return Math.round(price / tickSize) * tickSize;
  }
}
