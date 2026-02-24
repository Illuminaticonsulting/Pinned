/**
 * Performance Routes — Trade performance analytics API.
 *
 * POST /performance/import        — Import trades from exchange
 * GET  /performance/trades        — List imported trades
 * GET  /performance/analytics     — Compute performance metrics
 * GET  /performance/equity-curve  — Return equity curve data
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { pool } from '../db';
import { logger } from '../utils/logger';
import { verifyToken } from '../middleware/auth';

const router = Router();

router.use(verifyToken);

// ─── Validation Schemas ──────────────────────────────────────────────────────

const importSchema = z.object({
  exchange: z.enum(['blofin', 'mexc']),
  apiKey: z.string().min(1),
  apiSecret: z.string().min(1),
  passphrase: z.string().optional(),
  startDate: z.string().optional(),
});

const tradesQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  symbol: z.string().optional(),
  side: z.enum(['long', 'short']).optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  sortBy: z.enum(['entry_time', 'exit_time', 'pnl', 'symbol']).default('exit_time'),
  sortDir: z.enum(['asc', 'desc']).default('desc'),
});

// ─── Types ───────────────────────────────────────────────────────────────────

interface ExchangeTrade {
  tradeId: string;
  symbol: string;
  side: 'long' | 'short';
  entryTime: number;
  exitTime: number;
  entryPrice: number;
  exitPrice: number;
  size: number;
  pnl: number;
  fees: number;
}

// ─── POST /performance/import ────────────────────────────────────────────────

router.post('/import', async (req: Request, res: Response) => {
  try {
    const userId = req.user!.userId;
    const parsed = importSchema.safeParse(req.body);

    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid import config', details: parsed.error.format() });
      return;
    }

    const { exchange, apiKey, apiSecret, passphrase, startDate } = parsed.data;

    logger.info('Performance: importing trades', { userId, exchange });

    // Fetch trades from exchange API
    const trades = await fetchExchangeTrades(exchange, apiKey, apiSecret, passphrase, startDate);

    if (trades.length === 0) {
      res.json({ imported: 0, message: 'No trades found' });
      return;
    }

    // Upsert trades into DB
    let imported = 0;
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      for (const trade of trades) {
        const result = await client.query(
          `INSERT INTO user_trades (
             id, user_id, exchange, trade_id, symbol, side,
             entry_time, exit_time, entry_price, exit_price,
             size, pnl, fees, created_at
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW())
           ON CONFLICT (user_id, exchange, trade_id)
           DO UPDATE SET
             pnl = EXCLUDED.pnl,
             fees = EXCLUDED.fees,
             exit_time = EXCLUDED.exit_time,
             exit_price = EXCLUDED.exit_price
           RETURNING id`,
          [
            uuidv4(),
            userId,
            exchange,
            trade.tradeId,
            trade.symbol,
            trade.side,
            new Date(trade.entryTime).toISOString(),
            new Date(trade.exitTime).toISOString(),
            trade.entryPrice,
            trade.exitPrice,
            trade.size,
            trade.pnl,
            trade.fees,
          ],
        );

        if (result.rowCount && result.rowCount > 0) imported++;
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    logger.info('Performance: import complete', { userId, imported, total: trades.length });

    res.json({ imported, total: trades.length });
  } catch (err) {
    logger.error('Performance: import failed', { error: String(err) });
    res.status(500).json({ error: 'Import failed' });
  }
});

// ─── GET /performance/trades ─────────────────────────────────────────────────

router.get('/trades', async (req: Request, res: Response) => {
  try {
    const userId = req.user!.userId;
    const params = tradesQuerySchema.parse(req.query);

    const conditions: string[] = ['user_id = $1'];
    const values: any[] = [userId];
    let paramIdx = 2;

    if (params.symbol) {
      conditions.push(`symbol = $${paramIdx++}`);
      values.push(params.symbol);
    }
    if (params.side) {
      conditions.push(`side = $${paramIdx++}`);
      values.push(params.side);
    }
    if (params.startDate) {
      conditions.push(`exit_time >= $${paramIdx++}::timestamptz`);
      values.push(params.startDate);
    }
    if (params.endDate) {
      conditions.push(`exit_time <= $${paramIdx++}::timestamptz`);
      values.push(params.endDate);
    }

    const where = conditions.join(' AND ');
    const offset = (params.page - 1) * params.limit;

    // Count
    const countResult = await pool.query(
      `SELECT COUNT(*) AS total FROM user_trades WHERE ${where}`,
      values,
    );
    const total = parseInt(countResult.rows[0].total, 10);

    // Fetch
    const result = await pool.query(
      `SELECT id, exchange, trade_id, symbol, side,
              entry_time, exit_time, entry_price, exit_price,
              size, pnl, fees, created_at
       FROM user_trades
       WHERE ${where}
       ORDER BY ${params.sortBy} ${params.sortDir}
       LIMIT $${paramIdx++} OFFSET $${paramIdx++}`,
      [...values, params.limit, offset],
    );

    const trades = result.rows.map((row) => ({
      id: row.id,
      exchange: row.exchange,
      tradeId: row.trade_id,
      symbol: row.symbol,
      side: row.side,
      entryTime: new Date(row.entry_time).getTime(),
      exitTime: new Date(row.exit_time).getTime(),
      entryPrice: parseFloat(row.entry_price),
      exitPrice: parseFloat(row.exit_price),
      size: parseFloat(row.size),
      pnl: parseFloat(row.pnl),
      fees: parseFloat(row.fees),
    }));

    res.json({
      trades,
      pagination: {
        page: params.page,
        limit: params.limit,
        total,
        totalPages: Math.ceil(total / params.limit),
      },
    });
  } catch (err) {
    logger.error('Performance: list trades failed', { error: String(err) });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── GET /performance/analytics ──────────────────────────────────────────────

router.get('/analytics', async (req: Request, res: Response) => {
  try {
    const userId = req.user!.userId;

    // Summary metrics
    const summaryResult = await pool.query(
      `SELECT
         COUNT(*) AS total_trades,
         SUM(pnl) AS total_pnl,
         AVG(pnl) AS avg_trade,
         COUNT(*) FILTER (WHERE pnl > 0) AS winners,
         AVG(pnl) FILTER (WHERE pnl > 0) AS avg_winner,
         AVG(pnl) FILTER (WHERE pnl <= 0) AS avg_loser,
         MAX(pnl) AS best_trade,
         MIN(pnl) AS worst_trade
       FROM user_trades
       WHERE user_id = $1`,
      [userId],
    );

    const s = summaryResult.rows[0];
    const totalTrades = parseInt(s.total_trades, 10);
    const winRate = totalTrades > 0 ? parseInt(s.winners, 10) / totalTrades : 0;

    // Daily P&L for calendar heatmap
    const dailyResult = await pool.query(
      `SELECT
         DATE(exit_time) AS date,
         SUM(pnl) AS pnl,
         COUNT(*) AS trade_count
       FROM user_trades
       WHERE user_id = $1
       GROUP BY DATE(exit_time)
       ORDER BY date`,
      [userId],
    );

    const calendarData = dailyResult.rows.map((row) => ({
      date: row.date,
      pnl: parseFloat(row.pnl),
      tradeCount: parseInt(row.trade_count, 10),
    }));

    // Max drawdown (compute from ordered trades)
    const tradesResult = await pool.query(
      `SELECT pnl FROM user_trades WHERE user_id = $1 ORDER BY exit_time ASC`,
      [userId],
    );

    let peak = 0;
    let maxDrawdown = 0;
    let equity = 0;
    for (const row of tradesResult.rows) {
      equity += parseFloat(row.pnl);
      if (equity > peak) peak = equity;
      const dd = peak - equity;
      if (dd > maxDrawdown) maxDrawdown = dd;
    }

    // Sharpe ratio
    const pnls = tradesResult.rows.map((r) => parseFloat(r.pnl));
    const mean = pnls.length > 0 ? pnls.reduce((a, b) => a + b, 0) / pnls.length : 0;
    const variance = pnls.length > 0
      ? pnls.reduce((sum, p) => sum + (p - mean) ** 2, 0) / pnls.length
      : 0;
    const stdDev = Math.sqrt(variance);
    const sharpe = stdDev > 0 ? (mean / stdDev) * Math.sqrt(252) : 0;

    // Per-setup breakdown (uses setup column if available, else 'Unknown')
    const setupResult = await pool.query(
      `SELECT
         COALESCE(setup, 'Unknown') AS setup,
         COUNT(*) AS count,
         COUNT(*) FILTER (WHERE pnl > 0) AS winners,
         AVG(pnl) AS avg_pnl,
         SUM(pnl) AS total_pnl
       FROM user_trades
       WHERE user_id = $1
       GROUP BY COALESCE(setup, 'Unknown')
       ORDER BY COUNT(*) DESC`,
      [userId],
    );

    const perSetup = setupResult.rows.map((row) => ({
      setup: row.setup,
      count: parseInt(row.count, 10),
      winRate: parseInt(row.count, 10) > 0
        ? parseInt(row.winners, 10) / parseInt(row.count, 10)
        : 0,
      avgPnl: parseFloat(row.avg_pnl),
      totalPnl: parseFloat(row.total_pnl),
    }));

    res.json({
      summary: {
        totalPnl: parseFloat(s.total_pnl) || 0,
        winRate,
        avgTrade: parseFloat(s.avg_trade) || 0,
        maxDrawdown,
        sharpe,
        totalTrades,
        bestTrade: parseFloat(s.best_trade) || 0,
        worstTrade: parseFloat(s.worst_trade) || 0,
        avgWinner: parseFloat(s.avg_winner) || 0,
        avgLoser: parseFloat(s.avg_loser) || 0,
      },
      calendarData,
      perSetup,
    });
  } catch (err) {
    logger.error('Performance: analytics failed', { error: String(err) });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── GET /performance/equity-curve ───────────────────────────────────────────

router.get('/equity-curve', async (req: Request, res: Response) => {
  try {
    const userId = req.user!.userId;

    const result = await pool.query(
      `SELECT
         EXTRACT(EPOCH FROM exit_time) * 1000 AS time,
         pnl
       FROM user_trades
       WHERE user_id = $1
       ORDER BY exit_time ASC`,
      [userId],
    );

    let equity = 0;
    const equityCurve = result.rows.map((row) => {
      equity += parseFloat(row.pnl);
      return {
        time: parseFloat(row.time),
        equity,
        pnl: parseFloat(row.pnl),
      };
    });

    res.json({ equityCurve });
  } catch (err) {
    logger.error('Performance: equity curve failed', { error: String(err) });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── Exchange Trade Fetcher ──────────────────────────────────────────────────

async function fetchExchangeTrades(
  exchange: string,
  apiKey: string,
  apiSecret: string,
  passphrase?: string,
  startDate?: string,
): Promise<ExchangeTrade[]> {
  const trades: ExchangeTrade[] = [];

  if (exchange === 'blofin') {
    trades.push(...(await fetchBlofinTrades(apiKey, apiSecret, passphrase, startDate)));
  } else if (exchange === 'mexc') {
    trades.push(...(await fetchMexcTrades(apiKey, apiSecret, startDate)));
  }

  return trades;
}

async function fetchBlofinTrades(
  apiKey: string,
  apiSecret: string,
  passphrase?: string,
  startDate?: string,
): Promise<ExchangeTrade[]> {
  try {
    const crypto = await import('crypto');
    const timestamp = new Date().toISOString();
    const path = '/api/v1/trade/orders-history';
    const queryString = startDate ? `?begin=${new Date(startDate).getTime()}` : '';

    const prehash = `${timestamp}GET${path}${queryString}`;
    const signature = crypto
      .createHmac('sha256', apiSecret)
      .update(prehash)
      .digest('base64');

    const headers: Record<string, string> = {
      'ACCESS-KEY': apiKey,
      'ACCESS-SIGN': signature,
      'ACCESS-TIMESTAMP': timestamp,
      'Content-Type': 'application/json',
    };
    if (passphrase) headers['ACCESS-PASSPHRASE'] = passphrase;

    const res = await fetch(`https://openapi.blofin.com${path}${queryString}`, {
      method: 'GET',
      headers,
    });

    if (!res.ok) {
      logger.error('Performance: BloFin API error', { status: res.status });
      return [];
    }

    const data = await res.json();
    const orders = data?.data || [];

    return orders.map((order: any) => ({
      tradeId: order.orderId || order.tradeId,
      symbol: order.instId,
      side: order.posSide === 'long' ? 'long' : 'short',
      entryTime: parseInt(order.cTime, 10),
      exitTime: parseInt(order.uTime, 10),
      entryPrice: parseFloat(order.avgPx || order.px),
      exitPrice: parseFloat(order.avgPx || order.px),
      size: parseFloat(order.sz),
      pnl: parseFloat(order.pnl || '0'),
      fees: parseFloat(order.fee || '0'),
    }));
  } catch (err) {
    logger.error('Performance: BloFin fetch error', { error: String(err) });
    return [];
  }
}

async function fetchMexcTrades(
  apiKey: string,
  apiSecret: string,
  startDate?: string,
): Promise<ExchangeTrade[]> {
  try {
    const crypto = await import('crypto');
    const timestamp = Date.now();
    const params: Record<string, string> = { timestamp: String(timestamp) };
    if (startDate) params.startTime = String(new Date(startDate).getTime());

    const queryString = new URLSearchParams(params).toString();
    const signature = crypto
      .createHmac('sha256', apiSecret)
      .update(queryString)
      .digest('hex');

    const url = `https://api.mexc.com/api/v3/myTrades?${queryString}&signature=${signature}`;

    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'X-MEXC-APIKEY': apiKey,
        'Content-Type': 'application/json',
      },
    });

    if (!res.ok) {
      logger.error('Performance: MEXC API error', { status: res.status });
      return [];
    }

    const data = await res.json();
    const trades = Array.isArray(data) ? data : [];

    return trades.map((trade: any) => ({
      tradeId: String(trade.id),
      symbol: trade.symbol,
      side: trade.isBuyer ? 'long' : 'short',
      entryTime: trade.time,
      exitTime: trade.time,
      entryPrice: parseFloat(trade.price),
      exitPrice: parseFloat(trade.price),
      size: parseFloat(trade.qty),
      pnl: parseFloat(trade.realizedProfit || '0'),
      fees: parseFloat(trade.commission || '0'),
    }));
  } catch (err) {
    logger.error('Performance: MEXC fetch error', { error: String(err) });
    return [];
  }
}

export default router;
