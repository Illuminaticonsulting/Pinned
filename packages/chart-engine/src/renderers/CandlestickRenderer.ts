/**
 * CandlestickRenderer.ts
 * Premium quality chart renderer supporting 7 chart types:
 *   candles, hollow, bars (OHLC), line, area, heikinashi, baseline
 *
 * Visual quality improvements over TradingView:
 * - Anti-aliased rounded candle bodies
 * - Subtle body border for depth
 * - Gradient volume bars
 * - Smooth line/area rendering with quadratic curves
 * - Baseline chart with gradient fills above/below
 * - Heikin Ashi with proper smoothing
 * - Pulsing live candle glow
 */

import type { Viewport } from '../core/Viewport';
import type { ChartStateData, Candle, ChartType } from '../core/ChartState';

// ─── Colors ──────────────────────────────────────────────────────────────────

const BULL = '#22c55e';
const BEAR = '#ef4444';
const BULL_BRIGHT = '#4ade80';
const BEAR_BRIGHT = '#f87171';
const BULL_WICK = 'rgba(34, 197, 94, 0.7)';
const BEAR_WICK = 'rgba(239, 68, 68, 0.7)';
const BULL_BORDER = 'rgba(34, 197, 94, 0.35)';
const BEAR_BORDER = 'rgba(239, 68, 68, 0.35)';

const LINE_COLOR = '#3b82f6';
const LINE_WIDTH = 2;

const BASELINE_COLOR_ABOVE = '#22c55e';
const BASELINE_COLOR_BELOW = '#ef4444';

const MIN_CANDLE_WIDTH = 1;
const MAX_CANDLE_WIDTH = 50;
const CANDLE_GAP_RATIO = 0.15;
const RIGHT_MARGIN = 80;
const BOTTOM_MARGIN = 28;
const VOLUME_MAX_RATIO = 0.22;

// ─── Cached Gradients ──────────────────────────────────────────────────────────

let cachedBullGrad: CanvasGradient | null = null;
let cachedBearGrad: CanvasGradient | null = null;
let cachedGradChartH = 0;

// ─── Helpers ───────────────────────────────────────────────────────────────────

function isBull(c: Candle): boolean { return c.close >= c.open; }

/** Convert regular candles to Heikin Ashi */
function toHeikinAshi(candles: Candle[]): Candle[] {
  if (candles.length === 0) return [];
  const ha: Candle[] = [];
  let prevClose = candles[0]!.close;
  let prevOpen = candles[0]!.open;

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i]!;
    const haClose = (c.open + c.high + c.low + c.close) / 4;
    const haOpen = i === 0 ? (c.open + c.close) / 2 : (prevOpen + prevClose) / 2;
    const haHigh = Math.max(c.high, haOpen, haClose);
    const haLow = Math.min(c.low, haOpen, haClose);
    ha.push({
      ...c,
      open: haOpen,
      high: haHigh,
      low: haLow,
      close: haClose,
    });
    prevClose = haClose;
    prevOpen = haOpen;
  }
  return ha;
}

/** Binary search for candle range in visible time window */
function getVisibleRange(candles: readonly Candle[], startTime: number, endTime: number): [number, number] {
  let lo = 0, hi = candles.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (candles[mid]!.timestamp < startTime) lo = mid + 1; else hi = mid;
  }
  const startIdx = lo;
  lo = startIdx; hi = candles.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (candles[mid]!.timestamp <= endTime) lo = mid + 1; else hi = mid;
  }
  return [startIdx, lo];
}

/** Draw a rounded rectangle */
function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  if (w < 2 * r) r = w / 2;
  if (h < 2 * r) r = h / 2;
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// ─── Main Renderer ───────────────────────────────────────────────────────────

export function renderCandlesticks(
  ctx: CanvasRenderingContext2D,
  viewport: Viewport,
  state: Readonly<ChartStateData>,
): void {
  const chartType: ChartType = state.chartType ?? 'candles';
  const { width, height } = viewport.getLogicalSize();
  const chartW = width - RIGHT_MARGIN;
  const chartH = height - BOTTOM_MARGIN;
  const { start: startTime, end: endTime } = viewport.getVisibleTimeRange();

  let candles = state.candles;
  if (chartType === 'heikinashi') {
    candles = toHeikinAshi(candles);
  }

  const [startIdx, endIdx] = getVisibleRange(candles, startTime, endTime);
  const visible: Candle[] = [];
  for (let i = startIdx; i < endIdx; i++) visible.push(candles[i]!);

  // Append live candle
  if (state.liveCandle && state.liveCandle.timestamp >= startTime && state.liveCandle.timestamp <= endTime) {
    visible.push(state.liveCandle);
  }
  if (visible.length === 0) return;

  // Candle width
  let candleW = viewport.getCandleWidth();
  candleW = Math.max(MIN_CANDLE_WIDTH, Math.min(MAX_CANDLE_WIDTH, candleW));
  const gap = Math.max(1, candleW * CANDLE_GAP_RATIO);
  const bodyW = Math.max(1, candleW - gap * 2);

  // Max volume for volume bars
  let maxVolume = 0;
  for (const c of visible) if (c.volume > maxVolume) maxVolume = c.volume;

  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, chartW, chartH);
  ctx.clip();

  // Dispatch to chart type renderer
  switch (chartType) {
    case 'line':
      renderLine(ctx, viewport, visible, chartW, chartH);
      break;
    case 'area':
      renderArea(ctx, viewport, visible, chartW, chartH);
      break;
    case 'baseline':
      renderBaseline(ctx, viewport, visible, chartW, chartH);
      break;
    case 'bars':
      renderBars(ctx, viewport, visible, bodyW, chartH, maxVolume);
      break;
    case 'hollow':
      renderHollow(ctx, viewport, visible, bodyW, chartH, maxVolume);
      break;
    case 'candles':
    case 'heikinashi':
    default:
      renderCandles(ctx, viewport, visible, bodyW, chartW, chartH, maxVolume);
      break;
  }

  // Live candle glow (for candle-type charts)
  if (state.liveCandle && (chartType === 'candles' || chartType === 'heikinashi' || chartType === 'hollow')) {
    renderLiveGlow(ctx, viewport, state.liveCandle, bodyW);
  }

  ctx.restore();
}

// ─── Candles (filled bodies with premium borders) ────────────────────────────

function renderCandles(
  ctx: CanvasRenderingContext2D,
  viewport: Viewport,
  visible: Candle[],
  bodyW: number,
  chartW: number,
  chartH: number,
  maxVolume: number,
): void {
  // Volume gradient cache
  if (chartH !== cachedGradChartH || !cachedBullGrad || !cachedBearGrad) {
    cachedBullGrad = ctx.createLinearGradient(0, chartH, 0, chartH * 0.75);
    cachedBullGrad.addColorStop(0, 'rgba(34, 197, 94, 0.03)');
    cachedBullGrad.addColorStop(1, 'rgba(34, 197, 94, 0.18)');
    cachedBearGrad = ctx.createLinearGradient(0, chartH, 0, chartH * 0.75);
    cachedBearGrad.addColorStop(0, 'rgba(239, 68, 68, 0.03)');
    cachedBearGrad.addColorStop(1, 'rgba(239, 68, 68, 0.18)');
    cachedGradChartH = chartH;
  }

  const radius = bodyW > 6 ? 1.5 : 0;

  for (const c of visible) {
    const bull = isBull(c);
    const cx = viewport.timeToX(c.timestamp);
    const halfBody = bodyW / 2;
    const openY = viewport.priceToY(c.open);
    const closeY = viewport.priceToY(c.close);
    const highY = viewport.priceToY(c.high);
    const lowY = viewport.priceToY(c.low);

    // ── Wick (crisp 1px) ──────────────────────────────────────────────────
    const wickX = Math.round(cx) + 0.5;
    ctx.strokeStyle = bull ? BULL_WICK : BEAR_WICK;
    ctx.lineWidth = bodyW > 4 ? 1 : 0.5;
    ctx.beginPath();
    ctx.moveTo(wickX, Math.round(highY));
    ctx.lineTo(wickX, Math.round(lowY));
    ctx.stroke();

    // ── Body ──────────────────────────────────────────────────────────────
    const bodyTop = Math.min(openY, closeY);
    const bodyHeight = Math.max(Math.abs(openY - closeY), 1);
    const snappedLeft = Math.round(cx - halfBody);
    const snappedTop = Math.round(bodyTop);
    const snappedW = Math.max(1, Math.round(bodyW));
    const snappedH = Math.max(1, Math.round(bodyHeight));

    ctx.fillStyle = bull ? BULL : BEAR;
    if (radius > 0 && snappedH > 3) {
      roundRect(ctx, snappedLeft, snappedTop, snappedW, snappedH, radius);
      ctx.fill();
      // Subtle border for depth
      ctx.strokeStyle = bull ? BULL_BORDER : BEAR_BORDER;
      ctx.lineWidth = 0.5;
      ctx.stroke();
    } else if (bodyHeight < 1.5) {
      ctx.fillRect(snappedLeft, Math.round(openY), snappedW, 1);
    } else {
      ctx.fillRect(snappedLeft, snappedTop, snappedW, snappedH);
    }

    // ── Volume bar ────────────────────────────────────────────────────────
    if (maxVolume > 0) {
      const volHeight = (c.volume / maxVolume) * chartH * VOLUME_MAX_RATIO;
      ctx.fillStyle = bull ? cachedBullGrad! : cachedBearGrad!;
      ctx.fillRect(snappedLeft, chartH - Math.round(volHeight), snappedW, Math.round(volHeight));
    }
  }
}

// ─── Hollow Candles ──────────────────────────────────────────────────────────

function renderHollow(
  ctx: CanvasRenderingContext2D,
  viewport: Viewport,
  visible: Candle[],
  bodyW: number,
  chartH: number,
  maxVolume: number,
): void {
  for (const c of visible) {
    const bull = isBull(c);
    const cx = viewport.timeToX(c.timestamp);
    const halfBody = bodyW / 2;
    const openY = viewport.priceToY(c.open);
    const closeY = viewport.priceToY(c.close);
    const highY = viewport.priceToY(c.high);
    const lowY = viewport.priceToY(c.low);

    const wickX = Math.round(cx) + 0.5;
    ctx.strokeStyle = bull ? BULL : BEAR;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(wickX, Math.round(highY));
    ctx.lineTo(wickX, Math.round(lowY));
    ctx.stroke();

    const bodyTop = Math.min(openY, closeY);
    const bodyHeight = Math.max(Math.abs(openY - closeY), 1);
    const snappedLeft = Math.round(cx - halfBody);
    const snappedTop = Math.round(bodyTop);
    const snappedW = Math.max(1, Math.round(bodyW));
    const snappedH = Math.max(1, Math.round(bodyHeight));

    if (bull) {
      // Hollow body — stroke only
      ctx.strokeStyle = BULL;
      ctx.lineWidth = 1.5;
      ctx.strokeRect(snappedLeft + 0.5, snappedTop + 0.5, snappedW - 1, snappedH - 1);
    } else {
      // Filled body
      ctx.fillStyle = BEAR;
      ctx.fillRect(snappedLeft, snappedTop, snappedW, snappedH);
    }

    // Volume
    if (maxVolume > 0) {
      const volH = (c.volume / maxVolume) * chartH * VOLUME_MAX_RATIO;
      ctx.fillStyle = bull ? 'rgba(34, 197, 94, 0.12)' : 'rgba(239, 68, 68, 0.12)';
      ctx.fillRect(snappedLeft, chartH - Math.round(volH), snappedW, Math.round(volH));
    }
  }
}

// ─── OHLC Bars ───────────────────────────────────────────────────────────────

function renderBars(
  ctx: CanvasRenderingContext2D,
  viewport: Viewport,
  visible: Candle[],
  bodyW: number,
  chartH: number,
  maxVolume: number,
): void {
  const tickLen = Math.max(3, bodyW * 0.4);

  for (const c of visible) {
    const bull = isBull(c);
    const cx = Math.round(viewport.timeToX(c.timestamp)) + 0.5;
    const openY = Math.round(viewport.priceToY(c.open)) + 0.5;
    const closeY = Math.round(viewport.priceToY(c.close)) + 0.5;
    const highY = Math.round(viewport.priceToY(c.high)) + 0.5;
    const lowY = Math.round(viewport.priceToY(c.low)) + 0.5;

    ctx.strokeStyle = bull ? BULL : BEAR;
    ctx.lineWidth = bodyW > 4 ? 1.5 : 1;

    // Vertical bar
    ctx.beginPath();
    ctx.moveTo(cx, highY);
    ctx.lineTo(cx, lowY);
    ctx.stroke();

    // Open tick (left)
    ctx.beginPath();
    ctx.moveTo(cx - tickLen, openY);
    ctx.lineTo(cx, openY);
    ctx.stroke();

    // Close tick (right)
    ctx.beginPath();
    ctx.moveTo(cx, closeY);
    ctx.lineTo(cx + tickLen, closeY);
    ctx.stroke();

    // Volume
    if (maxVolume > 0) {
      const volH = (c.volume / maxVolume) * chartH * VOLUME_MAX_RATIO;
      ctx.fillStyle = bull ? 'rgba(34, 197, 94, 0.12)' : 'rgba(239, 68, 68, 0.12)';
      const halfW = Math.max(1, bodyW / 2);
      ctx.fillRect(Math.round(cx - halfW / 2), chartH - Math.round(volH), Math.round(halfW), Math.round(volH));
    }
  }
}

// ─── Line Chart ──────────────────────────────────────────────────────────────

function renderLine(
  ctx: CanvasRenderingContext2D,
  viewport: Viewport,
  visible: Candle[],
  chartW: number,
  chartH: number,
): void {
  if (visible.length < 2) return;

  const points: { x: number; y: number }[] = [];
  for (const c of visible) {
    points.push({ x: viewport.timeToX(c.timestamp), y: viewport.priceToY(c.close) });
  }

  // Smooth line with quadratic curves
  ctx.strokeStyle = LINE_COLOR;
  ctx.lineWidth = LINE_WIDTH;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(points[0]!.x, points[0]!.y);

  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1]!;
    const curr = points[i]!;
    const cpx = (prev.x + curr.x) / 2;
    ctx.quadraticCurveTo(prev.x, prev.y, cpx, (prev.y + curr.y) / 2);
  }
  const last = points[points.length - 1]!;
  ctx.lineTo(last.x, last.y);
  ctx.stroke();

  // Last price dot
  ctx.fillStyle = LINE_COLOR;
  ctx.beginPath();
  ctx.arc(last.x, last.y, 3, 0, Math.PI * 2);
  ctx.fill();
  // Outer ring
  ctx.strokeStyle = LINE_COLOR;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(last.x, last.y, 5, 0, Math.PI * 2);
  ctx.stroke();
}

// ─── Area Chart ──────────────────────────────────────────────────────────────

function renderArea(
  ctx: CanvasRenderingContext2D,
  viewport: Viewport,
  visible: Candle[],
  chartW: number,
  chartH: number,
): void {
  if (visible.length < 2) return;

  const points: { x: number; y: number }[] = [];
  for (const c of visible) {
    points.push({ x: viewport.timeToX(c.timestamp), y: viewport.priceToY(c.close) });
  }

  // Build path for line
  const buildPath = (): void => {
    ctx.beginPath();
    ctx.moveTo(points[0]!.x, points[0]!.y);
    for (let i = 1; i < points.length; i++) {
      const prev = points[i - 1]!;
      const curr = points[i]!;
      const cpx = (prev.x + curr.x) / 2;
      ctx.quadraticCurveTo(prev.x, prev.y, cpx, (prev.y + curr.y) / 2);
    }
    const last = points[points.length - 1]!;
    ctx.lineTo(last.x, last.y);
  };

  // Fill gradient
  const first = points[0]!;
  const last = points[points.length - 1]!;
  const grad = ctx.createLinearGradient(0, 0, 0, chartH);
  grad.addColorStop(0, 'rgba(59, 130, 246, 0.25)');
  grad.addColorStop(0.5, 'rgba(59, 130, 246, 0.08)');
  grad.addColorStop(1, 'rgba(59, 130, 246, 0.01)');

  buildPath();
  ctx.lineTo(last.x, chartH);
  ctx.lineTo(first.x, chartH);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  // Stroke line on top
  buildPath();
  ctx.strokeStyle = LINE_COLOR;
  ctx.lineWidth = LINE_WIDTH;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.stroke();

  // Last price dot
  ctx.fillStyle = LINE_COLOR;
  ctx.beginPath();
  ctx.arc(last.x, last.y, 3, 0, Math.PI * 2);
  ctx.fill();
}

// ─── Baseline Chart ──────────────────────────────────────────────────────────

function renderBaseline(
  ctx: CanvasRenderingContext2D,
  viewport: Viewport,
  visible: Candle[],
  chartW: number,
  chartH: number,
): void {
  if (visible.length < 2) return;

  // Baseline is the first visible close price
  const baseline = visible[0]!.close;
  const baselineY = viewport.priceToY(baseline);

  const points: { x: number; y: number }[] = [];
  for (const c of visible) {
    points.push({ x: viewport.timeToX(c.timestamp), y: viewport.priceToY(c.close) });
  }

  const first = points[0]!;
  const last = points[points.length - 1]!;

  // Build smooth path
  const buildPath = (): void => {
    ctx.beginPath();
    ctx.moveTo(points[0]!.x, points[0]!.y);
    for (let i = 1; i < points.length; i++) {
      const prev = points[i - 1]!;
      const curr = points[i]!;
      const cpx = (prev.x + curr.x) / 2;
      ctx.quadraticCurveTo(prev.x, prev.y, cpx, (prev.y + curr.y) / 2);
    }
    ctx.lineTo(last.x, last.y);
  };

  // Above baseline gradient (green)
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, chartW, baselineY);
  ctx.clip();
  buildPath();
  ctx.lineTo(last.x, 0);
  ctx.lineTo(first.x, 0);
  ctx.closePath();
  const aboveGrad = ctx.createLinearGradient(0, 0, 0, baselineY);
  aboveGrad.addColorStop(0, 'rgba(34, 197, 94, 0.35)');
  aboveGrad.addColorStop(1, 'rgba(34, 197, 94, 0.02)');
  ctx.fillStyle = aboveGrad;
  ctx.fill();
  ctx.restore();

  // Below baseline gradient (red)
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, baselineY, chartW, chartH - baselineY);
  ctx.clip();
  buildPath();
  ctx.lineTo(last.x, chartH);
  ctx.lineTo(first.x, chartH);
  ctx.closePath();
  const belowGrad = ctx.createLinearGradient(0, baselineY, 0, chartH);
  belowGrad.addColorStop(0, 'rgba(239, 68, 68, 0.02)');
  belowGrad.addColorStop(1, 'rgba(239, 68, 68, 0.35)');
  ctx.fillStyle = belowGrad;
  ctx.fill();
  ctx.restore();

  // Baseline dashed line
  ctx.strokeStyle = 'rgba(148, 163, 184, 0.4)';
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 3]);
  ctx.beginPath();
  ctx.moveTo(0, baselineY);
  ctx.lineTo(chartW, baselineY);
  ctx.stroke();
  ctx.setLineDash([]);

  // Main line, colored by side
  // Above = green, below = red
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1]!;
    const curr = points[i]!;
    const aboveLine = curr.y <= baselineY;
    ctx.strokeStyle = aboveLine ? BASELINE_COLOR_ABOVE : BASELINE_COLOR_BELOW;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(prev.x, prev.y);
    ctx.lineTo(curr.x, curr.y);
    ctx.stroke();
  }
}

// ─── Live Candle Glow ────────────────────────────────────────────────────────

function renderLiveGlow(
  ctx: CanvasRenderingContext2D,
  viewport: Viewport,
  live: Candle,
  bodyW: number,
): void {
  const cx = viewport.timeToX(live.timestamp);
  const halfBody = bodyW / 2;
  const openY = viewport.priceToY(live.open);
  const closeY = viewport.priceToY(live.close);
  const bodyTop = Math.min(openY, closeY);
  const bodyHeight = Math.max(Math.abs(openY - closeY), 1);

  const now = performance.now();
  const pulse = 0.15 + 0.3 * Math.sin(now / 400);
  const bull = isBull(live);
  const rgb = bull ? '34,197,94' : '239,68,68';

  // Outer glow
  ctx.shadowColor = `rgba(${rgb}, ${(pulse * 0.6).toFixed(2)})`;
  ctx.shadowBlur = 16;
  ctx.strokeStyle = `rgba(${rgb}, ${pulse.toFixed(2)})`;
  ctx.lineWidth = 1.5;
  ctx.strokeRect(cx - halfBody - 1.5, bodyTop - 1.5, bodyW + 3, bodyHeight + 3);
  ctx.shadowBlur = 0;
}
