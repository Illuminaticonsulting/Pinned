import 'dotenv/config';
import { z } from 'zod';

const configSchema = z.object({
  DATABASE_URL: z
    .string()
    .default('postgresql://pinned:pinned_dev@localhost:5432/pinned'),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  PORT: z.coerce.number().int().positive().default(3001),
  WS_PORT: z.coerce.number().int().positive().default(3002),

  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET must be at least 32 characters'),
  JWT_EXPIRY: z.string().default('15m'),
  JWT_REFRESH_EXPIRY: z.string().default('7d'),

  BLOFIN_API_KEY: z.string().optional(),
  BLOFIN_API_SECRET: z.string().optional(),
  BLOFIN_PASSPHRASE: z.string().optional(),

  MEXC_API_KEY: z.string().optional(),
  MEXC_API_SECRET: z.string().optional(),

  AI_SERVICE_URL: z.string().default('http://localhost:8000'),

  TELEGRAM_BOT_TOKEN: z.string().optional(),
  SENDGRID_API_KEY: z.string().optional(),

  NODE_ENV: z
    .enum(['dev', 'staging', 'production'])
    .default('dev'),

  INSTRUMENTS: z
    .string()
    .default('BTC-USDT,ETH-USDT')
    .transform((v) => v.split(',')),

  SNAPSHOT_INTERVAL_MS: z.coerce.number().int().positive().default(250),
  HEATMAP_RECOMPUTE_INTERVAL_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(5000),
  BIG_TRADE_WINDOW_MS: z.coerce.number().int().positive().default(500),
  BIG_TRADE_THRESHOLD_BTC: z.coerce.number().positive().default(1.0),
});

export type Config = z.infer<typeof configSchema>;

// In dev mode, provide safe defaults for JWT secrets if not set
const envWithDefaults = {
  ...process.env,
  ...(process.env.NODE_ENV !== 'production' && !process.env.JWT_SECRET
    ? {
        JWT_SECRET: 'dev-only-jwt-secret-32chars-minimum!!',
        JWT_REFRESH_SECRET: 'dev-only-refresh-secret-32chars-min!!',
      }
    : {}),
};

const parsed = configSchema.safeParse(envWithDefaults);

if (!parsed.success) {
  console.error(
    '\u274c Invalid environment configuration:',
    parsed.error.format(),
  );
  throw new Error('Invalid environment configuration');
}

// Safety check: block known weak secrets in production
if (
  parsed.data.NODE_ENV === 'production' &&
  (parsed.data.JWT_SECRET.includes('dev-') ||
    parsed.data.JWT_SECRET.includes('change-in-production'))
) {
  throw new Error('CRITICAL: Do not use dev JWT secrets in production');
}

export const config: Config = parsed.data;
