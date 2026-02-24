/**
 * TradeJournal.ts
 * Built-in trade journal baked into the platform.
 *
 * Press J on any candle to log a trade entry. Photo of chart auto-attached.
 * Tag it: setup type, conviction level, emotional state. P&L auto-pulled
 * from connected exchange. Weekly review dashboard.
 *
 * Traders currently pay $30/month for Tradervue or Notion setups to do this.
 * It's inside our platform free.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export type TradeSide = 'long' | 'short';
export type SetupType = 'breakout' | 'pullback' | 'reversal' | 'range' | 'scalp' | 'swing' | 'trend' | 'custom';
export type ConvictionLevel = 1 | 2 | 3 | 4 | 5;
export type EmotionalState = 'calm' | 'confident' | 'anxious' | 'fomo' | 'revenge' | 'euphoric' | 'neutral';

export interface TradeEntry {
  id: string;
  timestamp: number;
  symbol: string;
  timeframe: string;
  side: TradeSide;
  entryPrice: number;
  exitPrice?: number;
  stopLoss?: number;
  takeProfit?: number;
  positionSize?: number;
  setup: SetupType;
  conviction: ConvictionLevel;
  emotion: EmotionalState;
  notes: string;
  tags: string[];
  chartSnapshot?: string;        // base64 chart image
  pnl?: number;
  pnlPercent?: number;
  riskReward?: number;
  status: 'open' | 'closed' | 'cancelled';
  closedAt?: number;
}

export interface JournalStats {
  totalTrades: number;
  winRate: number;
  avgWin: number;
  avgLoss: number;
  profitFactor: number;
  avgRR: number;
  bestSetup: string;
  worstSetup: string;
  totalPnl: number;
}

export interface TradeJournalCallbacks {
  onGetChartSnapshot: () => Promise<string | null>;
  getCurrentPrice: () => number;
  getCurrentSymbol: () => string;
  getCurrentTimeframe: () => string;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const STORAGE_KEY = 'pinned_trade_journal';

const SETUP_TYPES: { value: SetupType; label: string; icon: string }[] = [
  { value: 'breakout', label: 'Breakout', icon: '🚀' },
  { value: 'pullback', label: 'Pullback', icon: '↩️' },
  { value: 'reversal', label: 'Reversal', icon: '🔄' },
  { value: 'range', label: 'Range', icon: '↔️' },
  { value: 'scalp', label: 'Scalp', icon: '⚡' },
  { value: 'swing', label: 'Swing', icon: '🌊' },
  { value: 'trend', label: 'Trend', icon: '📈' },
  { value: 'custom', label: 'Custom', icon: '✏️' },
];

const EMOTIONS: { value: EmotionalState; label: string; icon: string }[] = [
  { value: 'calm', label: 'Calm', icon: '😌' },
  { value: 'confident', label: 'Confident', icon: '💪' },
  { value: 'anxious', label: 'Anxious', icon: '😰' },
  { value: 'fomo', label: 'FOMO', icon: '🤯' },
  { value: 'revenge', label: 'Revenge', icon: '😤' },
  { value: 'euphoric', label: 'Euphoric', icon: '🤩' },
  { value: 'neutral', label: 'Neutral', icon: '😐' },
];

function uid(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

// ─── TradeJournal ────────────────────────────────────────────────────────────

export class TradeJournal {
  private entries: TradeEntry[] = [];
  private overlay: HTMLElement | null = null;
  private callbacks: TradeJournalCallbacks;
  private isOpen = false;
  private editingEntry: TradeEntry | null = null;

  constructor(callbacks: TradeJournalCallbacks) {
    this.callbacks = callbacks;
    this.loadEntries();
  }

  // ── Public API ─────────────────────────────────────────────────────────

  /** Open the journal entry modal (press J) */
  async openNewEntry(): Promise<void> {
    const snapshot = await this.callbacks.onGetChartSnapshot();
    const price = this.callbacks.getCurrentPrice();
    const symbol = this.callbacks.getCurrentSymbol();
    const timeframe = this.callbacks.getCurrentTimeframe();

    const entry: TradeEntry = {
      id: uid(),
      timestamp: Date.now(),
      symbol,
      timeframe,
      side: 'long',
      entryPrice: price,
      setup: 'breakout',
      conviction: 3,
      emotion: 'neutral',
      notes: '',
      tags: [],
      chartSnapshot: snapshot ?? undefined,
      status: 'open',
    };

    this.editingEntry = entry;
    this.renderEntryModal(entry, true);
  }

  /** Open the journal dashboard / review */
  openDashboard(): void {
    this.renderDashboard();
  }

  /** Get statistics for all entries */
  getStats(): JournalStats {
    const closed = this.entries.filter((e) => e.status === 'closed' && e.pnl != null);
    const wins = closed.filter((e) => e.pnl! > 0);
    const losses = closed.filter((e) => e.pnl! <= 0);
    const totalPnl = closed.reduce((sum, e) => sum + (e.pnl ?? 0), 0);
    const avgWin = wins.length > 0 ? wins.reduce((s, e) => s + e.pnl!, 0) / wins.length : 0;
    const avgLoss = losses.length > 0 ? Math.abs(losses.reduce((s, e) => s + e.pnl!, 0) / losses.length) : 0;

    // Best/worst setup by win rate
    const setupStats = new Map<string, { wins: number; total: number }>();
    for (const e of closed) {
      const s = setupStats.get(e.setup) ?? { wins: 0, total: 0 };
      s.total++;
      if (e.pnl! > 0) s.wins++;
      setupStats.set(e.setup, s);
    }
    let bestSetup = '-';
    let worstSetup = '-';
    let bestRate = -1;
    let worstRate = 2;
    for (const [setup, s] of setupStats) {
      const rate = s.wins / s.total;
      if (rate > bestRate) { bestRate = rate; bestSetup = setup; }
      if (rate < worstRate) { worstRate = rate; worstSetup = setup; }
    }

    return {
      totalTrades: closed.length,
      winRate: closed.length > 0 ? (wins.length / closed.length) * 100 : 0,
      avgWin,
      avgLoss,
      profitFactor: avgLoss > 0 ? avgWin / avgLoss : 0,
      avgRR: closed.length > 0 ? closed.reduce((s, e) => s + (e.riskReward ?? 0), 0) / closed.length : 0,
      bestSetup,
      worstSetup,
      totalPnl,
    };
  }

  getEntries(): TradeEntry[] {
    return [...this.entries];
  }

  close(): void {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.overlay?.classList.remove('open');
    setTimeout(() => {
      this.overlay?.remove();
      this.overlay = null;
    }, 200);
  }

  destroy(): void {
    this.close();
  }

  // ── Entry Modal ────────────────────────────────────────────────────────

  private renderEntryModal(entry: TradeEntry, isNew: boolean): void {
    this.close();
    this.isOpen = true;

    this.overlay = document.createElement('div');
    this.overlay.className = 'journal-overlay';
    this.overlay.addEventListener('mousedown', (e) => {
      if (e.target === this.overlay) this.close();
    });

    const modal = document.createElement('div');
    modal.className = 'journal-modal';
    modal.innerHTML = `
      <div class="journal-header">
        <h2 class="journal-title">${isNew ? '📝 New Trade Entry' : '✏️ Edit Trade'}</h2>
        <button class="journal-close" id="journalCloseBtn">✕</button>
      </div>

      <div class="journal-body">
        ${entry.chartSnapshot ? `
          <div class="journal-snapshot">
            <img src="${entry.chartSnapshot}" alt="Chart snapshot" />
          </div>
        ` : ''}

        <div class="journal-row">
          <div class="journal-field">
            <label>Symbol</label>
            <input type="text" class="journal-input" id="jSymbol" value="${entry.symbol}" readonly />
          </div>
          <div class="journal-field">
            <label>Side</label>
            <div class="journal-side-group" id="jSide">
              <button class="journal-side-btn ${entry.side === 'long' ? 'active long' : ''}" data-value="long">🟢 Long</button>
              <button class="journal-side-btn ${entry.side === 'short' ? 'active short' : ''}" data-value="short">🔴 Short</button>
            </div>
          </div>
        </div>

        <div class="journal-row">
          <div class="journal-field">
            <label>Entry Price</label>
            <input type="number" class="journal-input" id="jEntryPrice" value="${entry.entryPrice}" step="0.01" />
          </div>
          <div class="journal-field">
            <label>Stop Loss</label>
            <input type="number" class="journal-input" id="jStopLoss" value="${entry.stopLoss ?? ''}" placeholder="Optional" step="0.01" />
          </div>
          <div class="journal-field">
            <label>Take Profit</label>
            <input type="number" class="journal-input" id="jTakeProfit" value="${entry.takeProfit ?? ''}" placeholder="Optional" step="0.01" />
          </div>
        </div>

        <div class="journal-row">
          <div class="journal-field">
            <label>Setup Type</label>
            <div class="journal-chips" id="jSetup">
              ${SETUP_TYPES.map((s) =>
                `<button class="journal-chip ${entry.setup === s.value ? 'active' : ''}" data-value="${s.value}">${s.icon} ${s.label}</button>`
              ).join('')}
            </div>
          </div>
        </div>

        <div class="journal-row">
          <div class="journal-field">
            <label>Conviction Level</label>
            <div class="journal-stars" id="jConviction">
              ${[1, 2, 3, 4, 5].map((n) =>
                `<button class="journal-star ${n <= entry.conviction ? 'active' : ''}" data-value="${n}">★</button>`
              ).join('')}
            </div>
          </div>
          <div class="journal-field">
            <label>Emotional State</label>
            <div class="journal-chips journal-emotions" id="jEmotion">
              ${EMOTIONS.map((em) =>
                `<button class="journal-chip ${entry.emotion === em.value ? 'active' : ''}" data-value="${em.value}">${em.icon} ${em.label}</button>`
              ).join('')}
            </div>
          </div>
        </div>

        <div class="journal-row">
          <div class="journal-field journal-field--full">
            <label>Notes</label>
            <textarea class="journal-textarea" id="jNotes" rows="3" placeholder="What's the reasoning behind this trade?">${entry.notes}</textarea>
          </div>
        </div>

        <div class="journal-row">
          <div class="journal-field journal-field--full">
            <label>Tags</label>
            <input type="text" class="journal-input" id="jTags" placeholder="e.g. btc, breakout, high-volume (comma-separated)" value="${entry.tags.join(', ')}" />
          </div>
        </div>
      </div>

      <div class="journal-footer">
        <button class="journal-btn journal-btn--cancel" id="journalCancelBtn">Cancel</button>
        <button class="journal-btn journal-btn--save" id="journalSaveBtn">
          ${isNew ? '💾 Save Entry' : '💾 Update'}
        </button>
      </div>
    `;

    this.overlay.appendChild(modal);
    document.body.appendChild(this.overlay);
    requestAnimationFrame(() => this.overlay?.classList.add('open'));

    // Bind modal events
    modal.querySelector('#journalCloseBtn')?.addEventListener('click', () => this.close());
    modal.querySelector('#journalCancelBtn')?.addEventListener('click', () => this.close());

    // Side toggle
    modal.querySelectorAll<HTMLButtonElement>('#jSide .journal-side-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        modal.querySelectorAll('#jSide .journal-side-btn').forEach((b) => b.classList.remove('active', 'long', 'short'));
        btn.classList.add('active', btn.dataset.value!);
        entry.side = btn.dataset.value as TradeSide;
      });
    });

    // Setup chips
    modal.querySelectorAll<HTMLButtonElement>('#jSetup .journal-chip').forEach((btn) => {
      btn.addEventListener('click', () => {
        modal.querySelectorAll('#jSetup .journal-chip').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        entry.setup = btn.dataset.value as SetupType;
      });
    });

    // Conviction stars
    modal.querySelectorAll<HTMLButtonElement>('#jConviction .journal-star').forEach((btn) => {
      btn.addEventListener('click', () => {
        const val = parseInt(btn.dataset.value!, 10) as ConvictionLevel;
        entry.conviction = val;
        modal.querySelectorAll('#jConviction .journal-star').forEach((b) => {
          b.classList.toggle('active', parseInt((b as HTMLElement).dataset.value!, 10) <= val);
        });
      });
    });

    // Emotion chips
    modal.querySelectorAll<HTMLButtonElement>('#jEmotion .journal-chip').forEach((btn) => {
      btn.addEventListener('click', () => {
        modal.querySelectorAll('#jEmotion .journal-chip').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        entry.emotion = btn.dataset.value as EmotionalState;
      });
    });

    // Save
    modal.querySelector('#journalSaveBtn')?.addEventListener('click', () => {
      entry.entryPrice = parseFloat((modal.querySelector('#jEntryPrice') as HTMLInputElement).value) || entry.entryPrice;
      const sl = parseFloat((modal.querySelector('#jStopLoss') as HTMLInputElement).value);
      const tp = parseFloat((modal.querySelector('#jTakeProfit') as HTMLInputElement).value);
      if (!isNaN(sl)) entry.stopLoss = sl;
      if (!isNaN(tp)) entry.takeProfit = tp;
      entry.notes = (modal.querySelector('#jNotes') as HTMLTextAreaElement).value;
      entry.tags = (modal.querySelector('#jTags') as HTMLInputElement).value
        .split(',').map((t) => t.trim()).filter(Boolean);

      // Calculate R:R if SL/TP provided
      if (entry.stopLoss && entry.takeProfit) {
        const risk = Math.abs(entry.entryPrice - entry.stopLoss);
        const reward = Math.abs(entry.takeProfit - entry.entryPrice);
        entry.riskReward = risk > 0 ? reward / risk : 0;
      }

      if (isNew) {
        this.entries.push(entry);
      } else {
        const idx = this.entries.findIndex((e) => e.id === entry.id);
        if (idx >= 0) this.entries[idx] = entry;
      }
      this.saveEntries();
      this.close();
    });

    // ESC to close
    const escHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        this.close();
        document.removeEventListener('keydown', escHandler);
      }
    };
    document.addEventListener('keydown', escHandler);
  }

  // ── Dashboard ──────────────────────────────────────────────────────────

  private renderDashboard(): void {
    this.close();
    this.isOpen = true;

    const stats = this.getStats();

    this.overlay = document.createElement('div');
    this.overlay.className = 'journal-overlay';
    this.overlay.addEventListener('mousedown', (e) => {
      if (e.target === this.overlay) this.close();
    });

    const modal = document.createElement('div');
    modal.className = 'journal-modal journal-dashboard';
    modal.innerHTML = `
      <div class="journal-header">
        <h2 class="journal-title">📊 Trade Journal</h2>
        <div class="journal-header-actions">
          <button class="journal-btn journal-btn--save journal-btn--sm" id="journalNewBtn">+ New Entry</button>
          <button class="journal-close" id="journalCloseBtn">✕</button>
        </div>
      </div>

      <div class="journal-body">
        <!-- Stats Cards -->
        <div class="journal-stats-grid">
          <div class="journal-stat-card">
            <div class="journal-stat-value">${stats.totalTrades}</div>
            <div class="journal-stat-label">Total Trades</div>
          </div>
          <div class="journal-stat-card ${stats.winRate >= 50 ? 'bull' : 'bear'}">
            <div class="journal-stat-value">${stats.winRate.toFixed(1)}%</div>
            <div class="journal-stat-label">Win Rate</div>
          </div>
          <div class="journal-stat-card">
            <div class="journal-stat-value">${stats.profitFactor.toFixed(2)}</div>
            <div class="journal-stat-label">Profit Factor</div>
          </div>
          <div class="journal-stat-card ${stats.totalPnl >= 0 ? 'bull' : 'bear'}">
            <div class="journal-stat-value">$${stats.totalPnl.toFixed(2)}</div>
            <div class="journal-stat-label">Total P&L</div>
          </div>
          <div class="journal-stat-card">
            <div class="journal-stat-value">${stats.avgRR.toFixed(2)}</div>
            <div class="journal-stat-label">Avg R:R</div>
          </div>
          <div class="journal-stat-card">
            <div class="journal-stat-value">${stats.bestSetup}</div>
            <div class="journal-stat-label">Best Setup</div>
          </div>
        </div>

        <!-- Trade List -->
        <div class="journal-trade-list">
          <div class="journal-trade-header">
            <span>Date</span><span>Symbol</span><span>Side</span>
            <span>Entry</span><span>Exit</span><span>P&L</span>
            <span>Setup</span><span>R:R</span>
          </div>
          ${this.entries.slice().reverse().map((e) => `
            <div class="journal-trade-row ${e.pnl != null ? (e.pnl >= 0 ? 'win' : 'loss') : ''}" data-id="${e.id}">
              <span class="journal-trade-date">${new Date(e.timestamp).toLocaleDateString()}</span>
              <span class="journal-trade-symbol">${e.symbol}</span>
              <span class="journal-trade-side ${e.side}">${e.side === 'long' ? '🟢' : '🔴'} ${e.side}</span>
              <span>${e.entryPrice.toFixed(2)}</span>
              <span>${e.exitPrice?.toFixed(2) ?? '—'}</span>
              <span class="journal-trade-pnl ${(e.pnl ?? 0) >= 0 ? 'bull' : 'bear'}">${e.pnl != null ? `$${e.pnl.toFixed(2)}` : '—'}</span>
              <span class="journal-trade-setup">${e.setup}</span>
              <span>${e.riskReward?.toFixed(2) ?? '—'}</span>
            </div>
          `).join('') || '<div class="journal-empty">No trades logged yet. Press <kbd>J</kbd> on the chart to log your first trade.</div>'}
        </div>
      </div>
    `;

    this.overlay.appendChild(modal);
    document.body.appendChild(this.overlay);
    requestAnimationFrame(() => this.overlay?.classList.add('open'));

    modal.querySelector('#journalCloseBtn')?.addEventListener('click', () => this.close());
    modal.querySelector('#journalNewBtn')?.addEventListener('click', () => this.openNewEntry());

    // Click on trade row → edit
    modal.querySelectorAll<HTMLElement>('.journal-trade-row').forEach((row) => {
      row.addEventListener('click', () => {
        const entry = this.entries.find((e) => e.id === row.dataset.id);
        if (entry) this.renderEntryModal(entry, false);
      });
    });

    const escHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        this.close();
        document.removeEventListener('keydown', escHandler);
      }
    };
    document.addEventListener('keydown', escHandler);
  }

  // ── Persistence ────────────────────────────────────────────────────────

  private loadEntries(): void {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) this.entries = JSON.parse(raw);
    } catch { /* ignore */ }
  }

  private saveEntries(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.entries));
    } catch { /* ignore */ }
  }
}
