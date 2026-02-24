import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { pool } from '../db';
import { redis } from '../utils/redis';
import { logger } from '../utils/logger';
import { verifyToken } from '../middleware/auth';

const router = Router();

// All routes require authentication
router.use(verifyToken);

// ─── Validation Schemas ──────────────────────────────────────────────────────

const createWatchlistSchema = z.object({
  name: z.string().min(1).max(100).trim(),
  symbols: z.array(z.string().min(1).max(30)).min(1).max(50),
});

const updateWatchlistSchema = z.object({
  name: z.string().min(1).max(100).trim().optional(),
  symbols: z.array(z.string().min(1).max(30)).min(1).max(50).optional(),
});

// ─── GET /watchlists ─────────────────────────────────────────────────────────

router.get('/', async (req: Request, res: Response) => {
  try {
    const userId = req.user!.userId;

    const result = await pool.query(
      `SELECT id, name, symbols, created_at, updated_at
       FROM watchlists
       WHERE user_id = $1
       ORDER BY created_at ASC`,
      [userId],
    );

    const watchlists = result.rows.map((row) => ({
      id: row.id,
      userId,
      name: row.name,
      symbols: typeof row.symbols === 'string' ? JSON.parse(row.symbols) : row.symbols,
      createdAt: new Date(row.created_at).getTime(),
      updatedAt: new Date(row.updated_at).getTime(),
    }));

    res.json(watchlists);
  } catch (err) {
    logger.error('Watchlists: list failed', { error: String(err) });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── POST /watchlists ────────────────────────────────────────────────────────

router.post('/', async (req: Request, res: Response) => {
  try {
    const parsed = createWatchlistSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
      return;
    }

    const { name, symbols } = parsed.data;
    const userId = req.user!.userId;
    const id = uuidv4();
    const now = new Date().toISOString();

    await pool.query(
      `INSERT INTO watchlists (id, user_id, name, symbols, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, userId, name, JSON.stringify(symbols), now, now],
    );

    res.status(201).json({
      id,
      userId,
      name,
      symbols,
      createdAt: new Date(now).getTime(),
      updatedAt: new Date(now).getTime(),
    });
  } catch (err) {
    logger.error('Watchlists: create failed', { error: String(err) });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── PUT /watchlists/:id ─────────────────────────────────────────────────────

router.put('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const userId = req.user!.userId;

    // Verify ownership
    const existing = await pool.query(
      'SELECT user_id FROM watchlists WHERE id = $1',
      [id],
    );

    if (existing.rows.length === 0) {
      res.status(404).json({ error: 'Watchlist not found' });
      return;
    }

    if (existing.rows[0].user_id !== userId) {
      res.status(403).json({ error: 'Not authorized' });
      return;
    }

    const parsed = updateWatchlistSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
      return;
    }

    const updates = parsed.data;
    const setClauses: string[] = [];
    const params: any[] = [];
    let paramIndex = 1;

    if (updates.name !== undefined) {
      setClauses.push(`name = $${paramIndex++}`);
      params.push(updates.name);
    }

    if (updates.symbols !== undefined) {
      setClauses.push(`symbols = $${paramIndex++}`);
      params.push(JSON.stringify(updates.symbols));
    }

    if (setClauses.length === 0) {
      res.status(400).json({ error: 'No valid fields to update' });
      return;
    }

    setClauses.push(`updated_at = NOW()`);
    params.push(id);

    const result = await pool.query(
      `UPDATE watchlists SET ${setClauses.join(', ')} WHERE id = $${paramIndex}
       RETURNING id, name, symbols, created_at, updated_at`,
      params,
    );

    const row = result.rows[0];
    res.json({
      id: row.id,
      userId,
      name: row.name,
      symbols: typeof row.symbols === 'string' ? JSON.parse(row.symbols) : row.symbols,
      createdAt: new Date(row.created_at).getTime(),
      updatedAt: new Date(row.updated_at).getTime(),
    });
  } catch (err) {
    logger.error('Watchlists: update failed', { error: String(err) });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── DELETE /watchlists/:id ──────────────────────────────────────────────────

router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const userId = req.user!.userId;

    const result = await pool.query(
      'DELETE FROM watchlists WHERE id = $1 AND user_id = $2 RETURNING id',
      [id, userId],
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Watchlist not found or not authorized' });
      return;
    }

    res.json({ success: true, id });
  } catch (err) {
    logger.error('Watchlists: delete failed', { error: String(err) });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── GET /watchlists/:id/live ────────────────────────────────────────────────

router.get('/:id/live', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const userId = req.user!.userId;

    const result = await pool.query(
      `SELECT id, name, symbols, created_at, updated_at
       FROM watchlists
       WHERE id = $1 AND user_id = $2`,
      [id, userId],
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Watchlist not found or not authorized' });
      return;
    }

    const row = result.rows[0];
    const symbols: string[] = typeof row.symbols === 'string'
      ? JSON.parse(row.symbols)
      : row.symbols;

    // Fetch live prices from Redis for each symbol
    const livePrices: Record<string, {
      lastPrice: number | null;
      change24h: number | null;
      volume24h: number | null;
      high24h: number | null;
      low24h: number | null;
    }> = {};

    const exchanges = ['blofin', 'mexc'];

    await Promise.all(
      symbols.map(async (symbol) => {
        for (const exchange of exchanges) {
          try {
            const tickerRaw = await redis.get(`ticker:${exchange}:${symbol}`);
            if (tickerRaw) {
              const ticker = JSON.parse(tickerRaw);
              livePrices[symbol] = {
                lastPrice: ticker.lastPrice ?? null,
                change24h: ticker.change24h ?? null,
                volume24h: ticker.volume24h ?? null,
                high24h: ticker.high24h ?? null,
                low24h: ticker.low24h ?? null,
              };
              return; // Got data from first available exchange
            }
          } catch {
            // Try next exchange
          }
        }

        // No data found
        livePrices[symbol] = {
          lastPrice: null,
          change24h: null,
          volume24h: null,
          high24h: null,
          low24h: null,
        };
      }),
    );

    res.json({
      id: row.id,
      userId,
      name: row.name,
      symbols,
      livePrices,
      createdAt: new Date(row.created_at).getTime(),
      updatedAt: new Date(row.updated_at).getTime(),
    });
  } catch (err) {
    logger.error('Watchlists: live prices failed', { error: String(err) });
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
