import Redis from 'ioredis';
import { config } from '../config';
import { logger } from './logger';

function createClient(label: string): Redis {
  const client = new Redis(config.REDIS_URL, {
    maxRetriesPerRequest: null,
    retryStrategy(times) {
      const delay = Math.min(times * 200, 5000);
      logger.warn(`Redis ${label}: reconnecting in ${delay}ms`, {
        attempt: times,
      });
      return delay;
    },
  });

  client.on('connect', () => {
    logger.info(`Redis ${label}: connected`);
  });

  client.on('error', (err) => {
    logger.error(`Redis ${label}: error`, { error: String(err) });
  });

  client.on('close', () => {
    logger.warn(`Redis ${label}: connection closed`);
  });

  return client;
}

/** Main Redis client for commands. */
export const redis = createClient('main');

/** Dedicated subscriber client (separate connection required for pub/sub). */
export const redisSub = createClient('sub');

/** Returns true if the main Redis connection is healthy. */
export async function redisHealth(): Promise<boolean> {
  try {
    const pong = await redis.ping();
    return pong === 'PONG';
  } catch {
    return false;
  }
}

async function shutdown() {
  logger.info('Redis: shutting down clients');
  await Promise.allSettled([redis.quit(), redisSub.quit()]);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
