/**
 * BroadcastService — Live chart sync broadcast service.
 *
 * Manages broadcast rooms in Redis for real-time chart synchronisation
 * between a broadcaster and multiple viewers via Pub/Sub.
 */

import { v4 as uuidv4 } from 'uuid';
import { redis, redisSub } from '../utils/redis';
import { logger } from '../utils/logger';
import type { SyncMutation } from '@pinned/shared-types';

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface BroadcastRoom {
  broadcasterId: string;
  startedAt: number;
  viewerCount: number;
  status: 'live' | 'ended';
}

export interface RoomInfo extends BroadcastRoom {
  roomId: string;
}

// ─── Constants ─────────────────────────────────────────────────────────────────

const ROOM_TTL_SECONDS = 4 * 3600; // 4 hours
const ROOM_KEY = (id: string) => `broadcast:rooms:${id}`;
const VIEWERS_KEY = (id: string) => `broadcast:viewers:${id}`;
const STREAM_CHANNEL = (id: string) => `broadcast:stream:${id}`;

// ─── Service ───────────────────────────────────────────────────────────────────

class BroadcastService {
  private subscriptions = new Map<string, (message: string) => void>();

  // ── Create Room ────────────────────────────────────────────────────────

  async createRoom(broadcasterId: string): Promise<string> {
    const roomId = uuidv4().slice(0, 8);
    const key = ROOM_KEY(roomId);

    const room: BroadcastRoom = {
      broadcasterId,
      startedAt: Date.now(),
      viewerCount: 0,
      status: 'live',
    };

    await redis.hset(key, {
      broadcasterId: room.broadcasterId,
      startedAt: String(room.startedAt),
      viewerCount: '0',
      status: 'live',
    });
    await redis.expire(key, ROOM_TTL_SECONDS);

    // Track room as active
    await redis.sadd('broadcast:active_rooms', roomId);

    logger.info('BroadcastService: room created', { roomId, broadcasterId });
    return roomId;
  }

  // ── End Room ───────────────────────────────────────────────────────────

  async endRoom(roomId: string, userId: string): Promise<void> {
    const key = ROOM_KEY(roomId);
    const broadcasterId = await redis.hget(key, 'broadcasterId');

    if (!broadcasterId) {
      throw new Error(`Room ${roomId} not found`);
    }

    if (broadcasterId !== userId) {
      throw new Error('Only the broadcaster can end the room');
    }

    // Clean up all room data
    const pipeline = redis.pipeline();
    pipeline.del(key);
    pipeline.del(VIEWERS_KEY(roomId));
    pipeline.srem('broadcast:active_rooms', roomId);
    await pipeline.exec();

    // Notify subscribers that the room has ended
    await redis.publish(
      STREAM_CHANNEL(roomId),
      JSON.stringify({ type: 'room_ended', roomId, timestamp: Date.now() }),
    );

    logger.info('BroadcastService: room ended', { roomId, userId });
  }

  // ── Join Room ──────────────────────────────────────────────────────────

  async joinRoom(roomId: string, viewerId: string): Promise<void> {
    const key = ROOM_KEY(roomId);
    const exists = await redis.exists(key);
    if (!exists) {
      throw new Error(`Room ${roomId} not found`);
    }

    const status = await redis.hget(key, 'status');
    if (status !== 'live') {
      throw new Error(`Room ${roomId} is not live`);
    }

    await redis.sadd(VIEWERS_KEY(roomId), viewerId);
    await redis.hincrby(key, 'viewerCount', 1);

    logger.debug('BroadcastService: viewer joined', { roomId, viewerId });
  }

  // ── Leave Room ─────────────────────────────────────────────────────────

  async leaveRoom(roomId: string, viewerId: string): Promise<void> {
    const key = ROOM_KEY(roomId);

    const removed = await redis.srem(VIEWERS_KEY(roomId), viewerId);
    if (removed > 0) {
      await redis.hincrby(key, 'viewerCount', -1);
    }

    logger.debug('BroadcastService: viewer left', { roomId, viewerId });
  }

  // ── Broadcast Mutation ─────────────────────────────────────────────────

  async broadcastMutation(roomId: string, mutation: SyncMutation): Promise<void> {
    const key = ROOM_KEY(roomId);
    const broadcasterId = await redis.hget(key, 'broadcasterId');

    if (!broadcasterId) {
      throw new Error(`Room ${roomId} not found`);
    }

    if (broadcasterId !== mutation.userId) {
      throw new Error('Only the broadcaster can send mutations');
    }

    const payload = JSON.stringify(mutation);
    await redis.publish(STREAM_CHANNEL(roomId), payload);

    logger.debug('BroadcastService: mutation published', {
      roomId,
      type: mutation.type,
    });
  }

  // ── Subscribe to Mutations ─────────────────────────────────────────────

  async subscribeMutations(
    roomId: string,
    callback: (mutation: SyncMutation | { type: 'room_ended'; roomId: string }) => void,
  ): Promise<() => Promise<void>> {
    const channel = STREAM_CHANNEL(roomId);

    const handler = (message: string) => {
      try {
        const parsed = JSON.parse(message);
        callback(parsed);
      } catch (err) {
        logger.error('BroadcastService: failed to parse mutation', {
          error: String(err),
          roomId,
        });
      }
    };

    this.subscriptions.set(channel, handler);

    await redisSub.subscribe(channel);
    redisSub.on('message', (ch: string, msg: string) => {
      if (ch === channel) {
        handler(msg);
      }
    });

    logger.debug('BroadcastService: subscribed to mutations', { roomId });

    // Return unsubscribe function
    return async () => {
      this.subscriptions.delete(channel);
      await redisSub.unsubscribe(channel);
      logger.debug('BroadcastService: unsubscribed from mutations', { roomId });
    };
  }

  // ── Get Room Info ──────────────────────────────────────────────────────

  async getRoomInfo(roomId: string): Promise<RoomInfo | null> {
    const key = ROOM_KEY(roomId);
    const data = await redis.hgetall(key);

    if (!data || !data.broadcasterId) {
      return null;
    }

    // Get accurate viewer count from set
    const viewerCount = await redis.scard(VIEWERS_KEY(roomId));

    return {
      roomId,
      broadcasterId: data.broadcasterId,
      startedAt: parseInt(data.startedAt, 10),
      viewerCount: viewerCount || 0,
      status: data.status as 'live' | 'ended',
    };
  }

  // ── List Active Rooms ──────────────────────────────────────────────────

  async listActiveRooms(): Promise<RoomInfo[]> {
    const roomIds = await redis.smembers('broadcast:active_rooms');
    const rooms: RoomInfo[] = [];

    for (const roomId of roomIds) {
      const info = await this.getRoomInfo(roomId);
      if (info && info.status === 'live') {
        rooms.push(info);
      } else {
        // Stale entry — remove from active set
        await redis.srem('broadcast:active_rooms', roomId);
      }
    }

    return rooms;
  }
}

export const broadcastService = new BroadcastService();
