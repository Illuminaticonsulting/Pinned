import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { redis } from '../utils/redis';
import { logger } from '../utils/logger';

const router = Router();

// ─── Validation Schemas ──────────────────────────────────────────────────────

const tickerQuerySchema = z.object({
  exchange: z.enum(['blofin', 'mexc']),
  symbol: z.string().min(1).max(30),
});

const orderbookQuerySchema = z.object({
  exchange: z.enum(['blofin', 'mexc']),
  symbol: z.string().min(1).max(30),
});

const fundingQuerySchema = z.object({
  exchange: z.enum(['blofin', 'mexc']),
  symbol: z.string().min(1).max(30),
});

const tradesQuerySchema = z.object({
  exchange: z.enum(['blofin', 'mexc']),
  symbol: z.string().min(1).max(30),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

// ─── GET /market/ticker ──────────────────────────────────────────────────────

router.get('/ticker', async (req: Request, res: Response) => {
  try {
    const parsed = tickerQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
      return;
    }

    const { exchange, symbol } = parsed.data;
    const key = `ticker:${exchange}:${symbol}`;

    const raw = await redis.get(key);
    if (!raw) {
      res.status(404).json({ error: 'Ticker data not available' });
      return;
    }

    const ticker = JSON.parse(raw);
    res.json(ticker);
  } catch (err) {
    logger.error('Market: ticker fetch failed', { error: String(err) });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── GET /market/orderbook ───────────────────────────────────────────────────

router.get('/orderbook', async (req: Request, res: Response) => {
  try {
    const parsed = orderbookQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
      return;
    }

    const { exchange, symbol } = parsed.data;
    const key = `ob:${exchange}:${symbol}:latest`;

    const raw = await redis.get(key);
    if (!raw) {
      res.status(404).json({ error: 'Orderbook data not available' });
      return;
    }

    const orderbook = JSON.parse(raw);
    res.json(orderbook);
  } catch (err) {
    logger.error('Market: orderbook fetch failed', { error: String(err) });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── GET /market/funding ─────────────────────────────────────────────────────

router.get('/funding', async (req: Request, res: Response) => {
  try {
    const parsed = fundingQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
      return;
    }

    const { exchange, symbol } = parsed.data;
    const key = `funding:${exchange}:${symbol}`;

    const raw = await redis.get(key);
    if (!raw) {
      res.status(404).json({ error: 'Funding rate data not available' });
      return;
    }

    const funding = JSON.parse(raw);
    res.json(funding);
  } catch (err) {
    logger.error('Market: funding fetch failed', { error: String(err) });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── GET /market/trades ──────────────────────────────────────────────────────

router.get('/trades', async (req: Request, res: Response) => {
  try {
    const parsed = tradesQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
      return;
    }

    const { exchange, symbol, limit } = parsed.data;
    const streamKey = `trades:${exchange}:${symbol}`;

    // Read from Redis stream (newest to oldest)
    const entries = await redis.xrevrange(streamKey, '+', '-', 'COUNT', limit);

    if (!entries || entries.length === 0) {
      res.json([]);
      return;
    }

    const trades = entries.map(([id, fields]) => {
      const data: Record<string, string> = {};
      for (let i = 0; i < fields.length; i += 2) {
        data[fields[i]] = fields[i + 1];
      }

      return {
        time: parseInt(data.time, 10) || 0,
        price: parseFloat(data.price) || 0,
        size: parseFloat(data.size) || 0,
        side: data.side || 'buy',
        tradeId: data.tradeId || id,
        exchange,
        symbol,
      };
    });

    // Reverse to chronological order
    trades.reverse();

    res.json(trades);
  } catch (err) {
    logger.error('Market: trades fetch failed', { error: String(err) });
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
