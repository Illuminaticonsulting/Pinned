/**
 * PatternAnnotationRenderer.ts
 * Renders iceberg, spoofing, and absorption pattern annotations on Layer 4.
 * Draws icons, connecting lines, and confidence labels at the detected price/time.
 */

import type { Viewport } from '../core/Viewport';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface AnnotationPatternEvent {
  type: 'iceberg' | 'spoof' | 'absorption';
  time: number;
  price: number;
  confidence: number;
  estimatedSize?: number;
  direction: 'bid' | 'ask';
  duration?: number;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const RIGHT_MARGIN = 80;
const BOTTOM_MARGIN = 28;

const ICON_RADIUS = 8;
const LABEL_FONT = '9px JetBrains Mono, monospace';
const ICON_FONT = '12px Inter, sans-serif';

const PATTERN_COLORS: Record<string, { fill: string; stroke: string; glow: string }> = {
  iceberg: {
    fill: 'rgba(59, 130, 246, 0.85)',
    stroke: '#60a5fa',
    glow: 'rgba(59, 130, 246, 0.3)',
  },
  spoof: {
    fill: 'rgba(249, 115, 22, 0.85)',
    stroke: '#fb923c',
    glow: 'rgba(249, 115, 22, 0.3)',
  },
  absorption: {
    fill: 'rgba(34, 197, 94, 0.85)',
    stroke: '#4ade80',
    glow: 'rgba(34, 197, 94, 0.3)',
  },
};

const PATTERN_ICONS: Record<string, string> = {
  iceberg: '⬡',    // hexagon for hidden orders
  spoof: '⚡',      // lightning for fake orders
  absorption: '◉',  // bullseye for absorbed volume
};

const PATTERN_LABELS: Record<string, string> = {
  iceberg: 'ICE',
  spoof: 'SPF',
  absorption: 'ABS',
};

// ─── Renderer ────────────────────────────────────────────────────────────────

export function renderPatternAnnotations(
  ctx: CanvasRenderingContext2D,
  viewport: Viewport,
  events: AnnotationPatternEvent[],
): void {
  if (events.length === 0) return;

  const { width, height } = viewport.getLogicalSize();
  const chartW = width - RIGHT_MARGIN;
  const chartH = height - BOTTOM_MARGIN;

  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, chartW, chartH);
  ctx.clip();

  const { start: startTime, end: endTime } = viewport.getVisibleTimeRange();

  for (const ev of events) {
    // Skip events outside visible range
    if (ev.time < startTime || ev.time > endTime) continue;

    const x = viewport.timeToX(ev.time);
    const y = viewport.priceToY(ev.price);

    // Skip if outside chart area
    if (x < 0 || x > chartW || y < 0 || y > chartH) continue;

    const colors = PATTERN_COLORS[ev.type] ?? PATTERN_COLORS.absorption;
    const icon = PATTERN_ICONS[ev.type] ?? '●';
    const label = PATTERN_LABELS[ev.type] ?? ev.type.substring(0, 3).toUpperCase();

    // ── Glow effect ──
    ctx.shadowColor = colors.glow;
    ctx.shadowBlur = 12;

    // ── Direction arrow line ──
    const arrowLen = ev.direction === 'bid' ? 16 : -16;
    ctx.strokeStyle = colors.stroke;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([3, 2]);
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x, y + arrowLen);
    ctx.stroke();
    ctx.setLineDash([]);

    // ── Circle background ──
    ctx.beginPath();
    ctx.arc(x, y, ICON_RADIUS, 0, Math.PI * 2);
    ctx.fillStyle = colors.fill;
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Reset shadow for text
    ctx.shadowBlur = 0;

    // ── Icon ──
    ctx.font = ICON_FONT;
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(icon, x, y);

    // ── Label badge ──
    const badgeY = y - ICON_RADIUS - 12;
    ctx.font = LABEL_FONT;
    const labelText = `${label} ${Math.round(ev.confidence * 100)}%`;
    const labelW = ctx.measureText(labelText).width + 8;
    const badgeX = x - labelW / 2;

    // Badge background
    ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
    ctx.beginPath();
    ctx.roundRect(badgeX, badgeY - 8, labelW, 16, 3);
    ctx.fill();

    // Badge border
    ctx.strokeStyle = colors.stroke;
    ctx.lineWidth = 0.8;
    ctx.stroke();

    // Badge text
    ctx.fillStyle = colors.stroke;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(labelText, x, badgeY);

    // ── Estimated size (small text below) ──
    if (ev.estimatedSize && ev.estimatedSize > 0) {
      const sizeText = formatSize(ev.estimatedSize);
      ctx.font = '8px JetBrains Mono, monospace';
      ctx.fillStyle = 'rgba(156, 163, 175, 0.7)';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(sizeText, x, y + ICON_RADIUS + 3);
    }
  }

  ctx.restore();
}

function formatSize(size: number): string {
  if (size >= 1_000_000) return `${(size / 1_000_000).toFixed(1)}M`;
  if (size >= 1_000) return `${(size / 1_000).toFixed(1)}K`;
  if (size >= 1) return size.toFixed(1);
  return size.toFixed(3);
}
