import { EventEmitter } from 'events';

// ── Mocks must be declared before imports ──────────────────────────────────

const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

jest.mock('ws', () => {
  class MockWebSocket extends EventEmitter {
    static OPEN = 1;
    readyState = 1; // OPEN
    send = jest.fn();
    close = jest.fn();
    constructor(_url: string) {
      super();
      // simulate async open
      setTimeout(() => this.emit('open'), 0);
    }
  }
  return MockWebSocket;
});

jest.mock('../../utils/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

import { BloFinAdapter } from '../../adapters/blofin';

// ── Helpers ────────────────────────────────────────────────────────────────

function jsonResponse(data: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    json: async () => ({ code: '0', data }),
    headers: new Headers(),
  } as unknown as Response;
}

function rateLimitResponse(): Response {
  return {
    ok: false,
    status: 429,
    statusText: 'Too Many Requests',
    json: async () => ({ code: '50011', msg: 'Rate limited' }),
    headers: new Headers(),
  } as unknown as Response;
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('BloFinAdapter', () => {
  let adapter: BloFinAdapter;

  beforeEach(() => {
    jest.useFakeTimers({ advanceTimers: true });
    adapter = new BloFinAdapter();
    mockFetch.mockReset();
  });

  afterEach(async () => {
    await adapter.disconnect();
    jest.useRealTimers();
  });

  // ── REST tests ─────────────────────────────────────────────────────

  describe('getHistoricalCandles', () => {
    it('constructs the correct URL and parses response into Candle[]', async () => {
      const rawCandle = ['1700000000000', '36000', '36500', '35800', '36200', '150', '80', '70'];
      mockFetch.mockResolvedValueOnce(jsonResponse([rawCandle]));

      const candles = await adapter.getHistoricalCandles('BTC-USDT', '1m', 100);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toContain('/api/v1/market/candles');
      expect(url).toContain('instId=BTC-USDT');
      expect(url).toContain('bar=1m');
      expect(url).toContain('limit=100');

      expect(candles).toHaveLength(1);
      expect(candles[0]).toEqual(
        expect.objectContaining({
          time: 1700000000000,
          open: 36000,
          high: 36500,
          low: 35800,
          close: 36200,
          volume: 150,
          exchange: 'blofin',
          symbol: 'BTC-USDT',
          timeframe: '1m',
        }),
      );
    });

    it('maps timeframe correctly (e.g. "4h" → "4H")', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse([]));
      await adapter.getHistoricalCandles('ETH-USDT', '4h');

      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toContain('bar=4H');
    });

    it('defaults limit to 200', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse([]));
      await adapter.getHistoricalCandles('BTC-USDT', '1m');

      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toContain('limit=200');
    });
  });

  describe('REST error handling & retry logic', () => {
    it('retries on 429 with exponential backoff', async () => {
      mockFetch
        .mockResolvedValueOnce(rateLimitResponse())
        .mockResolvedValueOnce(jsonResponse([]));

      const promise = adapter.getHistoricalCandles('BTC-USDT', '1m');
      // Advance through the retry delay
      await jest.advanceTimersByTimeAsync(600);
      const candles = await promise;

      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(candles).toEqual([]);
    });

    it('throws after exhausting retries', async () => {
      mockFetch
        .mockResolvedValue(rateLimitResponse());

      const promise = adapter.getHistoricalCandles('BTC-USDT', '1m');
      // Attach rejection handler immediately to avoid unhandled rejection
      const assertion = expect(promise).rejects.toThrow();
      // Advance through all retry delays in steps to process recursive timers
      for (let i = 0; i < 10; i++) {
        await jest.advanceTimersByTimeAsync(1000);
      }
      await assertion;
    });
  });

  describe('getOrderbook', () => {
    it('returns an OrderbookSnapshot with parsed levels', async () => {
      const bookData = [
        {
          bids: [['35000', '10'], ['34999', '5']],
          asks: [['35001', '8'], ['35002', '3']],
          ts: '1700000000000',
        },
      ];
      mockFetch.mockResolvedValueOnce(jsonResponse(bookData));

      const ob = await adapter.getOrderbook('BTC-USDT');

      expect(ob.exchange).toBe('blofin');
      expect(ob.symbol).toBe('BTC-USDT');
      expect(ob.time).toBe(1700000000000);
      expect(ob.bids).toHaveLength(2);
      expect(ob.bids[0]).toEqual({ price: 35000, size: 10 });
      expect(ob.asks).toHaveLength(2);
      expect(ob.asks[0]).toEqual({ price: 35001, size: 8 });
    });
  });

  // ── WebSocket tests ────────────────────────────────────────────────

  describe('WebSocket connection', () => {
    it('emits "connected" on successful connection', async () => {
      const connectedCb = jest.fn();
      adapter.on('connected', connectedCb);
      await adapter.connect();

      expect(connectedCb).toHaveBeenCalledTimes(1);
      expect(adapter.connected).toBe(true);
    });

    it('sends subscribe message for trades', async () => {
      await adapter.connect();
      adapter.subscribeTrades('BTC-USDT');

      // Access internal ws to check send calls
      const ws = (adapter as any).ws;
      expect(ws.send).toHaveBeenCalledWith(
        JSON.stringify({
          op: 'subscribe',
          args: [{ channel: 'trades', instId: 'BTC-USDT' }],
        }),
      );
    });

    it('parses trade messages and emits trade events', async () => {
      await adapter.connect();
      const tradeCb = jest.fn();
      adapter.on('trade', tradeCb);

      const ws = (adapter as any).ws;
      const tradeMsg = JSON.stringify({
        arg: { channel: 'trades', instId: 'BTC-USDT' },
        data: [
          { ts: '1700000000000', px: '36000', sz: '1.5', side: 'buy', tradeId: '123' },
        ],
      });
      ws.emit('message', Buffer.from(tradeMsg));

      expect(tradeCb).toHaveBeenCalledTimes(1);
      expect(tradeCb).toHaveBeenCalledWith(
        expect.objectContaining({
          time: 1700000000000,
          price: 36000,
          size: 1.5,
          side: 'buy',
          tradeId: '123',
          exchange: 'blofin',
          symbol: 'BTC-USDT',
        }),
      );
    });

    it('parses orderbook messages and emits orderbook events', async () => {
      await adapter.connect();
      const obCb = jest.fn();
      adapter.on('orderbook', obCb);

      const ws = (adapter as any).ws;
      const obMsg = JSON.stringify({
        arg: { channel: 'books400', instId: 'ETH-USDT' },
        data: [
          {
            bids: [['3000', '100']],
            asks: [['3001', '50']],
            ts: '1700000001000',
          },
        ],
      });
      ws.emit('message', Buffer.from(obMsg));

      expect(obCb).toHaveBeenCalledTimes(1);
      const snap = obCb.mock.calls[0][0];
      expect(snap.bids[0]).toEqual({ price: 3000, size: 100 });
      expect(snap.asks[0]).toEqual({ price: 3001, size: 50 });
    });

    it('schedules reconnect on unexpected close', async () => {
      await adapter.connect();
      const reconnectingCb = jest.fn();
      adapter.on('reconnecting', reconnectingCb);

      const ws = (adapter as any).ws;
      ws.emit('close', 1006, Buffer.from('abnormal'));

      expect(reconnectingCb).toHaveBeenCalledWith(1);
    });
  });
});
