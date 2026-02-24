/**
 * HitTest.ts
 * Precise geometric hit-testing utilities for chart drawings.
 *
 * All functions operate in screen-pixel (CSS pixel) coordinates,
 * i.e. after the Viewport transform has been applied.
 */

import type { Drawing, ChartPoint } from '../core/ChartState';
import type { Viewport } from '../core/Viewport';

// ─── Types ─────────────────────────────────────────────────────────────────────

/** Describes a specific interactive handle on a drawing. */
export interface HandleInfo {
  readonly drawingId: string;
  readonly handleIndex: number;
  readonly type: 'endpoint' | 'corner' | 'midpoint' | 'center';
}

// ─── Primitive Geometry ────────────────────────────────────────────────────────

/**
 * Compute the shortest distance from point (px, py) to the line segment
 * defined by (x1, y1)–(x2, y2) using perpendicular projection.
 */
export function distancePointToLineSegment(
  px: number,
  py: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;

  // Degenerate segment (both endpoints coincide).
  if (lenSq === 0) {
    return Math.hypot(px - x1, py - y1);
  }

  // Parameter t ∈ [0,1] of the projection onto the infinite line.
  let t = ((px - x1) * dx + (py - y1) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));

  const projX = x1 + t * dx;
  const projY = y1 + t * dy;

  return Math.hypot(px - projX, py - projY);
}

/**
 * Test whether (px, py) lies inside the axis-aligned rectangle
 * defined by two opposite corners (x1, y1) and (x2, y2).
 */
export function isPointInRect(
  px: number,
  py: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): boolean {
  const minX = Math.min(x1, x2);
  const maxX = Math.max(x1, x2);
  const minY = Math.min(y1, y2);
  const maxY = Math.max(y1, y2);

  return px >= minX && px <= maxX && py >= minY && py <= maxY;
}

/**
 * Test whether (px, py) is near any edge of the rectangle but NOT inside it
 * (useful for resize handles on rectangle outlines).
 */
export function isPointNearRectEdge(
  px: number,
  py: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  threshold: number,
): boolean {
  const minX = Math.min(x1, x2);
  const maxX = Math.max(x1, x2);
  const minY = Math.min(y1, y2);
  const maxY = Math.max(y1, y2);

  // Must be within the expanded bounding box.
  if (
    px < minX - threshold ||
    px > maxX + threshold ||
    py < minY - threshold ||
    py > maxY + threshold
  ) {
    return false;
  }

  // Must NOT be deep inside (outside the contracted box).
  const insideX = px > minX + threshold && px < maxX - threshold;
  const insideY = py > minY + threshold && py < maxY - threshold;

  return !(insideX && insideY);
}

/**
 * Absolute vertical pixel distance from py to a horizontal line at lineY.
 */
export function distancePointToHorizontalLine(py: number, lineY: number): number {
  return Math.abs(py - lineY);
}

// ─── Drawing-Aware Hit Tests ───────────────────────────────────────────────────

/**
 * Convert a drawing's chart points into screen-pixel coordinates through the viewport.
 */
interface ScreenPoint { x: number; y: number }

function toScreenPoints(points: readonly ChartPoint[], viewport: Viewport): ScreenPoint[] {
  return points.map((p) => ({
    x: viewport.timeToX(p.time),
    y: viewport.priceToY(p.price),
  }));
}

/**
 * Compute the pixel distance from (px, py) to a drawing, using
 * type-appropriate geometry.
 */
function distanceToDrawing(
  px: number,
  py: number,
  drawing: Drawing,
  viewport: Viewport,
): number {
  const pts = toScreenPoints(drawing.points, viewport);

  switch (drawing.type) {
    case 'horizontal_line': {
      if (pts.length < 1) return Infinity;
      return distancePointToHorizontalLine(py, pts[0]!.y);
    }

    case 'trendline':
    case 'ray':
    case 'extended_line': {
      if (pts.length < 2) return Infinity;
      const a = pts[0]!;
      const b = pts[1]!;
      return distancePointToLineSegment(px, py, a.x, a.y, b.x, b.y);
    }

    case 'rectangle':
    case 'price_range':
    case 'date_range': {
      if (pts.length < 2) return Infinity;
      const r0 = pts[0]!;
      const r1 = pts[1]!;
      // Prefer inside → 0,  otherwise distance to nearest edge.
      if (isPointInRect(px, py, r0.x, r0.y, r1.x, r1.y)) {
        return 0;
      }
      // Distance to each of the four edges, take minimum.
      const minX = Math.min(r0.x, r1.x);
      const maxX = Math.max(r0.x, r1.x);
      const minY = Math.min(r0.y, r1.y);
      const maxY = Math.max(r0.y, r1.y);
      return Math.min(
        distancePointToLineSegment(px, py, minX, minY, maxX, minY), // top
        distancePointToLineSegment(px, py, maxX, minY, maxX, maxY), // right
        distancePointToLineSegment(px, py, minX, maxY, maxX, maxY), // bottom
        distancePointToLineSegment(px, py, minX, minY, minX, maxY), // left
      );
    }

    case 'fibonacci_retracement':
    case 'fibonacci_extension': {
      if (pts.length < 2) return Infinity;
      const levels = (drawing.properties.levels as number[] | undefined) ?? [
        0, 0.236, 0.382, 0.5, 0.618, 0.786, 1,
      ];
      const { width } = viewport.getLogicalSize();
      const p0 = drawing.points[0]!;
      const p1 = drawing.points[1]!;
      const priceDiff = p1.price - p0.price;
      let minDist = Infinity;
      for (const lvl of levels) {
        const levelPrice = p0.price + priceDiff * lvl;
        const levelY = viewport.priceToY(levelPrice);
        const d = distancePointToLineSegment(px, py, 0, levelY, width, levelY);
        if (d < minDist) minDist = d;
      }
      return minDist;
    }

    case 'vertical_line': {
      if (pts.length < 1) return Infinity;
      return Math.abs(px - pts[0]!.x);
    }

    case 'parallel_channel': {
      if (pts.length < 3) return Infinity;
      const pc0 = pts[0]!;
      const pc1 = pts[1]!;
      const pc2 = pts[2]!;
      const d1 = distancePointToLineSegment(px, py, pc0.x, pc0.y, pc1.x, pc1.y);
      // Third point defines offset for the parallel line.
      const offsetY = pc2.y - pc0.y;
      const d2 = distancePointToLineSegment(
        px,
        py,
        pc0.x,
        pc0.y + offsetY,
        pc1.x,
        pc1.y + offsetY,
      );
      return Math.min(d1, d2);
    }

    default: {
      // Fallback: distance to nearest point.
      let minDist = Infinity;
      for (const p of pts) {
        const d = Math.hypot(px - p.x, py - p.y);
        if (d < minDist) minDist = d;
      }
      return minDist;
    }
  }
}

// ─── Handle Detection ──────────────────────────────────────────────────────────

/**
 * Return the interactive handle (if any) at the given pixel position.
 *
 * @param px        Screen X (CSS pixels).
 * @param py        Screen Y (CSS pixels).
 * @param drawing   The drawing to test.
 * @param viewport  Active viewport for coordinate conversion.
 * @param threshold Maximum distance in CSS pixels.
 * @returns The matching handle descriptor, or `null`.
 */
export function getHandleAtPoint(
  px: number,
  py: number,
  drawing: Drawing,
  viewport: Viewport,
  threshold: number,
): HandleInfo | null {
  const pts = toScreenPoints(drawing.points, viewport);

  switch (drawing.type) {
    // ── Horizontal Line: single center handle ─────────────────────────────
    case 'horizontal_line': {
      if (pts.length < 1) return null;
      const { width } = viewport.getLogicalSize();
      const cx = width / 2;
      const cy = pts[0]!.y;
      if (Math.hypot(px - cx, py - cy) <= threshold) {
        return { drawingId: drawing.id, handleIndex: 0, type: 'center' };
      }
      return null;
    }

    // ── Two-Endpoint Drawings ─────────────────────────────────────────────
    case 'trendline':
    case 'ray':
    case 'extended_line':
    case 'fibonacci_retracement':
    case 'fibonacci_extension': {
      for (let i = 0; i < pts.length; i++) {
        const pt = pts[i]!;
        if (Math.hypot(px - pt.x, py - pt.y) <= threshold) {
          return { drawingId: drawing.id, handleIndex: i, type: 'endpoint' };
        }
      }
      return null;
    }

    // ── Rectangle: 8 handles (4 corners + 4 midpoints) ───────────────────
    case 'rectangle':
    case 'price_range':
    case 'date_range': {
      if (pts.length < 2) return null;
      const rp0 = pts[0]!;
      const rp1 = pts[1]!;
      const minX = Math.min(rp0.x, rp1.x);
      const maxX = Math.max(rp0.x, rp1.x);
      const minY = Math.min(rp0.y, rp1.y);
      const maxY = Math.max(rp0.y, rp1.y);
      const midX = (minX + maxX) / 2;
      const midY = (minY + maxY) / 2;

      const handles: { x: number; y: number; type: 'corner' | 'midpoint' }[] = [
        { x: minX, y: minY, type: 'corner' },
        { x: maxX, y: minY, type: 'corner' },
        { x: maxX, y: maxY, type: 'corner' },
        { x: minX, y: maxY, type: 'corner' },
        { x: midX, y: minY, type: 'midpoint' },
        { x: maxX, y: midY, type: 'midpoint' },
        { x: midX, y: maxY, type: 'midpoint' },
        { x: minX, y: midY, type: 'midpoint' },
      ];

      for (const h of handles) {
        if (Math.hypot(px - h.x, py - h.y) <= threshold) {
          return { drawingId: drawing.id, handleIndex: handles.indexOf(h), type: h.type };
        }
      }
      return null;
    }

    // ── Vertical Line: single center handle ───────────────────────────────
    case 'vertical_line': {
      if (pts.length < 1) return null;
      const { height } = viewport.getLogicalSize();
      const cy = height / 2;
      if (Math.hypot(px - pts[0]!.x, py - cy) <= threshold) {
        return { drawingId: drawing.id, handleIndex: 0, type: 'center' };
      }
      return null;
    }

    // ── Fallback: test each defined point ─────────────────────────────────
    default: {
      for (let i = 0; i < pts.length; i++) {
        const pt = pts[i]!;
        if (Math.hypot(px - pt.x, py - pt.y) <= threshold) {
          return { drawingId: drawing.id, handleIndex: i, type: 'endpoint' };
        }
      }
      return null;
    }
  }
}

// ─── Find Nearest Drawing ──────────────────────────────────────────────────────

/**
 * Find the closest drawing to (px, py) that is within `threshold` pixels.
 *
 * @param px        Screen X (CSS pixels).
 * @param py        Screen Y (CSS pixels).
 * @param drawings  Array of drawings to test.
 * @param viewport  Active viewport for coordinate conversion.
 * @param threshold Maximum distance in CSS pixels (default 5).
 * @returns The closest drawing, or `null` if none within threshold.
 */
export function findNearestDrawing(
  px: number,
  py: number,
  drawings: Drawing[],
  viewport: Viewport,
  threshold: number = 5,
): Drawing | null {
  let best: Drawing | null = null;
  let bestDist = Infinity;

  for (const drawing of drawings) {
    if (!drawing.visible) continue;

    const d = distanceToDrawing(px, py, drawing, viewport);
    if (d < bestDist && d <= threshold) {
      bestDist = d;
      best = drawing;
    }
  }

  return best;
}
