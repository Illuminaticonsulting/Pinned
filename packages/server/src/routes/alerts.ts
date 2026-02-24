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

const createAlertSchema = z.object({
  symbol: z.string().min(1).max(30),
  condition: z.object({
    type: z.enum([
      'price_cross',
      'delta_divergence',
      'ofi_threshold',
      'absorption',
      'funding_spike',
      'pattern',
    ]),
    value: z.number(),
    operator: z.enum(['gt', 'lt', 'cross_above', 'cross_below']),
  }),
  delivery: z.array(z.enum(['in_app', 'browser_push', 'telegram', 'email'])).min(1),
  expiresAt: z.number().optional(),
});

const updateAlertSchema = z.object({
  symbol: z.string().min(1).max(30).optional(),
  condition: z
    .object({
      type: z.enum([
        'price_cross',
        'delta_divergence',
        'ofi_threshold',
        'absorption',
        'funding_spike',
        'pattern',
      ]),
      value: z.number(),
      operator: z.enum(['gt', 'lt', 'cross_above', 'cross_below']),
    })
    .optional(),
  delivery: z.array(z.enum(['in_app', 'browser_push', 'telegram', 'email'])).min(1).optional(),
  active: z.boolean().optional(),
  expiresAt: z.number().nullable().optional(),
});

// ─── GET /alerts ─────────────────────────────────────────────────────────────

router.get('/', async (req: Request, res: Response) => {
  try {
    const userId = req.user!.userId;
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 20));
    const offset = (page - 1) * limit;

    const countResult = await pool.query(
      'SELECT COUNT(*) as total FROM alerts WHERE user_id = $1',
      [userId],
    );
    const total = parseInt(countResult.rows[0].total, 10);

    const result = await pool.query(
      `SELECT id, symbol, condition_type, condition_value, condition_operator,
              delivery, active, created_at, last_triggered, expires_at
       FROM alerts
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT $2 OFFSET $3`,
      [userId, limit, offset],
    );

    const alerts = result.rows.map((row) => ({
      id: row.id,
      userId,
      symbol: row.symbol,
      condition: {
        type: row.condition_type,
        value: row.condition_value,
        operator: row.condition_operator,
      },
      delivery: row.delivery,
      active: row.active,
      createdAt: new Date(row.created_at).getTime(),
      lastTriggered: row.last_triggered ? new Date(row.last_triggered).getTime() : undefined,
      expiresAt: row.expires_at ? new Date(row.expires_at).getTime() : undefined,
    }));

    res.json({
      alerts,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (err) {
    logger.error('Alerts: list failed', { error: String(err) });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── POST /alerts ────────────────────────────────────────────────────────────

router.post('/', async (req: Request, res: Response) => {
  try {
    const parsed = createAlertSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
      return;
    }

    const { symbol, condition, delivery, expiresAt } = parsed.data;
    const userId = req.user!.userId;
    const id = uuidv4();
    const now = new Date().toISOString();

    await pool.query(
      `INSERT INTO alerts (id, user_id, symbol, condition_type, condition_value,
                           condition_operator, delivery, active, created_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, true, $8, $9)`,
      [
        id,
        userId,
        symbol,
        condition.type,
        condition.value,
        condition.operator,
        delivery,
        now,
        expiresAt ? new Date(expiresAt).toISOString() : null,
      ],
    );

    res.status(201).json({
      id,
      userId,
      symbol,
      condition,
      delivery,
      active: true,
      createdAt: new Date(now).getTime(),
      expiresAt: expiresAt || undefined,
    });
  } catch (err) {
    logger.error('Alerts: create failed', { error: String(err) });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── PUT /alerts/:id ─────────────────────────────────────────────────────────

router.put('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const userId = req.user!.userId;

    // Verify ownership
    const existing = await pool.query(
      'SELECT user_id FROM alerts WHERE id = $1',
      [id],
    );

    if (existing.rows.length === 0) {
      res.status(404).json({ error: 'Alert not found' });
      return;
    }

    if (existing.rows[0].user_id !== userId) {
      res.status(403).json({ error: 'Not authorized' });
      return;
    }

    const parsed = updateAlertSchema.safeParse(req.body);
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
    if (updates.condition !== undefined) {
      setClauses.push(`condition_type = $${paramIndex++}`);
      params.push(updates.condition.type);
      setClauses.push(`condition_value = $${paramIndex++}`);
      params.push(updates.condition.value);
      setClauses.push(`condition_operator = $${paramIndex++}`);
      params.push(updates.condition.operator);
    }
    if (updates.delivery !== undefined) {
      setClauses.push(`delivery = $${paramIndex++}`);
      params.push(updates.delivery);
    }
    if (updates.active !== undefined) {
      setClauses.push(`active = $${paramIndex++}`);
      params.push(updates.active);
    }
    if (updates.expiresAt !== undefined) {
      setClauses.push(`expires_at = $${paramIndex++}`);
      params.push(updates.expiresAt ? new Date(updates.expiresAt).toISOString() : null);
    }

    if (setClauses.length === 0) {
      res.status(400).json({ error: 'No valid fields to update' });
      return;
    }

    params.push(id);

    const result = await pool.query(
      `UPDATE alerts SET ${setClauses.join(', ')} WHERE id = $${paramIndex}
       RETURNING id, symbol, condition_type, condition_value, condition_operator,
                 delivery, active, created_at, last_triggered, expires_at`,
      params,
    );

    const row = result.rows[0];
    res.json({
      id: row.id,
      userId,
      symbol: row.symbol,
      condition: {
        type: row.condition_type,
        value: row.condition_value,
        operator: row.condition_operator,
      },
      delivery: row.delivery,
      active: row.active,
      createdAt: new Date(row.created_at).getTime(),
      lastTriggered: row.last_triggered ? new Date(row.last_triggered).getTime() : undefined,
      expiresAt: row.expires_at ? new Date(row.expires_at).getTime() : undefined,
    });
  } catch (err) {
    logger.error('Alerts: update failed', { error: String(err) });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── DELETE /alerts/:id ──────────────────────────────────────────────────────

router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const userId = req.user!.userId;

    const result = await pool.query(
      'DELETE FROM alerts WHERE id = $1 AND user_id = $2 RETURNING id',
      [id, userId],
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Alert not found or not authorized' });
      return;
    }

    res.json({ success: true, id });
  } catch (err) {
    logger.error('Alerts: delete failed', { error: String(err) });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── GET /alerts/history ─────────────────────────────────────────────────────

router.get('/history', async (req: Request, res: Response) => {
  try {
    const userId = req.user!.userId;
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 20));
    const offset = (page - 1) * limit;

    const countResult = await pool.query(
      'SELECT COUNT(*) as total FROM alert_triggers WHERE user_id = $1',
      [userId],
    );
    const total = parseInt(countResult.rows[0].total, 10);

    const result = await pool.query(
      `SELECT at.id, at.alert_id, at.user_id, at.symbol, at.condition_type,
              at.condition_value, at.current_value, at.triggered_at
       FROM alert_triggers at
       WHERE at.user_id = $1
       ORDER BY at.triggered_at DESC
       LIMIT $2 OFFSET $3`,
      [userId, limit, offset],
    );

    const history = result.rows.map((row) => ({
      id: row.id,
      alertId: row.alert_id,
      userId: row.user_id,
      symbol: row.symbol,
      conditionType: row.condition_type,
      conditionValue: row.condition_value,
      currentValue: row.current_value,
      triggeredAt: new Date(row.triggered_at).getTime(),
    }));

    res.json({
      history,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (err) {
    logger.error('Alerts: history failed', { error: String(err) });
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
