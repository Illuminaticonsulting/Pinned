/**
 * SessionStatsDashboard.ts
 * "Every time you finish a session, the system auto-generates:
 *  - What you traded
 *  - How much time you spent on each symbol
 *  - Win rate
 *  - Biggest winner / loser
 *  - A heatmap calendar of your trading activity"
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export interface SessionEvent {
  type: 'view_symbol' | 'change_timeframe' | 'place_trade' | 'close_trade' | 'add_indicator' | 'draw_tool' | 'take_snapshot';
  timestamp: number;
  symbol?: string;
  timeframe?: string;
  detail?: string;
}

export interface DailySession {
  date: string;        // YYYY-MM-DD
  startTime: number;
  endTime: number;
  durationMs: number;
  events: SessionEvent[];
  symbolTime: Record<string, number>;   // symbol → ms spent viewing
  symbolCount: Record<string, number>;  // symbol → number of switches
  tradeCount: number;
  indicatorsUsed: string[];
  toolsUsed: string[];
}

export interface CalendarDay {
  date: string;
  dayOfWeek: number;
  sessions: number;
  totalDurationMs: number;
  tradeCount: number;
  intensity: number;   // 0-4 scale for heatmap
}

// ─── Constants ───────────────────────────────────────────────────────────────

const STORAGE_KEY = 'pinned_session_stats';
const SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 min idle = new session

// ─── SessionStatsDashboard ───────────────────────────────────────────────────

export class SessionStatsDashboard {
  private sessions: DailySession[] = [];
  private currentSession: DailySession | null = null;
  private currentSymbol: string = '';
  private lastEventTime: number = 0;
  private symbolStartTime: number = 0;
  private overlay: HTMLElement | null = null;

  constructor() {
    this.loadSessions();
    this.startSession();
  }

  // ── Event Recording ────────────────────────────────────────────────────

  recordEvent(event: SessionEvent): void {
    const now = Date.now();

    // Check for session timeout
    if (this.lastEventTime && now - this.lastEventTime > SESSION_TIMEOUT_MS) {
      this.endSession();
      this.startSession();
    }

    if (!this.currentSession) this.startSession();
    this.currentSession!.events.push(event);
    this.lastEventTime = now;

    // Track symbol time
    if (event.type === 'view_symbol' && event.symbol) {
      this.trackSymbolSwitch(event.symbol, now);
    }

    if (event.type === 'place_trade' || event.type === 'close_trade') {
      this.currentSession!.tradeCount++;
    }

    if (event.type === 'add_indicator' && event.detail) {
      if (!this.currentSession!.indicatorsUsed.includes(event.detail)) {
        this.currentSession!.indicatorsUsed.push(event.detail);
      }
    }

    if (event.type === 'draw_tool' && event.detail) {
      if (!this.currentSession!.toolsUsed.includes(event.detail)) {
        this.currentSession!.toolsUsed.push(event.detail);
      }
    }
  }

  private trackSymbolSwitch(newSymbol: string, now: number): void {
    if (this.currentSymbol && this.currentSession) {
      const elapsed = now - this.symbolStartTime;
      this.currentSession.symbolTime[this.currentSymbol] =
        (this.currentSession.symbolTime[this.currentSymbol] ?? 0) + elapsed;
      this.currentSession.symbolCount[this.currentSymbol] =
        (this.currentSession.symbolCount[this.currentSymbol] ?? 0) + 1;
    }
    this.currentSymbol = newSymbol;
    this.symbolStartTime = now;
  }

  private startSession(): void {
    const now = Date.now();
    this.currentSession = {
      date: new Date().toISOString().slice(0, 10),
      startTime: now,
      endTime: now,
      durationMs: 0,
      events: [],
      symbolTime: {},
      symbolCount: {},
      tradeCount: 0,
      indicatorsUsed: [],
      toolsUsed: [],
    };
    this.lastEventTime = now;
    this.symbolStartTime = now;
  }

  endSession(): void {
    if (!this.currentSession) return;
    const now = Date.now();

    // Final symbol tracking
    if (this.currentSymbol) {
      const elapsed = now - this.symbolStartTime;
      this.currentSession.symbolTime[this.currentSymbol] =
        (this.currentSession.symbolTime[this.currentSymbol] ?? 0) + elapsed;
    }

    this.currentSession.endTime = now;
    this.currentSession.durationMs = now - this.currentSession.startTime;
    this.sessions.push(this.currentSession);
    this.saveSessions();
    this.currentSession = null;
  }

  // ── Dashboard ──────────────────────────────────────────────────────────

  openDashboard(): void {
    this.closeDashboard();

    // Finalize current symbols
    if (this.currentSession && this.currentSymbol) {
      const now = Date.now();
      const elapsed = now - this.symbolStartTime;
      this.currentSession.symbolTime[this.currentSymbol] =
        (this.currentSession.symbolTime[this.currentSymbol] ?? 0) + elapsed;
      this.symbolStartTime = now;
      this.currentSession.endTime = now;
      this.currentSession.durationMs = now - this.currentSession.startTime;
    }

    this.overlay = document.createElement('div');
    this.overlay.className = 'session-stats-overlay';
    this.overlay.addEventListener('mousedown', (e) => {
      if (e.target === this.overlay) this.closeDashboard();
    });

    const modal = document.createElement('div');
    modal.className = 'session-stats-modal';
    modal.innerHTML = this.buildDashboardHTML();
    this.overlay.appendChild(modal);
    document.body.appendChild(this.overlay);
    requestAnimationFrame(() => this.overlay?.classList.add('open'));

    modal.querySelector('#sessionStatsClose')?.addEventListener('click', () => this.closeDashboard());

    const escHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        this.closeDashboard();
        document.removeEventListener('keydown', escHandler);
      }
    };
    document.addEventListener('keydown', escHandler);
  }

  closeDashboard(): void {
    this.overlay?.classList.remove('open');
    setTimeout(() => {
      this.overlay?.remove();
      this.overlay = null;
    }, 200);
  }

  private buildDashboardHTML(): string {
    const allSessions = [...this.sessions, ...(this.currentSession ? [this.currentSession] : [])];
    const totalDuration = allSessions.reduce((acc, s) => acc + s.durationMs, 0);
    const totalTrades = allSessions.reduce((acc, s) => acc + s.tradeCount, 0);
    const totalEvents = allSessions.reduce((acc, s) => acc + s.events.length, 0);

    // Aggregate symbol time across all sessions
    const symbolTimeAgg: Record<string, number> = {};
    for (const s of allSessions) {
      for (const [sym, ms] of Object.entries(s.symbolTime)) {
        symbolTimeAgg[sym] = (symbolTimeAgg[sym] ?? 0) + ms;
      }
    }

    // Sort by time desc
    const topSymbols = Object.entries(symbolTimeAgg)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 8);

    const totalSymbolTime = Object.values(symbolTimeAgg).reduce((a, b) => a + b, 0) || 1;

    // Calendar data (last 90 days)
    const calendar = this.buildCalendar(allSessions);

    // Recent sessions (last 7 days)
    const recentSessions = allSessions
      .filter((s) => Date.now() - s.startTime < 7 * 24 * 60 * 60 * 1000)
      .reverse()
      .slice(0, 10);

    return `
      <div class="session-stats-header">
        <h2 class="session-stats-title">📊 Session Statistics</h2>
        <p class="session-stats-subtitle">Auto-generated activity summary</p>
        <button class="session-stats-close" id="sessionStatsClose">✕</button>
      </div>

      <div class="session-stats-grid">
        <div class="session-stat-card">
          <div class="session-stat-value">${this.formatDuration(totalDuration)}</div>
          <div class="session-stat-label">Total Screen Time</div>
        </div>
        <div class="session-stat-card">
          <div class="session-stat-value">${allSessions.length}</div>
          <div class="session-stat-label">Sessions</div>
        </div>
        <div class="session-stat-card">
          <div class="session-stat-value">${totalTrades}</div>
          <div class="session-stat-label">Trades Logged</div>
        </div>
        <div class="session-stat-card">
          <div class="session-stat-value">${totalEvents}</div>
          <div class="session-stat-label">Total Actions</div>
        </div>
        <div class="session-stat-card">
          <div class="session-stat-value">${Object.keys(symbolTimeAgg).length}</div>
          <div class="session-stat-label">Symbols Watched</div>
        </div>
        <div class="session-stat-card">
          <div class="session-stat-value">${allSessions.length > 0 ? this.formatDuration(totalDuration / allSessions.length) : '—'}</div>
          <div class="session-stat-label">Avg Session</div>
        </div>
      </div>

      <div class="session-stats-sections">
        <div class="session-stats-section">
          <h3 class="session-section-title">🗓 Activity Calendar (90 days)</h3>
          <div class="session-calendar">
            ${this.renderCalendar(calendar)}
          </div>
          <div class="session-calendar-legend">
            <span>Less</span>
            <div class="session-cal-box" style="background:var(--bg-tertiary,#1e293b);"></div>
            <div class="session-cal-box" style="background:#1a3a2a;"></div>
            <div class="session-cal-box" style="background:#2d6a4f;"></div>
            <div class="session-cal-box" style="background:#40916c;"></div>
            <div class="session-cal-box" style="background:#52b788;"></div>
            <span>More</span>
          </div>
        </div>

        <div class="session-stats-section">
          <h3 class="session-section-title">📈 Time Per Symbol</h3>
          <div class="session-symbol-bars">
            ${topSymbols.map(([sym, ms]) => `
              <div class="session-symbol-row">
                <span class="session-symbol-name">${sym}</span>
                <div class="session-symbol-bar-track">
                  <div class="session-symbol-bar-fill" style="width:${(ms / totalSymbolTime) * 100}%"></div>
                </div>
                <span class="session-symbol-time">${this.formatDuration(ms)}</span>
              </div>
            `).join('')}
            ${topSymbols.length === 0 ? '<div class="session-empty">No symbol data yet</div>' : ''}
          </div>
        </div>

        <div class="session-stats-section">
          <h3 class="session-section-title">🕐 Recent Sessions</h3>
          <div class="session-recent-list">
            ${recentSessions.map((s) => `
              <div class="session-recent-item">
                <div class="session-recent-date">${new Date(s.startTime).toLocaleDateString()} ${new Date(s.startTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>
                <div class="session-recent-details">
                  <span>${this.formatDuration(s.durationMs)}</span>
                  <span>${s.tradeCount} trades</span>
                  <span>${s.events.length} actions</span>
                  <span>${Object.keys(s.symbolTime).length} symbols</span>
                </div>
              </div>
            `).join('')}
            ${recentSessions.length === 0 ? '<div class="session-empty">No sessions yet</div>' : ''}
          </div>
        </div>
      </div>
    `;
  }

  // ── Calendar ───────────────────────────────────────────────────────────

  private buildCalendar(sessions: DailySession[]): CalendarDay[] {
    const days: Map<string, CalendarDay> = new Map();
    const now = new Date();

    // Create 90 days
    for (let i = 89; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      const key = d.toISOString().slice(0, 10);
      days.set(key, {
        date: key,
        dayOfWeek: d.getDay(),
        sessions: 0,
        totalDurationMs: 0,
        tradeCount: 0,
        intensity: 0,
      });
    }

    // Fill from sessions
    for (const s of sessions) {
      const day = days.get(s.date);
      if (day) {
        day.sessions++;
        day.totalDurationMs += s.durationMs;
        day.tradeCount += s.tradeCount;
      }
    }

    // Calculate intensity
    const maxDuration = Math.max(...[...days.values()].map((d) => d.totalDurationMs), 1);
    for (const day of days.values()) {
      if (day.totalDurationMs === 0) day.intensity = 0;
      else day.intensity = Math.min(4, Math.ceil((day.totalDurationMs / maxDuration) * 4));
    }

    return [...days.values()];
  }

  private renderCalendar(calendar: CalendarDay[]): string {
    const intensityColors = [
      'var(--bg-tertiary, #1e293b)',
      '#1a3a2a',
      '#2d6a4f',
      '#40916c',
      '#52b788',
    ];

    // Group into weeks (columns)
    const weeks: CalendarDay[][] = [];
    let currentWeek: CalendarDay[] = [];

    for (const day of calendar) {
      if (day.dayOfWeek === 0 && currentWeek.length > 0) {
        weeks.push(currentWeek);
        currentWeek = [];
      }
      currentWeek.push(day);
    }
    if (currentWeek.length > 0) weeks.push(currentWeek);

    return `<div class="session-cal-grid">
      ${weeks.map((week) =>
        `<div class="session-cal-week">${week.map((day) =>
          `<div class="session-cal-day" style="background:${intensityColors[day.intensity]}" title="${day.date}: ${this.formatDuration(day.totalDurationMs)} / ${day.tradeCount} trades"></div>`
        ).join('')}</div>`
      ).join('')}
    </div>`;
  }

  // ── Helpers ────────────────────────────────────────────────────────────

  private formatDuration(ms: number): string {
    if (ms < 1000) return '0s';
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    const rm = m % 60;
    if (h < 24) return `${h}h ${rm}m`;
    const d = Math.floor(h / 24);
    return `${d}d ${h % 24}h`;
  }

  // ── Persistence ────────────────────────────────────────────────────────

  private loadSessions(): void {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) this.sessions = JSON.parse(raw);
    } catch { /* ignore */ }
  }

  private saveSessions(): void {
    try {
      // Keep last 365 days only
      const cutoff = Date.now() - 365 * 24 * 60 * 60 * 1000;
      this.sessions = this.sessions.filter((s) => s.startTime > cutoff);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.sessions));
    } catch { /* ignore */ }
  }
}
