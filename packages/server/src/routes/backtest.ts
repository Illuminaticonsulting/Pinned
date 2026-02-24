/**
 * Backtest Routes — Strategy backtesting API.
 *
 * POST /backtest/run       — Run a backtest with given config
 * GET  /backtest/configs   — List user's saved configs
 * POST /backtest/configs   — Save a backtest config
 * DELETE /backtest/configs/:id — Delete a config
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

const entryConditionSchema = z.object({
  id: z.string(),
  metric: z.enum([
    'imbalance_count', 'cumulative_delta', 'ofi',
    'absorption_level', 'regime', 'rsi', 'volume_ratio',
  ]),
  operator: z.enum(['>', '<', '=', '>=', '<=', 'crosses_above', 'crosses_below']),
  value: z.number(),
  logicalOp: z.enum(['AND', 'OR']),
});

const exitConditionsSchema = z.object({
  takeProfitTicks: z.number().nullable(),
  takeProfitPct: z.number().nullable(),
  stopLossTicks: z.number().nullable(),
  stopLossPct: z.number().nullable(),
  timeExitMinutes: z.number().nullable(),
  trailingStopTicks: z.number().nullable(),
  signalReversal: z.boolean(),
});

const backtestRunSchema = z.object({
  symbol: z.string().min(1).max(30),
  timeframe: z.enum(['1m', '5m', '15m', '1h', '4h', '1d']),
  dateRange: z.object({
    start: z.string().min(1),
    end: z.string().min(1),
  }),
  entryConditions: z.array(entryConditionSchema).min(1),
  exitConditions: exitConditionsSchema,
});

type BacktestRunInput = z.infer<typeof backtestRunSchema>;

// ─── Types ───────────────────────────────────────────────────────────────────

interface CandleRow {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  buy_volume: number;
  sell_volume: number;
  total_delta: number;
}

interface TradeResult {
  entryTime: number;
  exitTime: number;
  entryPrice: number;
  exitPrice: number;
  pnl: number;
  duration: number;
  setup: string;
}

interface BacktestResults {
  winRate: number;
  avgWinner: number;
  avgLoser: number;
  maxDrawdown: number;
  profitFactor: number;
  sharpe: number;
  totalPnl: number;
  trades: TradeResult[];
  equityCurve: { time: number; equity: number }[];
  perSetup: { setup: string; winRate: number; avgPnl: number; count: number }[];
}

// ─── POST /backtest/run ──────────────────────────────────────────────────────

router.post('/run', async (req: Request, res: Response) => {
  try {
    const parsed = backtestRunSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid backtest config', details: parsed.error.format() });
      return;
    }

    const config = parsed.data;
    const userId = req.user!.userId;

    logger.info('Backtest: running', { userId, symbol: config.symbol, timeframe: config.timeframe });

    // Load historical candles from TimescaleDB
    const candles = await loadCandles(config.symbol, config.timeframe, config.dateRange.start, config.dateRange.end);

    if (candles.length === 0) {
      res.status(404).json({ error: 'No historical data found for the given range' });
      return;
    }

    // Run backtest engine
    const results = runBacktest(candles, config);

    logger.info('Backtest: complete', {
      userId,
      symbol: config.symbol,
      trades: results.trades.length,
      totalPnl: results.totalPnl,
    });

    res.json(results);
  } catch (err) {
    logger.error('Backtest: run failed', { error: String(err) });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── GET /backtest/configs ───────────────────────────────────────────────────

router.get('/configs', async (req: Request, res: Response) => {
  try {
    const userId = req.user!.userId;

    const result = await pool.query(
      `SELECT id, name, config, created_at, updated_at
       FROM backtest_configs
       WHERE user_id = $1
       ORDER BY updated_at DESC`,
      [userId],
    );

    const configs = result.rows.map((row) => ({
      id: row.id,
      name: row.name,
      config: typeof row.config === 'string' ? JSON.parse(row.config) : row.config,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));

    res.json(configs);
  } catch (err) {
    logger.error('Backtest: list configs failed', { error: String(err) });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── POST /backtest/configs ──────────────────────────────────────────────────

router.post('/configs', async (req: Request, res: Response) => {
  try {
    const userId = req.user!.userId;
    const parsed = backtestRunSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid config', details: parsed.error.format() });
      return;
    }

    const id = uuidv4();
    const name = (req.body.name as string) || `${parsed.data.symbol} ${parsed.data.timeframe}`;
    const serialised = JSON.stringify(parsed.data);

    await pool.query(
      `INSERT INTO backtest_configs (id, user_id, name, config, created_at, updated_at)
       VALUES ($1, $2, $3, $4, NOW(), NOW())`,
      [id, userId, name, serialised],
    );

    logger.info('Backtest: config saved', { id, userId });

    res.status(201).json({ id, name });
  } catch (err) {
    logger.error('Backtest: save config failed', { error: String(err) });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── DELETE /backtest/configs/:id ────────────────────────────────────────────

router.delete('/configs/:id', async (req: Request, res: Response) => {
  try {
    const userId = req.user!.userId;
    const { id } = req.params;

    const result = await pool.query(
      `DELETE FROM backtest_configs WHERE id = $1 AND user_id = $2`,
      [id, userId],
    );

    if (result.rowCount === 0) {
      res.status(404).json({ error: 'Config not found' });
      return;
    }

    logger.info('Backtest: config deleted', { id, userId });
    res.json({ success: true });
  } catch (err) {
    logger.error('Backtest: delete config failed', { error: String(err) });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── Data Loading ────────────────────────────────────────────────────────────

async function loadCandles(
  symbol: string,
  timeframe: string,
  start: string,
  end: string,
): Promise<CandleRow[]> {
  const result = await pool.query<CandleRow>(
    `SELECT
       EXTRACT(EPOCH FROM time) * 1000 AS time,
       open, high, low, close, volume,
       COALESCE(buy_volume, 0) AS buy_volume,
       COALESCE(sell_volume, 0) AS sell_volume,
       COALESCE(buy_volume, 0) - COALESCE(sell_volume, 0) AS total_delta
     FROM candles
     WHERE symbol = $1
       AND timeframe = $2
       AND time >= $3::timestamptz
       AND time <= $4::timestamptz
     ORDER BY time ASC`,
    [symbol, timeframe, start, end],
  );

  return result.rows;
}

// ─── Backtest Engine ─────────────────────────────────────────────────────────

function runBacktest(candles: CandleRow[], config: BacktestRunInput): BacktestResults {
  const trades: TradeResult[] = [];
  let position: { entryTime: number; entryPrice: number; setup: string } | null = null;
  let equity = 0;
  const equityCurve: { time: number; equity: number }[] = [{ time: candles[0].time, equity: 0 }];

  // Pre-compute indicator values for the candle series
  const metricValues = computeMetrics(candles);

  for (let i = 1; i < candles.length; i++) {
    const candle = candles[i];
    const prevCandle = candles[i - 1];

    if (!position) {
      // Evaluate entry conditions
      if (evaluateEntry(config.entryConditions, metricValues, i)) {
        const setup = config.entryConditions.map((c) => `${c.metric}${c.operator}${c.value}`).join('&');
        position = {
          entryTime: candle.time,
          entryPrice: candle.close,
          setup,
        };
      }
    } else {
      // Evaluate exit conditions
      const exitResult = evaluateExit(candle, position, config.exitConditions, metricValues, i, config.entryConditions);

      if (exitResult.shouldExit) {
        const pnl = exitResult.exitPrice - position.entryPrice;
        const duration = candle.time - position.entryTime;

        trades.push({
          entryTime: position.entryTime,
          exitTime: candle.time,
          entryPrice: position.entryPrice,
          exitPrice: exitResult.exitPrice,
          pnl,
          duration,
          setup: position.setup,
        });

        equity += pnl;
        equityCurve.push({ time: candle.time, equity });
        position = null;
      }
    }
  }

  // Close any remaining position at last candle
  if (position) {
    const lastCandle = candles[candles.length - 1];
    const pnl = lastCandle.close - position.entryPrice;
    trades.push({
      entryTime: position.entryTime,
      exitTime: lastCandle.time,
      entryPrice: position.entryPrice,
      exitPrice: lastCandle.close,
      pnl,
      duration: lastCandle.time - position.entryTime,
      setup: position.setup,
    });
    equity += pnl;
    equityCurve.push({ time: lastCandle.time, equity });
  }

  return computeResults(trades, equityCurve);
}

// ─── Metric Computation ──────────────────────────────────────────────────────

function computeMetrics(candles: CandleRow[]): Map<string, number[]> {
  const metrics = new Map<string, number[]>();

  // Cumulative delta
  let cumDelta = 0;
  const cumDeltas = candles.map((c) => { cumDelta += c.total_delta; return cumDelta; });
  metrics.set('cumulative_delta', cumDeltas);

  // Volume ratio (buy/sell)
  const volRatio = candles.map((c) => c.sell_volume > 0 ? c.buy_volume / c.sell_volume : 1);
  metrics.set('volume_ratio', volRatio);

  // RSI (14-period)
  const closes = candles.map((c) => c.close);
  const rsi = computeRSI(closes, 14);
  metrics.set('rsi', rsi);

  // OFI (simplified: delta / volume)
  const ofi = candles.map((c) => c.volume > 0 ? c.total_delta / c.volume : 0);
  metrics.set('ofi', ofi);

  // Imbalance count (placeholder: count of candles where |delta| > volume * 0.3)
  const imbalance = candles.map((c) => Math.abs(c.total_delta) > c.volume * 0.3 ? 1 : 0);
  metrics.set('imbalance_count', runningSum(imbalance, 10));

  // Absorption (buy volume absorbed by sell volume)
  const absorption = candles.map((c) => {
    const total = c.buy_volume + c.sell_volume;
    return total > 0 ? Math.min(c.buy_volume, c.sell_volume) / total : 0;
  });
  metrics.set('absorption_level', absorption);

  // Regime (1 = uptrend, -1 = downtrend, 0 = range) — based on 20-period SMA slope
  const sma20 = computeSMA(closes, 20);
  const regime = sma20.map((v, i) => {
    if (i < 1) return 0;
    const slope = v - sma20[i - 1];
    if (slope > 0) return 1;
    if (slope < 0) return -1;
    return 0;
  });
  metrics.set('regime', regime);

  return metrics;
}

function computeRSI(closes: number[], period: number): number[] {
  const rsi: number[] = new Array(closes.length).fill(50);
  if (closes.length < period + 1) return rsi;

  let gainSum = 0;
  let lossSum = 0;

  for (let i = 1; i <= period; i++) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) gainSum += change;
    else lossSum += Math.abs(change);
  }

  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;

  rsi[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  for (let i = period + 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? Math.abs(change) : 0;

    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;

    rsi[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }

  return rsi;
}

function computeSMA(data: number[], period: number): number[] {
  const result: number[] = [];
  for (let i = 0; i < data.length; i++) {
    if (i < period - 1) {
      result.push(data[i]);
    } else {
      let sum = 0;
      for (let j = i - period + 1; j <= i; j++) sum += data[j];
      result.push(sum / period);
    }
  }
  return result;
}

function runningSum(data: number[], window: number): number[] {
  const result: number[] = [];
  let sum = 0;
  for (let i = 0; i < data.length; i++) {
    sum += data[i];
    if (i >= window) sum -= data[i - window];
    result.push(sum);
  }
  return result;
}

// ─── Entry Evaluation ────────────────────────────────────────────────────────

interface EntryCondition {
  metric: string;
  operator: string;
  value: number;
  logicalOp: 'AND' | 'OR';
}

function evaluateEntry(
  conditions: EntryCondition[],
  metrics: Map<string, number[]>,
  index: number,
): boolean {
  if (conditions.length === 0) return false;

  let result = evaluateCondition(conditions[0], metrics, index);

  for (let i = 1; i < conditions.length; i++) {
    const condResult = evaluateCondition(conditions[i], metrics, index);
    if (conditions[i].logicalOp === 'AND') {
      result = result && condResult;
    } else {
      result = result || condResult;
    }
  }

  return result;
}

function evaluateCondition(
  condition: EntryCondition,
  metrics: Map<string, number[]>,
  index: number,
): boolean {
  const values = metrics.get(condition.metric);
  if (!values || index >= values.length) return false;

  const current = values[index];
  const prev = index > 0 ? values[index - 1] : current;

  switch (condition.operator) {
    case '>': return current > condition.value;
    case '<': return current < condition.value;
    case '=': return Math.abs(current - condition.value) < 0.0001;
    case '>=': return current >= condition.value;
    case '<=': return current <= condition.value;
    case 'crosses_above': return prev <= condition.value && current > condition.value;
    case 'crosses_below': return prev >= condition.value && current < condition.value;
    default: return false;
  }
}

// ─── Exit Evaluation ─────────────────────────────────────────────────────────

interface ExitResult {
  shouldExit: boolean;
  exitPrice: number;
}

function evaluateExit(
  candle: CandleRow,
  position: { entryPrice: number; entryTime: number },
  exitCond: BacktestRunInput['exitConditions'],
  metrics: Map<string, number[]>,
  index: number,
  entryConditions: EntryCondition[],
): ExitResult {
  // Take profit (ticks)
  if (exitCond.takeProfitTicks != null) {
    const target = position.entryPrice + exitCond.takeProfitTicks;
    if (candle.high >= target) {
      return { shouldExit: true, exitPrice: target };
    }
  }

  // Take profit (percentage)
  if (exitCond.takeProfitPct != null) {
    const target = position.entryPrice * (1 + exitCond.takeProfitPct / 100);
    if (candle.high >= target) {
      return { shouldExit: true, exitPrice: target };
    }
  }

  // Stop loss (ticks)
  if (exitCond.stopLossTicks != null) {
    const target = position.entryPrice - exitCond.stopLossTicks;
    if (candle.low <= target) {
      return { shouldExit: true, exitPrice: target };
    }
  }

  // Stop loss (percentage)
  if (exitCond.stopLossPct != null) {
    const target = position.entryPrice * (1 - exitCond.stopLossPct / 100);
    if (candle.low <= target) {
      return { shouldExit: true, exitPrice: target };
    }
  }

  // Time-based exit
  if (exitCond.timeExitMinutes != null) {
    const elapsed = candle.time - position.entryTime;
    if (elapsed >= exitCond.timeExitMinutes * 60 * 1000) {
      return { shouldExit: true, exitPrice: candle.close };
    }
  }

  // Trailing stop
  if (exitCond.trailingStopTicks != null) {
    // Simplified: use high of current candle minus trailing amount
    const trailStop = candle.high - exitCond.trailingStopTicks;
    if (candle.close <= trailStop && candle.close < position.entryPrice) {
      return { shouldExit: true, exitPrice: trailStop };
    }
  }

  // Signal reversal
  if (exitCond.signalReversal) {
    // Invert entry conditions: if entry was >, reversal is <
    const reversed = entryConditions.map((c) => ({
      ...c,
      operator: reverseOperator(c.operator),
    }));
    if (evaluateEntry(reversed, metrics, index)) {
      return { shouldExit: true, exitPrice: candle.close };
    }
  }

  return { shouldExit: false, exitPrice: 0 };
}

function reverseOperator(op: string): string {
  switch (op) {
    case '>': return '<';
    case '<': return '>';
    case '>=': return '<=';
    case '<=': return '>=';
    case 'crosses_above': return 'crosses_below';
    case 'crosses_below': return 'crosses_above';
    default: return op;
  }
}

// ─── Results Computation ─────────────────────────────────────────────────────

function computeResults(
  trades: TradeResult[],
  equityCurve: { time: number; equity: number }[],
): BacktestResults {
  if (trades.length === 0) {
    return {
      winRate: 0, avgWinner: 0, avgLoser: 0, maxDrawdown: 0,
      profitFactor: 0, sharpe: 0, totalPnl: 0,
      trades: [], equityCurve, perSetup: [],
    };
  }

  const pnls = trades.map((t) => t.pnl);
  const winners = pnls.filter((p) => p > 0);
  const losers = pnls.filter((p) => p <= 0);

  const totalPnl = pnls.reduce((s, p) => s + p, 0);
  const winRate = winners.length / pnls.length;
  const avgWinner = winners.length > 0 ? winners.reduce((s, p) => s + p, 0) / winners.length : 0;
  const avgLoser = losers.length > 0 ? losers.reduce((s, p) => s + p, 0) / losers.length : 0;

  const grossProfit = winners.reduce((s, p) => s + p, 0);
  const grossLoss = Math.abs(losers.reduce((s, p) => s + p, 0));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;

  // Max drawdown
  let peak = 0;
  let maxDrawdown = 0;
  let equity = 0;
  for (const pnl of pnls) {
    equity += pnl;
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }

  // Sharpe ratio
  const mean = totalPnl / pnls.length;
  const variance = pnls.reduce((s, p) => s + (p - mean) ** 2, 0) / pnls.length;
  const stdDev = Math.sqrt(variance);
  const sharpe = stdDev > 0 ? (mean / stdDev) * Math.sqrt(252) : 0;

  // Per-setup breakdown
  const setupMap = new Map<string, number[]>();
  for (const t of trades) {
    const arr = setupMap.get(t.setup) || [];
    arr.push(t.pnl);
    setupMap.set(t.setup, arr);
  }

  const perSetup = Array.from(setupMap.entries()).map(([setup, pnlArr]) => {
    const w = pnlArr.filter((p) => p > 0);
    return {
      setup,
      winRate: w.length / pnlArr.length,
      avgPnl: pnlArr.reduce((s, p) => s + p, 0) / pnlArr.length,
      count: pnlArr.length,
    };
  });

  return {
    winRate, avgWinner, avgLoser, maxDrawdown, profitFactor, sharpe, totalPnl,
    trades, equityCurve, perSetup,
  };
}

export default router;
