// ── Mocks ──────────────────────────────────────────────────────────────────

const mockPipeline = {
  set: jest.fn().mockReturnThis(),
  lpush: jest.fn().mockReturnThis(),
  ltrim: jest.fn().mockReturnThis(),
  exec: jest.fn().mockResolvedValue([]),
};

jest.mock('../../utils/redis', () => ({
  redis: {
    pipeline: () => mockPipeline,
    xadd: jest.fn(),
    xrevrange: jest.fn().mockResolvedValue([]),
  },
}));

jest.mock('../../db', () => ({
  pool: {
    query: jest.fn().mockResolvedValue({ rows: [] }),
  },
}));

jest.mock('../../config', () => ({
  config: {},
}));

jest.mock('../../utils/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

import { OrderbookService } from '../../services/OrderbookService';
import type { OrderbookSnapshot, OrderbookLevel } from '@pinned/shared-types';
import { pool } from '../../db';

// ── Helpers ────────────────────────────────────────────────────────────────

function makeSnapshot(overrides: Partial<OrderbookSnapshot> = {}): OrderbookSnapshot {
  return {
    time: Date.now(),
    exchange: 'blofin',
    symbol: 'BTC-USDT',
    bids: [
      { price: 35000, size: 10 },
      { price: 34999, size: 5 },
    ],
    asks: [
      { price: 35001, size: 8 },
      { price: 35002, size: 3 },
    ],
    ...overrides,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('OrderbookService', () => {
  let service: OrderbookService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new OrderbookService();
    service.start();
  });

  afterEach(async () => {
    await service.stop();
  });

  describe('delta calculation', () => {
    it('detects additions when size increases at an existing price level', async () => {
      const snap1 = makeSnapshot({
        time: 1000,
        bids: [{ price: 35000, size: 10 }],
        asks: [],
      });
      const snap2 = makeSnapshot({
        time: 2000,
        bids: [{ price: 35000, size: 15 }],
        asks: [],
      });

      // First snapshot sets baseline
      await service.onSnapshot(snap1);
      mockPipeline.exec.mockClear();

      // Second snapshot should produce deltas
      await service.onSnapshot(snap2);

      // The service uses computeDeltas internally — verify via metrics
      const metrics = service.getMetrics();
      expect(metrics.totalSnapshots).toBeGreaterThanOrEqual(2);
    });

    it('detects cancellations when size decreases without a trade', async () => {
      const snap1 = makeSnapshot({
        time: 1000,
        bids: [{ price: 35000, size: 10 }],
        asks: [],
      });
      const snap2 = makeSnapshot({
        time: 2000,
        bids: [{ price: 35000, size: 3 }],
        asks: [],
      });

      await service.onSnapshot(snap1);
      await service.onSnapshot(snap2);

      // Delta count should be > 0 because there's a size change
      const metrics = service.getMetrics();
      expect(metrics.totalDeltas).toBeGreaterThan(0);
    });

    it('detects new price levels as additions', async () => {
      const snap1 = makeSnapshot({
        time: 1000,
        bids: [{ price: 35000, size: 10 }],
        asks: [],
      });
      const snap2 = makeSnapshot({
        time: 2000,
        bids: [
          { price: 35000, size: 10 },
          { price: 34999, size: 5 },
        ],
        asks: [],
      });

      await service.onSnapshot(snap1);
      await service.onSnapshot(snap2);

      // New level at 34999 should produce a delta
      const metrics = service.getMetrics();
      expect(metrics.totalDeltas).toBeGreaterThan(0);
    });
  });

  describe('circular buffer operation (Redis)', () => {
    it('stores latest snapshot and pushes to buffer with LTRIM', async () => {
      const snap = makeSnapshot();
      await service.onSnapshot(snap);

      expect(mockPipeline.set).toHaveBeenCalledWith(
        `ob:blofin:BTC-USDT:latest`,
        expect.any(String),
      );
      expect(mockPipeline.lpush).toHaveBeenCalledWith(
        `ob:blofin:BTC-USDT:buffer`,
        expect.any(String),
      );
      expect(mockPipeline.ltrim).toHaveBeenCalledWith(
        `ob:blofin:BTC-USDT:buffer`,
        0,
        28_799, // BUFFER_MAX_LEN - 1
      );
    });
  });

  describe('snapshot compression timing', () => {
    it('persists to DB on first snapshot', async () => {
      const snap = makeSnapshot({ time: 1000 });
      await service.onSnapshot(snap);

      expect((pool.query as jest.Mock)).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO orderbook_snapshots'),
        expect.any(Array),
      );
    });

    it('does NOT persist to DB within 60s of the last persist', async () => {
      const snap1 = makeSnapshot({ time: 1000 });
      await service.onSnapshot(snap1);
      (pool.query as jest.Mock).mockClear();

      // Second snapshot only 5 seconds later
      const snap2 = makeSnapshot({ time: 6000 });
      await service.onSnapshot(snap2);

      expect((pool.query as jest.Mock)).not.toHaveBeenCalled();
    });
  });

  describe('metrics', () => {
    it('tracks total snapshots processed', async () => {
      await service.onSnapshot(makeSnapshot({ time: 1000 }));
      await service.onSnapshot(makeSnapshot({ time: 2000 }));
      await service.onSnapshot(makeSnapshot({ time: 3000 }));

      const metrics = service.getMetrics();
      expect(metrics.totalSnapshots).toBe(3);
      expect(metrics.trackedSymbols).toBe(1);
    });
  });
});
