/**
 * Unit tests for geometric hit-testing utilities.
 */

import {
  distancePointToLineSegment,
  isPointInRect,
  isPointNearRectEdge,
} from '../../drawing/HitTest';

describe('HitTest geometry utilities', () => {
  // ── distancePointToLineSegment ────────────────────────────────────

  describe('distancePointToLineSegment', () => {
    it('returns 0 when the point is exactly on the line segment', () => {
      // Midpoint of segment (0,0)–(10,0)
      const d = distancePointToLineSegment(5, 0, 0, 0, 10, 0);
      expect(d).toBeCloseTo(0);
    });

    it('returns perpendicular distance when projection falls within segment', () => {
      // Point (5, 3) above the segment (0,0)–(10,0)
      const d = distancePointToLineSegment(5, 3, 0, 0, 10, 0);
      expect(d).toBeCloseTo(3);
    });

    it('returns distance to nearest endpoint when projection is beyond segment', () => {
      // Point (15, 0) beyond endpoint (10, 0)
      const d = distancePointToLineSegment(15, 0, 0, 0, 10, 0);
      expect(d).toBeCloseTo(5);
    });

    it('returns distance to start when projection is before segment', () => {
      // Point (-3, 4) before segment start (0,0)–(10,0)
      const d = distancePointToLineSegment(-3, 4, 0, 0, 10, 0);
      expect(d).toBeCloseTo(5); // sqrt(9+16) = 5
    });

    it('handles degenerate segment (zero length)', () => {
      // Both endpoints at (5,5), point at (8,9)
      const d = distancePointToLineSegment(8, 9, 5, 5, 5, 5);
      expect(d).toBeCloseTo(5); // sqrt(9+16) = 5
    });

    it('handles diagonal segments correctly', () => {
      // Segment from (0,0) to (4,4), point at (0,4) — distance = 2*sqrt(2) ≈ 2.828
      const d = distancePointToLineSegment(0, 4, 0, 0, 4, 4);
      expect(d).toBeCloseTo(2 * Math.SQRT2, 3);
    });
  });

  // ── isPointInRect ─────────────────────────────────────────────────

  describe('isPointInRect', () => {
    const x1 = 10, y1 = 10, x2 = 100, y2 = 80;

    it('returns true for a point inside the rectangle', () => {
      expect(isPointInRect(50, 40, x1, y1, x2, y2)).toBe(true);
    });

    it('returns false for a point outside the rectangle', () => {
      expect(isPointInRect(5, 5, x1, y1, x2, y2)).toBe(false);
      expect(isPointInRect(200, 200, x1, y1, x2, y2)).toBe(false);
    });

    it('returns true for a point on the edge', () => {
      expect(isPointInRect(10, 50, x1, y1, x2, y2)).toBe(true); // left edge
      expect(isPointInRect(50, 10, x1, y1, x2, y2)).toBe(true); // top edge
      expect(isPointInRect(100, 50, x1, y1, x2, y2)).toBe(true); // right edge
    });

    it('handles inverted corner order (x2 < x1, y2 < y1)', () => {
      // Providing corners in reverse order should still work
      expect(isPointInRect(50, 40, x2, y2, x1, y1)).toBe(true);
    });
  });

  // ── isPointNearRectEdge ───────────────────────────────────────────

  describe('isPointNearRectEdge', () => {
    const x1 = 10, y1 = 10, x2 = 100, y2 = 80;
    const threshold = 5;

    it('returns true for a point near an edge but outside the rect', () => {
      // Just outside the left edge
      expect(isPointNearRectEdge(7, 40, x1, y1, x2, y2, threshold)).toBe(true);
    });

    it('returns true for a point near an edge but inside the rect', () => {
      // Just inside the left edge
      expect(isPointNearRectEdge(13, 40, x1, y1, x2, y2, threshold)).toBe(true);
    });

    it('returns false for a point deep inside the rect', () => {
      // Center of the rect (well beyond threshold from any edge)
      expect(isPointNearRectEdge(55, 45, x1, y1, x2, y2, threshold)).toBe(false);
    });

    it('returns false for a point far outside the rect', () => {
      expect(isPointNearRectEdge(200, 200, x1, y1, x2, y2, threshold)).toBe(false);
    });

    it('returns true for a point near the corner', () => {
      // Near top-left corner
      expect(isPointNearRectEdge(12, 12, x1, y1, x2, y2, threshold)).toBe(true);
    });

    it('handles zero-width threshold gracefully', () => {
      // With threshold=0, only exact edge points should qualify
      // A point deep inside should return false
      expect(isPointNearRectEdge(55, 45, x1, y1, x2, y2, 0)).toBe(false);
    });
  });
});
