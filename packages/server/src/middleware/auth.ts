import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config';
import { redis } from '../utils/redis';
import { logger } from '../utils/logger';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface UserPayload {
  userId: string;
  email: string;
}

declare global {
  namespace Express {
    interface Request {
      user?: UserPayload;
    }
  }
}

// ─── Token Generation ────────────────────────────────────────────────────────

export function generateTokens(userId: string, email: string): {
  accessToken: string;
  refreshToken: string;
} {
  const accessToken = jwt.sign(
    { userId, email } as UserPayload,
    config.JWT_SECRET,
    { expiresIn: config.JWT_EXPIRY },
  );

  const refreshToken = jwt.sign(
    { userId, email, type: 'refresh' } as UserPayload & { type: string },
    config.JWT_REFRESH_SECRET,
    { expiresIn: config.JWT_REFRESH_EXPIRY },
  );

  return { accessToken, refreshToken };
}

// ─── Token Verification ─────────────────────────────────────────────────────

export function verifyRefreshToken(token: string): UserPayload {
  try {
    const payload = jwt.verify(token, config.JWT_REFRESH_SECRET) as UserPayload & { type?: string };
    if (!payload.userId || !payload.email) {
      throw new Error('Invalid refresh token payload');
    }
    return { userId: payload.userId, email: payload.email };
  } catch (err) {
    throw new Error('Invalid or expired refresh token');
  }
}

// ─── Extract Token Helper ────────────────────────────────────────────────────

function extractToken(req: Request): string | null {
  // Try Authorization header (Bearer token)
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7);
  }

  // Try httpOnly cookie
  if (req.cookies?.access_token) {
    return req.cookies.access_token;
  }

  return null;
}

// ─── Middleware: verifyToken ─────────────────────────────────────────────────

export function verifyToken(req: Request, res: Response, next: NextFunction): void {
  const token = extractToken(req);

  if (!token) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  try {
    const payload = jwt.verify(token, config.JWT_SECRET) as UserPayload;

    if (!payload.userId || !payload.email) {
      res.status(401).json({ error: 'Invalid token payload' });
      return;
    }

    req.user = payload;
    next();
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) {
      res.status(401).json({ error: 'Token expired' });
      return;
    }
    if (err instanceof jwt.JsonWebTokenError) {
      res.status(401).json({ error: 'Invalid token' });
      return;
    }

    logger.error('Auth middleware: unexpected error', { error: String(err) });
    res.status(500).json({ error: 'Internal server error' });
  }
}

// ─── Middleware: optionalAuth ────────────────────────────────────────────────

export function optionalAuth(req: Request, res: Response, next: NextFunction): void {
  const token = extractToken(req);

  if (!token) {
    next();
    return;
  }

  try {
    const payload = jwt.verify(token, config.JWT_SECRET) as UserPayload;
    if (payload.userId && payload.email) {
      req.user = payload;
    }
  } catch {
    // Token invalid, but optional — continue without auth
  }

  next();
}

// ─── Rate Limiter Middleware ─────────────────────────────────────────────────

interface RateLimitConfig {
  windowMs: number;
  maxRequests: number;
  keyPrefix: string;
}

const API_RATE_LIMIT: RateLimitConfig = {
  windowMs: 60_000,
  maxRequests: 100,
  keyPrefix: 'rl:api',
};

const AUTH_RATE_LIMIT: RateLimitConfig = {
  windowMs: 60_000,
  maxRequests: 10,
  keyPrefix: 'rl:auth',
};

function createRateLimiter(cfg: RateLimitConfig) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const key = `${cfg.keyPrefix}:${ip}`;

    try {
      const multi = redis.multi();
      multi.incr(key);
      multi.pttl(key);

      const results = await multi.exec();
      if (!results) {
        next();
        return;
      }

      const count = results[0][1] as number;
      const ttl = results[1][1] as number;

      // Set expiry if key is new
      if (ttl === -1) {
        await redis.pexpire(key, cfg.windowMs);
      }

      // Set rate limit headers
      res.setHeader('X-RateLimit-Limit', cfg.maxRequests);
      res.setHeader('X-RateLimit-Remaining', Math.max(0, cfg.maxRequests - count));

      if (count > cfg.maxRequests) {
        const retryAfter = ttl > 0 ? Math.ceil(ttl / 1000) : Math.ceil(cfg.windowMs / 1000);
        res.setHeader('Retry-After', retryAfter);
        res.status(429).json({
          error: 'Too many requests',
          retryAfter,
        });
        return;
      }

      next();
    } catch (err) {
      // If Redis is down, allow the request through
      logger.warn('Rate limiter: Redis error, allowing request', {
        error: String(err),
        ip,
      });
      next();
    }
  };
}

export const apiRateLimiter = createRateLimiter(API_RATE_LIMIT);
export const authRateLimiter = createRateLimiter(AUTH_RATE_LIMIT);
