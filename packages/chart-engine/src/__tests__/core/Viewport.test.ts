/**
 * Unit tests for Viewport coordinate transforms, zoom, pan, and auto-fit.
 */

// Viewport is a pure-math class with no DOM/Canvas dependencies when dpr is provided.
import { Viewport } from '../../core/Viewport';

describe('Viewport', () => {
  const WIDTH = 800;
  const HEIGHT = 600;
  const DPR = 2;

  let vp: Viewport;

  beforeEach(() => {
    vp = new Viewport(WIDTH, HEIGHT, DPR);
    vp.setVisibleRange(0, 800_000); // 0–800s
    vp.setPriceRange(29_000, 31_000); // $29k–$31k
  });

  // ── timeToX / xToTime roundtrip ─────────────────────────────────────

  describe('timeToX / xToTime roundtrip', () => {
    it('converts time → X → time with no precision loss', () => {
      const t = 400_000; // midpoint
      const x = vp.timeToX(t);
      const tBack = vp.xToTime(x);
      expect(tBack).toBeCloseTo(t, 5);
    });

    it('maps startTime to x=0 and endTime to x=WIDTH', () => {
      expect(vp.timeToX(0)).toBeCloseTo(0);
      expect(vp.timeToX(800_000)).toBeCloseTo(WIDTH);
    });

    it('handles timestamps outside visible range', () => {
      const x = vp.timeToX(-100_000);
      expect(x).toBeLessThan(0);

      const x2 = vp.timeToX(900_000);
      expect(x2).toBeGreaterThan(WIDTH);
    });
  });

  // ── priceToY / yToPrice roundtrip ──────────────────────────────────

  describe('priceToY / yToPrice roundtrip', () => {
    it('converts price → Y → price with no precision loss', () => {
      const price = 30_000;
      const y = vp.priceToY(price);
      const pBack = vp.yToPrice(y);
      expect(pBack).toBeCloseTo(price, 5);
    });

    it('Y is inverted: higher price → lower Y', () => {
      const yHigh = vp.priceToY(31_000); // high price
      const yLow = vp.priceToY(29_000);  // low price
      expect(yHigh).toBeLessThan(yLow);
    });

    it('maps priceHigh to y=0 and priceLow to y=HEIGHT', () => {
      expect(vp.priceToY(31_000)).toBeCloseTo(0);
      expect(vp.priceToY(29_000)).toBeCloseTo(HEIGHT);
    });
  });

  // ── Zoom ───────────────────────────────────────────────────────────

  describe('zoom', () => {
    it('zoom in (factor>1) narrows the visible time range', () => {
      const { start: sBefore, end: eBefore } = vp.getVisibleTimeRange();
      const spanBefore = eBefore - sBefore;

      vp.zoom(2, WIDTH / 2); // zoom 2x at center

      const { start: sAfter, end: eAfter } = vp.getVisibleTimeRange();
      const spanAfter = eAfter - sAfter;

      expect(spanAfter).toBeLessThan(spanBefore);
      expect(spanAfter).toBeCloseTo(spanBefore / 2, -1);
    });

    it('zoom keeps the anchor time fixed at the cursor position', () => {
      const cursorX = 200; // 25% of width
      const anchorTimeBefore = vp.xToTime(cursorX);

      vp.zoom(1.5, cursorX);

      // After zoom, the same screen pixel should map to the same time
      const anchorTimeAfter = vp.xToTime(cursorX);
      expect(anchorTimeAfter).toBeCloseTo(anchorTimeBefore, 0);
    });

    it('zoom out (factor<1) widens the visible time range', () => {
      const { start: sBefore, end: eBefore } = vp.getVisibleTimeRange();
      const spanBefore = eBefore - sBefore;

      vp.zoom(0.5, WIDTH / 2);

      const { start: sAfter, end: eAfter } = vp.getVisibleTimeRange();
      const spanAfter = eAfter - sAfter;

      expect(spanAfter).toBeGreaterThan(spanBefore);
    });
  });

  // ── Pan ────────────────────────────────────────────────────────────

  describe('pan', () => {
    it('panning right shifts time range backward', () => {
      const { start: sBefore } = vp.getVisibleTimeRange();
      vp.pan(100, 0); // pan 100px right
      const { start: sAfter } = vp.getVisibleTimeRange();

      expect(sAfter).toBeLessThan(sBefore);
    });

    it('panning down shifts price range upward', () => {
      const { low: lBefore } = vp.getVisiblePriceRange();
      vp.pan(0, 50); // pan 50px down
      const { low: lAfter } = vp.getVisiblePriceRange();

      expect(lAfter).toBeGreaterThan(lBefore);
    });

    it('pan preserves the time span length', () => {
      const { start: s1, end: e1 } = vp.getVisibleTimeRange();
      const span1 = e1 - s1;

      vp.pan(200, 0);

      const { start: s2, end: e2 } = vp.getVisibleTimeRange();
      const span2 = e2 - s2;

      expect(span2).toBeCloseTo(span1, 5);
    });
  });

  // ── fitPriceRange ─────────────────────────────────────────────────

  describe('fitPriceRange', () => {
    it('auto-fits price range with padding around visible candles', () => {
      // Candles with timestamps use 'timestamp' field based on the source code
      const candles = [
        { timestamp: 100_000, open: 30_100, high: 30_500, low: 29_800, close: 30_200, volume: 10 },
        { timestamp: 200_000, open: 30_200, high: 30_800, low: 30_000, close: 30_600, volume: 12 },
        { timestamp: 300_000, open: 30_600, high: 31_000, low: 30_400, close: 30_900, volume: 8 },
      ];

      vp.fitPriceRange(candles as any[]);

      const { low, high } = vp.getVisiblePriceRange();
      // Low should be below 29_800, high above 31_000 (with 10% padding)
      expect(low).toBeLessThan(29_800);
      expect(high).toBeGreaterThan(31_000);
    });

    it('does nothing if no candles fall within visible range', () => {
      const { low: lBefore, high: hBefore } = vp.getVisiblePriceRange();

      const candles = [
        { timestamp: 900_000, open: 50_000, high: 51_000, low: 49_000, close: 50_500, volume: 5 },
      ];

      vp.fitPriceRange(candles as any[]);

      const { low: lAfter, high: hAfter } = vp.getVisiblePriceRange();
      expect(lAfter).toBe(lBefore);
      expect(hAfter).toBe(hBefore);
    });
  });

  // ── Resize ────────────────────────────────────────────────────────

  describe('resize', () => {
    it('updates logical dimensions and recalculates transforms', () => {
      vp.resize(1200, 900);

      const { width, height } = vp.getLogicalSize();
      expect(width).toBe(1200);
      expect(height).toBe(900);

      // X mapping should use new width
      const x = vp.timeToX(400_000);
      expect(x).toBeCloseTo(600); // midpoint of 1200
    });

    it('updates DPR when provided', () => {
      vp.resize(800, 600, 3);
      expect(vp.getDevicePixelRatio()).toBe(3);
      expect(vp.getPhysicalWidth()).toBe(2400);
      expect(vp.getPhysicalHeight()).toBe(1800);
    });
  });

  // ── Derived metrics ───────────────────────────────────────────────

  describe('derived metrics', () => {
    it('getCandleWidth returns correct pixel width for timeframe', () => {
      vp.setTimeframe('1m');
      const cw = vp.getCandleWidth();
      // 1m = 60_000ms, span = 800_000ms, width = 800px
      // candleWidth = (60_000 / 800_000) * 800 = 60px
      expect(cw).toBeCloseTo(60);
    });

    it('getTimePerPixel returns correct ms/px', () => {
      // span = 800_000, width = 800
      expect(vp.getTimePerPixel()).toBeCloseTo(1000);
    });
  });
});
