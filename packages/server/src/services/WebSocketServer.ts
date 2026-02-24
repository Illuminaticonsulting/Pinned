import http from 'http';
import { URL } from 'url';
import WebSocket, { WebSocketServer as WSServer } from 'ws';
import jwt from 'jsonwebtoken';
import { logger } from '../utils/logger';
import { redis, redisSub } from '../utils/redis';
import { pool } from '../db';
import { config } from '../config';
import Redis from 'ioredis';
import type {
  WSSubscribeMessage,
  WSUnsubscribeMessage,
  SyncMutation,
} from '@pinned/shared-types';

// ─── Constants ───────────────────────────────────────────────────────────────

const PING_INTERVAL_MS = 30_000;
const PONG_TIMEOUT_MS = 10_000;
const MAX_SEND_BUFFER_BYTES = 1_048_576; // 1 MB
const HEATMAP_THROTTLE_INTERVAL = 250; // 4/sec
const TRADES_THROTTLE_INTERVAL = 100; // 10/sec
const INITIAL_CANDLE_LIMIT = 500;

// ─── Binary Message Types ────────────────────────────────────────────────────

const MSG_TYPE_HEATMAP = 0x01;

// ─── Types ───────────────────────────────────────────────────────────────────

interface UserPayload {
  userId: string;
  email: string;
}

interface ClientState {
  ws: WebSocket;
  user: UserPayload | null;
  channels: Set<string>;
  subscribers: Map<string, Redis>; // channel -> dedicated subscriber
  alive: boolean;
  lastHeatmapSend: Map<string, number>; // channel -> timestamp
  lastTradeSend: Map<string, number>;
  pendingMessages: Map<string, unknown[]>; // channel -> queued messages
  rooms: Set<string>; // broadcast room IDs
  isBroadcaster: Map<string, boolean>; // roomId -> true if broadcaster
}

interface BroadcastRoom {
  broadcasterId: string;
  viewers: Set<string>; // client IDs
}

// ─── Metrics ─────────────────────────────────────────────────────────────────

interface Metrics {
  connectionCount: number;
  messagesSentPerSec: number;
  bytesSentPerSec: number;
}

// ─── Server ──────────────────────────────────────────────────────────────────

export class WebSocketServer {
  private wss: WSServer | null = null;
  private httpServer: http.Server | null = null;
  private clients = new Map<string, ClientState>();
  private channelClients = new Map<string, Set<string>>(); // channel -> set of client IDs
  private rooms = new Map<string, BroadcastRoom>();
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private metricsTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  // Metrics counters
  private totalMessagesSent = 0;
  private totalBytesSent = 0;
  private messagesSentWindow: number[] = [];
  private bytesSentWindow: number[] = [];

  // ─── Lifecycle ───────────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    this.httpServer = http.createServer((_req, res) => {
      res.writeHead(426, { 'Content-Type': 'text/plain' });
      res.end('WebSocket connections only');
    });

    this.wss = new WSServer({ noServer: true });

    // Handle HTTP upgrade with JWT auth
    this.httpServer.on('upgrade', (req, socket, head) => {
      this.authenticate(req)
        .then((user) => {
          this.wss!.handleUpgrade(req, socket, head, (ws) => {
            this.wss!.emit('connection', ws, req, user);
          });
        })
        .catch((err) => {
          logger.warn('WebSocket: auth failed on upgrade', {
            error: String(err),
            ip: req.socket.remoteAddress,
          });
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
          socket.destroy();
        });
    });

    this.wss.on('connection', (ws: WebSocket, _req: http.IncomingMessage, user: UserPayload | null) => {
      this.handleConnection(ws, user);
    });

    // Ping interval
    this.pingTimer = setInterval(() => this.pingAll(), PING_INTERVAL_MS);

    // Metrics logging
    this.metricsTimer = setInterval(() => {
      const m = this.getMetrics();
      logger.info('WebSocket: metrics', {
        connections: m.connectionCount,
        msgPerSec: m.messagesSentPerSec.toFixed(1),
        bytesPerSec: m.bytesSentPerSec.toFixed(0),
      });
    }, 30_000);

    return new Promise<void>((resolve, reject) => {
      this.httpServer!.listen(config.WS_PORT, () => {
        logger.info('WebSocket: server started', { port: config.WS_PORT });
        resolve();
      });
      this.httpServer!.on('error', reject);
    });
  }

  async stop(): Promise<void> {
    this.running = false;

    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.metricsTimer) {
      clearInterval(this.metricsTimer);
      this.metricsTimer = null;
    }

    // Close all client connections
    for (const [, state] of this.clients) {
      this.cleanupClient(state);
      state.ws.close(1001, 'Server shutting down');
    }
    this.clients.clear();
    this.channelClients.clear();
    this.rooms.clear();

    // Close WSS
    if (this.wss) {
      await new Promise<void>((resolve) => {
        this.wss!.close(() => resolve());
      });
      this.wss = null;
    }

    // Close HTTP server
    if (this.httpServer) {
      await new Promise<void>((resolve) => {
        this.httpServer!.close(() => resolve());
      });
      this.httpServer = null;
    }

    logger.info('WebSocket: server stopped');
  }

  // ─── Authentication ──────────────────────────────────────────────────────

  private async authenticate(req: http.IncomingMessage): Promise<UserPayload | null> {
    let token: string | null = null;

    // Try query string
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    token = url.searchParams.get('token');

    // Try cookie
    if (!token && req.headers.cookie) {
      const cookies = req.headers.cookie.split(';').reduce<Record<string, string>>((acc, c) => {
        const [key, val] = c.trim().split('=');
        if (key && val) acc[key] = decodeURIComponent(val);
        return acc;
      }, {});
      token = cookies['access_token'] || null;
    }

    if (!token) {
      // Allow unauthenticated connections for public data
      return null;
    }

    try {
      const payload = jwt.verify(token, config.JWT_SECRET) as UserPayload;
      return payload;
    } catch {
      throw new Error('Invalid or expired token');
    }
  }

  // ─── Connection Handling ─────────────────────────────────────────────────

  private handleConnection(ws: WebSocket, user: UserPayload | null): void {
    const clientId = this.generateClientId();

    const state: ClientState = {
      ws,
      user,
      channels: new Set(),
      subscribers: new Map(),
      alive: true,
      lastHeatmapSend: new Map(),
      lastTradeSend: new Map(),
      pendingMessages: new Map(),
      rooms: new Set(),
      isBroadcaster: new Map(),
    };

    this.clients.set(clientId, state);

    logger.info('WebSocket: client connected', {
      clientId,
      userId: user?.userId ?? 'anonymous',
      totalClients: this.clients.size,
    });

    ws.on('message', (data: WebSocket.RawData) => {
      this.handleMessage(clientId, state, data);
    });

    ws.on('pong', () => {
      state.alive = true;
    });

    ws.on('close', (code, reason) => {
      logger.info('WebSocket: client disconnected', {
        clientId,
        userId: user?.userId ?? 'anonymous',
        code,
        reason: reason.toString(),
      });
      this.cleanupClient(state);
      this.removeClientFromAllChannels(clientId);
      this.removeClientFromAllRooms(clientId, state);
      this.clients.delete(clientId);
    });

    ws.on('error', (err) => {
      logger.error('WebSocket: client error', {
        clientId,
        error: String(err),
      });
    });
  }

  private handleMessage(clientId: string, state: ClientState, raw: WebSocket.RawData): void {
    let msg: any;

    try {
      msg = JSON.parse(raw.toString());
    } catch {
      this.sendJson(state, { type: 'error', data: 'Invalid JSON', timestamp: Date.now() });
      return;
    }

    switch (msg.type) {
      case 'subscribe':
        this.handleSubscribe(clientId, state, msg as WSSubscribeMessage);
        break;
      case 'unsubscribe':
        this.handleUnsubscribe(clientId, state, msg as WSUnsubscribeMessage);
        break;
      case 'sync_mutation':
        this.handleSyncMutation(clientId, state, msg);
        break;
      default:
        this.sendJson(state, {
          type: 'error',
          data: `Unknown message type: ${msg.type}`,
          timestamp: Date.now(),
        });
    }
  }

  // ─── Subscribe / Unsubscribe ─────────────────────────────────────────────

  private async handleSubscribe(
    clientId: string,
    state: ClientState,
    msg: WSSubscribeMessage,
  ): Promise<void> {
    if (!msg.channels || !Array.isArray(msg.channels)) return;

    for (const channel of msg.channels) {
      if (state.channels.has(channel)) continue;

      state.channels.add(channel);

      // Track channel → client mapping
      if (!this.channelClients.has(channel)) {
        this.channelClients.set(channel, new Set());
      }
      this.channelClients.get(channel)!.add(clientId);

      // Set up Redis subscriber for this channel
      await this.subscribeRedisChannel(clientId, state, channel);

      // Send initial payloads based on channel type
      await this.sendInitialPayload(state, channel);
    }
  }

  private async handleUnsubscribe(
    clientId: string,
    state: ClientState,
    msg: WSUnsubscribeMessage,
  ): Promise<void> {
    if (!msg.channels || !Array.isArray(msg.channels)) return;

    for (const channel of msg.channels) {
      if (!state.channels.has(channel)) continue;

      state.channels.delete(channel);

      // Remove from channel → client mapping
      const clients = this.channelClients.get(channel);
      if (clients) {
        clients.delete(clientId);
        if (clients.size === 0) {
          this.channelClients.delete(channel);
        }
      }

      // Unsubscribe Redis
      const sub = state.subscribers.get(channel);
      if (sub) {
        try {
          await sub.unsubscribe(channel);
          await sub.quit();
        } catch {
          // ignore
        }
        state.subscribers.delete(channel);
      }
    }
  }

  // ─── Redis Channel Subscription ─────────────────────────────────────────

  private async subscribeRedisChannel(
    _clientId: string,
    state: ClientState,
    channel: string,
  ): Promise<void> {
    // Each client gets a dedicated Redis subscriber per channel
    const sub = new Redis(config.REDIS_URL, {
      maxRetriesPerRequest: null,
      lazyConnect: true,
    });

    try {
      await sub.connect();
    } catch (err) {
      logger.error('WebSocket: Redis subscriber connect failed', {
        channel,
        error: String(err),
      });
      return;
    }

    sub.on('message', (ch: string, message: string) => {
      if (ch !== channel) return;
      this.deliverToClient(state, channel, message);
    });

    try {
      await sub.subscribe(channel);
      state.subscribers.set(channel, sub);
    } catch (err) {
      logger.error('WebSocket: Redis subscribe failed', {
        channel,
        error: String(err),
      });
      await sub.quit().catch(() => {});
    }
  }

  // ─── Initial Payloads ────────────────────────────────────────────────────

  private async sendInitialPayload(state: ClientState, channel: string): Promise<void> {
    const parts = channel.split(':');
    const channelType = parts[0]; // candles, trades, heatmap, orderbook, etc.

    try {
      switch (channelType) {
        case 'candles':
          await this.sendInitialCandles(state, channel, parts);
          break;
        case 'heatmap':
          await this.sendInitialHeatmap(state, channel, parts);
          break;
        case 'orderbook':
          await this.sendInitialOrderbook(state, channel, parts);
          break;
        // trades, signals, etc. don't get initial payloads
      }
    } catch (err) {
      logger.error('WebSocket: failed to send initial payload', {
        channel,
        error: String(err),
      });
    }
  }

  private async sendInitialCandles(
    state: ClientState,
    channel: string,
    parts: string[],
  ): Promise<void> {
    // Channel format: candles:exchange:symbol:timeframe
    if (parts.length < 4) return;

    const [, exchange, symbol, timeframe] = parts;

    const result = await pool.query(
      `SELECT time, open, high, low, close, volume, buy_volume, sell_volume
       FROM candles
       WHERE exchange = $1 AND symbol = $2 AND timeframe = $3
       ORDER BY time DESC
       LIMIT $4`,
      [exchange, symbol, timeframe, INITIAL_CANDLE_LIMIT],
    );

    if (result.rows.length > 0) {
      const candles = result.rows.reverse().map((r) => ({
        time: new Date(r.time).getTime(),
        open: parseFloat(r.open),
        high: parseFloat(r.high),
        low: parseFloat(r.low),
        close: parseFloat(r.close),
        volume: parseFloat(r.volume),
        buyVolume: parseFloat(r.buy_volume),
        sellVolume: parseFloat(r.sell_volume),
        exchange,
        symbol,
        timeframe,
      }));

      this.sendJson(state, {
        type: 'candle',
        channel,
        data: candles,
        timestamp: Date.now(),
      });
    }
  }

  private async sendInitialHeatmap(
    state: ClientState,
    channel: string,
    parts: string[],
  ): Promise<void> {
    // Channel format: heatmap:exchange:symbol
    if (parts.length < 3) return;

    const [, exchange, symbol] = parts;
    const blobKey = `heatmap:${exchange}:${symbol}:precomputed`;

    const blob = await redis.getBuffer(blobKey);
    if (blob) {
      // Send precomputed heatmap as binary
      if (state.ws.readyState === WebSocket.OPEN) {
        state.ws.send(blob, { binary: true });
        this.trackSend(blob.length);
      }
    }
  }

  private async sendInitialOrderbook(
    state: ClientState,
    channel: string,
    parts: string[],
  ): Promise<void> {
    // Channel format: orderbook:exchange:symbol
    if (parts.length < 3) return;

    const [, exchange, symbol] = parts;
    const snapshotKey = `ob:${exchange}:${symbol}:latest`;

    const raw = await redis.get(snapshotKey);
    if (raw) {
      this.sendJson(state, {
        type: 'orderbook',
        channel,
        data: JSON.parse(raw),
        timestamp: Date.now(),
      });
    }
  }

  // ─── Message Delivery with Throttling ────────────────────────────────────

  private deliverToClient(state: ClientState, channel: string, message: string): void {
    if (state.ws.readyState !== WebSocket.OPEN) return;

    const channelType = channel.split(':')[0];
    const now = Date.now();

    // Backpressure check
    if (state.ws.bufferedAmount > MAX_SEND_BUFFER_BYTES) {
      // Drop heatmap frames when backpressured
      if (channelType === 'heatmap') {
        logger.warn('WebSocket: dropping heatmap frame due to backpressure', {
          bufferedAmount: state.ws.bufferedAmount,
          channel,
        });
        return;
      }
    }

    // Throttle heatmap: max 4/sec
    if (channelType === 'heatmap') {
      const lastSend = state.lastHeatmapSend.get(channel) || 0;
      if (now - lastSend < HEATMAP_THROTTLE_INTERVAL) {
        return; // Drop frame
      }
      state.lastHeatmapSend.set(channel, now);

      // Try sending as binary if it looks like binary data
      try {
        const parsed = JSON.parse(message);
        if (parsed.cells && Array.isArray(parsed.cells)) {
          const binary = this.encodeHeatmapBinary(parsed.cells);
          state.ws.send(binary, { binary: true });
          this.trackSend(binary.byteLength);
          return;
        }
      } catch {
        // Not JSON, send as-is
      }
    }

    // Throttle trades: max 10/sec
    if (channelType === 'trades') {
      const lastSend = state.lastTradeSend.get(channel) || 0;
      if (now - lastSend < TRADES_THROTTLE_INTERVAL) {
        // Batch: queue message
        if (!state.pendingMessages.has(channel)) {
          state.pendingMessages.set(channel, []);

          // Schedule flush
          setTimeout(() => {
            const pending = state.pendingMessages.get(channel);
            if (pending && pending.length > 0 && state.ws.readyState === WebSocket.OPEN) {
              this.sendJson(state, {
                type: 'trade',
                channel,
                data: pending,
                timestamp: Date.now(),
              });
            }
            state.pendingMessages.delete(channel);
            state.lastTradeSend.set(channel, Date.now());
          }, TRADES_THROTTLE_INTERVAL - (now - lastSend));
        }

        try {
          state.pendingMessages.get(channel)!.push(JSON.parse(message));
        } catch {
          state.pendingMessages.get(channel)!.push(message);
        }
        return;
      }
      state.lastTradeSend.set(channel, now);
    }

    // Default: forward message
    state.ws.send(message);
    this.trackSend(Buffer.byteLength(message, 'utf-8'));
  }

  // ─── Binary Protocol for Heatmap ────────────────────────────────────────

  /**
   * Encodes heatmap cells as binary:
   * [uint8 msgType][uint16 cellCount][cells...]
   * Each cell: [uint16 priceIndex][uint16 timeIndex][float32 intensity][float32 maxSize]
   */
  private encodeHeatmapBinary(
    cells: Array<{ priceIndex: number; timeIndex: number; intensity: number; maxSize: number }>,
  ): ArrayBuffer {
    const HEADER_SIZE = 3; // 1 byte msgType + 2 bytes cellCount
    const CELL_SIZE = 12; // 2 + 2 + 4 + 4
    const buffer = new ArrayBuffer(HEADER_SIZE + cells.length * CELL_SIZE);
    const view = new DataView(buffer);

    view.setUint8(0, MSG_TYPE_HEATMAP);
    view.setUint16(1, cells.length);

    let offset = HEADER_SIZE;
    for (const cell of cells) {
      view.setUint16(offset, cell.priceIndex);
      view.setUint16(offset + 2, cell.timeIndex);
      view.setFloat32(offset + 4, cell.intensity);
      view.setFloat32(offset + 8, cell.maxSize);
      offset += CELL_SIZE;
    }

    return buffer;
  }

  // ─── Sync Mutations (Live Chart Sync) ────────────────────────────────────

  private handleSyncMutation(clientId: string, state: ClientState, msg: any): void {
    if (!state.user) {
      this.sendJson(state, {
        type: 'error',
        data: 'Authentication required for sync_mutation',
        timestamp: Date.now(),
      });
      return;
    }

    const mutation: SyncMutation = {
      type: msg.data?.type,
      data: msg.data?.data,
      userId: state.user.userId,
      timestamp: Date.now(),
    };

    // Forward to all rooms where this user is the broadcaster
    for (const roomId of state.rooms) {
      if (state.isBroadcaster.get(roomId)) {
        this.broadcastToRoom(roomId, clientId, {
          type: 'sync_mutation',
          data: mutation,
          timestamp: Date.now(),
        });
      }
    }
  }

  // ─── Broadcast Rooms ────────────────────────────────────────────────────

  createRoom(roomId: string, broadcasterId: string): void {
    this.rooms.set(roomId, {
      broadcasterId,
      viewers: new Set(),
    });

    // Find the broadcaster's client and mark them
    for (const [, state] of this.clients) {
      if (state.user?.userId === broadcasterId) {
        state.rooms.add(roomId);
        state.isBroadcaster.set(roomId, true);
        break;
      }
    }

    logger.info('WebSocket: room created', { roomId, broadcasterId });
  }

  joinRoom(roomId: string, viewerId: string): boolean {
    const room = this.rooms.get(roomId);
    if (!room) return false;

    room.viewers.add(viewerId);

    // Find viewer client and track room membership
    for (const [, state] of this.clients) {
      if (state.user?.userId === viewerId) {
        state.rooms.add(roomId);
        state.isBroadcaster.set(roomId, false);
        break;
      }
    }

    logger.info('WebSocket: user joined room', {
      roomId,
      viewerId,
      viewerCount: room.viewers.size,
    });
    return true;
  }

  leaveRoom(roomId: string, userId: string): void {
    const room = this.rooms.get(roomId);
    if (!room) return;

    room.viewers.delete(userId);

    for (const [, state] of this.clients) {
      if (state.user?.userId === userId) {
        state.rooms.delete(roomId);
        state.isBroadcaster.delete(roomId);
        break;
      }
    }

    // If broadcaster leaves, close the room
    if (room.broadcasterId === userId) {
      this.rooms.delete(roomId);
      logger.info('WebSocket: room closed (broadcaster left)', { roomId });
    } else {
      logger.info('WebSocket: user left room', {
        roomId,
        userId,
        viewerCount: room.viewers.size,
      });
    }
  }

  getRoomInfo(roomId: string): { broadcasterId: string; viewerCount: number } | null {
    const room = this.rooms.get(roomId);
    if (!room) return null;
    return {
      broadcasterId: room.broadcasterId,
      viewerCount: room.viewers.size,
    };
  }

  private broadcastToRoom(roomId: string, senderClientId: string, data: unknown): void {
    const room = this.rooms.get(roomId);
    if (!room) return;

    const payload = JSON.stringify(data);

    for (const [cid, state] of this.clients) {
      if (cid === senderClientId) continue;
      if (!state.rooms.has(roomId)) continue;

      if (state.ws.readyState === WebSocket.OPEN) {
        state.ws.send(payload);
        this.trackSend(Buffer.byteLength(payload, 'utf-8'));
      }
    }
  }

  // ─── Broadcast to Channel ───────────────────────────────────────────────

  broadcastToChannel(channel: string, data: unknown): void {
    const subscriberIds = this.channelClients.get(channel);
    if (!subscriberIds || subscriberIds.size === 0) return;

    const payload = typeof data === 'string' ? data : JSON.stringify(data);
    const payloadBytes = Buffer.byteLength(payload, 'utf-8');

    for (const clientId of subscriberIds) {
      const state = this.clients.get(clientId);
      if (!state || state.ws.readyState !== WebSocket.OPEN) continue;

      // Backpressure check
      if (state.ws.bufferedAmount > MAX_SEND_BUFFER_BYTES) {
        const channelType = channel.split(':')[0];
        if (channelType === 'heatmap') {
          logger.warn('WebSocket: dropping broadcast heatmap (backpressure)', {
            clientId,
            channel,
          });
          continue;
        }
      }

      state.ws.send(payload);
      this.trackSend(payloadBytes);
    }
  }

  // ─── Ping / Pong ────────────────────────────────────────────────────────

  private pingAll(): void {
    for (const [clientId, state] of this.clients) {
      if (!state.alive) {
        logger.warn('WebSocket: client unresponsive, disconnecting', { clientId });
        state.ws.terminate();
        this.cleanupClient(state);
        this.removeClientFromAllChannels(clientId);
        this.removeClientFromAllRooms(clientId, state);
        this.clients.delete(clientId);
        continue;
      }

      state.alive = false;
      state.ws.ping();

      // Set a timeout: if no pong within 10s, mark as dead
      setTimeout(() => {
        if (!state.alive && this.clients.has(clientId)) {
          logger.warn('WebSocket: pong timeout, disconnecting', { clientId });
          state.ws.terminate();
          this.cleanupClient(state);
          this.removeClientFromAllChannels(clientId);
          this.removeClientFromAllRooms(clientId, state);
          this.clients.delete(clientId);
        }
      }, PONG_TIMEOUT_MS);
    }
  }

  // ─── Cleanup Helpers ─────────────────────────────────────────────────────

  private cleanupClient(state: ClientState): void {
    for (const [, sub] of state.subscribers) {
      sub.quit().catch(() => {});
    }
    state.subscribers.clear();
    state.channels.clear();
    state.pendingMessages.clear();
  }

  private removeClientFromAllChannels(clientId: string): void {
    for (const [channel, clients] of this.channelClients) {
      clients.delete(clientId);
      if (clients.size === 0) {
        this.channelClients.delete(channel);
      }
    }
  }

  private removeClientFromAllRooms(clientId: string, state: ClientState): void {
    for (const roomId of state.rooms) {
      const room = this.rooms.get(roomId);
      if (!room) continue;

      if (state.user) {
        room.viewers.delete(state.user.userId);

        if (room.broadcasterId === state.user.userId) {
          // Broadcaster disconnected — close room
          this.rooms.delete(roomId);
          logger.info('WebSocket: room closed (broadcaster disconnected)', { roomId });
        }
      }
    }
    state.rooms.clear();
    state.isBroadcaster.clear();
  }

  // ─── Utilities ───────────────────────────────────────────────────────────

  private sendJson(state: ClientState, data: unknown): void {
    if (state.ws.readyState !== WebSocket.OPEN) return;

    const payload = JSON.stringify(data);
    state.ws.send(payload);
    this.trackSend(Buffer.byteLength(payload, 'utf-8'));
  }

  private trackSend(bytes: number): void {
    this.totalMessagesSent++;
    this.totalBytesSent += bytes;
    const now = Date.now();
    this.messagesSentWindow.push(now);
    this.bytesSentWindow.push(bytes);
  }

  private generateClientId(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }

  // ─── Metrics ─────────────────────────────────────────────────────────────

  getMetrics(): Metrics {
    const cutoff = Date.now() - 10_000;

    // Clean old window entries
    this.messagesSentWindow = this.messagesSentWindow.filter((ts) => ts >= cutoff);

    let recentBytes = 0;
    const newByteWindow: number[] = [];
    // bytesSentWindow stores byte values, not timestamps — pair with messagesSentWindow
    // For simplicity, recalculate
    const msgPerSec = this.messagesSentWindow.length / 10;

    // Estimate bytes/sec from total counters
    const bytesPerSec = this.bytesSentWindow.reduce((a, b) => a + b, 0) / 10;
    this.bytesSentWindow = [];

    return {
      connectionCount: this.clients.size,
      messagesSentPerSec: msgPerSec,
      bytesSentPerSec: bytesPerSec,
    };
  }

  getConnectedClientsPerInstrument(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const [channel, clients] of this.channelClients) {
      counts[channel] = clients.size;
    }
    return counts;
  }

  getConnectionCount(): number {
    return this.clients.size;
  }
}
