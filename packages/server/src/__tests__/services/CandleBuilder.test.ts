// ── Mocks ──────────────────────────────────────────────────────────────────

jest.mock('../../utils/redis', () => ({
  redis: {
    publish: jest.fn().mockResolvedValue(1),
    xread: jest.fn().mockResolvedValue(null),
  },
  redisSub: {
    subscribe: jest.fn(),
    on: jest.fn(),
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

import { CandleBuilderService } from '../../services/CandleBuilderService';
import { pool } from '../../db';
import { redis } from '../../utils/redis';
import type { Trade } from '@pinned/shared-types';

// ── Helpers ────────────────────────────────────────────────────────────────

function makeTrade(overrides: Partial<Trade> = {}): Trade {
  return {
    time: 60_000, // exactly at 1-minute bucket boundary
    price: 36000,
    size: 1.0,
    side: 'buy',
    tradeId: 'test-1',
    exchange: 'blofin',
    symbol: 'BTC-USDT',
    ...overrides,
  };
}

/**
 * Access private processTrade and candles map for testing.
 */
function processTrade(service: CandleBuilderService, trade: Trade) {
  return (service as any).processTrade(trade);
}

function getCandles(service: CandleBuilderService): Map<string, any> {
  return (service as any).candles;
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('CandleBuilderService', () => {
  let service: CandleBuilderService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new CandleBuilderService();
  });

  describe('candle construction from trades', () => {
    it('creates a new candle from the first trade in a time bucket', () => {
      processTrade(service, makeTrade({ time: 60_000, price: 36000, size: 2 }));

      const candles = getCandles(service);
      const key = 'blofin:BTC-USDT:1m';
      const candle = candles.get(key);

      expect(candle).toBeDefined();
      expect(candle.open).toBe(36000);
      expect(candle.high).toBe(36000);
      expect(candle.low).toBe(36000);
      expect(candle.close).toBe(36000);
      expect(candle.volume).toBe(2);
      expect(candle.time).toBe(60_000); // floored to minute
    });

    it('updates OHLCV correctly with subsequent trades', () => {
      processTrade(service, makeTrade({ time: 60_000, price: 36000, size: 1 }));
      processTrade(service, makeTrade({ time: 60_500, price: 36500, size: 0.5 })); // new high
      processTrade(service, makeTrade({ time: 61_000, price: 35800, size: 0.3 })); // new low, still same bucket (within 60s)
      processTrade(service, makeTrade({ time: 61_500, price: 36200, size: 0.2 })); // close

      const candle = getCandles(service).get('blofin:BTC-USDT:1m');

      expect(candle.open).toBe(36000);
      expect(candle.high).toBe(36500);
      expect(candle.low).toBe(35800);
      expect(candle.close).toBe(36200);
      expect(candle.volume).toBe(2.0); // 1 + 0.5 + 0.3 + 0.2
    });
  });

  describe('buy/sell volume splitting', () => {
    it('separates buy and sell volumes correctly', () => {
      processTrade(service, makeTrade({ time: 60_000, price: 36000, size: 3, side: 'buy' }));
      processTrade(service, makeTrade({ time: 60_100, price: 36000, size: 2, side: 'sell' }));
      processTrade(service, makeTrade({ time: 60_200, price: 36000, size: 1, side: 'buy' }));

      const candle = getCandles(service).get('blofin:BTC-USDT:1m');

      expect(candle.buyVolume).toBe(4); // 3 + 1
      expect(candle.sellVolume).toBe(2);
      expect(candle.volume).toBe(6); // total
    });
  });

  describe('time boundary crossing triggers flush', () => {
    it('flushes and creates a new candle when trade crosses time boundary', async () => {
      const closeCandle = jest.spyOn(service as any, 'closeCandle').mockResolvedValue(undefined);

      // Trade in minute 1 (bucket = 60_000)
      processTrade(service, makeTrade({ time: 60_000, price: 36000, size: 1 }));

      // Trade in minute 2 (bucket = 120_000) — triggers close of minute 1
      processTrade(service, makeTrade({ time: 120_000, price: 36100, size: 0.5 }));

      expect(closeCandle).toHaveBeenCalledTimes(6); // once for each of the 6 timeframes
      closeCandle.mockRestore();
    });
  });

  describe('multi-timeframe candles', () => {
    it('creates candles for all 6 timeframes from a single trade', () => {
      processTrade(service, makeTrade({ time: 300_000, price: 36000, size: 1 }));

      const candles = getCandles(service);
      // Should have entries for 1m, 5m, 15m, 1h, 4h, 1d
      expect(candles.has('blofin:BTC-USDT:1m')).toBe(true);
      expect(candles.has('blofin:BTC-USDT:5m')).toBe(true);
      expect(candles.has('blofin:BTC-USDT:15m')).toBe(true);
      expect(candles.has('blofin:BTC-USDT:1h')).toBe(true);
      expect(candles.has('blofin:BTC-USDT:4h')).toBe(true);
      expect(candles.has('blofin:BTC-USDT:1d')).toBe(true);
    });
  });

  describe('OHLCV correctness', () => {
    it('maintains correct high and low across many trades', () => {
      const prices = [100, 105, 98, 102, 110, 95, 103];
      for (const [i, price] of prices.entries()) {
        processTrade(service, makeTrade({ time: 60_000 + i * 10, price, size: 1 }));
      }

      const candle = getCandles(service).get('blofin:BTC-USDT:1m');

      expect(candle.open).toBe(100);
      expect(candle.high).toBe(110);
      expect(candle.low).toBe(95);
      expect(candle.close).toBe(103);
      expect(candle.volume).toBe(7);
    });
  });
});
