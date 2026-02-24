/**
 * IndicatorConflictDetector.ts
 * "You added RSI + Stochastic + CCI — those three are doing the same thing.
 *  Suggest: keep one."
 * Watches active indicators and warns about redundancy.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export interface IndicatorInfo {
  id: string;
  name: string;
  params?: Record<string, number | string>;
}

export interface ConflictWarning {
  type: 'redundant' | 'overcrowded' | 'opposing';
  indicators: string[];
  message: string;
  suggestion: string;
}

type ConflictCallback = (warnings: ConflictWarning[]) => void;

// ─── Conflict Rules ──────────────────────────────────────────────────────────

interface IndicatorCategory {
  name: string;
  memberIds: string[];
  maxRecommended: number;
}

const INDICATOR_CATEGORIES: IndicatorCategory[] = [
  {
    name: 'Momentum Oscillators',
    memberIds: ['rsi', 'stochastic', 'stochrsi', 'cci', 'williams_r', 'mfi'],
    maxRecommended: 1,
  },
  {
    name: 'Trend / Moving Averages',
    memberIds: ['sma', 'ema', 'wma', 'dema', 'tema', 'hull_ma', 'kama'],
    maxRecommended: 3,
  },
  {
    name: 'Volatility Bands',
    memberIds: ['bollinger', 'keltner', 'donchian', 'atr_bands'],
    maxRecommended: 1,
  },
  {
    name: 'Volume Indicators',
    memberIds: ['obv', 'vwap', 'mfi', 'accumulation_distribution', 'cmf', 'volume_profile'],
    maxRecommended: 2,
  },
  {
    name: 'Trend Strength',
    memberIds: ['adx', 'aroon', 'ichimoku', 'parabolic_sar', 'supertrend'],
    maxRecommended: 1,
  },
  {
    name: 'MACD-type',
    memberIds: ['macd', 'ppo', 'tsi'],
    maxRecommended: 1,
  },
];

/** Known opposing pairs — when both are present they can confuse signals */
const OPPOSING_PAIRS: [string, string, string][] = [
  ['rsi', 'macd', 'RSI is a bounded oscillator while MACD is unbounded — conflicting signal types'],
  ['bollinger', 'keltner', 'Both are volatility envelopes with different math — one is usually enough'],
];

/** Absolute max indicators before "overcrowded" warning */
const OVERCROWDED_THRESHOLD = 6;

// ─── IndicatorConflictDetector ───────────────────────────────────────────────

export class IndicatorConflictDetector {
  private activeIndicators: Map<string, IndicatorInfo> = new Map();
  private onConflict: ConflictCallback;
  private notifyContainer: HTMLElement | null = null;

  constructor(onConflict: ConflictCallback) {
    this.onConflict = onConflict;
    this.createNotifyContainer();
  }

  // ── Public API ─────────────────────────────────────────────────────────

  /** Called whenever an indicator is added or removed */
  setActiveIndicators(indicators: IndicatorInfo[]): void {
    this.activeIndicators.clear();
    for (const ind of indicators) {
      this.activeIndicators.set(ind.id, ind);
    }
    this.analyze();
  }

  addIndicator(indicator: IndicatorInfo): void {
    this.activeIndicators.set(indicator.id, indicator);
    this.analyze();
  }

  removeIndicator(id: string): void {
    this.activeIndicators.delete(id);
    this.analyze();
  }

  /** Get current warnings without callback */
  getWarnings(): ConflictWarning[] {
    return this.computeWarnings();
  }

  destroy(): void {
    this.notifyContainer?.remove();
    this.notifyContainer = null;
  }

  // ── Analysis ───────────────────────────────────────────────────────────

  private analyze(): void {
    const warnings = this.computeWarnings();
    if (warnings.length > 0) {
      this.onConflict(warnings);
      this.showNotifications(warnings);
    } else {
      this.clearNotifications();
    }
  }

  private computeWarnings(): ConflictWarning[] {
    const warnings: ConflictWarning[] = [];
    const ids = [...this.activeIndicators.keys()];

    // 1. Category redundancy
    for (const cat of INDICATOR_CATEGORIES) {
      const active = ids.filter((id) => cat.memberIds.includes(id));
      if (active.length > cat.maxRecommended) {
        const names = active.map((id) => this.activeIndicators.get(id)?.name ?? id);
        warnings.push({
          type: 'redundant',
          indicators: active,
          message: `${names.join(', ')} are all ${cat.name} — they measure the same thing.`,
          suggestion: `Keep ${cat.maxRecommended === 1 ? 'one' : `up to ${cat.maxRecommended}`}. The extra noise hurts more than it helps.`,
        });
      }
    }

    // 2. Opposing pairs
    for (const [a, b, reason] of OPPOSING_PAIRS) {
      if (ids.includes(a) && ids.includes(b)) {
        const nameA = this.activeIndicators.get(a)?.name ?? a;
        const nameB = this.activeIndicators.get(b)?.name ?? b;
        warnings.push({
          type: 'opposing',
          indicators: [a, b],
          message: `${nameA} + ${nameB} — ${reason}`,
          suggestion: 'Choose the one that matches your strategy style.',
        });
      }
    }

    // 3. Overcrowded chart
    if (ids.length > OVERCROWDED_THRESHOLD) {
      warnings.push({
        type: 'overcrowded',
        indicators: ids,
        message: `${ids.length} indicators active — your chart is getting noisy.`,
        suggestion: `Consider removing overlaps. Most pro traders use 2-3 max.`,
      });
    }

    return warnings;
  }

  // ── Notification UI ────────────────────────────────────────────────────

  private createNotifyContainer(): void {
    if (document.querySelector('.indicator-conflict-container')) return;
    this.notifyContainer = document.createElement('div');
    this.notifyContainer.className = 'indicator-conflict-container';
    document.body.appendChild(this.notifyContainer);
  }

  private showNotifications(warnings: ConflictWarning[]): void {
    if (!this.notifyContainer) this.createNotifyContainer();
    this.clearNotifications();

    for (const w of warnings) {
      const el = document.createElement('div');
      el.className = `indicator-conflict-toast indicator-conflict-toast--${w.type}`;
      el.innerHTML = `
        <div class="indicator-conflict-icon">
          ${w.type === 'redundant' ? '⚠️' : w.type === 'opposing' ? '⚡' : '📊'}
        </div>
        <div class="indicator-conflict-body">
          <div class="indicator-conflict-msg">${w.message}</div>
          <div class="indicator-conflict-suggestion">${w.suggestion}</div>
        </div>
        <button class="indicator-conflict-dismiss" title="Dismiss">✕</button>
      `;

      el.querySelector('.indicator-conflict-dismiss')?.addEventListener('click', () => {
        el.classList.add('dismissed');
        setTimeout(() => el.remove(), 300);
      });

      this.notifyContainer!.appendChild(el);

      // Auto-dismiss after 10 seconds
      setTimeout(() => {
        el.classList.add('dismissed');
        setTimeout(() => el.remove(), 300);
      }, 10000);
    }
  }

  private clearNotifications(): void {
    if (this.notifyContainer) this.notifyContainer.innerHTML = '';
  }
}
