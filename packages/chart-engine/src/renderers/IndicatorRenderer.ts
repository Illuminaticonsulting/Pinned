/**
 * IndicatorRenderer.ts
 * Renders overlay indicators (EMA, SMA, Bollinger Bands, VWAP, Anchored VWAP)
 * on the main chart and sub-plot indicators (RSI, MACD, Cumulative Delta, OFI,
 * Funding Rate) in stacked panels below the main chart on Layer 2.
 */

import type { Viewport } from '../core/Viewport';
import type { ChartStateData, Candle } from '../core/ChartState';

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

// Classic indicator colors
const EMA_COLORS = ['#f59e0b', '#3b82f6', '#8b5cf6', '#ec4899']; // EMA 9, 21, 50, 200
const SMA_COLORS = ['#06b6d4', '#10b981', '#6366f1', '#f43f5e']; // SMA 20, 50, 100, 200
const BB_COLOR = '#8b5cf6';
const BB_FILL = 'rgba(139, 92, 246, 0.06)';
const RSI_COLOR = '#f59e0b';
const RSI_OVERBOUGHT = 70;
const RSI_OVERSOLD = 30;
const MACD_LINE_COLOR = '#3b82f6';
const MACD_SIGNAL_COLOR = '#ef4444';
const MACD_HIST_BULL = 'rgba(34, 197, 94, 0.6)';
const MACD_HIST_BEAR = 'rgba(239, 68, 68, 0.6)';

// ─── Classic Indicator Calculations ──────────────────────────────────────────

function computeEMA(values: number[], period: number): number[] {
  const result: number[] = [];
  if (values.length === 0) return result;
  const k = 2 / (period + 1);
  let ema = values[0]!;
  result.push(ema);
  for (let i = 1; i < values.length; i++) {
    ema = values[i]! * k + ema * (1 - k);
    result.push(ema);
  }
  return result;
}

function computeSMA(values: number[], period: number): number[] {
  const result: number[] = new Array(values.length).fill(NaN);
  if (values.length < period) return result;
  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i]!;
  result[period - 1] = sum / period;
  for (let i = period; i < values.length; i++) {
    sum += values[i]! - values[i - period]!;
    result[i] = sum / period;
  }
  return result;
}

function computeBollingerBands(values: number[], period: number, stdDev: number): { upper: number[]; middle: number[]; lower: number[] } {
  const middle = computeSMA(values, period);
  const upper: number[] = new Array(values.length).fill(NaN);
  const lower: number[] = new Array(values.length).fill(NaN);

  for (let i = period - 1; i < values.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const diff = values[j]! - middle[i]!;
      sum += diff * diff;
    }
    const std = Math.sqrt(sum / period);
    upper[i] = middle[i]! + stdDev * std;
    lower[i] = middle[i]! - stdDev * std;
  }

  return { upper, middle, lower };
}

function computeRSI(values: number[], period = 14): number[] {
  const result: number[] = new Array(values.length).fill(NaN);
  if (values.length < period + 1) return result;

  let gainSum = 0, lossSum = 0;
  for (let i = 1; i <= period; i++) {
    const change = values[i]! - values[i - 1]!;
    if (change > 0) gainSum += change; else lossSum += Math.abs(change);
  }
  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;
  result[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  for (let i = period + 1; i < values.length; i++) {
    const change = values[i]! - values[i - 1]!;
    avgGain = (avgGain * (period - 1) + Math.max(change, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-change, 0)) / period;
    result[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return result;
}

function computeMACD(values: number[], fast = 12, slow = 26, signal = 9): { macd: number[]; signal: number[]; histogram: number[] } {
  const emaFast = computeEMA(values, fast);
  const emaSlow = computeEMA(values, slow);

  const macdLine: number[] = [];
  for (let i = 0; i < values.length; i++) {
    macdLine.push(emaFast[i]! - emaSlow[i]!);
  }
  const signalLine = computeEMA(macdLine, signal);
  const histogram: number[] = [];
  for (let i = 0; i < values.length; i++) {
    histogram.push(macdLine[i]! - signalLine[i]!);
  }

  return { macd: macdLine, signal: signalLine, histogram };
}

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

  // Extract close prices for indicator computation
  const closes: number[] = candles.map(c => c.close);

  // Determine which subplots are active
  const subplotKeys: string[] = [];
  if (indicators.get('rsi')) subplotKeys.push('RSI');
  if (indicators.get('macd')) subplotKeys.push('MACD');
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

  // ── EMA overlays ──────────────────────────────────────────────────────────
  const emaPeriods = [9, 21, 50, 200];
  for (let ei = 0; ei < emaPeriods.length; ei++) {
    const period = emaPeriods[ei]!;
    const key = `ema${period}`;
    if (!indicators.get(key)) continue;
    const emaVals = computeEMA(closes, period);
    const points: { x: number; y: number }[] = [];
    for (let i = period; i < candles.length; i++) {
      const c = candles[i]!;
      if (c.timestamp < startTime || c.timestamp > endTime) continue;
      const x = viewport.timeToX(c.timestamp);
      const y = viewport.priceToY(emaVals[i]!);
      if (y >= 0 && y <= mainBottom) points.push({ x, y });
    }
    if (points.length > 1) {
      ctx.strokeStyle = EMA_COLORS[ei] ?? '#f59e0b';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([]);
      drawPolyline(ctx, points);
      const last = points[points.length - 1]!;
      ctx.font = OVERLAY_LABEL_FONT;
      ctx.fillStyle = EMA_COLORS[ei] ?? '#f59e0b';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(`EMA ${period}`, last.x + 6, last.y);
    }
  }

  // ── SMA overlays ──────────────────────────────────────────────────────────
  const smaPeriods = [20, 50, 100, 200];
  for (let si = 0; si < smaPeriods.length; si++) {
    const period = smaPeriods[si]!;
    const key = `sma${period}`;
    if (!indicators.get(key)) continue;
    const smaVals = computeSMA(closes, period);
    const points: { x: number; y: number }[] = [];
    for (let i = period - 1; i < candles.length; i++) {
      const c = candles[i]!;
      if (c.timestamp < startTime || c.timestamp > endTime) continue;
      const val = smaVals[i];
      if (val === undefined || isNaN(val)) continue;
      const x = viewport.timeToX(c.timestamp);
      const y = viewport.priceToY(val);
      if (y >= 0 && y <= mainBottom) points.push({ x, y });
    }
    if (points.length > 1) {
      ctx.strokeStyle = SMA_COLORS[si] ?? '#06b6d4';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([]);
      drawPolyline(ctx, points);
      const last = points[points.length - 1]!;
      ctx.font = OVERLAY_LABEL_FONT;
      ctx.fillStyle = SMA_COLORS[si] ?? '#06b6d4';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(`SMA ${period}`, last.x + 6, last.y);
    }
  }

  // ── Bollinger Bands overlay ───────────────────────────────────────────────
  if (indicators.get('bollingerBands')) {
    const bb = computeBollingerBands(closes, 20, 2);
    const upperPts: { x: number; y: number }[] = [];
    const middlePts: { x: number; y: number }[] = [];
    const lowerPts: { x: number; y: number }[] = [];
    for (let i = 19; i < candles.length; i++) {
      const c = candles[i]!;
      if (c.timestamp < startTime || c.timestamp > endTime) continue;
      const u = bb.upper[i], m = bb.middle[i], l = bb.lower[i];
      if (u === undefined || isNaN(u)) continue;
      const x = viewport.timeToX(c.timestamp);
      upperPts.push({ x, y: viewport.priceToY(u!) });
      middlePts.push({ x, y: viewport.priceToY(m!) });
      lowerPts.push({ x, y: viewport.priceToY(l!) });
    }
    if (upperPts.length > 1) {
      // Fill between bands
      ctx.beginPath();
      ctx.moveTo(upperPts[0]!.x, upperPts[0]!.y);
      for (const p of upperPts) ctx.lineTo(p.x, p.y);
      for (let i = lowerPts.length - 1; i >= 0; i--) ctx.lineTo(lowerPts[i]!.x, lowerPts[i]!.y);
      ctx.closePath();
      ctx.fillStyle = BB_FILL;
      ctx.fill();
      // Upper band
      ctx.strokeStyle = BB_COLOR;
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 2]);
      drawPolyline(ctx, upperPts);
      // Lower band
      drawPolyline(ctx, lowerPts);
      // Middle band (SMA 20)
      ctx.setLineDash([]);
      ctx.lineWidth = 1.5;
      drawPolyline(ctx, middlePts);
      const lastU = upperPts[upperPts.length - 1]!;
      ctx.font = OVERLAY_LABEL_FONT;
      ctx.fillStyle = BB_COLOR;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText('BB', lastU.x + 6, lastU.y);
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

    // ── RSI ──────────────────────────────────────────────────────────────
    if (sp.key === 'RSI') {
      const rsiVals = computeRSI(closes, 14);
      let rMin = 0, rMax = 100;

      // Overbought / Oversold lines
      const obY = scaleY(RSI_OVERBOUGHT, rMin, rMax, spTop, spBottom);
      const osY = scaleY(RSI_OVERSOLD, rMin, rMax, spTop, spBottom);
      const midY = scaleY(50, rMin, rMax, spTop, spBottom);

      ctx.strokeStyle = 'rgba(239, 68, 68, 0.3)';
      ctx.lineWidth = 0.5;
      ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(0, obY); ctx.lineTo(chartW, obY); ctx.stroke();

      ctx.strokeStyle = 'rgba(34, 197, 94, 0.3)';
      ctx.beginPath(); ctx.moveTo(0, osY); ctx.lineTo(chartW, osY); ctx.stroke();

      ctx.strokeStyle = ZERO_LINE_COLOR;
      ctx.beginPath(); ctx.moveTo(0, midY); ctx.lineTo(chartW, midY); ctx.stroke();
      ctx.setLineDash([]);

      // Fill overbought/oversold zones
      ctx.fillStyle = 'rgba(239, 68, 68, 0.04)';
      ctx.fillRect(0, spTop, chartW, obY - spTop);
      ctx.fillStyle = 'rgba(34, 197, 94, 0.04)';
      ctx.fillRect(0, osY, chartW, spBottom - osY);

      // RSI line
      const rsiPts: { x: number; y: number }[] = [];
      for (let i = 0; i < candles.length; i++) {
        const c = candles[i]!;
        if (c.timestamp < startTime || c.timestamp > endTime) continue;
        const val = rsiVals[i];
        if (val === undefined || isNaN(val)) continue;
        rsiPts.push({ x: viewport.timeToX(c.timestamp), y: scaleY(val, rMin, rMax, spTop, spBottom) });
      }
      if (rsiPts.length > 1) {
        ctx.strokeStyle = RSI_COLOR;
        ctx.lineWidth = 1.5;
        drawPolyline(ctx, rsiPts);
      }

      // Labels
      ctx.font = SUBPLOT_LABEL_FONT;
      ctx.fillStyle = SUBPLOT_LABEL_COLOR;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText('70', chartW + 4, obY);
      ctx.fillText('30', chartW + 4, osY);
      ctx.fillText('50', chartW + 4, midY);
    }

    // ── MACD ─────────────────────────────────────────────────────────────
    if (sp.key === 'MACD') {
      const macdData = computeMACD(closes, 12, 26, 9);

      let mMin = Infinity, mMax = -Infinity;
      for (let i = 0; i < candles.length; i++) {
        const c = candles[i]!;
        if (c.timestamp < startTime || c.timestamp > endTime) continue;
        const vals = [macdData.macd[i]!, macdData.signal[i]!, macdData.histogram[i]!];
        for (const v of vals) {
          if (v < mMin) mMin = v;
          if (v > mMax) mMax = v;
        }
      }
      if (!isFinite(mMin)) { mMin = -1; mMax = 1; }

      // Zero line
      const zeroY = scaleY(0, mMin, mMax, spTop, spBottom);
      ctx.strokeStyle = ZERO_LINE_COLOR;
      ctx.lineWidth = 0.5;
      ctx.beginPath(); ctx.moveTo(0, zeroY); ctx.lineTo(chartW, zeroY); ctx.stroke();

      // Histogram bars
      const barW = Math.max(1, viewport.getCandleWidth() * 0.5);
      for (let i = 0; i < candles.length; i++) {
        const c = candles[i]!;
        if (c.timestamp < startTime || c.timestamp > endTime) continue;
        const hVal = macdData.histogram[i];
        if (hVal === undefined) continue;
        const x = viewport.timeToX(c.timestamp);
        const hY = scaleY(hVal, mMin, mMax, spTop, spBottom);
        ctx.fillStyle = hVal >= 0 ? MACD_HIST_BULL : MACD_HIST_BEAR;
        if (hVal >= 0) {
          ctx.fillRect(x - barW / 2, hY, barW, zeroY - hY);
        } else {
          ctx.fillRect(x - barW / 2, zeroY, barW, hY - zeroY);
        }
      }

      // MACD line
      const macdPts: { x: number; y: number }[] = [];
      const sigPts: { x: number; y: number }[] = [];
      for (let i = 0; i < candles.length; i++) {
        const c = candles[i]!;
        if (c.timestamp < startTime || c.timestamp > endTime) continue;
        const mv = macdData.macd[i], sv = macdData.signal[i];
        if (mv === undefined || sv === undefined) continue;
        const x = viewport.timeToX(c.timestamp);
        macdPts.push({ x, y: scaleY(mv, mMin, mMax, spTop, spBottom) });
        sigPts.push({ x, y: scaleY(sv, mMin, mMax, spTop, spBottom) });
      }
      if (macdPts.length > 1) {
        ctx.strokeStyle = MACD_LINE_COLOR;
        ctx.lineWidth = 1.5;
        drawPolyline(ctx, macdPts);
        ctx.strokeStyle = MACD_SIGNAL_COLOR;
        ctx.lineWidth = 1;
        drawPolyline(ctx, sigPts);
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
