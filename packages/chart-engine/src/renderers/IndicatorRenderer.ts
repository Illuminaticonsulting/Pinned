/**
 * IndicatorRenderer.ts
 * Renders overlay indicators (VWAP, Anchored VWAP) on the main chart and
 * sub-plot indicators (Cumulative Delta, OFI, Funding Rate) in stacked
 * panels below the main chart on Layer 2.
 */

import type { Viewport } from '../core/Viewport';
import type { ChartStateData } from '../core/ChartState';

// ─── Constants ─────────────────────────────────────────────────────────────────

const RIGHT_MARGIN = 80;
const BOTTOM_MARGIN = 28;

const VWAP_COLOR = '#3b82f6';
const VWAP_WIDTH = 2;
const ANCHORED_VWAP_COLORS = ['#a855f7', '#f97316', '#06b6d4', '#ec4899', '#84cc16'];
const ANCHORED_VWAP_DASH = [5, 3];

const SUBPLOT_HEIGHT_RATIO = 0.20;
const SUBPLOT_DIVIDER_COLOR = '#374151';
const SUBPLOT_BG = 'rgba(10, 14, 23, 0.6)';
const SUBPLOT_LABEL_COLOR = '#9ca3af';
const SUBPLOT_LABEL_FONT = '10px JetBrains Mono, monospace';
const OVERLAY_LABEL_FONT = '11px JetBrains Mono, monospace';

const BULL_COLOR = '#22c55e';
const BEAR_COLOR = '#ef4444';
const ZERO_LINE_COLOR = 'rgba(100, 116, 139, 0.3)';
const EMA_COLOR = '#facc15';

// ─── Types ─────────────────────────────────────────────────────────────────────

/** Indicator data is stashed in the state via the indicators Map<string, boolean>. */
// We use well-known keys for enabled state; actual data would be attached
// separately by the data layer. For rendering we look for arrays on the
// extended state object (cast for flexibility).

interface IndicatorData {
  vwap?: number[];            // One value per candle
  anchoredVwaps?: AnchoredVwapEntry[];
  cumulativeDelta?: number[]; // One value per candle
  ofi?: OfiEntry[];           // Per-second / per-candle OFI
  fundingRate?: FundingRateEntry[];
}

interface AnchoredVwapEntry {
  id: string;
  anchorIndex: number; // Index into candles array
  values: number[];    // Value from anchor to latest
  color?: string;
}

interface OfiEntry {
  timestamp: number;
  value: number;
  ema?: number;
}

interface FundingRateEntry {
  timestamp: number;
  rate: number;
}

type ExtendedState = ChartStateData & Partial<IndicatorData>;

// ─── Helpers ───────────────────────────────────────────────────────────────────

function formatPrice(price: number): string {
  if (price >= 10_000) return price.toFixed(0);
  if (price >= 100) return price.toFixed(1);
  if (price >= 1) return price.toFixed(2);
  return price.toFixed(4);
}

/** Draw a smooth polyline through a series of (x, y) points. */
function drawPolyline(
  ctx: CanvasRenderingContext2D,
  points: { x: number; y: number }[],
): void {
  if (points.length === 0) return;
  const first = points[0]!;
  ctx.beginPath();
  ctx.moveTo(first.x, first.y);
  for (let i = 1; i < points.length; i++) {
    const pt = points[i]!;
    ctx.lineTo(pt.x, pt.y);
  }
  ctx.stroke();
}

/** Map a value into a pixel range using a linear scale. */
function scaleY(value: number, min: number, max: number, topPx: number, bottomPx: number): number {
  const range = max - min;
  if (range === 0) return (topPx + bottomPx) / 2;
  return topPx + ((max - value) / range) * (bottomPx - topPx);
}

// ─── Sub-plot layout ───────────────────────────────────────────────────────────

interface SubplotRegion {
  key: string;
  label: string;
  top: number;
  bottom: number;
}

function computeSubplots(
  enabledSubplots: string[],
  chartH: number,
): { mainBottom: number; subplots: SubplotRegion[] } {
  if (enabledSubplots.length === 0) return { mainBottom: chartH, subplots: [] };

  const totalSubHeight = Math.min(enabledSubplots.length * SUBPLOT_HEIGHT_RATIO, 0.6) * chartH;
  const mainBottom = chartH - totalSubHeight;
  const perSubH = totalSubHeight / enabledSubplots.length;

  const subplots: SubplotRegion[] = enabledSubplots.map((key, i) => ({
    key,
    label: key,
    top: mainBottom + i * perSubH,
    bottom: mainBottom + (i + 1) * perSubH,
  }));

  return { mainBottom, subplots };
}

// ─── Renderer ──────────────────────────────────────────────────────────────────

/**
 * Draw overlay and sub-plot indicators.
 */
export function renderIndicators(
  ctx: CanvasRenderingContext2D,
  viewport: Viewport,
  state: Readonly<ChartStateData>,
): void {
  const ext = state as ExtendedState;
  const { width, height } = viewport.getLogicalSize();
  const chartW = width - RIGHT_MARGIN;
  const chartH = height - BOTTOM_MARGIN;
  const { start: startTime, end: endTime } = viewport.getVisibleTimeRange();

  const indicators = state.indicators;
  const candles = state.candles;

  // Determine which subplots are active
  const subplotKeys: string[] = [];
  if (indicators.get('cumulativeDelta')) subplotKeys.push('Cum. Delta');
  if (indicators.get('ofi')) subplotKeys.push('OFI');
  if (indicators.get('fundingRate')) subplotKeys.push('Funding Rate');

  const { mainBottom, subplots } = computeSubplots(subplotKeys, chartH);

  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, chartW, chartH);
  ctx.clip();

  // ── VWAP overlay ─────────────────────────────────────────────────────────
  if (indicators.get('vwap') && ext.vwap && ext.vwap.length > 0) {
    const points: { x: number; y: number }[] = [];

    for (let i = 0; i < candles.length; i++) {
      const c = candles[i];
      if (!c || c.timestamp < startTime || c.timestamp > endTime) continue;
      if (i >= ext.vwap.length) break;
      const vwapVal = ext.vwap[i];
      if (vwapVal === undefined) continue;

      const x = viewport.timeToX(c.timestamp);
      const y = viewport.priceToY(vwapVal);
      if (y >= 0 && y <= mainBottom) {
        points.push({ x, y });
      }
    }

    if (points.length > 1) {
      ctx.strokeStyle = VWAP_COLOR;
      ctx.lineWidth = VWAP_WIDTH;
      ctx.setLineDash([]);
      drawPolyline(ctx, points);

      // Label at right edge
      const last = points[points.length - 1];
      if (last) {
        ctx.font = OVERLAY_LABEL_FONT;
        ctx.fillStyle = VWAP_COLOR;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        const lastVwap = ext.vwap[Math.min(candles.length - 1, ext.vwap.length - 1)] ?? 0;
        ctx.fillText(`VWAP ${formatPrice(lastVwap)}`, last.x + 6, last.y);
      }
    }
  }

  // ── Anchored VWAPs ───────────────────────────────────────────────────────
  if (ext.anchoredVwaps) {
    for (let vi = 0; vi < ext.anchoredVwaps.length; vi++) {
      const av = ext.anchoredVwaps[vi];
      if (!av) continue;
      const color = av.color ?? ANCHORED_VWAP_COLORS[vi % ANCHORED_VWAP_COLORS.length] ?? '#a855f7';
      const points: { x: number; y: number }[] = [];

      for (let j = 0; j < av.values.length; j++) {
        const cIdx = av.anchorIndex + j;
        if (cIdx >= candles.length) break;
        const c = candles[cIdx];
        if (!c || c.timestamp < startTime || c.timestamp > endTime) continue;
        const avVal = av.values[j];
        if (avVal === undefined) continue;

        const x = viewport.timeToX(c.timestamp);
        const y = viewport.priceToY(avVal);
        if (y >= 0 && y <= mainBottom) {
          points.push({ x, y });
        }
      }

      if (points.length > 1) {
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5;
        ctx.setLineDash(ANCHORED_VWAP_DASH);
        drawPolyline(ctx, points);

        // Value label
        const last = points[points.length - 1];
        if (last) {
          ctx.setLineDash([]);
          ctx.font = OVERLAY_LABEL_FONT;
          ctx.fillStyle = color;
          ctx.textAlign = 'left';
          ctx.textBaseline = 'middle';
          const lastVal = av.values[av.values.length - 1] ?? 0;
          ctx.fillText(formatPrice(lastVal), last.x + 6, last.y);
        }
      }
    }
  }

  ctx.setLineDash([]);

  // ── Subplots ─────────────────────────────────────────────────────────────
  for (const sp of subplots) {
    // Background & divider
    ctx.fillStyle = SUBPLOT_BG;
    ctx.fillRect(0, sp.top, chartW, sp.bottom - sp.top);

    ctx.strokeStyle = SUBPLOT_DIVIDER_COLOR;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, sp.top);
    ctx.lineTo(chartW, sp.top);
    ctx.stroke();

    // Title
    ctx.font = SUBPLOT_LABEL_FONT;
    ctx.fillStyle = SUBPLOT_LABEL_COLOR;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(sp.label, 6, sp.top + 4);

    const spTop = sp.top + 18; // leave room for title
    const spBottom = sp.bottom - 4;
    const spMid = (spTop + spBottom) / 2;

    // ── Cumulative Delta ────────────────────────────────────────────────
    if (sp.key === 'Cum. Delta' && ext.cumulativeDelta) {
      const data = ext.cumulativeDelta;
      if (data.length === 0) continue;

      // Compute min/max for visible range
      let min = Infinity;
      let max = -Infinity;
      for (let i = 0; i < candles.length; i++) {
        const c = candles[i];
        if (!c || c.timestamp < startTime || c.timestamp > endTime) continue;
        if (i >= data.length) break;
        const val = data[i]!;
        if (val < min) min = val;
        if (val > max) max = val;
      }
      if (!isFinite(min)) continue;

      // Zero line
      const zeroY = scaleY(0, min, max, spTop, spBottom);
      ctx.strokeStyle = ZERO_LINE_COLOR;
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      ctx.moveTo(0, Math.max(spTop, Math.min(spBottom, zeroY)));
      ctx.lineTo(chartW, Math.max(spTop, Math.min(spBottom, zeroY)));
      ctx.stroke();

      // Line chart
      let prevPt: { x: number; y: number } | null = null;
      for (let i = 0; i < candles.length; i++) {
        const c = candles[i];
        if (!c || c.timestamp < startTime || c.timestamp > endTime) continue;
        if (i >= data.length) break;
        const val = data[i] ?? 0;

        const x = viewport.timeToX(c.timestamp);
        const y = scaleY(val, min, max, spTop, spBottom);

        if (prevPt) {
          const prevVal = i > 0 ? (data[i - 1] ?? val) : val;
          const rising = val >= prevVal;
          ctx.strokeStyle = rising ? BULL_COLOR : BEAR_COLOR;
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.moveTo(prevPt.x, prevPt.y);
          ctx.lineTo(x, y);
          ctx.stroke();
        }
        prevPt = { x, y };
      }
    }

    // ── OFI Histogram ───────────────────────────────────────────────────
    if (sp.key === 'OFI' && ext.ofi) {
      const data = ext.ofi;
      if (data.length === 0) continue;

      let min = 0;
      let max = 0;
      for (const d of data) {
        if (d.timestamp < startTime || d.timestamp > endTime) continue;
        if (d.value < min) min = d.value;
        if (d.value > max) max = d.value;
      }
      const absMax = Math.max(Math.abs(min), Math.abs(max), 1);

      const zeroY = spMid;

      // Zero line
      ctx.strokeStyle = ZERO_LINE_COLOR;
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      ctx.moveTo(0, zeroY);
      ctx.lineTo(chartW, zeroY);
      ctx.stroke();

      const barW = Math.max(1, viewport.getCandleWidth() * 0.6);
      const halfRange = (spBottom - spTop) / 2;

      const emaPoints: { x: number; y: number }[] = [];

      for (const d of data) {
        if (d.timestamp < startTime || d.timestamp > endTime) continue;
        const x = viewport.timeToX(d.timestamp);
        const barH = (Math.abs(d.value) / absMax) * halfRange;

        ctx.fillStyle = d.value >= 0 ? BULL_COLOR : BEAR_COLOR;
        if (d.value >= 0) {
          ctx.fillRect(x - barW / 2, zeroY - barH, barW, barH);
        } else {
          ctx.fillRect(x - barW / 2, zeroY, barW, barH);
        }

        if (d.ema !== undefined) {
          const emaY = scaleY(d.ema, -absMax, absMax, spTop, spBottom);
          emaPoints.push({ x, y: emaY });
        }
      }

      // EMA line overlay
      if (emaPoints.length > 1) {
        ctx.strokeStyle = EMA_COLOR;
        ctx.lineWidth = 1;
        drawPolyline(ctx, emaPoints);
      }
    }

    // ── Funding Rate ────────────────────────────────────────────────────
    if (sp.key === 'Funding Rate' && ext.fundingRate) {
      const data = ext.fundingRate;
      if (data.length === 0) continue;

      let absMax = 0;
      for (const d of data) {
        if (d.timestamp < startTime || d.timestamp > endTime) continue;
        const a = Math.abs(d.rate);
        if (a > absMax) absMax = a;
      }
      if (absMax === 0) absMax = 0.001;

      const zeroY = spMid;
      const halfRange = (spBottom - spTop) / 2;
      const barW = Math.max(2, viewport.getCandleWidth() * 0.5);

      // Zero line
      ctx.strokeStyle = ZERO_LINE_COLOR;
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      ctx.moveTo(0, zeroY);
      ctx.lineTo(chartW, zeroY);
      ctx.stroke();

      // Compute spike threshold (2σ from mean)
      let sum = 0;
      let sumSq = 0;
      let count = 0;
      for (const d of data) {
        sum += Math.abs(d.rate);
        sumSq += d.rate * d.rate;
        count++;
      }
      const mean = count > 0 ? sum / count : 0;
      const variance = count > 0 ? sumSq / count - (sum / count) ** 2 : 0;
      const spikeThreshold = mean + 2 * Math.sqrt(Math.max(variance, 0));

      for (const d of data) {
        if (d.timestamp < startTime || d.timestamp > endTime) continue;
        const x = viewport.timeToX(d.timestamp);
        const barH = (Math.abs(d.rate) / absMax) * halfRange;
        const isSpike = Math.abs(d.rate) > spikeThreshold;

        if (d.rate >= 0) {
          ctx.fillStyle = isSpike ? 'rgba(34, 197, 94, 0.9)' : BULL_COLOR;
          ctx.fillRect(x - barW / 2, zeroY - barH, barW, barH);
        } else {
          ctx.fillStyle = isSpike ? 'rgba(239, 68, 68, 0.9)' : BEAR_COLOR;
          ctx.fillRect(x - barW / 2, zeroY, barW, barH);
        }

        // Highlight spikes with a brighter border
        if (isSpike) {
          ctx.strokeStyle = '#ffffff';
          ctx.lineWidth = 1;
          if (d.rate >= 0) {
            ctx.strokeRect(x - barW / 2, zeroY - barH, barW, barH);
          } else {
            ctx.strokeRect(x - barW / 2, zeroY, barW, barH);
          }
        }
      }
    }

    // Subplot Y-axis scale labels
    ctx.font = SUBPLOT_LABEL_FONT;
    ctx.fillStyle = SUBPLOT_LABEL_COLOR;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText('0', chartW + 4, spMid - 5);
  }

  ctx.restore();
}
