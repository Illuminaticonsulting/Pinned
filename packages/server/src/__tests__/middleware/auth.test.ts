import jwt from 'jsonwebtoken';
import type { Request, Response, NextFunction } from 'express';

// ── Mocks ──────────────────────────────────────────────────────────────────

const mockRedisMulti = {
  incr: jest.fn().mockReturnThis(),
  pttl: jest.fn().mockReturnThis(),
  exec: jest.fn().mockResolvedValue([
    [null, 1],  // count
    [null, -1], // ttl
  ]),
};

jest.mock('../../utils/redis', () => ({
  redis: {
    multi: () => mockRedisMulti,
    pexpire: jest.fn().mockResolvedValue(1),
    incr: jest.fn(),
    get: jest.fn(),
  },
}));

jest.mock('../../config', () => ({
  config: {
    JWT_SECRET: 'test-jwt-secret',
    JWT_REFRESH_SECRET: 'test-refresh-secret',
    JWT_EXPIRY: '15m',
    JWT_REFRESH_EXPIRY: '7d',
  },
}));

jest.mock('../../utils/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

import { verifyToken, generateTokens, apiRateLimiter } from '../../middleware/auth';

// ── Helpers ────────────────────────────────────────────────────────────────

function mockReq(overrides: Partial<Request> = {}): Request {
  return {
    headers: {},
    cookies: {},
    ip: '127.0.0.1',
    socket: { remoteAddress: '127.0.0.1' },
    ...overrides,
  } as unknown as Request;
}

function mockRes(): Response {
  const res = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
    setHeader: jest.fn().mockReturnThis(),
  } as unknown as Response;
  return res;
}

function mockNext(): NextFunction {
  return jest.fn();
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('Auth middleware', () => {
  const JWT_SECRET = 'test-jwt-secret';

  describe('verifyToken', () => {
    it('passes through with valid JWT and populates req.user', async () => {
      const token = jwt.sign(
        { userId: 'user-1', email: 'test@pinned.dev' },
        JWT_SECRET,
        { expiresIn: '1h' },
      );

      const req = mockReq({
        headers: { authorization: `Bearer ${token}` },
      });
      const res = mockRes();
      const next = mockNext();

      await verifyToken(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(req.user).toBeDefined();
      expect(req.user!.userId).toBe('user-1');
      expect(req.user!.email).toBe('test@pinned.dev');
    });

    it('returns 401 when token is expired', () => {
      const token = jwt.sign(
        { userId: 'user-1', email: 'test@pinned.dev' },
        JWT_SECRET,
        { expiresIn: '-1s' }, // already expired
      );

      const req = mockReq({
        headers: { authorization: `Bearer ${token}` },
      });
      const res = mockRes();
      const next = mockNext();

      verifyToken(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: 'Token expired' }),
      );
    });

    it('returns 401 when no token is provided', () => {
      const req = mockReq();
      const res = mockRes();
      const next = mockNext();

      verifyToken(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: 'Authentication required' }),
      );
    });

    it('returns 401 with malformed token', () => {
      const req = mockReq({
        headers: { authorization: 'Bearer not-a-valid-jwt' },
      });
      const res = mockRes();
      const next = mockNext();

      verifyToken(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: 'Invalid token' }),
      );
    });

    it('returns 401 with token signed by wrong secret', () => {
      const token = jwt.sign(
        { userId: 'user-1', email: 'test@pinned.dev' },
        'wrong-secret',
        { expiresIn: '1h' },
      );

      const req = mockReq({
        headers: { authorization: `Bearer ${token}` },
      });
      const res = mockRes();
      const next = mockNext();

      verifyToken(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(401);
    });

    it('reads token from cookies if no Authorization header', async () => {
      const token = jwt.sign(
        { userId: 'user-2', email: 'cookie@pinned.dev' },
        JWT_SECRET,
        { expiresIn: '1h' },
      );

      const req = mockReq({
        cookies: { access_token: token },
      });
      const res = mockRes();
      const next = mockNext();

      await verifyToken(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(req.user!.userId).toBe('user-2');
    });
  });

  describe('generateTokens', () => {
    it('generates valid access and refresh tokens', () => {
      const tokens = generateTokens('user-1', 'test@pinned.dev');

      expect(tokens.accessToken).toBeDefined();
      expect(tokens.refreshToken).toBeDefined();

      const decoded = jwt.verify(tokens.accessToken, JWT_SECRET) as any;
      expect(decoded.userId).toBe('user-1');
      expect(decoded.email).toBe('test@pinned.dev');
    });
  });

  describe('rate limiter', () => {
    it('returns 429 when request count exceeds limit', async () => {
      // Mock Redis to return count above limit (> 100)
      mockRedisMulti.exec.mockResolvedValueOnce([
        [null, 101], // count exceeds limit
        [null, 55_000], // TTL in ms
      ]);

      const req = mockReq();
      const res = mockRes();
      const next = mockNext();

      await apiRateLimiter(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(429);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: 'Too many requests' }),
      );
    });

    it('allows requests within the rate limit', async () => {
      mockRedisMulti.exec.mockResolvedValueOnce([
        [null, 5], // count within limit
        [null, 55_000],
      ]);

      const req = mockReq();
      const res = mockRes();
      const next = mockNext();

      await apiRateLimiter(req, res, next);

      expect(next).toHaveBeenCalled();
    });
  });
});
