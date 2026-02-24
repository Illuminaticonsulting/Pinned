/**
 * FootprintRenderer.ts
 * Renders order-flow footprint candles (bid/ask volume at each price level)
 * as an alternative to plain candlesticks on Layer 1.
 */

import type { Viewport } from '../core/Viewport';
import type { ChartStateData, FootprintCandle } from '../core/ChartState';

// ─── Constants ─────────────────────────────────────────────────────────────────

const MIN_FOOTPRINT_CANDLE_WIDTH = 60;
const CELL_FONT = '9px JetBrains Mono, monospace';
const BULL_TEXT = '#22c55e';
const BEAR_TEXT = '#ef4444';
const BULL_BG = 'rgba(34, 197, 94, 0.08)';
const BEAR_BG = 'rgba(239, 68, 68, 0.08)';
const IMBALANCE_BORDER = '#facc15';
const OUTLINE_BULL = '#22c55e';
const OUTLINE_BEAR = '#ef4444';
const DIVIDER_COLOR = 'rgba(100, 116, 139, 0.4)';
const CELL_BORDER_COLOR = 'rgba(100, 116, 139, 0.2)';
const DELTA_BAR_MAX_H = 30;

const RIGHT_MARGIN = 80;
const BOTTOM_MARGIN = 28;

const IMBALANCE_RATIO = 3;

// ─── Helpers ───────────────────────────────────────────────────────────────────

function formatVolume(v: number): string {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
  if (v >= 100) return v.toFixed(0);
  if (v >= 1) return v.toFixed(1);
  return v.toFixed(2);
}

// ─── Renderer ──────────────────────────────────────────────────────────────────

/**
 * Render footprint candles showing bid/ask volume at each price level.
 * Only activates when the zoom level provides at least 60px per candle.
 */
export function renderFootprint(
  ctx: CanvasRenderingContext2D,
  viewport: Viewport,
  state: Readonly<ChartStateData>,
): void {
  const candleWidth = viewport.getCandleWidth();
  if (candleWidth < MIN_FOOTPRINT_CANDLE_WIDTH) return;

  const { width, height } = viewport.getLogicalSize();
  const chartW = width - RIGHT_MARGIN;
  const chartH = height - BOTTOM_MARGIN;
  const { start: startTime, end: endTime } = viewport.getVisibleTimeRange();

  const footprintData = state.footprintData;
  if (!footprintData || footprintData.size === 0) return;

  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, chartW, chartH);
  ctx.clip();
  ctx.font = CELL_FONT;

  const candles = state.candles;
  const bodyW = Math.max(1, candleWidth - 2);
  const halfBody = bodyW / 2;

  // Compute max absolute delta across visible footprint candles for delta bar scaling
  let maxAbsDelta = 0;
  for (const c of candles) {
    if (c.timestamp < startTime || c.timestamp > endTime) continue;
    const fp = footprintData.get(c.timestamp);
    if (fp) {
      const absDelta = Math.abs(fp.totalDelta);
      if (absDelta > maxAbsDelta) maxAbsDelta = absDelta;
    }
  }

  for (const candle of candles) {
    if (candle.timestamp < startTime || candle.timestamp > endTime) continue;

    const fp: FootprintCandle | undefined = footprintData.get(candle.timestamp);
    if (!fp || fp.levels.length === 0) continue;

    const cx = viewport.timeToX(candle.timestamp);
    const bull = candle.close >= candle.open;

    // ── Candle body outline ─────────────────────────────────────────────────
    const openY = viewport.priceToY(candle.open);
    const closeY = viewport.priceToY(candle.close);
    const bodyTop = Math.min(openY, closeY);
    const bodyHeight = Math.max(Math.abs(openY - closeY), 1);

    ctx.strokeStyle = bull ? OUTLINE_BULL : OUTLINE_BEAR;
    ctx.lineWidth = 1;
    ctx.strokeRect(cx - halfBody, bodyTop, bodyW, bodyHeight);

    // ── Sort levels by price descending (top of canvas first) ───────────────
    const levels = [...fp.levels].sort((a, b) => b.price - a.price);
    if (levels.length === 0) continue;

    // Determine row height from price spacing between adjacent levels
    let rowHeight: number;
    if (levels.length > 1 && levels[0] && levels[1]) {
      const priceStep = Math.abs(levels[0].price - levels[1].price);
      const y0 = viewport.priceToY(levels[0].price);
      const y1 = viewport.priceToY(levels[0].price - priceStep);
      rowHeight = Math.abs(y1 - y0);
    } else {
      rowHeight = bodyHeight;
    }

    // Check if there's enough room for text
    const canShowText = rowHeight >= 10 && bodyW >= 40;

    for (let i = 0; i < levels.length; i++) {
      const level = levels[i];
      if (!level) continue;
      const y = viewport.priceToY(level.price);
      const cellTop = y - rowHeight / 2;

      // ── Cell background based on net delta ────────────────────────────────
      const netDelta = level.askVolume - level.bidVolume;
      ctx.fillStyle = netDelta >= 0 ? BULL_BG : BEAR_BG;
      ctx.fillRect(cx - halfBody, cellTop, bodyW, rowHeight);

      // ── Cell border ───────────────────────────────────────────────────────
      ctx.strokeStyle = CELL_BORDER_COLOR;
      ctx.lineWidth = 0.5;
      ctx.strokeRect(cx - halfBody, cellTop, bodyW, rowHeight);

      if (canShowText) {
        // ── Divider line ──────────────────────────────────────────────────
        ctx.strokeStyle = DIVIDER_COLOR;
        ctx.lineWidth = 0.5;
        ctx.beginPath();
        ctx.moveTo(cx, cellTop);
        ctx.lineTo(cx, cellTop + rowHeight);
        ctx.stroke();

        // ── Sell (bid) volume – left column, right-aligned ──────────────
        const sellText = formatVolume(level.bidVolume);
        ctx.fillStyle = BEAR_TEXT;
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        ctx.fillText(sellText, cx - 2, y);

        // ── Buy (ask) volume – right column, left-aligned ──────────────
        const buyText = formatVolume(level.askVolume);
        ctx.fillStyle = BULL_TEXT;
        ctx.textAlign = 'left';
        ctx.fillText(buyText, cx + 2, y);
      } else {
        // ── Heatmap rectangles when too small for text ──────────────────
        const maxVol = Math.max(level.bidVolume, level.askVolume, 1);
        const colW = bodyW / 2;

        // Sell side (left)
        const sellAlpha = Math.min(level.bidVolume / maxVol, 1) * 0.6 + 0.1;
        ctx.fillStyle = `rgba(239, 68, 68, ${sellAlpha.toFixed(2)})`;
        ctx.fillRect(cx - halfBody, cellTop, colW, rowHeight);

        // Buy side (right)
        const buyAlpha = Math.min(level.askVolume / maxVol, 1) * 0.6 + 0.1;
        ctx.fillStyle = `rgba(34, 197, 94, ${buyAlpha.toFixed(2)})`;
        ctx.fillRect(cx, cellTop, colW, rowHeight);
      }

      // ── Imbalance detection (diagonal comparison) ─────────────────────
      // Compare this level's ask vs next lower level's bid, and vice-versa
      if (i < levels.length - 1) {
        const nextLevel = levels[i + 1];
        if (!nextLevel) continue;
        const askBidRatio = nextLevel.bidVolume > 0 ? level.askVolume / nextLevel.bidVolume : Infinity;
        const bidAskRatio = level.bidVolume > 0 ? nextLevel.askVolume / level.bidVolume : Infinity;

        if (askBidRatio >= IMBALANCE_RATIO || bidAskRatio >= IMBALANCE_RATIO) {
          ctx.strokeStyle = IMBALANCE_BORDER;
          ctx.lineWidth = 1.5;
          ctx.strokeRect(cx - halfBody + 0.5, cellTop + 0.5, bodyW - 1, rowHeight - 1);
        }
      }
    }

    // ── Delta bar below candle ──────────────────────────────────────────────
    if (maxAbsDelta > 0) {
      const delta = fp.totalDelta;
      const barHeight = (Math.abs(delta) / maxAbsDelta) * DELTA_BAR_MAX_H;
      const barY = viewport.priceToY(candle.low) + 4;

      ctx.fillStyle = delta >= 0
        ? 'rgba(34, 197, 94, 0.5)'
        : 'rgba(239, 68, 68, 0.5)';
      ctx.fillRect(cx - halfBody, barY, bodyW, barHeight);
    }
  }

  ctx.restore();
}
