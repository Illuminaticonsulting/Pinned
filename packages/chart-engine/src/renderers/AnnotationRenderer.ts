/**
 * AnnotationRenderer.ts
 * Renders AI signal arrows, big trade markers, pattern event icons,
 * and liquidation cluster bands on Layer 4.
 */

import type { Viewport } from '../core/Viewport';
import type { ChartStateData } from '../core/ChartState';

// ─── Constants ─────────────────────────────────────────────────────────────────

const RIGHT_MARGIN = 80;
const BOTTOM_MARGIN = 28;

const BULL_COLOR = '#22c55e';
const BEAR_COLOR = '#ef4444';
const SNOWFLAKE_COLOR = '#67e8f9';

const SIGNAL_MIN_SIZE = 8;
const SIGNAL_MAX_SIZE = 20;
const TRADE_MIN_RADIUS = 6;
const TRADE_MAX_RADIUS = 24;

const LABEL_FONT = '10px JetBrains Mono, monospace';
const TOOLTIP_BG = 'rgba(30, 41, 59, 0.95)';
const TOOLTIP_BORDER = '#475569';
const TOOLTIP_TEXT = '#e2e8f0';
const TOOLTIP_FONT = '11px JetBrains Mono, monospace';
const TOOLTIP_PADDING = 8;
const TOOLTIP_RADIUS = 4;
const TOOLTIP_MAX_W = 280;

// ─── Annotation Data Types ─────────────────────────────────────────────────────

export interface AISignal {
  timestamp: number;
  price: number;
  direction: 'buy' | 'sell';
  confidence: number; // 0–1
  reasoning?: string;
  triggers?: string[];
  hovered?: boolean;
}

export interface BigTrade {
  timestamp: number;
  price: number;
  size: number;
  side: 'buy' | 'sell';
  symbol?: string;
}

export type PatternEventType = 'iceberg' | 'spoof' | 'absorption';

export interface PatternEvent {
  timestamp: number;
  price: number;
  type: PatternEventType;
}

export interface LiquidationCluster {
  priceHigh: number;
  priceLow: number;
  intensity: number; // 0–1
}

export interface AnnotationData {
  signals?: AISignal[];
  bigTrades?: BigTrade[];
  patternEvents?: PatternEvent[];
  liquidationClusters?: LiquidationCluster[];
}

type ExtendedState = ChartStateData & Partial<AnnotationData>;

// ─── Drawing Helpers ───────────────────────────────────────────────────────────

/** Draw a filled upwards-pointing equilateral triangle centred at (cx, cy). */
function drawTriangleUp(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  size: number,
): void {
  const half = size / 2;
  const h = (size * Math.sqrt(3)) / 2;
  ctx.beginPath();
  ctx.moveTo(cx, cy - h / 2);
  ctx.lineTo(cx - half, cy + h / 2);
  ctx.lineTo(cx + half, cy + h / 2);
  ctx.closePath();
  ctx.fill();
}

/** Draw a filled downwards-pointing equilateral triangle centred at (cx, cy). */
function drawTriangleDown(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  size: number,
): void {
  const half = size / 2;
  const h = (size * Math.sqrt(3)) / 2;
  ctx.beginPath();
  ctx.moveTo(cx, cy + h / 2);
  ctx.lineTo(cx - half, cy - h / 2);
  ctx.lineTo(cx + half, cy - h / 2);
  ctx.closePath();
  ctx.fill();
}

/** Draw a simple snowflake (6-spoke asterisk) at (cx, cy). */
function drawSnowflake(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
): void {
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const angle = (Math.PI / 3) * i;
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(angle) * r, cy + Math.sin(angle) * r);
  }
  ctx.stroke();
}

/** Draw a warning triangle outline at (cx, cy). */
function drawWarningTriangle(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  size: number,
): void {
  const half = size / 2;
  const h = (size * Math.sqrt(3)) / 2;
  ctx.beginPath();
  ctx.moveTo(cx, cy - h / 2);
  ctx.lineTo(cx - half, cy + h / 2);
  ctx.lineTo(cx + half, cy + h / 2);
  ctx.closePath();
  ctx.stroke();

  // Exclamation mark
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('!', cx, cy + 2);
}

/** Draw a simple shield icon at (cx, cy). */
function drawShield(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  size: number,
): void {
  const w = size * 0.7;
  const h = size;
  ctx.beginPath();
  ctx.moveTo(cx, cy - h / 2);
  ctx.quadraticCurveTo(cx + w / 2, cy - h / 2, cx + w / 2, cy);
  ctx.quadraticCurveTo(cx + w / 2, cy + h / 3, cx, cy + h / 2);
  ctx.quadraticCurveTo(cx - w / 2, cy + h / 3, cx - w / 2, cy);
  ctx.quadraticCurveTo(cx - w / 2, cy - h / 2, cx, cy - h / 2);
  ctx.closePath();
  ctx.stroke();
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

/** Word-wrap text into lines that fit within maxWidth. */
function wrapText(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
): string[] {
  const words = text.split(' ');
  const lines: string[] = [];
  let current = '';

  for (const word of words) {
    const test = current ? `${current} ${word}` : word;
    if (ctx.measureText(test).width > maxWidth && current) {
      lines.push(current);
      current = word;
    } else {
      current = test;
    }
  }
  if (current) lines.push(current);
  return lines;
}

// ─── Renderer ──────────────────────────────────────────────────────────────────

/**
 * Draw annotation overlays: AI signals, big trades, pattern events,
 * and liquidation clusters.
 */
export function renderAnnotations(
  ctx: CanvasRenderingContext2D,
  viewport: Viewport,
  state: Readonly<ChartStateData>,
): void {
  const ext = state as ExtendedState;
  const { width, height } = viewport.getLogicalSize();
  const chartW = width - RIGHT_MARGIN;
  const chartH = height - BOTTOM_MARGIN;
  const { start: startTime, end: endTime } = viewport.getVisibleTimeRange();

  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, chartW, chartH);
  ctx.clip();

  // ── Liquidation cluster bands ────────────────────────────────────────────
  if (ext.liquidationClusters) {
    for (const cluster of ext.liquidationClusters) {
      const yTop = viewport.priceToY(cluster.priceHigh);
      const yBottom = viewport.priceToY(cluster.priceLow);
      const bandH = Math.abs(yBottom - yTop);
      const bandY = Math.min(yTop, yBottom);

      if (bandY > chartH || bandY + bandH < 0) continue;

      const alpha = 0.06 + cluster.intensity * 0.18;
      ctx.fillStyle = `rgba(251, 146, 60, ${alpha.toFixed(3)})`;
      ctx.fillRect(0, bandY, chartW, bandH);

      // Border at top and bottom
      ctx.strokeStyle = `rgba(251, 146, 60, ${(alpha + 0.1).toFixed(3)})`;
      ctx.lineWidth = 0.5;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(0, bandY);
      ctx.lineTo(chartW, bandY);
      ctx.moveTo(0, bandY + bandH);
      ctx.lineTo(chartW, bandY + bandH);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  // ── AI Signal arrows ─────────────────────────────────────────────────────
  let hoveredSignal: AISignal | null = null;

  if (ext.signals) {
    for (const signal of ext.signals) {
      if (signal.timestamp < startTime || signal.timestamp > endTime) continue;

      const x = viewport.timeToX(signal.timestamp);
      const confidence = Math.max(0, Math.min(1, signal.confidence));
      const size = SIGNAL_MIN_SIZE + (SIGNAL_MAX_SIZE - SIGNAL_MIN_SIZE) * ((confidence - 0.5) / 0.5);
      const clampedSize = Math.max(SIGNAL_MIN_SIZE, Math.min(SIGNAL_MAX_SIZE, size));

      if (signal.direction === 'buy') {
        const y = viewport.priceToY(signal.price) + clampedSize + 4;
        ctx.fillStyle = BULL_COLOR;
        drawTriangleUp(ctx, x, y, clampedSize);
      } else {
        const y = viewport.priceToY(signal.price) - clampedSize - 4;
        ctx.fillStyle = BEAR_COLOR;
        drawTriangleDown(ctx, x, y, clampedSize);
      }

      if (signal.hovered) {
        hoveredSignal = signal;
      }
    }
  }

  // ── Big Trade markers ────────────────────────────────────────────────────
  if (ext.bigTrades) {
    // Compute max trade size for scaling
    let maxSize = 0;
    for (const t of ext.bigTrades) {
      if (t.size > maxSize) maxSize = t.size;
    }
    if (maxSize === 0) maxSize = 1;

    for (const trade of ext.bigTrades) {
      if (trade.timestamp < startTime || trade.timestamp > endTime) continue;

      const x = viewport.timeToX(trade.timestamp);
      const y = viewport.priceToY(trade.price);

      if (y < 0 || y > chartH) continue;

      const sizeRatio = trade.size / maxSize;
      const radius = TRADE_MIN_RADIUS + (TRADE_MAX_RADIUS - TRADE_MIN_RADIUS) * sizeRatio;
      const color = trade.side === 'buy' ? BULL_COLOR : BEAR_COLOR;

      // Circle
      ctx.fillStyle = color.replace(')', ', 0.3)').replace('rgb', 'rgba');
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fill();

      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.stroke();

      // Size label
      const sizeText = formatTradeSize(trade.size, trade.symbol);
      ctx.font = LABEL_FONT;
      ctx.fillStyle = color;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillText(sizeText, x, y - radius - 3);
    }
  }

  // ── Pattern event markers ────────────────────────────────────────────────
  if (ext.patternEvents) {
    const now = performance.now();

    for (const event of ext.patternEvents) {
      if (event.timestamp < startTime || event.timestamp > endTime) continue;

      const x = viewport.timeToX(event.timestamp);
      const y = viewport.priceToY(event.price);

      if (y < 0 || y > chartH) continue;

      switch (event.type) {
        case 'iceberg': {
          ctx.strokeStyle = SNOWFLAKE_COLOR;
          ctx.lineWidth = 1.5;
          drawSnowflake(ctx, x, y, 8);
          break;
        }

        case 'spoof': {
          // Pulsing red warning triangle
          const pulse = 0.5 + 0.5 * Math.sin(now / 300);
          ctx.strokeStyle = `rgba(239, 68, 68, ${(0.5 + pulse * 0.5).toFixed(2)})`;
          ctx.fillStyle = BEAR_COLOR;
          ctx.lineWidth = 1.5;
          ctx.font = '8px JetBrains Mono, monospace';
          drawWarningTriangle(ctx, x, y, 14);
          break;
        }

        case 'absorption': {
          // Cycling opacity shield
          const alpha = 0.3 + 0.5 * ((Math.sin(now / 500) + 1) / 2);
          ctx.strokeStyle = `rgba(59, 130, 246, ${alpha.toFixed(2)})`;
          ctx.lineWidth = 1.5;
          drawShield(ctx, x, y, 14);
          break;
        }
      }
    }
  }

  // ── Tooltip for hovered signal ───────────────────────────────────────────
  if (hoveredSignal) {
    drawSignalTooltip(ctx, viewport, hoveredSignal, chartW, chartH);
  }

  ctx.restore();
}

// ─── Private Helpers ───────────────────────────────────────────────────────────

function formatTradeSize(size: number, symbol?: string): string {
  const unit = symbol ? ` ${symbol.split('/')[0]}` : '';
  if (size >= 1_000) return `${(size / 1_000).toFixed(1)}K${unit}`;
  if (size >= 1) return `${size.toFixed(1)}${unit}`;
  return `${size.toFixed(3)}${unit}`;
}

function drawSignalTooltip(
  ctx: CanvasRenderingContext2D,
  viewport: Viewport,
  signal: AISignal,
  chartW: number,
  chartH: number,
): void {
  const x = viewport.timeToX(signal.timestamp);
  const y = viewport.priceToY(signal.price);

  ctx.font = TOOLTIP_FONT;

  // Build tooltip lines
  const lines: string[] = [];
  lines.push(`${signal.direction.toUpperCase()} — Confidence: ${(signal.confidence * 100).toFixed(0)}%`);

  if (signal.reasoning) {
    const wrapped = wrapText(ctx, signal.reasoning, TOOLTIP_MAX_W - TOOLTIP_PADDING * 2);
    lines.push(...wrapped);
  }

  if (signal.triggers && signal.triggers.length > 0) {
    lines.push('');
    lines.push('Triggers:');
    for (const t of signal.triggers) {
      lines.push(`• ${t}`);
    }
  }

  const lineHeight = 15;
  const tooltipW = TOOLTIP_MAX_W;
  const tooltipH = lines.length * lineHeight + TOOLTIP_PADDING * 2;

  // Position tooltip to the right of the signal, or left if near edge
  let tx = x + 16;
  let ty = y - tooltipH / 2;

  if (tx + tooltipW > chartW) tx = x - tooltipW - 16;
  if (ty < 0) ty = 4;
  if (ty + tooltipH > chartH) ty = chartH - tooltipH - 4;

  // Background
  ctx.fillStyle = TOOLTIP_BG;
  fillRoundedRect(ctx, tx, ty, tooltipW, tooltipH, TOOLTIP_RADIUS);

  // Border
  ctx.strokeStyle = TOOLTIP_BORDER;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(tx + TOOLTIP_RADIUS, ty);
  ctx.lineTo(tx + tooltipW - TOOLTIP_RADIUS, ty);
  ctx.arcTo(tx + tooltipW, ty, tx + tooltipW, ty + TOOLTIP_RADIUS, TOOLTIP_RADIUS);
  ctx.lineTo(tx + tooltipW, ty + tooltipH - TOOLTIP_RADIUS);
  ctx.arcTo(tx + tooltipW, ty + tooltipH, tx + tooltipW - TOOLTIP_RADIUS, ty + tooltipH, TOOLTIP_RADIUS);
  ctx.lineTo(tx + TOOLTIP_RADIUS, ty + tooltipH);
  ctx.arcTo(tx, ty + tooltipH, tx, ty + tooltipH - TOOLTIP_RADIUS, TOOLTIP_RADIUS);
  ctx.lineTo(tx, ty + TOOLTIP_RADIUS);
  ctx.arcTo(tx, ty, tx + TOOLTIP_RADIUS, ty, TOOLTIP_RADIUS);
  ctx.closePath();
  ctx.stroke();

  // Text
  ctx.fillStyle = TOOLTIP_TEXT;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';

  for (let i = 0; i < lines.length; i++) {
    // First line bold-ish via colour
    if (i === 0) {
      ctx.fillStyle = signal.direction === 'buy' ? BULL_COLOR : BEAR_COLOR;
    } else {
      ctx.fillStyle = TOOLTIP_TEXT;
    }
    ctx.fillText(lines[i] ?? '', tx + TOOLTIP_PADDING, ty + TOOLTIP_PADDING + i * lineHeight);
  }
}
