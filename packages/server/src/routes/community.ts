import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { redis } from '../utils/redis';
import { pool } from '../db';
import { logger } from '../utils/logger';
import { verifyToken, optionalAuth } from '../middleware/auth';

const router = Router();

// ─── Constants ───────────────────────────────────────────────────────────────

const ROOM_TTL_SECONDS = 12 * 3600; // 12 hours max broadcast session

// ─── POST /community/broadcast ───────────────────────────────────────────────

router.post('/broadcast', verifyToken, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.userId;

    // Get broadcaster display name
    const userResult = await pool.query(
      'SELECT display_name FROM users WHERE id = $1',
      [userId],
    );

    const displayName = userResult.rows.length > 0
      ? userResult.rows[0].display_name
      : 'Unknown';

    const roomId = uuidv4().slice(0, 8);

    // Store room metadata in Redis
    const roomData = {
      broadcasterId: userId,
      broadcasterName: displayName,
      viewerCount: 0,
      status: 'live',
      createdAt: Date.now(),
    };

    await redis.set(
      `broadcast:room:${roomId}`,
      JSON.stringify(roomData),
      'EX',
      ROOM_TTL_SECONDS,
    );

    // Track active rooms per user
    await redis.sadd(`broadcast:user:${userId}`, roomId);

    logger.info('Community: broadcast room created', { roomId, userId });

    res.status(201).json({
      roomId,
      broadcasterName: displayName,
      status: 'live',
      createdAt: roomData.createdAt,
    });
  } catch (err) {
    logger.error('Community: create broadcast failed', { error: String(err) });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── DELETE /community/broadcast/:roomId ─────────────────────────────────────

router.delete('/broadcast/:roomId', verifyToken, async (req: Request, res: Response) => {
  try {
    const { roomId } = req.params;
    const userId = req.user!.userId;

    const raw = await redis.get(`broadcast:room:${roomId}`);
    if (!raw) {
      res.status(404).json({ error: 'Broadcast room not found' });
      return;
    }

    const roomData = JSON.parse(raw);

    // Only broadcaster can end
    if (roomData.broadcasterId !== userId) {
      res.status(403).json({ error: 'Only the broadcaster can end this broadcast' });
      return;
    }

    // Mark as ended
    roomData.status = 'ended';
    await redis.set(
      `broadcast:room:${roomId}`,
      JSON.stringify(roomData),
      'EX',
      300, // Keep for 5 minutes after end
    );

    // Remove from user's active rooms
    await redis.srem(`broadcast:user:${userId}`, roomId);

    // Clean up viewer set
    await redis.del(`broadcast:viewers:${roomId}`);

    logger.info('Community: broadcast ended', { roomId, userId });

    res.json({ success: true, roomId });
  } catch (err) {
    logger.error('Community: end broadcast failed', { error: String(err) });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── GET /community/broadcast/:roomId ────────────────────────────────────────

router.get('/broadcast/:roomId', async (req: Request, res: Response) => {
  try {
    const { roomId } = req.params;

    const raw = await redis.get(`broadcast:room:${roomId}`);
    if (!raw) {
      res.status(404).json({ error: 'Broadcast room not found' });
      return;
    }

    const roomData = JSON.parse(raw);

    // Get live viewer count
    const viewerCount = await redis.scard(`broadcast:viewers:${roomId}`);

    res.json({
      roomId,
      broadcasterName: roomData.broadcasterName,
      broadcasterId: roomData.broadcasterId,
      viewerCount: viewerCount || 0,
      status: roomData.status,
      createdAt: roomData.createdAt,
    });
  } catch (err) {
    logger.error('Community: get broadcast info failed', { error: String(err) });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── POST /community/broadcast/:roomId/join ──────────────────────────────────

router.post('/broadcast/:roomId/join', optionalAuth, async (req: Request, res: Response) => {
  try {
    const { roomId } = req.params;

    const raw = await redis.get(`broadcast:room:${roomId}`);
    if (!raw) {
      res.status(404).json({ error: 'Broadcast room not found' });
      return;
    }

    const roomData = JSON.parse(raw);

    if (roomData.status !== 'live') {
      res.status(410).json({ error: 'Broadcast has ended' });
      return;
    }

    // Track viewer (use userId if authenticated, otherwise generate anonymous ID)
    const viewerId = req.user?.userId || `anon_${Date.now().toString(36)}`;
    await redis.sadd(`broadcast:viewers:${roomId}`, viewerId);

    // Update viewer count
    const viewerCount = await redis.scard(`broadcast:viewers:${roomId}`);
    roomData.viewerCount = viewerCount;
    await redis.set(
      `broadcast:room:${roomId}`,
      JSON.stringify(roomData),
      'KEEPTTL',
    );

    logger.info('Community: viewer joined broadcast', {
      roomId,
      viewerId,
      viewerCount,
    });

    res.json({
      roomId,
      viewerId,
      viewerCount: viewerCount || 0,
      broadcasterName: roomData.broadcasterName,
      status: roomData.status,
    });
  } catch (err) {
    logger.error('Community: join broadcast failed', { error: String(err) });
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
