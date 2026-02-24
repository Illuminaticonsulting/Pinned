/**
 * SplitComparison.ts
 * Split-screen time comparison: same asset, two different dates, side-by-side.
 *
 * "Does BTC's current 4h chart look like the March 2023 breakout?"
 * Pick two dates → overlay or split. Correlation score shows similarity.
 *
 * No crypto platform has this. Bloomberg Terminal's "GP" command is the closest
 * equivalent, but restricted to equities.
 */

import type { Candle } from '../core/ChartState';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ComparisonPeriod {
  label: string;
  startTs: number;
  endTs: number;
  candles: Candle[];
  color: string;
}

export type ComparisonMode = 'split' | 'overlay';

export interface SplitComparisonCallbacks {
  fetchCandles: (symbol: string, timeframe: string, startTs: number, endTs: number) => Promise<Candle[]>;
  getCurrentSymbol: () => string;
  getCurrentTimeframe: () => string;
  onToast: (message: string, duration?: number) => void;
}

// ─── SplitComparison ─────────────────────────────────────────────────────────

export class SplitComparison {
  private overlay: HTMLElement | null = null;
  private isOpen = false;
  private callbacks: SplitComparisonCallbacks;
  private mode: ComparisonMode = 'overlay';
  private periodA: ComparisonPeriod | null = null;
  private periodB: ComparisonPeriod | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;

  constructor(callbacks: SplitComparisonCallbacks) {
    this.callbacks = callbacks;
  }

  // ── Public API ─────────────────────────────────────────────────────────

  open(): void {
    if (this.isOpen) return;
    this.isOpen = true;
    this.render();
  }

  close(): void {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.overlay?.classList.remove('open');
    setTimeout(() => {
      this.overlay?.remove();
      this.overlay = null;
      this.canvas = null;
      this.ctx = null;
    }, 200);
  }

  destroy(): void {
    this.close();
  }

  // ── Render ─────────────────────────────────────────────────────────────

  private render(): void {
    this.overlay = document.createElement('div');
    this.overlay.className = 'comparison-overlay';
    this.overlay.addEventListener('mousedown', (e) => {
      if (e.target === this.overlay) this.close();
    });

    const symbol = this.callbacks.getCurrentSymbol();
    const timeframe = this.callbacks.getCurrentTimeframe();

    const modal = document.createElement('div');
    modal.className = 'comparison-modal';
    modal.innerHTML = `
      <div class="comparison-header">
        <h2 class="comparison-title">📊 Split Comparison</h2>
        <p class="comparison-subtitle">${symbol} • ${timeframe} — Compare two time periods side by side</p>
        <button class="comparison-close" id="compClose">✕</button>
      </div>

      <div class="comparison-controls">
        <div class="comparison-period">
          <h3 class="comparison-period-title" style="color:#6366f1">📅 Period A</h3>
          <div class="comparison-date-row">
            <label>Start</label>
            <input type="datetime-local" id="compAStart" class="comparison-date" />
            <label>End</label>
            <input type="datetime-local" id="compAEnd" class="comparison-date" />
          </div>
        </div>
        <div class="comparison-period">
          <h3 class="comparison-period-title" style="color:#f59e0b">📅 Period B</h3>
          <div class="comparison-date-row">
            <label>Start</label>
            <input type="datetime-local" id="compBStart" class="comparison-date" />
            <label>End</label>
            <input type="datetime-local" id="compBEnd" class="comparison-date" />
          </div>
        </div>
      </div>

      <div class="comparison-actions">
        <div class="comparison-mode-toggle">
          <button class="comparison-mode-btn active" data-mode="overlay">Overlay</button>
          <button class="comparison-mode-btn" data-mode="split">Split</button>
        </div>
        <button class="comparison-load-btn" id="compLoadBtn">🔍 Compare</button>
      </div>

      <div class="comparison-chart-area" id="compChartArea">
        <div class="comparison-empty">Select two date ranges and click Compare</div>
      </div>

      <div class="comparison-stats" id="compStats" style="display:none">
        <div class="comparison-stat">
          <span class="comparison-stat-label">Correlation</span>
          <span class="comparison-stat-value" id="compCorrelation">—</span>
        </div>
        <div class="comparison-stat">
          <span class="comparison-stat-label">Period A Return</span>
          <span class="comparison-stat-value" id="compReturnA">—</span>
        </div>
        <div class="comparison-stat">
          <span class="comparison-stat-label">Period B Return</span>
          <span class="comparison-stat-value" id="compReturnB">—</span>
        </div>
        <div class="comparison-stat">
          <span class="comparison-stat-label">A Volatility</span>
          <span class="comparison-stat-value" id="compVolA">—</span>
        </div>
        <div class="comparison-stat">
          <span class="comparison-stat-label">B Volatility</span>
          <span class="comparison-stat-value" id="compVolB">—</span>
        </div>
      </div>
    `;

    this.overlay.appendChild(modal);
    document.body.appendChild(this.overlay);
    requestAnimationFrame(() => this.overlay?.classList.add('open'));

    // Set default dates
    this.setDefaultDates(modal);
    this.bindEvents(modal);
  }

  private setDefaultDates(modal: HTMLElement): void {
    const now = new Date();
    const oneDay = 24 * 60 * 60 * 1000;

    // Period A: last 24h
    const aEnd = now;
    const aStart = new Date(now.getTime() - oneDay);

    // Period B: 7 days ago, same duration
    const bEnd = new Date(now.getTime() - 7 * oneDay);
    const bStart = new Date(bEnd.getTime() - oneDay);

    const fmt = (d: Date) => d.toISOString().slice(0, 16);

    (modal.querySelector('#compAStart') as HTMLInputElement).value = fmt(aStart);
    (modal.querySelector('#compAEnd') as HTMLInputElement).value = fmt(aEnd);
    (modal.querySelector('#compBStart') as HTMLInputElement).value = fmt(bStart);
    (modal.querySelector('#compBEnd') as HTMLInputElement).value = fmt(bEnd);
  }

  private bindEvents(modal: HTMLElement): void {
    modal.querySelector('#compClose')?.addEventListener('click', () => this.close());

    // Mode toggle
    modal.querySelectorAll<HTMLButtonElement>('.comparison-mode-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        modal.querySelectorAll('.comparison-mode-btn').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        this.mode = btn.dataset.mode as ComparisonMode;
        if (this.periodA && this.periodB) this.drawChart(modal);
      });
    });

    // Load/compare
    modal.querySelector('#compLoadBtn')?.addEventListener('click', async () => {
      await this.loadPeriods(modal);
    });

    // ESC
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        this.close();
        document.removeEventListener('keydown', esc);
      }
    };
    document.addEventListener('keydown', esc);
  }

  private async loadPeriods(modal: HTMLElement): Promise<void> {
    const symbol = this.callbacks.getCurrentSymbol();
    const tf = this.callbacks.getCurrentTimeframe();

    const aStart = new Date((modal.querySelector('#compAStart') as HTMLInputElement).value).getTime();
    const aEnd = new Date((modal.querySelector('#compAEnd') as HTMLInputElement).value).getTime();
    const bStart = new Date((modal.querySelector('#compBStart') as HTMLInputElement).value).getTime();
    const bEnd = new Date((modal.querySelector('#compBEnd') as HTMLInputElement).value).getTime();

    if (!aStart || !aEnd || !bStart || !bEnd) {
      this.callbacks.onToast('Please fill all date fields');
      return;
    }

    const loadBtn = modal.querySelector('#compLoadBtn') as HTMLButtonElement;
    loadBtn.textContent = '⏳ Loading...';
    loadBtn.disabled = true;

    try {
      const [candlesA, candlesB] = await Promise.all([
        this.callbacks.fetchCandles(symbol, tf, aStart, aEnd),
        this.callbacks.fetchCandles(symbol, tf, bStart, bEnd),
      ]);

      if (candlesA.length === 0 || candlesB.length === 0) {
        this.callbacks.onToast('No data for one or both periods');
        return;
      }

      this.periodA = {
        label: 'Period A',
        startTs: aStart,
        endTs: aEnd,
        candles: candlesA,
        color: '#6366f1',
      };

      this.periodB = {
        label: 'Period B',
        startTs: bStart,
        endTs: bEnd,
        candles: candlesB,
        color: '#f59e0b',
      };

      this.drawChart(modal);
      this.computeStats(modal);
    } catch (err) {
      this.callbacks.onToast('Failed to load candle data');
      console.error('[SplitComparison] Load error:', err);
    } finally {
      loadBtn.textContent = '🔍 Compare';
      loadBtn.disabled = false;
    }
  }

  private drawChart(modal: HTMLElement): void {
    if (!this.periodA || !this.periodB) return;

    const chartArea = modal.querySelector('#compChartArea') as HTMLElement;
    chartArea.innerHTML = '';

    this.canvas = document.createElement('canvas');
    this.canvas.className = 'comparison-canvas';
    this.canvas.width = chartArea.clientWidth || 800;
    this.canvas.height = 300;
    chartArea.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d')!;

    if (this.mode === 'overlay') {
      this.drawOverlay();
    } else {
      this.drawSplit();
    }
  }

  private drawOverlay(): void {
    if (!this.ctx || !this.canvas || !this.periodA || !this.periodB) return;
    const { width, height } = this.canvas;
    const padding = { top: 20, bottom: 30, left: 60, right: 20 };
    const chartW = width - padding.left - padding.right;
    const chartH = height - padding.top - padding.bottom;

    this.ctx.fillStyle = '#0a0e17';
    this.ctx.fillRect(0, 0, width, height);

    // Normalize both series to percentage change from start
    const normalizeToPercent = (candles: Candle[]) => {
      if (candles.length === 0) return [];
      const base = candles[0].close;
      return candles.map((c) => ((c.close - base) / base) * 100);
    };

    const pctA = normalizeToPercent(this.periodA.candles);
    const pctB = normalizeToPercent(this.periodB.candles);

    const maxLen = Math.max(pctA.length, pctB.length);
    const allPct = [...pctA, ...pctB];
    const minPct = Math.min(...allPct);
    const maxPct = Math.max(...allPct);
    const range = maxPct - minPct || 1;

    // Draw grid
    this.ctx.strokeStyle = '#1e293b';
    this.ctx.lineWidth = 0.5;
    for (let i = 0; i <= 4; i++) {
      const y = padding.top + (chartH / 4) * i;
      this.ctx.beginPath();
      this.ctx.moveTo(padding.left, y);
      this.ctx.lineTo(width - padding.right, y);
      this.ctx.stroke();

      const val = maxPct - (range / 4) * i;
      this.ctx.fillStyle = '#4b5563';
      this.ctx.font = '10px monospace';
      this.ctx.textAlign = 'right';
      this.ctx.fillText(`${val.toFixed(1)}%`, padding.left - 8, y + 3);
    }

    // Zero line
    const zeroY = padding.top + ((maxPct - 0) / range) * chartH;
    this.ctx.strokeStyle = '#374151';
    this.ctx.setLineDash([4, 4]);
    this.ctx.beginPath();
    this.ctx.moveTo(padding.left, zeroY);
    this.ctx.lineTo(width - padding.right, zeroY);
    this.ctx.stroke();
    this.ctx.setLineDash([]);

    // Draw series
    const drawSeries = (pcts: number[], color: string) => {
      if (pcts.length < 2) return;
      this.ctx!.strokeStyle = color;
      this.ctx!.lineWidth = 2;
      this.ctx!.beginPath();

      for (let i = 0; i < pcts.length; i++) {
        const x = padding.left + (i / (maxLen - 1)) * chartW;
        const y = padding.top + ((maxPct - pcts[i]) / range) * chartH;
        if (i === 0) this.ctx!.moveTo(x, y);
        else this.ctx!.lineTo(x, y);
      }
      this.ctx!.stroke();
    };

    drawSeries(pctA, this.periodA.color);
    drawSeries(pctB, this.periodB.color);

    // Legend
    this.ctx.font = '11px sans-serif';
    this.ctx.fillStyle = this.periodA.color;
    this.ctx.fillText(`● Period A (${this.periodA.candles.length} bars)`, padding.left + 10, padding.top + 12);
    this.ctx.fillStyle = this.periodB.color;
    this.ctx.fillText(`● Period B (${this.periodB.candles.length} bars)`, padding.left + 200, padding.top + 12);
  }

  private drawSplit(): void {
    if (!this.ctx || !this.canvas || !this.periodA || !this.periodB) return;
    const { width, height } = this.canvas;
    const halfW = width / 2;

    this.ctx.fillStyle = '#0a0e17';
    this.ctx.fillRect(0, 0, width, height);

    // Divider
    this.ctx.strokeStyle = '#374151';
    this.ctx.lineWidth = 1;
    this.ctx.beginPath();
    this.ctx.moveTo(halfW, 0);
    this.ctx.lineTo(halfW, height);
    this.ctx.stroke();

    // Draw candles for each side
    this.drawCandlesticks(this.periodA.candles, 0, 0, halfW - 4, height, this.periodA.label, this.periodA.color);
    this.drawCandlesticks(this.periodB.candles, halfW + 4, 0, halfW - 4, height, this.periodB.label, this.periodB.color);
  }

  private drawCandlesticks(candles: Candle[], ox: number, oy: number, w: number, h: number, label: string, color: string): void {
    if (!this.ctx || candles.length === 0) return;
    const padding = { top: 30, bottom: 20, left: 10, right: 10 };
    const chartW = w - padding.left - padding.right;
    const chartH = h - padding.top - padding.bottom;

    const highs = candles.map((c) => c.high);
    const lows = candles.map((c) => c.low);
    const minPrice = Math.min(...lows);
    const maxPrice = Math.max(...highs);
    const range = maxPrice - minPrice || 1;

    const candleWidth = Math.max(1, chartW / candles.length - 1);

    for (let i = 0; i < candles.length; i++) {
      const c = candles[i];
      const x = ox + padding.left + (i / candles.length) * chartW;
      const bullish = c.close >= c.open;

      const openY = oy + padding.top + ((maxPrice - c.open) / range) * chartH;
      const closeY = oy + padding.top + ((maxPrice - c.close) / range) * chartH;
      const highY = oy + padding.top + ((maxPrice - c.high) / range) * chartH;
      const lowY = oy + padding.top + ((maxPrice - c.low) / range) * chartH;

      // Wick
      this.ctx.strokeStyle = bullish ? '#10b981' : '#f43f5e';
      this.ctx.lineWidth = 1;
      this.ctx.beginPath();
      this.ctx.moveTo(x + candleWidth / 2, highY);
      this.ctx.lineTo(x + candleWidth / 2, lowY);
      this.ctx.stroke();

      // Body
      this.ctx.fillStyle = bullish ? '#10b981' : '#f43f5e';
      const bodyTop = Math.min(openY, closeY);
      const bodyH = Math.max(1, Math.abs(closeY - openY));
      this.ctx.fillRect(x, bodyTop, candleWidth, bodyH);
    }

    // Label
    this.ctx.fillStyle = color;
    this.ctx.font = 'bold 11px sans-serif';
    this.ctx.fillText(label, ox + padding.left + 4, oy + 18);
  }

  private computeStats(modal: HTMLElement): void {
    if (!this.periodA || !this.periodB) return;

    const statsEl = modal.querySelector('#compStats') as HTMLElement;
    statsEl.style.display = 'flex';

    // Returns
    const returnA = this.calcReturn(this.periodA.candles);
    const returnB = this.calcReturn(this.periodB.candles);

    // Volatility (std dev of returns)
    const volA = this.calcVolatility(this.periodA.candles);
    const volB = this.calcVolatility(this.periodB.candles);

    // Correlation
    const correlation = this.calcCorrelation(this.periodA.candles, this.periodB.candles);

    const corrEl = modal.querySelector('#compCorrelation')!;
    corrEl.textContent = `${(correlation * 100).toFixed(1)}%`;
    (corrEl as HTMLElement).style.color = correlation > 0.7 ? '#10b981' : correlation > 0.4 ? '#f59e0b' : '#f43f5e';

    const retAEl = modal.querySelector('#compReturnA')!;
    retAEl.textContent = `${returnA >= 0 ? '+' : ''}${returnA.toFixed(2)}%`;
    (retAEl as HTMLElement).style.color = returnA >= 0 ? '#10b981' : '#f43f5e';

    const retBEl = modal.querySelector('#compReturnB')!;
    retBEl.textContent = `${returnB >= 0 ? '+' : ''}${returnB.toFixed(2)}%`;
    (retBEl as HTMLElement).style.color = returnB >= 0 ? '#10b981' : '#f43f5e';

    (modal.querySelector('#compVolA')! as HTMLElement).textContent = `${volA.toFixed(2)}%`;
    (modal.querySelector('#compVolB')! as HTMLElement).textContent = `${volB.toFixed(2)}%`;
  }

  private calcReturn(candles: Candle[]): number {
    if (candles.length < 2) return 0;
    const first = candles[0].close;
    const last = candles[candles.length - 1].close;
    return ((last - first) / first) * 100;
  }

  private calcVolatility(candles: Candle[]): number {
    if (candles.length < 2) return 0;
    const returns: number[] = [];
    for (let i = 1; i < candles.length; i++) {
      returns.push((candles[i].close - candles[i - 1].close) / candles[i - 1].close);
    }
    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length;
    return Math.sqrt(variance) * 100;
  }

  private calcCorrelation(candlesA: Candle[], candlesB: Candle[]): number {
    // Normalize to same length using percent change from start
    const norm = (candles: Candle[]) => {
      if (!candles.length) return [];
      const base = candles[0].close;
      return candles.map((c) => ((c.close - base) / base) * 100);
    };

    const pA = norm(candlesA);
    const pB = norm(candlesB);

    // Resample to same length
    const len = Math.min(pA.length, pB.length);
    if (len < 2) return 0;

    const a = pA.slice(0, len);
    const b = pB.slice(0, len);

    const meanA = a.reduce((s, v) => s + v, 0) / len;
    const meanB = b.reduce((s, v) => s + v, 0) / len;

    let cov = 0, varA = 0, varB = 0;
    for (let i = 0; i < len; i++) {
      const dA = a[i] - meanA;
      const dB = b[i] - meanB;
      cov += dA * dB;
      varA += dA * dA;
      varB += dB * dB;
    }

    const denom = Math.sqrt(varA * varB);
    return denom === 0 ? 0 : cov / denom;
  }
}
