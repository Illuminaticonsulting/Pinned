/**
 * DrawingRenderer.ts
 * Renders all user drawings on Layer 3 of the Pinned chart engine.
 *
 * Exported entry point: renderDrawings(ctx, viewport, state)
 */

import type { ChartStateData, Drawing, Candle } from '../core/ChartState';
import type { Viewport } from '../core/Viewport';

// ─── Constants ─────────────────────────────────────────────────────────────────

const HANDLE_RADIUS = 4;
const HANDLE_FILL = '#ffffff';
const HANDLE_STROKE = '#2196F3';
const LABEL_FONT = '11px "Inter", sans-serif';
const LABEL_PAD_X = 4;
const LABEL_PAD_Y = 2;

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
  ctx.beginPath();
  ctx.arc(x, y, HANDLE_RADIUS, 0, Math.PI * 2);
  ctx.fillStyle = HANDLE_FILL;
  ctx.fill();
  ctx.strokeStyle = HANDLE_STROKE;
  ctx.lineWidth = 1.5;
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

  ctx.strokeStyle = color;
  ctx.lineWidth = lw;
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
  const lw = drawing.properties.lineWidth ?? 1;

  ctx.strokeStyle = color;
  ctx.lineWidth = lw;
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

function renderAnchoredVwap(
  ctx: CanvasRenderingContext2D,
  drawing: Drawing,
  viewport: Viewport,
  candles: readonly import('../core/ChartState').Candle[],
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
  candles: readonly import('../core/ChartState').Candle[],
): void {
  ctx.save();
  ctx.globalAlpha = 0.5;

  switch (drawing.type) {
    case 'horizontal_line':
      renderHorizontalLine(ctx, { ...drawing, selected: false }, viewport);
      break;
    case 'trendline':
    case 'ray':
    case 'extended_line':
      renderTrendLine(ctx, { ...drawing, selected: false }, viewport);
      break;
    case 'rectangle':
    case 'price_range':
    case 'date_range':
      renderRectangle(ctx, { ...drawing, selected: false }, viewport);
      break;
    case 'fibonacci_retracement':
    case 'fibonacci_extension':
      renderFibonacci(ctx, { ...drawing, selected: false }, viewport);
      break;
    case 'measure':
      renderAnchoredVwap(ctx, { ...drawing, selected: false }, viewport, candles);
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
  candles: readonly import('../core/ChartState').Candle[],
): void {
  if (!drawing.visible) return;

  switch (drawing.type) {
    case 'horizontal_line':
      renderHorizontalLine(ctx, drawing, viewport);
      break;
    case 'trendline':
    case 'ray':
    case 'extended_line':
      renderTrendLine(ctx, drawing, viewport);
      break;
    case 'rectangle':
    case 'price_range':
    case 'date_range':
      renderRectangle(ctx, drawing, viewport);
      break;
    case 'fibonacci_retracement':
    case 'fibonacci_extension':
      renderFibonacci(ctx, drawing, viewport);
      break;
    case 'measure':
      // Anchored VWAP stored under the 'measure' type alias.
      renderAnchoredVwap(ctx, drawing, viewport, candles);
      break;
    default:
      // Unsupported type – skip.
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
