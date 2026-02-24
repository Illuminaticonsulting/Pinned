import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { pool } from '../db';
import { logger } from '../utils/logger';
import { verifyToken } from '../middleware/auth';

const router = Router();

// All routes require authentication
router.use(verifyToken);

// ─── Validation Schemas ──────────────────────────────────────────────────────

const createDrawingSchema = z.object({
  symbol: z.string().min(1).max(30),
  timeframe: z.enum(['1m', '5m', '15m', '1h', '4h', '1d']),
  type: z.enum(['hline', 'trendline', 'rectangle', 'fibonacci', 'anchored_vwap']),
  points: z.array(
    z.object({
      time: z.number(),
      price: z.number(),
    }),
  ).min(1).max(20),
  properties: z.object({
    color: z.string().max(30),
    lineWidth: z.number().min(1).max(10),
    lineStyle: z.enum(['solid', 'dashed', 'dotted']),
    fillColor: z.string().max(30).optional(),
    fillOpacity: z.number().min(0).max(1).optional(),
    extended: z.boolean().optional(),
    levels: z.array(z.number()).optional(),
    label: z.string().max(100).optional(),
  }),
});

const updateDrawingSchema = createDrawingSchema.partial();

// ─── GET /drawings ───────────────────────────────────────────────────────────

router.get('/', async (req: Request, res: Response) => {
  try {
    const { symbol, timeframe } = req.query;
    const userId = req.user!.userId;

    let query = `
      SELECT id, symbol, timeframe, type, points, properties, created_at, updated_at
      FROM drawings
      WHERE user_id = $1
    `;
    const params: any[] = [userId];
    let paramIndex = 2;

    if (symbol && typeof symbol === 'string') {
      query += ` AND symbol = $${paramIndex++}`;
      params.push(symbol);
    }

    if (timeframe && typeof timeframe === 'string') {
      query += ` AND timeframe = $${paramIndex++}`;
      params.push(timeframe);
    }

    query += ` ORDER BY updated_at DESC`;

    const result = await pool.query(query, params);

    const drawings = result.rows.map((row) => ({
      id: row.id,
      userId,
      symbol: row.symbol,
      timeframe: row.timeframe,
      type: row.type,
      points: typeof row.points === 'string' ? JSON.parse(row.points) : row.points,
      properties: typeof row.properties === 'string' ? JSON.parse(row.properties) : row.properties,
      createdAt: new Date(row.created_at).getTime(),
      updatedAt: new Date(row.updated_at).getTime(),
    }));

    res.json(drawings);
  } catch (err) {
    logger.error('Drawings: list failed', { error: String(err) });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── POST /drawings ──────────────────────────────────────────────────────────

router.post('/', async (req: Request, res: Response) => {
  try {
    const parsed = createDrawingSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
      return;
    }

    const { symbol, timeframe, type, points, properties } = parsed.data;
    const userId = req.user!.userId;
    const id = uuidv4();
    const now = new Date().toISOString();

    await pool.query(
      `INSERT INTO drawings (id, user_id, symbol, timeframe, type, points, properties, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [id, userId, symbol, timeframe, type, JSON.stringify(points), JSON.stringify(properties), now, now],
    );

    res.status(201).json({
      id,
      userId,
      symbol,
      timeframe,
      type,
      points,
      properties,
      createdAt: new Date(now).getTime(),
      updatedAt: new Date(now).getTime(),
    });
  } catch (err) {
    logger.error('Drawings: create failed', { error: String(err) });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── PUT /drawings/:id ──────────────────────────────────────────────────────

router.put('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const userId = req.user!.userId;

    // Verify ownership
    const existing = await pool.query(
      'SELECT user_id FROM drawings WHERE id = $1',
      [id],
    );

    if (existing.rows.length === 0) {
      res.status(404).json({ error: 'Drawing not found' });
      return;
    }

    if (existing.rows[0].user_id !== userId) {
      res.status(403).json({ error: 'Not authorized' });
      return;
    }

    const parsed = updateDrawingSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
      return;
    }

    const updates = parsed.data;
    const setClauses: string[] = [];
    const params: any[] = [];
    let paramIndex = 1;

    if (updates.symbol !== undefined) {
      setClauses.push(`symbol = $${paramIndex++}`);
      params.push(updates.symbol);
    }
    if (updates.timeframe !== undefined) {
      setClauses.push(`timeframe = $${paramIndex++}`);
      params.push(updates.timeframe);
    }
    if (updates.type !== undefined) {
      setClauses.push(`type = $${paramIndex++}`);
      params.push(updates.type);
    }
    if (updates.points !== undefined) {
      setClauses.push(`points = $${paramIndex++}`);
      params.push(JSON.stringify(updates.points));
    }
    if (updates.properties !== undefined) {
      setClauses.push(`properties = $${paramIndex++}`);
      params.push(JSON.stringify(updates.properties));
    }

    if (setClauses.length === 0) {
      res.status(400).json({ error: 'No valid fields to update' });
      return;
    }

    setClauses.push(`updated_at = NOW()`);
    params.push(id);

    const result = await pool.query(
      `UPDATE drawings SET ${setClauses.join(', ')} WHERE id = $${paramIndex}
       RETURNING id, symbol, timeframe, type, points, properties, created_at, updated_at`,
      params,
    );

    const row = result.rows[0];
    res.json({
      id: row.id,
      userId,
      symbol: row.symbol,
      timeframe: row.timeframe,
      type: row.type,
      points: typeof row.points === 'string' ? JSON.parse(row.points) : row.points,
      properties: typeof row.properties === 'string' ? JSON.parse(row.properties) : row.properties,
      createdAt: new Date(row.created_at).getTime(),
      updatedAt: new Date(row.updated_at).getTime(),
    });
  } catch (err) {
    logger.error('Drawings: update failed', { error: String(err) });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── DELETE /drawings/:id ────────────────────────────────────────────────────

router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const userId = req.user!.userId;

    const result = await pool.query(
      'DELETE FROM drawings WHERE id = $1 AND user_id = $2 RETURNING id',
      [id, userId],
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Drawing not found or not authorized' });
      return;
    }

    res.json({ success: true, id });
  } catch (err) {
    logger.error('Drawings: delete failed', { error: String(err) });
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
