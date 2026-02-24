import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { pool } from '../db';
import { redis } from '../utils/redis';
import { logger } from '../utils/logger';
import { config } from '../config';
import {
  verifyToken,
  generateTokens,
  verifyRefreshToken,
  authRateLimiter,
} from '../middleware/auth';

const router = Router();

// ─── Validation Schemas ──────────────────────────────────────────────────────

const registerSchema = z.object({
  email: z.string().email().max(255),
  password: z.string().min(8).max(128),
  displayName: z.string().min(1).max(100).trim(),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const refreshSchema = z.object({
  refreshToken: z.string().min(1),
});

const updateProfileSchema = z.object({
  displayName: z.string().min(1).max(100).trim().optional(),
  avatar: z.string().url().max(500).optional(),
  preferences: z
    .object({
      defaultSymbol: z.string().optional(),
      defaultTimeframe: z.enum(['1m', '5m', '15m', '1h', '4h', '1d']).optional(),
      theme: z.enum(['dark', 'darker']).optional(),
      defaultExchange: z.enum(['blofin', 'mexc']).optional(),
    })
    .optional(),
});

// ─── Cookie Config ───────────────────────────────────────────────────────────

const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: config.NODE_ENV === 'production',
  sameSite: 'lax' as const,
  path: '/',
};

// ─── POST /register ──────────────────────────────────────────────────────────

router.post('/register', authRateLimiter, async (req: Request, res: Response) => {
  try {
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
      return;
    }

    const { email, password, displayName } = parsed.data;

    // Check if user already exists
    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
    if (existing.rows.length > 0) {
      res.status(409).json({ error: 'Email already registered' });
      return;
    }

    // Hash password
    const passwordHash = await bcrypt.hash(password, 12);

    // Insert user
    const userId = uuidv4();
    const now = new Date().toISOString();

    await pool.query(
      `INSERT INTO users (id, email, display_name, password_hash, created_at, preferences)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        userId,
        email.toLowerCase(),
        displayName,
        passwordHash,
        now,
        JSON.stringify({
          defaultSymbol: 'BTC-USDT',
          defaultTimeframe: '1m',
          theme: 'dark',
          defaultExchange: 'blofin',
        }),
      ],
    );

    // Generate tokens
    const tokens = generateTokens(userId, email.toLowerCase());

    // Set cookie
    res.cookie('access_token', tokens.accessToken, COOKIE_OPTIONS);

    logger.info('Auth: user registered', { userId, email: email.toLowerCase() });

    res.status(201).json({
      user: {
        id: userId,
        email: email.toLowerCase(),
        displayName,
        createdAt: new Date(now).getTime(),
      },
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
    });
  } catch (err) {
    logger.error('Auth: register failed', { error: String(err) });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── POST /login ─────────────────────────────────────────────────────────────

router.post('/login', authRateLimiter, async (req: Request, res: Response) => {
  try {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
      return;
    }

    const { email, password } = parsed.data;

    // Find user
    const result = await pool.query(
      `SELECT id, email, display_name, password_hash, avatar, created_at, preferences
       FROM users
       WHERE email = $1`,
      [email.toLowerCase()],
    );

    if (result.rows.length === 0) {
      res.status(401).json({ error: 'Invalid email or password' });
      return;
    }

    const user = result.rows[0];

    // Compare password
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      res.status(401).json({ error: 'Invalid email or password' });
      return;
    }

    // Generate tokens
    const tokens = generateTokens(user.id, user.email);

    // Set cookie
    res.cookie('access_token', tokens.accessToken, COOKIE_OPTIONS);

    logger.info('Auth: user logged in', { userId: user.id });

    res.json({
      user: {
        id: user.id,
        email: user.email,
        displayName: user.display_name,
        avatar: user.avatar || undefined,
        createdAt: new Date(user.created_at).getTime(),
        preferences: typeof user.preferences === 'string'
          ? JSON.parse(user.preferences)
          : user.preferences,
      },
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
    });
  } catch (err) {
    logger.error('Auth: login failed', { error: String(err) });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── POST /refresh ───────────────────────────────────────────────────────────

router.post('/refresh', authRateLimiter, async (req: Request, res: Response) => {
  try {
    const parsed = refreshSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
      return;
    }

    const { refreshToken } = parsed.data;

    // Check if token is blacklisted
    const blacklisted = await redis.get(`rt_blacklist:${refreshToken}`);
    if (blacklisted) {
      res.status(401).json({ error: 'Token has been revoked' });
      return;
    }

    // Verify refresh token
    let payload;
    try {
      payload = verifyRefreshToken(refreshToken);
    } catch {
      res.status(401).json({ error: 'Invalid or expired refresh token' });
      return;
    }

    // Blacklist old refresh token (TTL = refresh token expiry)
    await redis.set(`rt_blacklist:${refreshToken}`, '1', 'EX', 7 * 24 * 3600);

    // Generate new token pair
    const tokens = generateTokens(payload.userId, payload.email);

    // Set cookie
    res.cookie('access_token', tokens.accessToken, COOKIE_OPTIONS);

    res.json({
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
    });
  } catch (err) {
    logger.error('Auth: refresh failed', { error: String(err) });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── POST /logout ────────────────────────────────────────────────────────────

router.post('/logout', async (req: Request, res: Response) => {
  try {
    const { refreshToken } = req.body || {};

    // Blacklist refresh token if provided
    if (refreshToken && typeof refreshToken === 'string') {
      await redis.set(`rt_blacklist:${refreshToken}`, '1', 'EX', 7 * 24 * 3600);
    }

    // Clear cookies
    res.clearCookie('access_token', COOKIE_OPTIONS);

    res.json({ success: true });
  } catch (err) {
    logger.error('Auth: logout failed', { error: String(err) });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── GET /me ─────────────────────────────────────────────────────────────────

router.get('/me', verifyToken, async (req: Request, res: Response) => {
  try {
    const result = await pool.query(
      `SELECT id, email, display_name, avatar, created_at, preferences
       FROM users
       WHERE id = $1`,
      [req.user!.userId],
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    const user = result.rows[0];

    res.json({
      id: user.id,
      email: user.email,
      displayName: user.display_name,
      avatar: user.avatar || undefined,
      createdAt: new Date(user.created_at).getTime(),
      preferences: typeof user.preferences === 'string'
        ? JSON.parse(user.preferences)
        : user.preferences,
    });
  } catch (err) {
    logger.error('Auth: get profile failed', { error: String(err) });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── PATCH /me ───────────────────────────────────────────────────────────────

router.patch('/me', verifyToken, async (req: Request, res: Response) => {
  try {
    const parsed = updateProfileSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
      return;
    }

    const updates = parsed.data;
    const setClauses: string[] = [];
    const params: any[] = [];
    let paramIndex = 1;

    if (updates.displayName !== undefined) {
      setClauses.push(`display_name = $${paramIndex++}`);
      params.push(updates.displayName);
    }
    if (updates.avatar !== undefined) {
      setClauses.push(`avatar = $${paramIndex++}`);
      params.push(updates.avatar);
    }
    if (updates.preferences !== undefined) {
      // Merge with existing preferences
      setClauses.push(`preferences = preferences || $${paramIndex++}::jsonb`);
      params.push(JSON.stringify(updates.preferences));
    }

    if (setClauses.length === 0) {
      res.status(400).json({ error: 'No valid fields to update' });
      return;
    }

    setClauses.push(`updated_at = NOW()`);
    params.push(req.user!.userId);

    const result = await pool.query(
      `UPDATE users SET ${setClauses.join(', ')} WHERE id = $${paramIndex}
       RETURNING id, email, display_name, avatar, created_at, preferences`,
      params,
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    const user = result.rows[0];

    res.json({
      id: user.id,
      email: user.email,
      displayName: user.display_name,
      avatar: user.avatar || undefined,
      createdAt: new Date(user.created_at).getTime(),
      preferences: typeof user.preferences === 'string'
        ? JSON.parse(user.preferences)
        : user.preferences,
    });
  } catch (err) {
    logger.error('Auth: update profile failed', { error: String(err) });
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
