/**
 * VolumeProfileRenderer.ts
 * Renders horizontal volume-at-price histogram and POC / Value Area lines on Layer 2.
 */

import type { Viewport } from '../core/Viewport';
import type { ChartStateData, VolumeProfile } from '../core/ChartState';

// ─── Constants ─────────────────────────────────────────────────────────────────

const BAR_MAX_WIDTH_RATIO = 0.30;
const BAR_ABOVE_POC_COLOR = 'rgba(34, 197, 94, 0.30)';
const BAR_BELOW_POC_COLOR = 'rgba(239, 68, 68, 0.30)';
const POC_COLOR = 'rgba(250, 204, 21, 0.70)';
const POC_LINE_COLOR = 'rgba(250, 204, 21, 0.35)';
const VAH_VAL_COLOR = 'rgba(147, 197, 253, 0.5)';
const VAH_VAL_LABEL_COLOR = '#93c5fd';
const LABEL_FONT = '10px JetBrains Mono, monospace';
const BUY_DELTA_COLOR = 'rgba(34, 197, 94, 0.45)';
const SELL_DELTA_COLOR = 'rgba(239, 68, 68, 0.45)';

const RIGHT_MARGIN = 80;
const BOTTOM_MARGIN = 28;
const POC_DASH = [6, 4];
const VA_DASH = [3, 3];

// ─── Renderer ──────────────────────────────────────────────────────────────────

/**
 * Draw volume-by-price histogram bars, POC, and Value Area boundaries.
 */
export function renderVolumeProfile(
  ctx: CanvasRenderingContext2D,
  viewport: Viewport,
  state: Readonly<ChartStateData>,
): void {
  const profile: VolumeProfile | null = state.volumeProfile;
  if (!profile || profile.rows.length === 0) return;

  const { width, height } = viewport.getLogicalSize();
  const chartW = width - RIGHT_MARGIN;
  const chartH = height - BOTTOM_MARGIN;
  const maxBarWidth = chartW * BAR_MAX_WIDTH_RATIO;

  // Find max volume (POC row) for scaling
  let maxVolume = 0;
  for (const row of profile.rows) {
    if (row.totalVolume > maxVolume) maxVolume = row.totalVolume;
  }
  if (maxVolume === 0) return;

  // Determine row height from price spacing between adjacent rows
  const sortedRows = [...profile.rows].sort((a, b) => b.price - a.price);
  let rowHeight: number;
  if (sortedRows.length > 1 && sortedRows[0] && sortedRows[1]) {
    const priceStep = Math.abs(sortedRows[0].price - sortedRows[1].price);
    const y0 = viewport.priceToY(sortedRows[0].price);
    const y1 = viewport.priceToY(sortedRows[0].price - priceStep);
    rowHeight = Math.max(Math.abs(y1 - y0), 1);
  } else {
    rowHeight = 4;
  }

  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, chartW, chartH);
  ctx.clip();

  // Check if delta colouring is useful (any row has buy/sell split)
  const hasDelta = profile.rows.some((r) => r.buyVolume > 0 || r.sellVolume > 0);

  // ── Volume bars ──────────────────────────────────────────────────────────
  for (const row of profile.rows) {
    const y = viewport.priceToY(row.price);
    const cellTop = y - rowHeight / 2;

    if (cellTop > chartH || cellTop + rowHeight < 0) continue;

    const barW = (row.totalVolume / maxVolume) * maxBarWidth;

    if (hasDelta && (row.buyVolume > 0 || row.sellVolume > 0)) {
      // ── Delta colouring mode: split bar into buy + sell portions ──────
      const buyW = row.totalVolume > 0
        ? (row.buyVolume / row.totalVolume) * barW
        : 0;
      const sellW = barW - buyW;

      // Draw from the right side of chart area leftwards
      const barX = chartW - barW;

      // Sell portion (left part)
      if (sellW > 0) {
        ctx.fillStyle = SELL_DELTA_COLOR;
        ctx.fillRect(barX, cellTop, sellW, rowHeight - 1);
      }

      // Buy portion (right part)
      if (buyW > 0) {
        ctx.fillStyle = BUY_DELTA_COLOR;
        ctx.fillRect(barX + sellW, cellTop, buyW, rowHeight - 1);
      }
    } else {
      // ── Simple colouring: above POC = green, below POC = red ─────────
      const barX = chartW - barW;
      ctx.fillStyle = row.price >= profile.poc ? BAR_ABOVE_POC_COLOR : BAR_BELOW_POC_COLOR;
      ctx.fillRect(barX, cellTop, barW, rowHeight - 1);
    }
  }

  // ── POC line + highlight ─────────────────────────────────────────────────
  const pocY = viewport.priceToY(profile.poc);
  if (pocY >= 0 && pocY <= chartH) {
    // Highlight the POC bar
    const pocRow = profile.rows.find((r) => r.price === profile.poc);
    if (pocRow) {
      const barW = (pocRow.totalVolume / maxVolume) * maxBarWidth;
      const barX = chartW - barW;
      ctx.fillStyle = POC_COLOR;
      ctx.fillRect(barX, pocY - rowHeight / 2, barW, rowHeight - 1);
    }

    // Dashed line across chart at POC
    ctx.strokeStyle = POC_LINE_COLOR;
    ctx.lineWidth = 1;
    ctx.setLineDash(POC_DASH);
    ctx.beginPath();
    ctx.moveTo(0, pocY);
    ctx.lineTo(chartW, pocY);
    ctx.stroke();

    // POC label
    ctx.setLineDash([]);
    ctx.fillStyle = POC_COLOR;
    ctx.font = LABEL_FONT;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillText('POC', chartW - maxBarWidth - 6, pocY);
  }

  // ── Value Area High line ─────────────────────────────────────────────────
  const vahY = viewport.priceToY(profile.valueAreaHigh);
  if (vahY >= 0 && vahY <= chartH) {
    ctx.strokeStyle = VAH_VAL_COLOR;
    ctx.lineWidth = 1;
    ctx.setLineDash(VA_DASH);
    ctx.beginPath();
    ctx.moveTo(0, vahY);
    ctx.lineTo(chartW, vahY);
    ctx.stroke();

    ctx.setLineDash([]);
    ctx.fillStyle = VAH_VAL_LABEL_COLOR;
    ctx.font = LABEL_FONT;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillText('VAH', chartW - maxBarWidth - 6, vahY);
  }

  // ── Value Area Low line ──────────────────────────────────────────────────
  const valY = viewport.priceToY(profile.valueAreaLow);
  if (valY >= 0 && valY <= chartH) {
    ctx.strokeStyle = VAH_VAL_COLOR;
    ctx.lineWidth = 1;
    ctx.setLineDash(VA_DASH);
    ctx.beginPath();
    ctx.moveTo(0, valY);
    ctx.lineTo(chartW, valY);
    ctx.stroke();

    ctx.setLineDash([]);
    ctx.fillStyle = VAH_VAL_LABEL_COLOR;
    ctx.font = LABEL_FONT;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillText('VAL', chartW - maxBarWidth - 6, valY);
  }

  ctx.restore();
}
