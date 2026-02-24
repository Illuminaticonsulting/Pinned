/**
 * GridRenderer.ts
 * Renders the background grid, price/time axes, and current price indicator on Layer 0.
 */

import type { Viewport } from '../core/Viewport';
import type { ChartStateData } from '../core/ChartState';

// ─── Constants ─────────────────────────────────────────────────────────────────

const BG_COLOR = '#0a0e17';
const GRID_COLOR = 'rgba(148, 163, 184, 0.06)';
const GRID_SUB_COLOR = 'rgba(148, 163, 184, 0.025)';
const GRID_LINE_WIDTH = 0.5;
const LABEL_COLOR = '#64748b';
const LABEL_FONT = '11px JetBrains Mono, monospace';
const BORDER_COLOR = 'rgba(148, 163, 184, 0.1)';
const CURRENT_PRICE_COLOR = '#eab308';

const RIGHT_MARGIN = 80;
const BOTTOM_MARGIN = 28;

/** Price grid intervals ordered small → large. */
const PRICE_NICE_NUMBERS = [
  0.0001, 0.0005, 0.001, 0.005, 0.01, 0.025, 0.05,
  0.1, 0.25, 0.5, 1, 2, 5, 10, 25, 50, 100, 250, 500,
  1_000, 2_500, 5_000, 10_000, 25_000, 50_000, 100_000,
];

/** Time grid intervals in milliseconds (label, ms). */
const TIME_INTERVALS: { label: string; ms: number }[] = [
  { label: '1s', ms: 1_000 },
  { label: '5s', ms: 5_000 },
  { label: '15s', ms: 15_000 },
  { label: '30s', ms: 30_000 },
  { label: '1m', ms: 60_000 },
  { label: '5m', ms: 300_000 },
  { label: '15m', ms: 900_000 },
  { label: '30m', ms: 1_800_000 },
  { label: '1h', ms: 3_600_000 },
  { label: '4h', ms: 14_400_000 },
  { label: '1d', ms: 86_400_000 },
  { label: '1w', ms: 604_800_000 },
];

// ─── Helpers ───────────────────────────────────────────────────────────────────

/** Pick the largest nice-number interval that yields between ~4-10 grid lines. */
function pickPriceInterval(priceRange: number): number {
  const target = priceRange / 6;
  for (let i = 0; i < PRICE_NICE_NUMBERS.length; i++) {
    const n = PRICE_NICE_NUMBERS[i]!;
    if (n >= target) return n;
  }
  return PRICE_NICE_NUMBERS[PRICE_NICE_NUMBERS.length - 1] ?? 1_000;
}

/** Pick a time interval that produces ~5-12 grid lines for the visible span. */
function pickTimeInterval(timeSpanMs: number): number {
  const target = timeSpanMs / 8;
  for (const entry of TIME_INTERVALS) {
    if (entry.ms >= target) return entry.ms;
  }
  return TIME_INTERVALS[TIME_INTERVALS.length - 1]?.ms ?? 604_800_000;
}

/** Format a price with appropriate decimal precision. */
function formatPrice(price: number): string {
  if (price >= 10_000) return price.toFixed(0);
  if (price >= 100) return price.toFixed(1);
  if (price >= 1) return price.toFixed(2);
  if (price >= 0.01) return price.toFixed(4);
  return price.toFixed(6);
}

/** Format a timestamp for time axis labels. */
function formatTime(timestamp: number, intervalMs: number): string {
  const d = new Date(timestamp);
  if (intervalMs >= 86_400_000) {
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
      'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return `${months[d.getUTCMonth()]} ${d.getUTCDate()}`;
  }
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  if (intervalMs < 60_000) {
    const ss = String(d.getUTCSeconds()).padStart(2, '0');
    return `${hh}:${mm}:${ss}`;
  }
  return `${hh}:${mm}`;
}

// ─── Renderer ──────────────────────────────────────────────────────────────────

/**
 * Draw background grid, price axis, time axis, and current-price indicator.
 */
export function renderGrid(
  ctx: CanvasRenderingContext2D,
  viewport: Viewport,
  state: Readonly<ChartStateData>,
): void {
  const { width, height } = viewport.getLogicalSize();
  const chartW = width - RIGHT_MARGIN;
  const chartH = height - BOTTOM_MARGIN;

  const { low: priceLow, high: priceHigh } = viewport.getVisiblePriceRange();
  const { start: startTime, end: endTime } = viewport.getVisibleTimeRange();
  const priceRange = priceHigh - priceLow;
  const timeRange = endTime - startTime;

  if (priceRange <= 0 || timeRange <= 0) return;

  // ── Background ────────────────────────────────────────────────────────────
  ctx.fillStyle = BG_COLOR;
  ctx.fillRect(0, 0, width, height);

  // Empty state when no candle data yet
  if (state.candles.length === 0 && !state.liveCandle) {
    ctx.fillStyle = 'rgba(148, 163, 184, 0.2)';
    ctx.font = '13px Inter, -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('Loading chart data…', width / 2, height / 2);
    return;
  }

  ctx.save();
  ctx.font = LABEL_FONT;
  ctx.textBaseline = 'middle';

  // ── Horizontal grid (price) ───────────────────────────────────────────────
  const priceInterval = pickPriceInterval(priceRange);
  const firstPrice = Math.ceil(priceLow / priceInterval) * priceInterval;

  ctx.fillStyle = LABEL_COLOR;
  ctx.textAlign = 'left';

  // Sub-grid (half intervals) — pixel-snapped for crispness
  const subInterval = priceInterval / 2;
  const firstSubPrice = Math.ceil(priceLow / subInterval) * subInterval;
  ctx.strokeStyle = GRID_SUB_COLOR;
  ctx.lineWidth = 0.5;
  for (let p = firstSubPrice; p <= priceHigh; p += subInterval) {
    const y = Math.round(viewport.priceToY(p)) + 0.5;
    if (y < 0 || y > chartH) continue;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(chartW, y);
    ctx.stroke();
  }

  // Main grid — pixel-snapped
  ctx.strokeStyle = GRID_COLOR;
  ctx.lineWidth = GRID_LINE_WIDTH;

  for (let p = firstPrice; p <= priceHigh; p += priceInterval) {
    const y = Math.round(viewport.priceToY(p)) + 0.5;
    if (y < 0 || y > chartH) continue;

    // Grid line
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(chartW, y);
    ctx.stroke();

    // Price label in right margin
    ctx.fillText(formatPrice(p), chartW + 8, Math.round(viewport.priceToY(p)));
  }

  // ── Vertical grid (time) ──────────────────────────────────────────────────
  const timeInterval = pickTimeInterval(timeRange);
  const firstTime = Math.ceil(startTime / timeInterval) * timeInterval;

  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';

  for (let t = firstTime; t <= endTime; t += timeInterval) {
    const x = Math.round(viewport.timeToX(t)) + 0.5;  // pixel-snap
    if (x < 0 || x > chartW) continue;

    // Grid line
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, chartH);
    ctx.stroke();

    // Time label in bottom margin
    ctx.fillText(formatTime(t, timeInterval), x, chartH + 6);
  }

  // ── Current price indicator ───────────────────────────────────────────────
  const candles = state.candles;
  const lastCandle = state.liveCandle ?? (candles.length > 0 ? candles[candles.length - 1] : null);

  if (lastCandle) {
    const lastPrice = lastCandle.close;
    const y = viewport.priceToY(lastPrice);

    if (y >= 0 && y <= chartH) {
      // Dashed line across chart
      ctx.save();
      ctx.strokeStyle = CURRENT_PRICE_COLOR;
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(chartW, y);
      ctx.stroke();
      ctx.restore();

      // Price label box in right margin
      const priceText = formatPrice(lastPrice);
      const textWidth = ctx.measureText(priceText).width;
      const boxW = textWidth + 12;
      const boxH = 18;
      const boxX = chartW + 2;
      const boxY = y - boxH / 2;

      // Rounded price indicator pill
      ctx.fillStyle = CURRENT_PRICE_COLOR;
      ctx.beginPath();
      const rr = 3;
      ctx.moveTo(boxX + rr, boxY);
      ctx.arcTo(boxX + boxW, boxY, boxX + boxW, boxY + boxH, rr);
      ctx.arcTo(boxX + boxW, boxY + boxH, boxX, boxY + boxH, rr);
      ctx.arcTo(boxX, boxY + boxH, boxX, boxY, rr);
      ctx.arcTo(boxX, boxY, boxX + boxW, boxY, rr);
      ctx.closePath();
      ctx.fill();

      ctx.fillStyle = '#000';
      ctx.font = LABEL_FONT;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(priceText, boxX + 6, y);
    }
  }

  // ── Axis borders ──────────────────────────────────────────────────────────
  ctx.strokeStyle = BORDER_COLOR;
  ctx.lineWidth = 1;
  ctx.setLineDash([]);

  // Right axis border (vertical line)
  ctx.beginPath();
  ctx.moveTo(chartW, 0);
  ctx.lineTo(chartW, chartH);
  ctx.stroke();

  // Bottom axis border (horizontal line)
  ctx.beginPath();
  ctx.moveTo(0, chartH);
  ctx.lineTo(width, chartH);
  ctx.stroke();

  ctx.restore();
}
