// ── Mocks ──────────────────────────────────────────────────────────────────

jest.mock('../../utils/redis', () => ({
  redis: {
    publish: jest.fn().mockResolvedValue(1),
    xread: jest.fn().mockResolvedValue(null),
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

import { PatternDetectionService } from '../../services/PatternDetectionService';
import { redis } from '../../utils/redis';
import type { DeltaChange } from '@pinned/shared-types';

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Access the private processDelta method for unit testing.
 * In production, deltas arrive via Redis stream; here we invoke directly.
 */
function processDelta(
  service: PatternDetectionService,
  exchange: string,
  symbol: string,
  delta: DeltaChange,
): Promise<void> {
  return (service as any).processDelta(exchange, symbol, delta);
}

function emitPattern(service: PatternDetectionService): jest.SpyInstance {
  const spy = jest.spyOn(service as any, 'emitPattern').mockResolvedValue(undefined);
  return spy;
}

function makeDelta(overrides: Partial<DeltaChange> = {}): DeltaChange {
  return {
    price: 35000,
    sizeDelta: 0,
    type: 'addition',
    time: Date.now(),
    ...overrides,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('PatternDetectionService', () => {
  let service: PatternDetectionService;
  let emitSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new PatternDetectionService();
    emitSpy = emitPattern(service);
  });

  afterEach(async () => {
    await service.stop();
    emitSpy.mockRestore();
  });

  // ── Iceberg Detection ──────────────────────────────────────────────

  describe('iceberg detection', () => {
    it('emits iceberg event after 3 refill cycles at the same price', async () => {
      const price = 35000;
      const now = Date.now();

      // Cycle 1: deplete then refill
      await processDelta(service, 'blofin', 'BTC-USDT', makeDelta({
        price, sizeDelta: -5, type: 'fill', time: now,
      }));
      await processDelta(service, 'blofin', 'BTC-USDT', makeDelta({
        price, sizeDelta: 5, type: 'addition', time: now + 100,
      }));

      // Cycle 2
      await processDelta(service, 'blofin', 'BTC-USDT', makeDelta({
        price, sizeDelta: -5, type: 'fill', time: now + 200,
      }));
      await processDelta(service, 'blofin', 'BTC-USDT', makeDelta({
        price, sizeDelta: 5, type: 'addition', time: now + 300,
      }));

      // Cycle 3
      await processDelta(service, 'blofin', 'BTC-USDT', makeDelta({
        price, sizeDelta: -5, type: 'fill', time: now + 400,
      }));
      await processDelta(service, 'blofin', 'BTC-USDT', makeDelta({
        price, sizeDelta: 5, type: 'addition', time: now + 500,
      }));

      expect(emitSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'iceberg',
          price,
          exchange: 'blofin',
          symbol: 'BTC-USDT',
        }),
      );
    });

    it('does NOT emit iceberg if fewer than 3 refill cycles occur', async () => {
      const price = 35000;
      const now = Date.now();

      // Only 2 cycles
      await processDelta(service, 'blofin', 'BTC-USDT', makeDelta({
        price, sizeDelta: -5, type: 'fill', time: now,
      }));
      await processDelta(service, 'blofin', 'BTC-USDT', makeDelta({
        price, sizeDelta: 5, type: 'addition', time: now + 100,
      }));
      await processDelta(service, 'blofin', 'BTC-USDT', makeDelta({
        price, sizeDelta: -5, type: 'fill', time: now + 200,
      }));
      await processDelta(service, 'blofin', 'BTC-USDT', makeDelta({
        price, sizeDelta: 5, type: 'addition', time: now + 300,
      }));

      expect(emitSpy).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: 'iceberg' }),
      );
    });

    it('resets iceberg state if duration exceeds 60 seconds', async () => {
      const price = 35000;
      const now = Date.now();

      // Start a cycle, then wait >60s
      await processDelta(service, 'blofin', 'BTC-USDT', makeDelta({
        price, sizeDelta: -5, type: 'fill', time: now,
      }));
      await processDelta(service, 'blofin', 'BTC-USDT', makeDelta({
        price, sizeDelta: 5, type: 'addition', time: now + 100,
      }));

      // 65 seconds later — should reset
      await processDelta(service, 'blofin', 'BTC-USDT', makeDelta({
        price, sizeDelta: -5, type: 'fill', time: now + 65_000,
      }));

      // Only 1 cycle after reset, should not emit
      expect(emitSpy).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: 'iceberg' }),
      );
    });
  });

  // ── Spoof Detection ────────────────────────────────────────────────

  describe('spoof detection', () => {
    it('emits spoof event when large order appears and disappears without trade in <3s', async () => {
      const price = 35000;
      const now = Date.now();

      // Set total book depth so the ratio check passes (2% threshold)
      service.updateBookDepth('blofin', 'BTC-USDT', 1000);

      // Large order appears (sizeDelta = 25, which is 2.5% of 1000)
      await processDelta(service, 'blofin', 'BTC-USDT', makeDelta({
        price, sizeDelta: 25, type: 'addition', time: now,
      }));

      // Order disappears without trade (cancellation, not fill)
      await processDelta(service, 'blofin', 'BTC-USDT', makeDelta({
        price, sizeDelta: -25, type: 'cancellation', time: now + 2000,
      }));

      expect(emitSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'spoof',
          price,
          exchange: 'blofin',
          symbol: 'BTC-USDT',
        }),
      );
    });

    it('does NOT emit spoof if the order was filled (trade occurred)', async () => {
      const price = 35000;
      const now = Date.now();

      service.updateBookDepth('blofin', 'BTC-USDT', 1000);

      await processDelta(service, 'blofin', 'BTC-USDT', makeDelta({
        price, sizeDelta: 25, type: 'addition', time: now,
      }));

      // Removed WITH a trade (fill, not cancellation)
      await processDelta(service, 'blofin', 'BTC-USDT', makeDelta({
        price, sizeDelta: -25, type: 'fill', time: now + 1000,
      }));

      expect(emitSpy).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: 'spoof' }),
      );
    });

    it('expires spoof candidates after 3 seconds', async () => {
      const price = 35000;
      const now = Date.now();

      service.updateBookDepth('blofin', 'BTC-USDT', 1000);

      await processDelta(service, 'blofin', 'BTC-USDT', makeDelta({
        price, sizeDelta: 25, type: 'addition', time: now,
      }));

      // Remove after >3 seconds — should NOT be flagged as spoof
      await processDelta(service, 'blofin', 'BTC-USDT', makeDelta({
        price, sizeDelta: -25, type: 'cancellation', time: now + 4000,
      }));

      expect(emitSpy).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: 'spoof' }),
      );
    });
  });

  // ── Absorption Detection ──────────────────────────────────────────

  describe('absorption detection', () => {
    it('emits absorption when trade volume is 3x+ the level size decrease', async () => {
      const price = 35000;
      const now = Date.now();

      // Simulate fills interleaved with additions (level absorbs fills and gets refilled)
      // Fill: tradeVolume += 3, sizeDecrease += 3
      await processDelta(service, 'blofin', 'BTC-USDT', makeDelta({
        price, sizeDelta: -3, type: 'fill', time: now,
      }));
      // Addition (refill): sizeDecrease = max(0, 3-2) = 1
      await processDelta(service, 'blofin', 'BTC-USDT', makeDelta({
        price, sizeDelta: 2, type: 'addition', time: now + 100,
      }));

      // Fill: tradeVolume = 6, sizeDecrease = 1+3 = 4
      await processDelta(service, 'blofin', 'BTC-USDT', makeDelta({
        price, sizeDelta: -3, type: 'fill', time: now + 200,
      }));
      // Addition (refill): sizeDecrease = max(0, 4-3) = 1
      await processDelta(service, 'blofin', 'BTC-USDT', makeDelta({
        price, sizeDelta: 3, type: 'addition', time: now + 300,
      }));

      // Fill: tradeVolume = 9, sizeDecrease = 1+3 = 4
      await processDelta(service, 'blofin', 'BTC-USDT', makeDelta({
        price, sizeDelta: -3, type: 'fill', time: now + 400,
      }));
      // Addition (refill): sizeDecrease = max(0, 4-3) = 1
      await processDelta(service, 'blofin', 'BTC-USDT', makeDelta({
        price, sizeDelta: 3, type: 'addition', time: now + 500,
      }));

      // Final state: tradeVolume = 9, sizeDecrease = 1
      // ratio = 9 / 1 = 9.0 >= 3 ✓
      expect(emitSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'absorption',
          price,
        }),
      );
    });
  });

  // ── Edge cases ────────────────────────────────────────────────────

  describe('edge cases', () => {
    it('handles multiple symbols independently', async () => {
      const now = Date.now();

      service.updateBookDepth('blofin', 'BTC-USDT', 1000);
      service.updateBookDepth('blofin', 'ETH-USDT', 1000);

      // Spoof on BTC-USDT
      await processDelta(service, 'blofin', 'BTC-USDT', makeDelta({
        price: 35000, sizeDelta: 25, type: 'addition', time: now,
      }));
      await processDelta(service, 'blofin', 'BTC-USDT', makeDelta({
        price: 35000, sizeDelta: -25, type: 'cancellation', time: now + 1000,
      }));

      // Verify only BTC-USDT spoof emitted
      const spoofCalls = emitSpy.mock.calls.filter(
        (c: any[]) => c[0].type === 'spoof',
      );
      expect(spoofCalls.every((c: any[]) => c[0].symbol === 'BTC-USDT')).toBe(true);
    });

    it('cleans up state on stop()', async () => {
      const now = Date.now();

      service.updateBookDepth('blofin', 'BTC-USDT', 1000);
      await processDelta(service, 'blofin', 'BTC-USDT', makeDelta({
        price: 35000, sizeDelta: 25, type: 'addition', time: now,
      }));

      await service.stop();

      // Internal maps should be cleared
      expect((service as any).icebergStates.size).toBe(0);
      expect((service as any).spoofCandidates.size).toBe(0);
      expect((service as any).absorptionTrackers.size).toBe(0);
    });
  });
});
