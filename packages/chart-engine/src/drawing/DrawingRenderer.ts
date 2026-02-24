/**
 * DrawingRenderer.ts
 * Renders all user drawings on Layer 3 of the Pinned chart engine.
 *
 * Exported entry point: renderDrawings(ctx, viewport, state)
 */

import type { ChartStateData, Drawing, Candle } from '../core/ChartState';
import type { Viewport } from '../core/Viewport';

// ─── Constants ─────────────────────────────────────────────────────────────────

const HANDLE_RADIUS = 5;
const HANDLE_FILL = '#ffffff';
const HANDLE_STROKE = '#6366f1';
const HANDLE_GLOW = 'rgba(99, 102, 241, 0.4)';
const LABEL_FONT = '11px "Inter", sans-serif';
const LABEL_PAD_X = 6;
const LABEL_PAD_Y = 3;

/** Cross-browser rounded rect path (polyfill for ctx.roundRect). */
function fillRoundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  r = Math.min(r, w / 2, h / 2);
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

const FIB_COLORS = [
  'rgba(244, 67, 54, 0.08)',
  'rgba(255, 152, 0, 0.08)',
  'rgba(255, 235, 59, 0.08)',
  'rgba(76, 175, 80, 0.08)',
  'rgba(33, 150, 243, 0.08)',
  'rgba(156, 39, 176, 0.08)',
];

// ─── Dash Patterns ─────────────────────────────────────────────────────────────

function setLineDash(
  ctx: CanvasRenderingContext2D,
  style: string | undefined,
): void {
  switch (style) {
    case 'dashed':
      ctx.setLineDash([6, 4]);
      break;
    case 'dotted':
      ctx.setLineDash([2, 3]);
      break;
    default:
      ctx.setLineDash([]);
  }
}

// ─── Handle Drawing ────────────────────────────────────────────────────────────

function drawHandle(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
): void {
  // Outer glow
  ctx.beginPath();
  ctx.arc(x, y, HANDLE_RADIUS + 3, 0, Math.PI * 2);
  ctx.fillStyle = HANDLE_GLOW;
  ctx.fill();

  // White fill circle
  ctx.beginPath();
  ctx.arc(x, y, HANDLE_RADIUS, 0, Math.PI * 2);
  ctx.fillStyle = HANDLE_FILL;
  ctx.fill();
  ctx.strokeStyle = HANDLE_STROKE;
  ctx.lineWidth = 2;
  ctx.stroke();
}

// ─── Price Label ───────────────────────────────────────────────────────────────

function drawPriceLabel(
  ctx: CanvasRenderingContext2D,
  price: number,
  y: number,
  color: string,
  width: number,
): void {
  const text = price.toFixed(2);
  ctx.font = LABEL_FONT;
  const tw = ctx.measureText(text).width;
  const boxW = tw + LABEL_PAD_X * 2;
  const boxH = 16;
  const x = width - boxW;

  ctx.fillStyle = color;
  ctx.fillRect(x, y - boxH / 2, boxW, boxH);

  ctx.fillStyle = '#ffffff';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.fillText(text, x + LABEL_PAD_X, y);
}

// ─── Per-Type Renderers ────────────────────────────────────────────────────────

function renderHorizontalLine(
  ctx: CanvasRenderingContext2D,
  drawing: Drawing,
  viewport: Viewport,
): void {
  if (drawing.points.length < 1) return;

  const { width } = viewport.getLogicalSize();
  const y = viewport.priceToY(drawing.points[0].price);
  const color = drawing.properties.color ?? '#2196F3';
  const lw = drawing.properties.lineWidth ?? 1;
  const isHovered = (drawing as any)._hovered;

  // Hover glow
  if (isHovered && !drawing.selected) {
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = lw + 6;
    ctx.globalAlpha = 0.18;
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
    ctx.restore();
  }

  ctx.strokeStyle = color;
  ctx.lineWidth = isHovered ? lw + 1 : lw;
  setLineDash(ctx, drawing.properties.lineStyle);
  ctx.beginPath();
  ctx.moveTo(0, y);
  ctx.lineTo(width, y);
  ctx.stroke();
  ctx.setLineDash([]);

  // Price label on right axis.
  drawPriceLabel(ctx, drawing.points[0].price, y, color, width);

  // Selection handle.
  if (drawing.selected) {
    drawHandle(ctx, width / 2, y);
  }
}

function renderTrendLine(
  ctx: CanvasRenderingContext2D,
  drawing: Drawing,
  viewport: Viewport,
): void {
  if (drawing.points.length < 2) return;

  const x1 = viewport.timeToX(drawing.points[0].time);
  const y1 = viewport.priceToY(drawing.points[0].price);
  const x2 = viewport.timeToX(drawing.points[1].time);
  const y2 = viewport.priceToY(drawing.points[1].price);

  const color = drawing.properties.color ?? '#2196F3';
  const lw = drawing.properties.lineWidth ?? 2;
  const isHovered = (drawing as any)._hovered;

  // Hover glow — thicker semi-transparent underline
  if (isHovered && !drawing.selected) {
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = lw + 6;
    ctx.globalAlpha = 0.18;
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
    ctx.restore();
  }

  ctx.strokeStyle = color;
  ctx.lineWidth = isHovered ? lw + 1 : lw;
  setLineDash(ctx, drawing.properties.lineStyle);

  ctx.beginPath();

  if (drawing.properties.extendRight || drawing.properties.extendLeft) {
    // Extend as a ray/infinite line by projecting far beyond visible area.
    const { width } = viewport.getLogicalSize();
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len;
    const uy = dy / len;
    const ext = width * 4; // generous extension

    const sx = drawing.properties.extendLeft ? x1 - ux * ext : x1;
    const sy = drawing.properties.extendLeft ? y1 - uy * ext : y1;
    const ex = drawing.properties.extendRight ? x2 + ux * ext : x2;
    const ey = drawing.properties.extendRight ? y2 + uy * ext : y2;

    ctx.moveTo(sx, sy);
    ctx.lineTo(ex, ey);
  } else {
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
  }

  ctx.stroke();
  ctx.setLineDash([]);

  // Angle label near midpoint (when selected).
  if (drawing.selected) {
    const mx = (x1 + x2) / 2;
    const my = (y1 + y2) / 2;
    const angle = (Math.atan2(y1 - y2, x2 - x1) * 180) / Math.PI;
    ctx.font = LABEL_FONT;
    ctx.fillStyle = color;
    ctx.textBaseline = 'bottom';
    ctx.textAlign = 'center';
    ctx.fillText(`${angle.toFixed(1)}°`, mx, my - 6);

    drawHandle(ctx, x1, y1);
    drawHandle(ctx, x2, y2);
    // Midpoint handle for dragging the whole line (TradingView-style)
    drawHandle(ctx, mx, my);
  }
}

function renderRectangle(
  ctx: CanvasRenderingContext2D,
  drawing: Drawing,
  viewport: Viewport,
): void {
  if (drawing.points.length < 2) return;

  const x1 = viewport.timeToX(drawing.points[0].time);
  const y1 = viewport.priceToY(drawing.points[0].price);
  const x2 = viewport.timeToX(drawing.points[1].time);
  const y2 = viewport.priceToY(drawing.points[1].price);

  const minX = Math.min(x1, x2);
  const minY = Math.min(y1, y2);
  const w = Math.abs(x2 - x1);
  const h = Math.abs(y2 - y1);

  const fillColor = drawing.properties.fillColor ?? '#2196F3';
  const fillOpacity = drawing.properties.fillOpacity ?? 0.15;
  const borderColor = drawing.properties.color ?? '#2196F3';
  const lw = drawing.properties.lineWidth ?? 1;

  // Fill.
  ctx.save();
  ctx.globalAlpha = fillOpacity;
  ctx.fillStyle = fillColor;
  ctx.fillRect(minX, minY, w, h);
  ctx.restore();

  // Border.
  ctx.strokeStyle = borderColor;
  ctx.lineWidth = lw;
  setLineDash(ctx, drawing.properties.lineStyle);
  ctx.strokeRect(minX, minY, w, h);
  ctx.setLineDash([]);

  // Selection handles: 4 corners + 4 midpoints.
  if (drawing.selected) {
    const maxX = Math.max(x1, x2);
    const maxY = Math.max(y1, y2);
    const midX = (minX + maxX) / 2;
    const midY = (minY + maxY) / 2;

    const pts = [
      [minX, minY],
      [maxX, minY],
      [maxX, maxY],
      [minX, maxY],
      [midX, minY],
      [maxX, midY],
      [midX, maxY],
      [minX, midY],
    ];
    for (const [hx, hy] of pts) {
      drawHandle(ctx, hx, hy);
    }
  }
}

function renderFibonacci(
  ctx: CanvasRenderingContext2D,
  drawing: Drawing,
  viewport: Viewport,
): void {
  if (drawing.points.length < 2) return;

  const { width } = viewport.getLogicalSize();
  const price0 = drawing.points[0].price;
  const price1 = drawing.points[1].price;
  const priceDiff = price1 - price0;

  const defaultLevels = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
  const extensionLevels = [1.272, 1.618, 2.618];
  const levels: number[] = (drawing.properties.levels as number[]) ?? [
    ...defaultLevels,
    ...extensionLevels,
  ];

  const color = drawing.properties.color ?? '#2196F3';
  const lw = drawing.properties.lineWidth ?? 1;

  // Draw fills between adjacent levels.
  for (let i = 0; i < levels.length - 1; i++) {
    const yA = viewport.priceToY(price0 + priceDiff * levels[i]);
    const yB = viewport.priceToY(price0 + priceDiff * levels[i + 1]);
    ctx.fillStyle = FIB_COLORS[i % FIB_COLORS.length];
    ctx.fillRect(0, Math.min(yA, yB), width, Math.abs(yB - yA));
  }

  // Draw level lines + labels.
  ctx.font = LABEL_FONT;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'right';

  for (const lvl of levels) {
    const levelPrice = price0 + priceDiff * lvl;
    const y = viewport.priceToY(levelPrice);

    ctx.strokeStyle = color;
    ctx.lineWidth = lw;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();

    // Label: percentage + price.
    const pct = (lvl * 100).toFixed(1);
    const label = `${pct}%  ${levelPrice.toFixed(2)}`;
    ctx.fillStyle = color;
    ctx.fillText(label, width - 6, y - 2);
  }

  ctx.setLineDash([]);

  // Endpoint handles when selected.
  if (drawing.selected) {
    const y0 = viewport.priceToY(price0);
    const y1 = viewport.priceToY(price1);
    const x0 = viewport.timeToX(drawing.points[0].time);
    const x1 = viewport.timeToX(drawing.points[1].time);
    drawHandle(ctx, x0, y0);
    drawHandle(ctx, x1, y1);
  }
}

function renderVerticalLine(
  ctx: CanvasRenderingContext2D,
  drawing: Drawing,
  viewport: Viewport,
): void {
  if (drawing.points.length < 1) return;

  const { height } = viewport.getLogicalSize();
  const x = viewport.timeToX(drawing.points[0].time);
  const color = drawing.properties.color ?? '#2196F3';
  const lw = drawing.properties.lineWidth ?? 1;

  ctx.strokeStyle = color;
  ctx.lineWidth = lw;
  setLineDash(ctx, drawing.properties.lineStyle);

  ctx.beginPath();
  ctx.moveTo(x, 0);
  ctx.lineTo(x, height);
  ctx.stroke();
  ctx.setLineDash([]);

  // Time label at bottom
  const date = new Date(drawing.points[0].time);
  const label = `${date.getMonth() + 1}/${date.getDate()} ${date.getHours()}:${String(date.getMinutes()).padStart(2, '0')}`;
  ctx.font = LABEL_FONT;
  const tw = ctx.measureText(label).width;
  ctx.fillStyle = color;
  ctx.fillRect(x - tw / 2 - LABEL_PAD_X, height - 18, tw + LABEL_PAD_X * 2, 16);
  ctx.fillStyle = '#ffffff';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  ctx.fillText(label, x, height - 10);

  if (drawing.selected) {
    drawHandle(ctx, x, height / 2);
  }
}

function renderEllipse(
  ctx: CanvasRenderingContext2D,
  drawing: Drawing,
  viewport: Viewport,
): void {
  if (drawing.points.length < 2) return;

  const x1 = viewport.timeToX(drawing.points[0].time);
  const y1 = viewport.priceToY(drawing.points[0].price);
  const x2 = viewport.timeToX(drawing.points[1].time);
  const y2 = viewport.priceToY(drawing.points[1].price);

  const cx = (x1 + x2) / 2;
  const cy = (y1 + y2) / 2;
  const rx = Math.abs(x2 - x1) / 2;
  const ry = Math.abs(y2 - y1) / 2;

  const fillColor = drawing.properties.fillColor ?? '#2196F3';
  const fillOpacity = drawing.properties.fillOpacity ?? 0.15;
  const borderColor = drawing.properties.color ?? '#2196F3';
  const lw = drawing.properties.lineWidth ?? 1;

  // Fill
  ctx.save();
  ctx.globalAlpha = fillOpacity;
  ctx.fillStyle = fillColor;
  ctx.beginPath();
  ctx.ellipse(cx, cy, Math.max(rx, 1), Math.max(ry, 1), 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // Border
  ctx.strokeStyle = borderColor;
  ctx.lineWidth = lw;
  setLineDash(ctx, drawing.properties.lineStyle);
  ctx.beginPath();
  ctx.ellipse(cx, cy, Math.max(rx, 1), Math.max(ry, 1), 0, 0, Math.PI * 2);
  ctx.stroke();
  ctx.setLineDash([]);

  if (drawing.selected) {
    drawHandle(ctx, x1, y1);
    drawHandle(ctx, x2, y2);
    drawHandle(ctx, cx - rx, cy);
    drawHandle(ctx, cx + rx, cy);
    drawHandle(ctx, cx, cy - ry);
    drawHandle(ctx, cx, cy + ry);
  }
}

function renderParallelChannel(
  ctx: CanvasRenderingContext2D,
  drawing: Drawing,
  viewport: Viewport,
): void {
  // 3 points: p0 & p1 define the base line, p2 defines the channel width
  if (drawing.points.length < 2) return;

  const x0 = viewport.timeToX(drawing.points[0].time);
  const y0 = viewport.priceToY(drawing.points[0].price);
  const x1 = viewport.timeToX(drawing.points[1].time);
  const y1 = viewport.priceToY(drawing.points[1].price);

  const color = drawing.properties.color ?? '#2196F3';
  const fillColor = drawing.properties.fillColor ?? '#2196F3';
  const fillOpacity = drawing.properties.fillOpacity ?? 0.08;
  const lw = drawing.properties.lineWidth ?? 1;

  // Channel offset (from point 3, or default)
  let offsetY = 50; // default pixel offset
  if (drawing.points.length >= 3) {
    const y2 = viewport.priceToY(drawing.points[2].price);
    offsetY = y2 - y0;
  }

  // Base line
  ctx.strokeStyle = color;
  ctx.lineWidth = lw;
  setLineDash(ctx, drawing.properties.lineStyle);

  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.stroke();

  // Parallel line
  ctx.beginPath();
  ctx.moveTo(x0, y0 + offsetY);
  ctx.lineTo(x1, y1 + offsetY);
  ctx.stroke();

  // Middle line (dashed)
  ctx.setLineDash([4, 4]);
  ctx.globalAlpha = 0.5;
  ctx.beginPath();
  ctx.moveTo(x0, y0 + offsetY / 2);
  ctx.lineTo(x1, y1 + offsetY / 2);
  ctx.stroke();
  ctx.globalAlpha = 1;
  ctx.setLineDash([]);

  // Fill between
  ctx.save();
  ctx.globalAlpha = fillOpacity;
  ctx.fillStyle = fillColor;
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.lineTo(x1, y1 + offsetY);
  ctx.lineTo(x0, y0 + offsetY);
  ctx.closePath();
  ctx.fill();
  ctx.restore();

  if (drawing.selected) {
    drawHandle(ctx, x0, y0);
    drawHandle(ctx, x1, y1);
    drawHandle(ctx, (x0 + x1) / 2, (y0 + y1) / 2 + offsetY);
  }
}

function renderText(
  ctx: CanvasRenderingContext2D,
  drawing: Drawing,
  viewport: Viewport,
): void {
  if (drawing.points.length < 1) return;

  const x = viewport.timeToX(drawing.points[0].time);
  const y = viewport.priceToY(drawing.points[0].price);
  const text = (drawing.properties as any).text ?? 'Text';
  const fontSize = (drawing.properties as any).fontSize ?? 14;
  const color = drawing.properties.color ?? '#E0E0E0';

  ctx.font = `${fontSize}px "Inter", sans-serif`;
  ctx.fillStyle = color;
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';

  // Background box
  const metrics = ctx.measureText(text);
  const textH = fontSize * 1.3;
  const pad = 6;

  if (drawing.selected) {
    ctx.save();
    ctx.fillStyle = 'rgba(99, 102, 241, 0.1)';
    ctx.strokeStyle = 'rgba(99, 102, 241, 0.4)';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.fillRect(x - pad, y - pad, metrics.width + pad * 2, textH + pad * 2);
    ctx.strokeRect(x - pad, y - pad, metrics.width + pad * 2, textH + pad * 2);
    ctx.setLineDash([]);
    ctx.restore();
  }

  ctx.fillStyle = color;
  ctx.fillText(text, x, y);

  if (drawing.selected) {
    drawHandle(ctx, x - pad, y - pad);
    drawHandle(ctx, x + metrics.width + pad, y + textH + pad);
  }
}

function renderPriceRange(
  ctx: CanvasRenderingContext2D,
  drawing: Drawing,
  viewport: Viewport,
): void {
  if (drawing.points.length < 2) return;

  const x1 = viewport.timeToX(drawing.points[0].time);
  const y1 = viewport.priceToY(drawing.points[0].price);
  const x2 = viewport.timeToX(drawing.points[1].time);
  const y2 = viewport.priceToY(drawing.points[1].price);

  const minX = Math.min(x1, x2);
  const minY = Math.min(y1, y2);
  const w = Math.abs(x2 - x1);
  const h = Math.abs(y2 - y1);

  const priceDelta = drawing.points[1].price - drawing.points[0].price;
  const pctChange = drawing.points[0].price !== 0
    ? (priceDelta / drawing.points[0].price) * 100
    : 0;
  const isPositive = priceDelta >= 0;

  const fillColor = isPositive ? '#4CAF50' : '#F44336';
  const borderColor = isPositive ? '#4CAF50' : '#F44336';

  // Fill
  ctx.save();
  ctx.globalAlpha = 0.1;
  ctx.fillStyle = fillColor;
  ctx.fillRect(minX, minY, w, h);
  ctx.restore();

  // Border
  ctx.strokeStyle = borderColor;
  ctx.lineWidth = 1;
  ctx.strokeRect(minX, minY, w, h);

  // Price delta label
  const label = `${isPositive ? '+' : ''}${priceDelta.toFixed(2)} (${isPositive ? '+' : ''}${pctChange.toFixed(2)}%)`;
  ctx.font = '12px "Inter", sans-serif';
  ctx.fillStyle = borderColor;
  ctx.textBaseline = 'bottom';
  ctx.textAlign = 'center';
  const cx = minX + w / 2;
  const labelY = minY - 4;

  // Label background
  const tw = ctx.measureText(label).width;
  ctx.fillStyle = borderColor;
  ctx.fillRect(cx - tw / 2 - 6, labelY - 16, tw + 12, 18);
  ctx.fillStyle = '#ffffff';
  ctx.fillText(label, cx, labelY);

  if (drawing.selected) {
    drawHandle(ctx, x1, y1);
    drawHandle(ctx, x2, y2);
  }
}

function renderDateRange(
  ctx: CanvasRenderingContext2D,
  drawing: Drawing,
  viewport: Viewport,
): void {
  if (drawing.points.length < 2) return;

  const x1 = viewport.timeToX(drawing.points[0].time);
  const y1 = viewport.priceToY(drawing.points[0].price);
  const x2 = viewport.timeToX(drawing.points[1].time);
  const y2 = viewport.priceToY(drawing.points[1].price);
  const { height } = viewport.getLogicalSize();

  const minX = Math.min(x1, x2);
  const w = Math.abs(x2 - x1);
  const color = drawing.properties.color ?? '#9C27B0';

  // Shaded column across full height
  ctx.save();
  ctx.globalAlpha = 0.06;
  ctx.fillStyle = color;
  ctx.fillRect(minX, 0, w, height);
  ctx.restore();

  // Left/right border lines
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(x1, 0); ctx.lineTo(x1, height);
  ctx.moveTo(x2, 0); ctx.lineTo(x2, height);
  ctx.stroke();
  ctx.setLineDash([]);

  // Time delta label
  const timeDelta = Math.abs(drawing.points[1].time - drawing.points[0].time);
  const hours = Math.floor(timeDelta / 3600000);
  const mins = Math.floor((timeDelta % 3600000) / 60000);
  const bars = Math.round(timeDelta / 60000); // 1m candles approx
  const label = hours > 0 ? `${hours}h ${mins}m (${bars} bars)` : `${mins}m (${bars} bars)`;

  ctx.font = '12px "Inter", sans-serif';
  const tw = ctx.measureText(label).width;
  const cx = minX + w / 2;

  ctx.fillStyle = color;
  ctx.fillRect(cx - tw / 2 - 6, 8, tw + 12, 20);
  ctx.fillStyle = '#ffffff';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  ctx.fillText(label, cx, 18);

  if (drawing.selected) {
    drawHandle(ctx, x1, height / 2);
    drawHandle(ctx, x2, height / 2);
  }
}

function renderMeasure(
  ctx: CanvasRenderingContext2D,
  drawing: Drawing,
  viewport: Viewport,
): void {
  if (drawing.points.length < 2) return;

  const x1 = viewport.timeToX(drawing.points[0].time);
  const y1 = viewport.priceToY(drawing.points[0].price);
  const x2 = viewport.timeToX(drawing.points[1].time);
  const y2 = viewport.priceToY(drawing.points[1].price);

  const minX = Math.min(x1, x2);
  const minY = Math.min(y1, y2);
  const w = Math.abs(x2 - x1);
  const h = Math.abs(y2 - y1);

  const priceDelta = drawing.points[1].price - drawing.points[0].price;
  const pctChange = drawing.points[0].price !== 0
    ? (priceDelta / drawing.points[0].price) * 100
    : 0;
  const timeDelta = Math.abs(drawing.points[1].time - drawing.points[0].time);
  const isPositive = priceDelta >= 0;
  const fillColor = isPositive ? '#4CAF50' : '#F44336';

  // Fill
  ctx.save();
  ctx.globalAlpha = 0.08;
  ctx.fillStyle = fillColor;
  ctx.fillRect(minX, minY, w, h);
  ctx.restore();

  // Border
  ctx.strokeStyle = fillColor;
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 3]);
  ctx.strokeRect(minX, minY, w, h);
  ctx.setLineDash([]);

  // Diagonal line
  ctx.strokeStyle = fillColor;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();

  // Measurement info box
  const hours = Math.floor(timeDelta / 3600000);
  const mins = Math.floor((timeDelta % 3600000) / 60000);
  const timeStr = hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;
  const line1 = `${isPositive ? '+' : ''}${priceDelta.toFixed(2)} (${isPositive ? '+' : ''}${pctChange.toFixed(2)}%)`;
  const line2 = timeStr;

  ctx.font = '11px "Inter", sans-serif';
  const tw1 = ctx.measureText(line1).width;
  const tw2 = ctx.measureText(line2).width;
  const boxW = Math.max(tw1, tw2) + 16;
  const boxH = 36;
  const boxX = x2 + 8;
  const boxY = y2 - boxH / 2;

  // Info box background
  ctx.fillStyle = 'rgba(30, 33, 40, 0.95)';
  ctx.strokeStyle = fillColor;
  ctx.lineWidth = 1;
  ctx.beginPath();
  fillRoundedRect(ctx, boxX, boxY, boxW, boxH, 4);
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = fillColor;
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';
  ctx.fillText(line1, boxX + 8, boxY + 4);
  ctx.fillStyle = '#9E9E9E';
  ctx.fillText(line2, boxX + 8, boxY + 18);

  if (drawing.selected) {
    drawHandle(ctx, x1, y1);
    drawHandle(ctx, x2, y2);
  }
}

function renderAnchoredVwap(
  ctx: CanvasRenderingContext2D,
  drawing: Drawing,
  viewport: Viewport,
  candles: readonly Candle[],
): void {
  if (drawing.points.length < 1 || candles.length === 0) return;

  const anchorTime = drawing.points[0].time;
  const color = drawing.properties.color ?? '#FF9800';
  const lw = drawing.properties.lineWidth ?? 1;
  const { width } = viewport.getLogicalSize();

  // Compute VWAP from anchor candle onwards.
  let cumVolume = 0;
  let cumVwap = 0;
  const vwapPoints: { x: number; y: number }[] = [];

  for (const c of candles) {
    if (c.timestamp < anchorTime) continue;
    const tp = (c.high + c.low + c.close) / 3; // typical price
    cumVolume += c.volume;
    cumVwap += tp * c.volume;
    if (cumVolume === 0) continue;

    const vwapValue = cumVwap / cumVolume;
    vwapPoints.push({
      x: viewport.timeToX(c.timestamp),
      y: viewport.priceToY(vwapValue),
    });
  }

  if (vwapPoints.length === 0) return;

  // Draw VWAP line.
  ctx.strokeStyle = color;
  ctx.lineWidth = lw;
  ctx.setLineDash([6, 4]);
  ctx.beginPath();
  ctx.moveTo(vwapPoints[0].x, vwapPoints[0].y);
  for (let i = 1; i < vwapPoints.length; i++) {
    ctx.lineTo(vwapPoints[i].x, vwapPoints[i].y);
  }
  ctx.stroke();
  ctx.setLineDash([]);

  // Label at right edge with current VWAP value.
  const last = vwapPoints[vwapPoints.length - 1];
  if (cumVolume > 0) {
    const currentVwap = cumVwap / cumVolume;
    drawPriceLabel(ctx, currentVwap, last.y, color, width);
  }

  // Anchor handle.
  if (drawing.selected) {
    drawHandle(ctx, vwapPoints[0].x, vwapPoints[0].y);
  }
}

// ─── Preview (In-Progress) Drawing ─────────────────────────────────────────────

function renderPreview(
  ctx: CanvasRenderingContext2D,
  drawing: Drawing,
  viewport: Viewport,
  candles: readonly Candle[],
): void {
  ctx.save();
  ctx.globalAlpha = 0.7;

  const preview = { ...drawing, selected: false };

  // Draw the first anchor point as a visible dot even with only 1 point
  if (drawing.points.length >= 1) {
    const ax = viewport.timeToX(drawing.points[0].time);
    const ay = viewport.priceToY(drawing.points[0].price);
    ctx.beginPath();
    ctx.arc(ax, ay, 4, 0, Math.PI * 2);
    ctx.fillStyle = drawing.properties.color ?? '#2196F3';
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  switch (drawing.type) {
    case 'horizontal_line':
      renderHorizontalLine(ctx, preview, viewport);
      break;
    case 'vertical_line':
      renderVerticalLine(ctx, preview, viewport);
      break;
    case 'trendline':
    case 'ray':
    case 'extended_line':
      renderTrendLine(ctx, preview, viewport);
      break;
    case 'parallel_channel':
      renderParallelChannel(ctx, preview, viewport);
      break;
    case 'rectangle':
      renderRectangle(ctx, preview, viewport);
      break;
    case 'ellipse':
      renderEllipse(ctx, preview, viewport);
      break;
    case 'fibonacci_retracement':
    case 'fibonacci_extension':
      renderFibonacci(ctx, preview, viewport);
      break;
    case 'text':
      renderText(ctx, preview, viewport);
      break;
    case 'price_range':
      renderPriceRange(ctx, preview, viewport);
      break;
    case 'date_range':
      renderDateRange(ctx, preview, viewport);
      break;
    case 'measure':
      renderMeasure(ctx, preview, viewport);
      break;
    case 'anchored_vwap':
      renderAnchoredVwap(ctx, preview, viewport, candles);
      break;
    default:
      break;
  }

  ctx.restore();
}

// ─── Dispatch ──────────────────────────────────────────────────────────────────

function renderSingleDrawing(
  ctx: CanvasRenderingContext2D,
  drawing: Drawing,
  viewport: Viewport,
  candles: readonly Candle[],
): void {
  if (!drawing.visible) return;

  switch (drawing.type) {
    case 'horizontal_line':
      renderHorizontalLine(ctx, drawing, viewport);
      break;
    case 'vertical_line':
      renderVerticalLine(ctx, drawing, viewport);
      break;
    case 'trendline':
    case 'ray':
    case 'extended_line':
      renderTrendLine(ctx, drawing, viewport);
      break;
    case 'parallel_channel':
      renderParallelChannel(ctx, drawing, viewport);
      break;
    case 'rectangle':
      renderRectangle(ctx, drawing, viewport);
      break;
    case 'ellipse':
      renderEllipse(ctx, drawing, viewport);
      break;
    case 'fibonacci_retracement':
    case 'fibonacci_extension':
      renderFibonacci(ctx, drawing, viewport);
      break;
    case 'text':
      renderText(ctx, drawing, viewport);
      break;
    case 'price_range':
      renderPriceRange(ctx, drawing, viewport);
      break;
    case 'date_range':
      renderDateRange(ctx, drawing, viewport);
      break;
    case 'measure':
      renderMeasure(ctx, drawing, viewport);
      break;
    case 'anchored_vwap':
      renderAnchoredVwap(ctx, drawing, viewport, candles);
      break;
    default:
      break;
  }
}

// ─── Public Entry Point ────────────────────────────────────────────────────────

/**
 * Render all active drawings (and any in-progress preview) onto a canvas
 * context. Intended for Layer 3 of the render pipeline.
 *
 * @param ctx      The 2D canvas rendering context.
 * @param viewport The current Viewport (for coordinate transforms).
 * @param state    A snapshot of the chart state data.
 * @param pendingDrawing Optional in-progress drawing to preview at 50 % opacity.
 */
export function renderDrawings(
  ctx: CanvasRenderingContext2D,
  viewport: Viewport,
  state: Readonly<ChartStateData>,
  pendingDrawing?: Drawing | null,
): void {
  const candles = state.candles;

  // Committed drawings.
  for (const drawing of state.activeDrawings) {
    renderSingleDrawing(ctx, drawing, viewport, candles);
  }

  // In-progress preview.
  if (pendingDrawing && pendingDrawing.points.length > 0) {
    renderPreview(ctx, pendingDrawing, viewport, candles);
  }
}
