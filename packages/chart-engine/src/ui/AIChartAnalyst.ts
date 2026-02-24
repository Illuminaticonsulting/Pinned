/**
 * AIChartAnalyst.ts
 * AI Chart Analyst inline — Highlight any section of the chart, right-click →
 * "Analyze This Zone". AI reads the orderflow, volume profile, delta divergence,
 * and gives a plain-English read.
 *
 * "High volume node rejection with bearish delta divergence — distribution
 * pattern." TradingView can't do this. DeepCharts won't.
 */

import type { Candle, ChartStateData } from '../core/ChartState';
import type { Viewport } from '../core/Viewport';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface AnalysisZone {
  startTime: number;
  endTime: number;
  highPrice: number;
  lowPrice: number;
  candles: Candle[];
}

export interface AnalysisResult {
  summary: string;
  details: AnalysisDetail[];
  bias: 'bullish' | 'bearish' | 'neutral';
  confidence: number;     // 0-100
  pattern?: string;
  timestamp: number;
}

export interface AnalysisDetail {
  label: string;
  value: string;
  sentiment: 'bullish' | 'bearish' | 'neutral';
}

export interface AIAnalystCallbacks {
  getState: () => Readonly<ChartStateData>;
  getViewport: () => Viewport;
  onToast: (msg: string) => void;
}

// ─── Analysis Logic ──────────────────────────────────────────────────────────

function analyzeZone(zone: AnalysisZone): AnalysisResult {
  const { candles } = zone;
  if (candles.length === 0) {
    return {
      summary: 'No candle data in selected zone.',
      details: [],
      bias: 'neutral',
      confidence: 0,
      timestamp: Date.now(),
    };
  }

  const details: AnalysisDetail[] = [];

  // ── Volume Analysis ──────────────────────────────────────────────────
  const totalVolume = candles.reduce((s, c) => s + c.volume, 0);
  const avgVolume = totalVolume / candles.length;
  const highVolCandles = candles.filter((c) => c.volume > avgVolume * 1.5).length;
  const volumeRatio = highVolCandles / candles.length;

  details.push({
    label: 'Total Volume',
    value: formatVolume(totalVolume),
    sentiment: 'neutral',
  });
  details.push({
    label: 'High-Vol Candles',
    value: `${highVolCandles}/${candles.length} (${(volumeRatio * 100).toFixed(0)}%)`,
    sentiment: volumeRatio > 0.4 ? 'bullish' : 'neutral',
  });

  // ── Price Action ─────────────────────────────────────────────────────
  const first = candles[0]!;
  const last = candles[candles.length - 1]!;
  const priceChange = last.close - first.open;
  const priceChangePercent = (priceChange / first.open) * 100;
  const rangeHigh = Math.max(...candles.map((c) => c.high));
  const rangeLow = Math.min(...candles.map((c) => c.low));
  const range = rangeHigh - rangeLow;

  details.push({
    label: 'Price Change',
    value: `${priceChange >= 0 ? '+' : ''}${priceChange.toFixed(2)} (${priceChangePercent >= 0 ? '+' : ''}${priceChangePercent.toFixed(2)}%)`,
    sentiment: priceChange > 0 ? 'bullish' : priceChange < 0 ? 'bearish' : 'neutral',
  });
  details.push({
    label: 'Range',
    value: `${rangeLow.toFixed(2)} — ${rangeHigh.toFixed(2)} (${range.toFixed(2)})`,
    sentiment: 'neutral',
  });

  // ── Delta Analysis (Buy vs Sell pressure) ────────────────────────────
  const bullCandles = candles.filter((c) => c.close >= c.open).length;
  const bearCandles = candles.length - bullCandles;
  const bullRatio = bullCandles / candles.length;

  details.push({
    label: 'Bull / Bear Candles',
    value: `${bullCandles} / ${bearCandles}`,
    sentiment: bullRatio > 0.6 ? 'bullish' : bullRatio < 0.4 ? 'bearish' : 'neutral',
  });

  // ── Body-to-Wick ratio (conviction indicator) ───────────────────────
  let totalBody = 0;
  let totalWick = 0;
  for (const c of candles) {
    totalBody += Math.abs(c.close - c.open);
    totalWick += (c.high - Math.max(c.open, c.close)) + (Math.min(c.open, c.close) - c.low);
  }
  const bodyWickRatio = totalWick > 0 ? totalBody / totalWick : 10;

  details.push({
    label: 'Body/Wick Ratio',
    value: bodyWickRatio.toFixed(2),
    sentiment: bodyWickRatio > 2 ? 'bullish' : bodyWickRatio < 0.5 ? 'bearish' : 'neutral',
  });

  // ── Volume-Weighted Price (POC proxy) ────────────────────────────────
  let vwapSum = 0;
  let volSum = 0;
  for (const c of candles) {
    const typicalPrice = (c.high + c.low + c.close) / 3;
    vwapSum += typicalPrice * c.volume;
    volSum += c.volume;
  }
  const vwap = volSum > 0 ? vwapSum / volSum : last.close;

  details.push({
    label: 'VWAP (Zone)',
    value: vwap.toFixed(2),
    sentiment: last.close > vwap ? 'bullish' : 'bearish',
  });

  // ── Rejection Detection ──────────────────────────────────────────────
  const topRejections = candles.filter((c) => {
    const upperWick = c.high - Math.max(c.open, c.close);
    const body = Math.abs(c.close - c.open);
    return upperWick > body * 2 && c.high > rangeHigh - range * 0.1;
  }).length;
  const bottomRejections = candles.filter((c) => {
    const lowerWick = Math.min(c.open, c.close) - c.low;
    const body = Math.abs(c.close - c.open);
    return lowerWick > body * 2 && c.low < rangeLow + range * 0.1;
  }).length;

  if (topRejections > 0) {
    details.push({
      label: 'Upper Rejections',
      value: `${topRejections} candle${topRejections > 1 ? 's' : ''}`,
      sentiment: 'bearish',
    });
  }
  if (bottomRejections > 0) {
    details.push({
      label: 'Lower Rejections',
      value: `${bottomRejections} candle${bottomRejections > 1 ? 's' : ''}`,
      sentiment: 'bullish',
    });
  }

  // ── Generate Summary ─────────────────────────────────────────────────
  let bias: 'bullish' | 'bearish' | 'neutral' = 'neutral';
  let confidence = 50;
  let pattern = '';
  const summaryParts: string[] = [];

  // Volume analysis
  if (volumeRatio > 0.5) {
    summaryParts.push('High volume concentration detected');
    confidence += 10;
  } else if (volumeRatio < 0.15) {
    summaryParts.push('Low volume — weak participation');
    confidence -= 10;
  }

  // Trend + Delta
  if (priceChangePercent > 1 && bullRatio > 0.6) {
    bias = 'bullish';
    pattern = 'Accumulation / Rally';
    summaryParts.push(`Strong bullish momentum (+${priceChangePercent.toFixed(1)}%) with ${(bullRatio * 100).toFixed(0)}% bull candles`);
    confidence += 15;
  } else if (priceChangePercent < -1 && bullRatio < 0.4) {
    bias = 'bearish';
    pattern = 'Distribution / Selloff';
    summaryParts.push(`Strong bearish pressure (${priceChangePercent.toFixed(1)}%) with ${((1 - bullRatio) * 100).toFixed(0)}% bear candles`);
    confidence += 15;
  } else if (Math.abs(priceChangePercent) < 0.3 && volumeRatio > 0.3) {
    pattern = 'Consolidation with volume';
    summaryParts.push('Price consolidating despite elevated volume — potential breakout imminent');
    confidence += 5;
  }

  // Rejection analysis
  if (topRejections >= 2 && priceChange <= 0) {
    bias = 'bearish';
    pattern = 'Distribution — Upper Rejection';
    summaryParts.push(`${topRejections} upper wick rejections — sellers defending highs`);
    confidence += 12;
  }
  if (bottomRejections >= 2 && priceChange >= 0) {
    bias = 'bullish';
    pattern = 'Accumulation — Lower Rejection';
    summaryParts.push(`${bottomRejections} lower wick rejections — buyers defending lows`);
    confidence += 12;
  }

  // Delta divergence (price up but mostly bear candles, or vice versa)
  if (priceChange > 0 && bullRatio < 0.4) {
    summaryParts.push('⚠️ Bearish delta divergence — price rising on selling pressure');
    bias = 'bearish';
    pattern = 'Delta Divergence (Bearish)';
    confidence += 10;
  } else if (priceChange < 0 && bullRatio > 0.6) {
    summaryParts.push('⚠️ Bullish delta divergence — price falling on buying pressure');
    bias = 'bullish';
    pattern = 'Delta Divergence (Bullish)';
    confidence += 10;
  }

  // VWAP relationship
  if (last.close > vwap) {
    summaryParts.push('Price above zone VWAP — buyers in control');
  } else {
    summaryParts.push('Price below zone VWAP — sellers in control');
  }

  confidence = Math.max(10, Math.min(95, confidence));

  return {
    summary: summaryParts.join('. ') + '.',
    details,
    bias,
    confidence,
    pattern: pattern || undefined,
    timestamp: Date.now(),
  };
}

function formatVolume(v: number): string {
  if (v >= 1e9) return (v / 1e9).toFixed(2) + 'B';
  if (v >= 1e6) return (v / 1e6).toFixed(2) + 'M';
  if (v >= 1e3) return (v / 1e3).toFixed(1) + 'K';
  return v.toFixed(0);
}

// ─── AIChartAnalyst ──────────────────────────────────────────────────────────

export class AIChartAnalyst {
  private callbacks: AIAnalystCallbacks;
  private panel: HTMLElement | null = null;
  private lastResult: AnalysisResult | null = null;

  constructor(callbacks: AIAnalystCallbacks) {
    this.callbacks = callbacks;
  }

  /**
   * Analyze a zone defined by screen coordinates (from a selection rectangle).
   */
  analyzeScreenZone(x1: number, y1: number, x2: number, y2: number): AnalysisResult {
    const vp = this.callbacks.getViewport();
    const state = this.callbacks.getState();

    const startTime = Math.min(vp.xToTime(x1), vp.xToTime(x2));
    const endTime = Math.max(vp.xToTime(x1), vp.xToTime(x2));
    const highPrice = Math.max(vp.yToPrice(y1), vp.yToPrice(y2));
    const lowPrice = Math.min(vp.yToPrice(y1), vp.yToPrice(y2));

    const candles = state.candles.filter(
      (c) => c.timestamp >= startTime && c.timestamp <= endTime,
    );

    const zone: AnalysisZone = { startTime, endTime, highPrice, lowPrice, candles };
    const result = analyzeZone(zone);
    this.lastResult = result;
    this.showResultPanel(result, zone);
    return result;
  }

  /**
   * Analyze the currently visible chart section.
   */
  analyzeVisibleChart(): AnalysisResult {
    const vp = this.callbacks.getViewport();
    const state = this.callbacks.getState();
    const { width, height } = vp.getLogicalSize();

    return this.analyzeScreenZone(0, 0, width, height);
  }

  /**
   * Analyze last N candles.
   */
  analyzeLastN(n: number): AnalysisResult {
    const state = this.callbacks.getState();
    const candles = state.candles.slice(-n);
    if (candles.length === 0) {
      const empty: AnalysisResult = {
        summary: 'No candle data available.',
        details: [],
        bias: 'neutral',
        confidence: 0,
        timestamp: Date.now(),
      };
      this.showResultPanel(empty, null);
      return empty;
    }

    const zone: AnalysisZone = {
      startTime: candles[0]!.timestamp,
      endTime: candles[candles.length - 1]!.timestamp,
      highPrice: Math.max(...candles.map((c) => c.high)),
      lowPrice: Math.min(...candles.map((c) => c.low)),
      candles,
    };
    const result = analyzeZone(zone);
    this.lastResult = result;
    this.showResultPanel(result, zone);
    return result;
  }

  closePanel(): void {
    this.panel?.remove();
    this.panel = null;
  }

  destroy(): void {
    this.closePanel();
  }

  // ── Result Panel ───────────────────────────────────────────────────────

  private showResultPanel(result: AnalysisResult, zone: AnalysisZone | null): void {
    this.closePanel();

    const biasColor = result.bias === 'bullish' ? '#10b981' : result.bias === 'bearish' ? '#f43f5e' : '#94a3b8';
    const biasIcon = result.bias === 'bullish' ? '📈' : result.bias === 'bearish' ? '📉' : '➡️';

    this.panel = document.createElement('div');
    this.panel.className = 'ai-analyst-panel';
    this.panel.innerHTML = `
      <div class="ai-analyst-header">
        <div class="ai-analyst-title">
          <span class="ai-analyst-icon">🤖</span>
          <span>AI Chart Analysis</span>
        </div>
        <button class="ai-analyst-close" id="aiAnalystClose">✕</button>
      </div>

      ${result.pattern ? `
        <div class="ai-analyst-pattern" style="border-color:${biasColor}">
          <span class="ai-analyst-pattern-icon">${biasIcon}</span>
          <span class="ai-analyst-pattern-name">${result.pattern}</span>
          <span class="ai-analyst-confidence" style="color:${biasColor}">${result.confidence}% confidence</span>
        </div>
      ` : ''}

      <div class="ai-analyst-summary">${result.summary}</div>

      <div class="ai-analyst-details">
        ${result.details.map((d) => {
          const sentColor = d.sentiment === 'bullish' ? '#10b981' : d.sentiment === 'bearish' ? '#f43f5e' : '#94a3b8';
          return `
            <div class="ai-analyst-detail">
              <span class="ai-analyst-detail-label">${d.label}</span>
              <span class="ai-analyst-detail-value" style="color:${sentColor}">${d.value}</span>
            </div>
          `;
        }).join('')}
      </div>

      <div class="ai-analyst-bias" style="background:${biasColor}15;border-color:${biasColor}">
        <span>Overall Bias: <strong style="color:${biasColor}">${result.bias.toUpperCase()}</strong></span>
        <div class="ai-analyst-bias-bar">
          <div class="ai-analyst-bias-fill" style="width:${result.confidence}%;background:${biasColor}"></div>
        </div>
      </div>

      ${zone ? `
        <div class="ai-analyst-zone-info">
          ${zone.candles.length} candles analyzed · ${new Date(zone.startTime).toLocaleTimeString()} — ${new Date(zone.endTime).toLocaleTimeString()}
        </div>
      ` : ''}
    `;

    document.body.appendChild(this.panel);
    requestAnimationFrame(() => this.panel?.classList.add('open'));

    this.panel.querySelector('#aiAnalystClose')?.addEventListener('click', () => this.closePanel());
  }
}
