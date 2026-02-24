/**
 * CrosshairRenderer.ts
 * Renders the interactive crosshair, axis labels, and OHLCV data display on Layer 5.
 */

import type { Viewport } from '../core/Viewport';
import type { ChartStateData, Candle, FootprintCandle } from '../core/ChartState';

// ─── Constants ─────────────────────────────────────────────────────────────────

const CROSSHAIR_COLOR = 'rgba(255, 255, 255, 0.3)';
const CROSSHAIR_DASH = [4, 3];
const LABEL_BG = '#374151';
const LABEL_TEXT = '#ffffff';
const LABEL_FONT = '11px JetBrains Mono, monospace';
const OHLCV_LABEL_COLOR = '#9ca3af';
const BULL_COLOR = '#22c55e';
const BEAR_COLOR = '#ef4444';
const LABEL_PADDING_X = 6;
const LABEL_RADIUS = 3;

const RIGHT_MARGIN = 80;
const BOTTOM_MARGIN = 28;

// ─── Helpers ───────────────────────────────────────────────────────────────────

/** Format a price value with appropriate precision. */
function formatPrice(price: number): string {
  if (price >= 10_000) return price.toFixed(0);
  if (price >= 100) return price.toFixed(1);
  if (price >= 1) return price.toFixed(2);
  if (price >= 0.01) return price.toFixed(4);
  return price.toFixed(6);
}

/** Format a number with thousands separators. */
function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(2)}K`;
  return n.toFixed(2);
}

/** Format a timestamp for the crosshair label. */
function formatTimestamp(ts: number): string {
  const d = new Date(ts);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const mon = months[d.getUTCMonth()];
  const day = d.getUTCDate();
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${mon} ${day} ${hh}:${mm}`;
}

/** Draw a filled rounded rectangle. */
function fillRoundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
  ctx.fill();
}

/** Find the candle whose center is closest to a given X, within snap tolerance. */
function findCandleAtX(
  x: number,
  viewport: Viewport,
  candles: readonly Candle[],
  liveCandle: Candle | null,
): Candle | null {
  const candleW = viewport.getCandleWidth();
  const snapRadius = candleW / 2;

  let best: Candle | null = null;
  let bestDist = Infinity;

  const check = (c: Candle) => {
    const cx = viewport.timeToX(c.timestamp);
    const dist = Math.abs(cx - x);
    if (dist < bestDist && dist <= snapRadius) {
      bestDist = dist;
      best = c;
    }
  };

  for (const c of candles) {
    check(c);
  }
  if (liveCandle) check(liveCandle);

  return best;
}

// ─── Renderer ──────────────────────────────────────────────────────────────────

/**
 * Draw crosshair lines, axis labels at cursor, and OHLCV info panel.
 */
export function renderCrosshair(
  ctx: CanvasRenderingContext2D,
  viewport: Viewport,
  state: Readonly<ChartStateData>,
): void {
  if (!state.crosshairEnabled || !state.cursor.visible) return;

  const { width, height } = viewport.getLogicalSize();
  const chartW = width - RIGHT_MARGIN;
  const chartH = height - BOTTOM_MARGIN;

  let cursorX = state.cursor.x;
  const cursorY = state.cursor.y;

  // ── Snap X to nearest candle centre ───────────────────────────────────────
  const hoveredCandle = findCandleAtX(cursorX, viewport, state.candles, state.liveCandle);
  if (hoveredCandle) {
    cursorX = viewport.timeToX(hoveredCandle.timestamp);
  }

  const cursorPrice = viewport.yToPrice(cursorY);
  const cursorTime = viewport.xToTime(cursorX);

  ctx.save();
  ctx.font = LABEL_FONT;

  // ── Crosshair lines ──────────────────────────────────────────────────────
  ctx.strokeStyle = CROSSHAIR_COLOR;
  ctx.lineWidth = 1;
  ctx.setLineDash(CROSSHAIR_DASH);

  // Horizontal line
  if (cursorY >= 0 && cursorY <= chartH) {
    ctx.beginPath();
    ctx.moveTo(0, cursorY);
    ctx.lineTo(chartW, cursorY);
    ctx.stroke();
  }

  // Vertical line
  if (cursorX >= 0 && cursorX <= chartW) {
    ctx.beginPath();
    ctx.moveTo(cursorX, 0);
    ctx.lineTo(cursorX, chartH);
    ctx.stroke();
  }

  ctx.setLineDash([]);

  // ── Price label on right axis ─────────────────────────────────────────────
  if (cursorY >= 0 && cursorY <= chartH) {
    const priceText = formatPrice(cursorPrice);
    const tw = ctx.measureText(priceText).width;
    const boxW = tw + LABEL_PADDING_X * 2;
    const boxH = 18;
    const boxX = chartW + 2;
    const boxY = cursorY - boxH / 2;

    ctx.fillStyle = LABEL_BG;
    fillRoundedRect(ctx, boxX, boxY, boxW, boxH, LABEL_RADIUS);
    ctx.fillStyle = LABEL_TEXT;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(priceText, boxX + LABEL_PADDING_X, cursorY);
  }

  // ── Time label on bottom axis ─────────────────────────────────────────────
  if (cursorX >= 0 && cursorX <= chartW) {
    const timeText = formatTimestamp(cursorTime);
    const tw = ctx.measureText(timeText).width;
    const boxW = tw + LABEL_PADDING_X * 2;
    const boxH = 18;
    const boxX = cursorX - boxW / 2;
    const boxY = chartH + 4;

    ctx.fillStyle = LABEL_BG;
    fillRoundedRect(ctx, boxX, boxY, boxW, boxH, LABEL_RADIUS);
    ctx.fillStyle = LABEL_TEXT;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(timeText, cursorX, boxY + boxH / 2);
  }

  // ── OHLCV info panel (top-left) ──────────────────────────────────────────
  const displayCandle: Candle | null = hoveredCandle
    ?? state.liveCandle
    ?? (state.candles.length > 0 ? state.candles[state.candles.length - 1] ?? null : null);

  if (displayCandle) {
    const bull = displayCandle.close >= displayCandle.open;
    const dirColor = bull ? BULL_COLOR : BEAR_COLOR;

    const panelX = 8;
    const panelY = 14;
    let drawX = panelX;

    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';

    const segments: { label: string; value: string }[] = [
      { label: 'O: ', value: formatPrice(displayCandle.open) },
      { label: '  H: ', value: formatPrice(displayCandle.high) },
      { label: '  L: ', value: formatPrice(displayCandle.low) },
      { label: '  C: ', value: formatPrice(displayCandle.close) },
      { label: '  Vol: ', value: formatNumber(displayCandle.volume) },
    ];

    for (const seg of segments) {
      // Label
      ctx.fillStyle = OHLCV_LABEL_COLOR;
      ctx.fillText(seg.label, drawX, panelY);
      drawX += ctx.measureText(seg.label).width;

      // Value coloured by direction (except volume)
      ctx.fillStyle = seg.label.includes('Vol') ? LABEL_TEXT : dirColor;
      ctx.fillText(seg.value, drawX, panelY);
      drawX += ctx.measureText(seg.value).width;
    }

    // ── Footprint data at cursor price level ────────────────────────────────
    if (hoveredCandle && state.footprintData.size > 0) {
      const fp: FootprintCandle | undefined = state.footprintData.get(hoveredCandle.timestamp);
      if (fp) {
        // Find the level closest to cursor price
        let closestLevel = fp.levels[0] ?? null;
        let closestDist = Infinity;
        for (const lvl of fp.levels) {
          const d = Math.abs(lvl.price - cursorPrice);
          if (d < closestDist) {
            closestDist = d;
            closestLevel = lvl;
          }
        }

        if (closestLevel) {
          drawX += 12;
          const fpSegments = [
            { label: '  Buy: ', value: formatNumber(closestLevel.askVolume), color: BULL_COLOR },
            { label: '  Sell: ', value: formatNumber(closestLevel.bidVolume), color: BEAR_COLOR },
            { label: '  Δ: ', value: formatNumber(closestLevel.delta), color: closestLevel.delta >= 0 ? BULL_COLOR : BEAR_COLOR },
          ];

          for (const seg of fpSegments) {
            ctx.fillStyle = OHLCV_LABEL_COLOR;
            ctx.fillText(seg.label, drawX, panelY);
            drawX += ctx.measureText(seg.label).width;

            ctx.fillStyle = seg.color;
            ctx.fillText(seg.value, drawX, panelY);
            drawX += ctx.measureText(seg.value).width;
          }
        }
      }
    }
  }

  ctx.restore();
}
