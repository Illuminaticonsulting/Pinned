import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';

import { config } from './config';
import { logger } from './utils/logger';
import { redis } from './utils/redis';
import { pool, runMigrations } from './db';
import { createAdapter, ExchangeAdapter } from './adapters';
import { WebSocketServer } from './services/WebSocketServer';
import { TradeIngestionService } from './services/TradeIngestionService';
import { CandleBuilderService } from './services/CandleBuilderService';
import { OrderbookService } from './services/OrderbookService';
import { BigTradeService } from './services/BigTradeService';
import { HeatmapService } from './services/HeatmapService';
import { PatternDetectionService } from './services/PatternDetectionService';
import { OFIService } from './services/OFIService';
import { FundingRateService } from './services/FundingRateService';
import { AlertEvaluationService } from './services/AlertEvaluationService';
import { apiRateLimiter } from './middleware/auth';

// Routes
import authRoutes from './routes/auth';
import drawingRoutes from './routes/drawings';
import alertRoutes from './routes/alerts';
import watchlistRoutes from './routes/watchlists';
import chartRoutes from './routes/charts';
import marketRoutes from './routes/market';
import communityRoutes from './routes/community';

import type { Exchange, Timeframe } from '@pinned/shared-types';

// ─── Express App Setup ──────────────────────────────────────────────────────

const app = express();

app.set('trust proxy', 1);

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "blob:"],
      connectSrc: ["'self'", "ws:", "wss:"],
      fontSrc: ["'self'", "data:"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
    },
  },
}));
app.use(cors({
  origin: config.NODE_ENV === 'production'
    ? ['https://pinned.trade'] // Replace with actual domain
    : ['http://localhost:3000', 'http://localhost:5173'],
  credentials: true,
}));
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());
app.use(apiRateLimiter);

// Health check (not behind rate limiter) - minimal info for public
app.get('/health', async (_req, res) => {
  try {
    const dbOk = await pool.query('SELECT 1 AS ok').then((r) => r.rows[0]?.ok === 1).catch(() => false);
    const redisOk = await redis.ping().then((r) => r === 'PONG').catch(() => false);

    const healthy = dbOk && redisOk;
    res.status(healthy ? 200 : 503).json({
      status: healthy ? 'ok' : 'degraded',
    });
  } catch {
    res.status(503).json({ status: 'error' });
  }
});

// Mount routes under /api/v1
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/drawings', drawingRoutes);
app.use('/api/v1/alerts', alertRoutes);
app.use('/api/v1/watchlists', watchlistRoutes);
app.use('/api/v1/charts', chartRoutes);
app.use('/api/v1/market', marketRoutes);
app.use('/api/v1/community', communityRoutes);

// 404 handler
app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Global error handler
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  logger.error('Unhandled express error', { error: String(err), stack: err.stack });
  res.status(500).json({ error: 'Internal server error' });
});

// ─── Service Instances ──────────────────────────────────────────────────────

const tradeIngestion = new TradeIngestionService();
const candleBuilder = new CandleBuilderService();
const orderbookService = new OrderbookService();
const bigTrade = new BigTradeService();
const heatmapService = new HeatmapService();
const patternDetection = new PatternDetectionService();
const ofiService = new OFIService();
const fundingRateService = new FundingRateService();
const alertEvaluation = new AlertEvaluationService();
const wsServer = new WebSocketServer();

// ─── Bootstrap ──────────────────────────────────────────────────────────────

async function bootstrap(): Promise<void> {
  logger.info('Pinned server starting...', {
    nodeEnv: config.NODE_ENV,
    port: config.PORT,
    wsPort: config.WS_PORT,
    instruments: config.INSTRUMENTS,
  });

  // 1. Run database migrations
  try {
    await runMigrations();
    logger.info('Database migrations complete');
  } catch (err) {
    logger.error('Database migration failed', { error: String(err) });
    throw err;
  }

  // 2. Create exchange adapters for each exchange
  const exchanges: Exchange[] = ['blofin', 'mexc'];
  const adapters: ExchangeAdapter[] = [];

  for (const exchange of exchanges) {
    try {
      const adapter = createAdapter(exchange);
      adapters.push(adapter);
      logger.info('Exchange adapter created', { exchange });
    } catch (err) {
      logger.error('Failed to create exchange adapter', {
        exchange,
        error: String(err),
      });
    }
  }

  // 3. Wire adapter events to services
  for (const adapter of adapters) {
    adapter.on('trade', (trade) => {
      tradeIngestion.onTrade(trade).catch((err) => {
        logger.error('Trade ingestion error', { error: String(err) });
      });
    });

    adapter.on('orderbook', (snapshot) => {
      orderbookService.onSnapshot(snapshot).catch((err) => {
        logger.error('Orderbook service error', { error: String(err) });
      });

      ofiService.onSnapshot(snapshot);
    });

    // Register adapter for funding rate fetching
    fundingRateService.registerAdapter({
      exchange: adapter.exchange as Exchange,
      fetchFundingRate: (symbol: string) => adapter.getFundingRate(symbol),
    });
  }

  // 4. Start all services
  const instruments = config.INSTRUMENTS;

  tradeIngestion.start();
  candleBuilder.start(instruments);
  orderbookService.start();
  bigTrade.start(instruments);
  heatmapService.start(instruments);
  patternDetection.start(instruments);
  ofiService.start(instruments);
  fundingRateService.start(instruments);
  alertEvaluation.start();

  const serviceCount = 9;
  logger.info('All services started', { serviceCount });

  // 5. Connect adapters and subscribe to feeds
  const defaultTimeframes: Timeframe[] = ['1m', '5m', '15m', '1h', '4h', '1d'];

  for (const adapter of adapters) {
    try {
      await adapter.connect();

      for (const symbol of instruments) {
        adapter.subscribeTrades(symbol);
        adapter.subscribeOrderbook(symbol);

        for (const tf of defaultTimeframes) {
          adapter.subscribeCandles(symbol, tf);
        }
      }

      logger.info('Exchange adapter connected and subscribed', {
        exchange: adapter.exchange,
        instruments,
        timeframes: defaultTimeframes,
      });
    } catch (err) {
      logger.error('Failed to connect exchange adapter', {
        exchange: adapter.exchange,
        error: String(err),
      });
    }
  }

  // 6. Start WebSocket server
  await wsServer.start();

  // 7. Start Express HTTP server
  const httpServer = app.listen(config.PORT, () => {
    logger.info('Pinned server started', {
      httpPort: config.PORT,
      wsPort: config.WS_PORT,
      instruments,
      exchangeCount: adapters.length,
      serviceCount,
    });
  });

  // 8. Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info(`Received ${signal}, shutting down gracefully...`);

    // Stop accepting new connections
    httpServer.close();

    try {
      // Disconnect exchange adapters
      await Promise.allSettled(
        adapters.map((a) => a.disconnect()),
      );
      logger.info('Exchange adapters disconnected');

      // Stop services (order matters: stop consumers before producers)
      await Promise.allSettled([
        alertEvaluation.stop(),
        patternDetection.stop(),
        ofiService.stop(),
        heatmapService.stop(),
        bigTrade.stop(),
        candleBuilder.stop(),
        orderbookService.stop(),
        tradeIngestion.stop(),
        fundingRateService.stop(),
      ]);
      logger.info('All services stopped');

      // Stop WebSocket server
      await wsServer.stop();
      logger.info('WebSocket server stopped');

      // Close database pool
      await pool.end();
      logger.info('Database pool closed');

      // Close Redis connections
      await Promise.allSettled([redis.quit()]);
      logger.info('Redis connections closed');

      logger.info('Graceful shutdown complete');
      process.exit(0);
    } catch (err) {
      logger.error('Error during shutdown', { error: String(err) });
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Handle unhandled rejections
  process.on('unhandledRejection', (reason: unknown) => {
    logger.error('Unhandled rejection', { reason: String(reason) });
  });

  process.on('uncaughtException', (err: Error) => {
    logger.error('Uncaught exception', { error: err.message, stack: err.stack });
    process.exit(1);
  });
}

// ─── Entry Point ────────────────────────────────────────────────────────────

bootstrap().catch((err) => {
  logger.error('Fatal: bootstrap failed', { error: String(err) });
  process.exit(1);
});

export { app };
