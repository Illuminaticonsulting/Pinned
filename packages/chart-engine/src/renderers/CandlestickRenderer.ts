/**
 * CandlestickRenderer.ts
 * Renders OHLCV candlestick bodies, wicks, volume bars, and live candle glow on Layer 1.
 */

import type { Viewport } from '../core/Viewport';
import type { ChartStateData, Candle } from '../core/ChartState';

// ─── Constants ─────────────────────────────────────────────────────────────────

const BULL_COLOR = '#10b981';
const BEAR_COLOR = '#f43f5e';
const BULL_WICK_COLOR = 'rgba(16, 185, 129, 0.65)';
const BEAR_WICK_COLOR = 'rgba(244, 63, 94, 0.65)';
const BULL_VOL_COLOR = 'rgba(16, 185, 129, 0.15)';
const BEAR_VOL_COLOR = 'rgba(244, 63, 94, 0.15)';

const MIN_CANDLE_WIDTH = 3;
const MAX_CANDLE_WIDTH = 50;
const CANDLE_GAP = 1;
const RIGHT_MARGIN = 80;
const BOTTOM_MARGIN = 28;
const VOLUME_MAX_RATIO = 0.25;

// ─── Helpers ───────────────────────────────────────────────────────────────────

function isBull(c: Candle): boolean {
  return c.close >= c.open;
}

// ─── Renderer ──────────────────────────────────────────────────────────────────

/**
 * Draw candlestick chart with volume bars and optional live-candle glow.
 */
export function renderCandlesticks(
  ctx: CanvasRenderingContext2D,
  viewport: Viewport,
  state: Readonly<ChartStateData>,
): void {
  const { width, height } = viewport.getLogicalSize();
  const chartW = width - RIGHT_MARGIN;
  const chartH = height - BOTTOM_MARGIN;
  const { start: startTime, end: endTime } = viewport.getVisibleTimeRange();

  // Clamp candle width
  let candleW = viewport.getCandleWidth();
  candleW = Math.max(MIN_CANDLE_WIDTH, Math.min(MAX_CANDLE_WIDTH, candleW));
  const bodyW = Math.max(1, candleW - CANDLE_GAP * 2);

  // Filter visible candles
  const candles = state.candles;
  const visible: Candle[] = [];
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    if (c && c.timestamp >= startTime && c.timestamp <= endTime) {
      visible.push(c);
    }
  }

  // Append live candle if present and within range
  if (state.liveCandle && state.liveCandle.timestamp >= startTime && state.liveCandle.timestamp <= endTime) {
    visible.push(state.liveCandle);
  }

  if (visible.length === 0) return;

  // ── Compute max visible volume for volume bars ────────────────────────────
  let maxVolume = 0;
  for (const c of visible) {
    if (c.volume > maxVolume) maxVolume = c.volume;
  }

  ctx.save();

  // Clip to chart area
  ctx.beginPath();
  ctx.rect(0, 0, chartW, chartH);
  ctx.clip();

  // ── Draw each candle ──────────────────────────────────────────────────────
  for (const candle of visible) {
    const bull = isBull(candle);
    const cx = viewport.timeToX(candle.timestamp);
    const halfBody = bodyW / 2;

    const openY = viewport.priceToY(candle.open);
    const closeY = viewport.priceToY(candle.close);
    const highY = viewport.priceToY(candle.high);
    const lowY = viewport.priceToY(candle.low);

    // ── Wick ────────────────────────────────────────────────────────────────
    ctx.strokeStyle = bull ? BULL_WICK_COLOR : BEAR_WICK_COLOR;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cx, highY);
    ctx.lineTo(cx, lowY);
    ctx.stroke();

    // ── Body ────────────────────────────────────────────────────────────────
    const bodyTop = Math.min(openY, closeY);
    const bodyBottom = Math.max(openY, closeY);
    let bodyHeight = bodyBottom - bodyTop;

    ctx.fillStyle = bull ? BULL_COLOR : BEAR_COLOR;

    if (bodyHeight < 1) {
      // Doji – draw a thin horizontal line
      ctx.fillRect(cx - halfBody, openY - 0.5, bodyW, 1);
    } else {
      ctx.fillRect(cx - halfBody, bodyTop, bodyW, bodyHeight);
    }

    // ── Volume bar ──────────────────────────────────────────────────────────
    if (maxVolume > 0) {
      const volHeight = (candle.volume / maxVolume) * chartH * VOLUME_MAX_RATIO;
      ctx.fillStyle = bull ? BULL_VOL_COLOR : BEAR_VOL_COLOR;
      ctx.fillRect(cx - halfBody, chartH - volHeight, bodyW, volHeight);
    }
  }

  // ── Live candle glow ──────────────────────────────────────────────────────
  if (state.liveCandle) {
    const live = state.liveCandle;
    const cx = viewport.timeToX(live.timestamp);
    const halfBody = bodyW / 2;
    const openY = viewport.priceToY(live.open);
    const closeY = viewport.priceToY(live.close);
    const bodyTop = Math.min(openY, closeY);
    const bodyHeight = Math.max(Math.abs(openY - closeY), 1);

    // Pulsing glow via a time-based alpha oscillation
    const now = performance.now();
    const pulse = 0.2 + 0.25 * Math.sin(now / 500);
    const bull = isBull(live);
    const baseColor = bull ? [16, 185, 129] : [244, 63, 94];
    const glowColor = `rgba(${baseColor.join(',')}, ${pulse.toFixed(2)})`;

    // Outer soft glow
    ctx.shadowColor = `rgba(${baseColor.join(',')}, ${(pulse * 0.5).toFixed(2)})`;
    ctx.shadowBlur = 12;
    ctx.strokeStyle = glowColor;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(cx - halfBody - 1, bodyTop - 1, bodyW + 2, bodyHeight + 2);
    ctx.shadowBlur = 0;

    // Inner bright border
    ctx.strokeStyle = `rgba(${baseColor.join(',')}, ${(pulse + 0.2).toFixed(2)})`;
    ctx.lineWidth = 0.5;
    ctx.strokeRect(cx - halfBody, bodyTop, bodyW, bodyHeight);
  }

  ctx.restore();
}
