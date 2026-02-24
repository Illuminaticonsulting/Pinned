import { Router, Request, Response } from 'express';
import { z } from 'zod';
import crypto from 'crypto';
import { pool } from '../db';
import { logger } from '../utils/logger';
import { verifyToken, optionalAuth } from '../middleware/auth';

const router = Router();

// ─── Validation Schemas ──────────────────────────────────────────────────────

const candlesQuerySchema = z.object({
  exchange: z.enum(['blofin', 'mexc']),
  symbol: z.string().min(1).max(30),
  timeframe: z.enum(['1m', '5m', '15m', '1h', '4h', '1d']),
  limit: z.coerce.number().int().min(1).max(5000).default(500),
  before: z.coerce.number().optional(), // timestamp, fetch candles before this time
});

const signalsQuerySchema = z.object({
  symbol: z.string().min(1).max(30),
  since: z.coerce.number(), // timestamp
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function generateShortId(): string {
  // 8-char alphanumeric ID (48 bits of entropy)
  return crypto.randomBytes(6).toString('base64url').slice(0, 8);
}

// ─── POST /charts/share ──────────────────────────────────────────────────────

router.post('/share', verifyToken, async (req: Request, res: Response) => {
  try {
    const { state } = req.body;
    if (!state || typeof state !== 'object') {
      res.status(400).json({ error: 'Chart state is required' });
      return;
    }

    const userId = req.user!.userId;
    const shortId = generateShortId();
    const now = new Date().toISOString();

    // Ensure uniqueness (unlikely collision, but check)
    let attempts = 0;
    let id = shortId;
    while (attempts < 5) {
      const existing = await pool.query(
        'SELECT id FROM shared_charts WHERE short_id = $1',
        [id],
      );
      if (existing.rows.length === 0) break;
      id = generateShortId();
      attempts++;
    }

    if (attempts >= 5) {
      res.status(500).json({ error: 'Failed to generate unique short ID' });
      return;
    }

    await pool.query(
      `INSERT INTO shared_charts (short_id, user_id, state, view_count, created_at)
       VALUES ($1, $2, $3, 0, $4)`,
      [id, userId, JSON.stringify(state), now],
    );

    logger.info('Charts: shared chart created', { shortId: id, userId });

    res.status(201).json({
      shortId: id,
      url: `/charts/share/${id}`,
      createdAt: new Date(now).getTime(),
    });
  } catch (err) {
    logger.error('Charts: share failed', { error: String(err) });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── GET /charts/share/:id ───────────────────────────────────────────────────

router.get('/share/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    // Increment view count and return state
    const result = await pool.query(
      `UPDATE shared_charts SET view_count = view_count + 1
       WHERE short_id = $1
       RETURNING short_id, user_id, state, view_count, created_at`,
      [id],
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Shared chart not found' });
      return;
    }

    const row = result.rows[0];

    res.json({
      shortId: row.short_id,
      userId: row.user_id,
      state: typeof row.state === 'string' ? JSON.parse(row.state) : row.state,
      viewCount: row.view_count,
      createdAt: new Date(row.created_at).getTime(),
    });
  } catch (err) {
    logger.error('Charts: get shared chart failed', { error: String(err) });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── GET /charts/candles ─────────────────────────────────────────────────────

router.get('/candles', async (req: Request, res: Response) => {
  try {
    const parsed = candlesQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
      return;
    }

    const { exchange, symbol, timeframe, limit, before } = parsed.data;

    let query = `
      SELECT time, open, high, low, close, volume, buy_volume, sell_volume
      FROM candles
      WHERE exchange = $1 AND symbol = $2 AND timeframe = $3
    `;
    const params: any[] = [exchange, symbol, timeframe];
    let paramIndex = 4;

    if (before) {
      query += ` AND time < $${paramIndex++}`;
      params.push(new Date(before).toISOString());
    }

    query += ` ORDER BY time DESC LIMIT $${paramIndex}`;
    params.push(limit);

    const result = await pool.query(query, params);

    const candles = result.rows.reverse().map((row) => ({
      time: new Date(row.time).getTime(),
      open: parseFloat(row.open),
      high: parseFloat(row.high),
      low: parseFloat(row.low),
      close: parseFloat(row.close),
      volume: parseFloat(row.volume),
      buyVolume: parseFloat(row.buy_volume),
      sellVolume: parseFloat(row.sell_volume),
      exchange,
      symbol,
      timeframe,
    }));

    res.json(candles);
  } catch (err) {
    logger.error('Charts: candles query failed', { error: String(err) });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── GET /charts/signals ─────────────────────────────────────────────────────

router.get('/signals', optionalAuth, async (req: Request, res: Response) => {
  try {
    const parsed = signalsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
      return;
    }

    const { symbol, since, limit } = parsed.data;

    const result = await pool.query(
      `SELECT id, time, symbol, direction, confidence, reasoning,
              triggers, pattern_type, regime, metadata
       FROM signals
       WHERE symbol = $1 AND time > $2
       ORDER BY time DESC
       LIMIT $3`,
      [symbol, new Date(since).toISOString(), limit],
    );

    const signals = result.rows.map((row) => ({
      id: row.id,
      time: new Date(row.time).getTime(),
      symbol: row.symbol,
      direction: row.direction,
      confidence: parseFloat(row.confidence),
      reasoning: row.reasoning,
      triggers: typeof row.triggers === 'string' ? JSON.parse(row.triggers) : row.triggers,
      patternType: row.pattern_type,
      regime: row.regime || undefined,
      metadata: row.metadata
        ? (typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata)
        : undefined,
    }));

    res.json(signals);
  } catch (err) {
    logger.error('Charts: signals query failed', { error: String(err) });
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
