/**
 * PerformancePanel — Performance analytics dashboard.
 *
 * Displays imported trade performance with calendar heatmap, equity curve,
 * summary metrics, per-setup breakdown, and trade history with filtering.
 */

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface PerformanceTrade {
  id: string;
  entryTime: number;
  exitTime: number;
  entryPrice: number;
  exitPrice: number;
  side: 'long' | 'short';
  size: number;
  pnl: number;
  fees: number;
  symbol: string;
  setup?: string;
}

export interface PerformanceMetrics {
  totalPnl: number;
  winRate: number;
  avgTrade: number;
  maxDrawdown: number;
  sharpe: number;
  totalTrades: number;
  bestTrade: number;
  worstTrade: number;
}

interface DailyPnl {
  date: string;  // YYYY-MM-DD
  pnl: number;
  tradeCount: number;
}

interface SetupBreakdown {
  setup: string;
  count: number;
  winRate: number;
  avgPnl: number;
  totalPnl: number;
}

// ─── Constants ─────────────────────────────────────────────────────────────────

const S = {
  wrapper: {
    display: 'flex', flexDirection: 'column', width: '100%', height: '100%',
    background: '#0a0e17', overflow: 'auto', fontFamily: 'Inter, system-ui, sans-serif',
    color: '#f9fafb',
  } as Partial<CSSStyleDeclaration>,
  header: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    height: '40px', minHeight: '40px', padding: '0 16px',
    background: '#111827', borderBottom: '1px solid #374151', flexShrink: '0',
  } as Partial<CSSStyleDeclaration>,
  title: {
    fontSize: '13px', fontWeight: '700', textTransform: 'uppercase',
    letterSpacing: '0.05em', color: '#f9fafb',
  } as Partial<CSSStyleDeclaration>,
  section: {
    padding: '16px', borderBottom: '1px solid #1f2937',
  } as Partial<CSSStyleDeclaration>,
  sectionTitle: {
    fontSize: '12px', fontWeight: '600', color: '#9ca3af',
    textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '12px',
  } as Partial<CSSStyleDeclaration>,
  statsGrid: {
    display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '12px',
  } as Partial<CSSStyleDeclaration>,
  statCard: {
    background: '#1f2937', borderRadius: '6px', padding: '12px', textAlign: 'center',
  } as Partial<CSSStyleDeclaration>,
  statValue: {
    fontSize: '18px', fontWeight: '700', marginBottom: '4px',
  } as Partial<CSSStyleDeclaration>,
  statLabel: {
    fontSize: '10px', color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.05em',
  } as Partial<CSSStyleDeclaration>,
  table: {
    width: '100%', borderCollapse: 'collapse', fontSize: '12px',
  } as Partial<CSSStyleDeclaration>,
  th: {
    padding: '8px', textAlign: 'left', color: '#6b7280', fontSize: '10px',
    textTransform: 'uppercase', letterSpacing: '0.05em', borderBottom: '1px solid #374151',
    cursor: 'pointer', userSelect: 'none',
  } as Partial<CSSStyleDeclaration>,
  td: {
    padding: '8px', borderBottom: '1px solid #1f2937', color: '#f9fafb', fontSize: '12px',
  } as Partial<CSSStyleDeclaration>,
  btn: {
    appearance: 'none', border: 'none', borderRadius: '6px', cursor: 'pointer',
    padding: '8px 16px', fontSize: '12px', fontWeight: '600',
  } as Partial<CSSStyleDeclaration>,
  btnPrimary: { background: '#6366f1', color: '#fff' } as Partial<CSSStyleDeclaration>,
  btnSecondary: {
    background: '#1f2937', color: '#9ca3af', border: '1px solid #374151',
  } as Partial<CSSStyleDeclaration>,
  toggleBtn: {
    appearance: 'none', border: '1px solid #374151', background: '#1f2937',
    color: '#9ca3af', borderRadius: '4px', padding: '4px 10px', fontSize: '11px',
    cursor: 'pointer', fontWeight: '500',
  } as Partial<CSSStyleDeclaration>,
  toggleBtnActive: {
    background: '#6366f1', color: '#fff', borderColor: '#6366f1',
  } as Partial<CSSStyleDeclaration>,
  filterRow: {
    display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px',
  } as Partial<CSSStyleDeclaration>,
  select: {
    appearance: 'none', background: '#1f2937', border: '1px solid #374151',
    borderRadius: '4px', color: '#f9fafb', padding: '6px 10px', fontSize: '12px',
    outline: 'none', cursor: 'pointer',
  } as Partial<CSSStyleDeclaration>,
};

// ─── PerformancePanel ──────────────────────────────────────────────────────────

export class PerformancePanel {
  private container: HTMLElement | null = null;
  private wrapperEl: HTMLDivElement | null = null;

  // Data
  private trades: PerformanceTrade[] = [];
  private metrics: PerformanceMetrics | null = null;
  private dailyPnl: DailyPnl[] = [];
  private setupBreakdowns: SetupBreakdown[] = [];

  // Filter / sort state
  private sortColumn: string = 'entryTime';
  private sortDirection: 'asc' | 'desc' = 'desc';
  private filterSymbol: string = '';
  private filterSide: string = '';
  private showTradeOverlay = false;

  // DOM refs
  private calendarCanvas: HTMLCanvasElement | null = null;
  private equityCanvas: HTMLCanvasElement | null = null;
  private tradeTableBody: HTMLTableSectionElement | null = null;
  private overlayToggle: HTMLButtonElement | null = null;

  // Callbacks
  private onOverlayToggle?: (enabled: boolean) => void;

  // ── Mount ──────────────────────────────────────────────────────────────

  mount(container: HTMLElement): void {
    this.container = container;
    this.buildDOM();
  }

  // ── Load Data ──────────────────────────────────────────────────────────

  loadData(trades: PerformanceTrade[]): void {
    this.trades = [...trades];
    this.computeMetrics();
    this.computeDailyPnl();
    this.computeSetupBreakdowns();
    this.render();
  }

  // ── Destroy ────────────────────────────────────────────────────────────

  destroy(): void {
    this.wrapperEl?.remove();
    this.container = null;
    this.wrapperEl = null;
    this.trades = [];
    this.metrics = null;
  }

  // ── Register overlay toggle callback ──────────────────────────────────

  onTradeOverlayToggle(cb: (enabled: boolean) => void): void {
    this.onOverlayToggle = cb;
  }

  // ── Compute Metrics ───────────────────────────────────────────────────

  private computeMetrics(): void {
    if (this.trades.length === 0) {
      this.metrics = {
        totalPnl: 0, winRate: 0, avgTrade: 0, maxDrawdown: 0,
        sharpe: 0, totalTrades: 0, bestTrade: 0, worstTrade: 0,
      };
      return;
    }

    const pnls = this.trades.map((t) => t.pnl);
    const winners = pnls.filter((p) => p > 0);
    const totalPnl = pnls.reduce((s, p) => s + p, 0);
    const avgTrade = totalPnl / pnls.length;

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

    // Sharpe ratio (annualised, assuming daily returns)
    const mean = avgTrade;
    const variance = pnls.reduce((s, p) => s + (p - mean) ** 2, 0) / pnls.length;
    const stdDev = Math.sqrt(variance);
    const sharpe = stdDev > 0 ? (mean / stdDev) * Math.sqrt(252) : 0;

    this.metrics = {
      totalPnl,
      winRate: pnls.length > 0 ? winners.length / pnls.length : 0,
      avgTrade,
      maxDrawdown,
      sharpe,
      totalTrades: pnls.length,
      bestTrade: Math.max(...pnls),
      worstTrade: Math.min(...pnls),
    };
  }

  private computeDailyPnl(): void {
    const map = new Map<string, { pnl: number; count: number }>();
    for (const t of this.trades) {
      const date = new Date(t.exitTime).toISOString().slice(0, 10);
      const existing = map.get(date) || { pnl: 0, count: 0 };
      existing.pnl += t.pnl;
      existing.count++;
      map.set(date, existing);
    }
    this.dailyPnl = Array.from(map.entries())
      .map(([date, v]) => ({ date, pnl: v.pnl, tradeCount: v.count }))
      .sort((a, b) => a.date.localeCompare(b.date));
  }

  private computeSetupBreakdowns(): void {
    const map = new Map<string, PerformanceTrade[]>();
    for (const t of this.trades) {
      const setup = t.setup || 'Unknown';
      const arr = map.get(setup) || [];
      arr.push(t);
      map.set(setup, arr);
    }

    this.setupBreakdowns = Array.from(map.entries()).map(([setup, trades]) => {
      const pnls = trades.map((t) => t.pnl);
      const winners = pnls.filter((p) => p > 0);
      return {
        setup,
        count: trades.length,
        winRate: trades.length > 0 ? winners.length / trades.length : 0,
        avgPnl: pnls.reduce((s, p) => s + p, 0) / (trades.length || 1),
        totalPnl: pnls.reduce((s, p) => s + p, 0),
      };
    });
  }

  // ── Build DOM ─────────────────────────────────────────────────────────

  private buildDOM(): void {
    this.wrapperEl = document.createElement('div');
    Object.assign(this.wrapperEl.style, S.wrapper);

    // Header
    const header = document.createElement('div');
    Object.assign(header.style, S.header);
    const title = document.createElement('span');
    Object.assign(title.style, S.title);
    title.textContent = 'Performance Analytics';
    header.appendChild(title);

    // Entry/exit overlay toggle
    this.overlayToggle = document.createElement('button');
    Object.assign(this.overlayToggle.style, S.toggleBtn);
    this.overlayToggle.textContent = '📍 Trade Overlay';
    this.overlayToggle.addEventListener('click', () => {
      this.showTradeOverlay = !this.showTradeOverlay;
      Object.assign(
        this.overlayToggle!.style,
        this.showTradeOverlay ? S.toggleBtnActive : S.toggleBtn,
      );
      this.onOverlayToggle?.(this.showTradeOverlay);
    });
    header.appendChild(this.overlayToggle);

    this.wrapperEl.appendChild(header);
    this.container!.appendChild(this.wrapperEl);
  }

  // ── Render ────────────────────────────────────────────────────────────

  private render(): void {
    if (!this.wrapperEl) return;

    // Remove everything except the header
    const header = this.wrapperEl.firstElementChild;
    while (this.wrapperEl.children.length > 1) {
      this.wrapperEl.removeChild(this.wrapperEl.lastChild!);
    }

    const body = document.createElement('div');
    body.style.flex = '1';
    body.style.overflow = 'auto';

    // Summary metrics
    body.appendChild(this.renderMetrics());

    // Calendar heatmap
    body.appendChild(this.renderCalendar());

    // Equity curve
    body.appendChild(this.renderEquityCurve());

    // Per-setup breakdown
    if (this.setupBreakdowns.length > 0) {
      body.appendChild(this.renderSetupBreakdown());
    }

    // Trade history
    body.appendChild(this.renderTradeHistory());

    this.wrapperEl.appendChild(body);

    // Draw canvases after in DOM
    requestAnimationFrame(() => {
      this.drawCalendar();
      this.drawEquityCurve();
    });
  }

  // ── Summary Metrics ───────────────────────────────────────────────────

  private renderMetrics(): HTMLDivElement {
    const section = document.createElement('div');
    Object.assign(section.style, S.section);
    const stitle = document.createElement('div');
    Object.assign(stitle.style, S.sectionTitle);
    stitle.textContent = 'Summary';
    section.appendChild(stitle);

    const m = this.metrics!;
    const grid = document.createElement('div');
    Object.assign(grid.style, S.statsGrid);

    const stats: { label: string; value: string; color?: string }[] = [
      { label: 'Total P&L', value: `$${m.totalPnl.toFixed(2)}`, color: m.totalPnl >= 0 ? '#10b981' : '#ef4444' },
      { label: 'Win Rate', value: `${(m.winRate * 100).toFixed(1)}%`, color: m.winRate >= 0.5 ? '#10b981' : '#ef4444' },
      { label: 'Avg Trade', value: `$${m.avgTrade.toFixed(2)}`, color: m.avgTrade >= 0 ? '#10b981' : '#ef4444' },
      { label: 'Max Drawdown', value: `$${m.maxDrawdown.toFixed(2)}`, color: '#ef4444' },
      { label: 'Sharpe Ratio', value: m.sharpe.toFixed(2) },
      { label: 'Total Trades', value: String(m.totalTrades) },
      { label: 'Best Trade', value: `$${m.bestTrade.toFixed(2)}`, color: '#10b981' },
      { label: 'Worst Trade', value: `$${m.worstTrade.toFixed(2)}`, color: '#ef4444' },
    ];

    for (const stat of stats) {
      const card = document.createElement('div');
      Object.assign(card.style, S.statCard);
      const val = document.createElement('div');
      Object.assign(val.style, S.statValue);
      val.style.color = stat.color || '#f9fafb';
      val.textContent = stat.value;
      card.appendChild(val);
      const lbl = document.createElement('div');
      Object.assign(lbl.style, S.statLabel);
      lbl.textContent = stat.label;
      card.appendChild(lbl);
      grid.appendChild(card);
    }

    section.appendChild(grid);
    return section;
  }

  // ── Calendar Heatmap ──────────────────────────────────────────────────

  private renderCalendar(): HTMLDivElement {
    const section = document.createElement('div');
    Object.assign(section.style, S.section);
    const stitle = document.createElement('div');
    Object.assign(stitle.style, S.sectionTitle);
    stitle.textContent = 'Daily P&L Calendar';
    section.appendChild(stitle);

    this.calendarCanvas = document.createElement('canvas');
    this.calendarCanvas.style.width = '100%';
    this.calendarCanvas.style.height = '140px';
    this.calendarCanvas.style.borderRadius = '6px';
    this.calendarCanvas.style.background = '#1f2937';
    section.appendChild(this.calendarCanvas);

    return section;
  }

  private drawCalendar(): void {
    const canvas = this.calendarCanvas;
    if (!canvas || this.dailyPnl.length === 0) return;

    const rect = canvas.getBoundingClientRect();
    const dpr = devicePixelRatio;
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.scale(dpr, dpr);
    const w = rect.width;
    const h = rect.height;
    const pad = 30;
    const cellSize = 12;
    const cellGap = 2;

    const pnls = this.dailyPnl.map((d) => d.pnl);
    const maxAbs = Math.max(Math.abs(Math.min(...pnls)), Math.abs(Math.max(...pnls))) || 1;

    // Group by week
    const firstDate = new Date(this.dailyPnl[0].date);
    const pnlMap = new Map(this.dailyPnl.map((d) => [d.date, d.pnl]));

    // Day labels
    const dayLabels = ['Mon', '', 'Wed', '', 'Fri', '', ''];
    ctx.fillStyle = '#6b7280';
    ctx.font = '9px Inter, system-ui, sans-serif';
    ctx.textAlign = 'right';
    for (let i = 0; i < 7; i++) {
      if (dayLabels[i]) {
        ctx.fillText(dayLabels[i], pad - 4, pad + i * (cellSize + cellGap) + cellSize - 2);
      }
    }

    // Draw cells
    const lastDate = new Date(this.dailyPnl[this.dailyPnl.length - 1].date);
    const totalDays = Math.ceil((lastDate.getTime() - firstDate.getTime()) / 86400000) + 1;

    let col = 0;
    const startDow = (firstDate.getDay() + 6) % 7; // Monday = 0

    for (let d = 0; d < totalDays; d++) {
      const current = new Date(firstDate);
      current.setDate(current.getDate() + d);
      const dow = (current.getDay() + 6) % 7;
      const dateStr = current.toISOString().slice(0, 10);
      const pnl = pnlMap.get(dateStr);

      if (d > 0 && dow === 0) col++;

      const x = pad + col * (cellSize + cellGap);
      const y = pad + dow * (cellSize + cellGap);

      if (x + cellSize > w) break;

      if (pnl !== undefined) {
        const intensity = Math.min(Math.abs(pnl) / maxAbs, 1);
        const alpha = 0.2 + intensity * 0.8;
        ctx.fillStyle = pnl >= 0
          ? `rgba(16, 185, 129, ${alpha})`
          : `rgba(239, 68, 68, ${alpha})`;
      } else {
        ctx.fillStyle = '#374151';
      }

      ctx.beginPath();
      ctx.roundRect(x, y, cellSize, cellSize, 2);
      ctx.fill();
    }
  }

  // ── Equity Curve ──────────────────────────────────────────────────────

  private renderEquityCurve(): HTMLDivElement {
    const section = document.createElement('div');
    Object.assign(section.style, S.section);
    const stitle = document.createElement('div');
    Object.assign(stitle.style, S.sectionTitle);
    stitle.textContent = 'Equity Curve';
    section.appendChild(stitle);

    this.equityCanvas = document.createElement('canvas');
    this.equityCanvas.style.width = '100%';
    this.equityCanvas.style.height = '180px';
    this.equityCanvas.style.borderRadius = '6px';
    this.equityCanvas.style.background = '#1f2937';
    section.appendChild(this.equityCanvas);

    return section;
  }

  private drawEquityCurve(): void {
    const canvas = this.equityCanvas;
    if (!canvas || this.trades.length === 0) return;

    const rect = canvas.getBoundingClientRect();
    const dpr = devicePixelRatio;
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.scale(dpr, dpr);
    const w = rect.width;
    const h = rect.height;
    const pad = 16;

    // Build equity curve from sorted trades
    const sorted = [...this.trades].sort((a, b) => a.exitTime - b.exitTime);
    let equity = 0;
    const curve = [{ time: sorted[0].entryTime, equity: 0 }];
    for (const t of sorted) {
      equity += t.pnl;
      curve.push({ time: t.exitTime, equity });
    }

    const equities = curve.map((c) => c.equity);
    const minE = Math.min(...equities);
    const maxE = Math.max(...equities);
    const range = maxE - minE || 1;

    // Line
    ctx.beginPath();
    for (let i = 0; i < curve.length; i++) {
      const x = pad + (i / (curve.length - 1)) * (w - pad * 2);
      const y = pad + (1 - (curve[i].equity - minE) / range) * (h - pad * 2);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    const finalE = equities[equities.length - 1];
    ctx.strokeStyle = finalE >= 0 ? '#10b981' : '#ef4444';
    ctx.lineWidth = 2;
    ctx.stroke();

    // Fill
    ctx.lineTo(pad + (w - pad * 2), h - pad);
    ctx.lineTo(pad, h - pad);
    ctx.closePath();
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    const color = finalE >= 0 ? '#10b981' : '#ef4444';
    grad.addColorStop(0, color + '30');
    grad.addColorStop(1, color + '00');
    ctx.fillStyle = grad;
    ctx.fill();
  }

  // ── Per-Setup Breakdown ───────────────────────────────────────────────

  private renderSetupBreakdown(): HTMLDivElement {
    const section = document.createElement('div');
    Object.assign(section.style, S.section);
    const stitle = document.createElement('div');
    Object.assign(stitle.style, S.sectionTitle);
    stitle.textContent = 'Per-Setup Breakdown';
    section.appendChild(stitle);

    const table = document.createElement('table');
    Object.assign(table.style, S.table);

    const thead = document.createElement('thead');
    const headerRow = document.createElement('tr');
    for (const col of ['Setup / Pattern', 'Trades', 'Win Rate', 'Avg P&L', 'Total P&L']) {
      const th = document.createElement('th');
      Object.assign(th.style, S.th);
      th.textContent = col;
      headerRow.appendChild(th);
    }
    thead.appendChild(headerRow);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    for (const s of this.setupBreakdowns) {
      const tr = document.createElement('tr');
      const cells = [
        s.setup,
        String(s.count),
        `${(s.winRate * 100).toFixed(1)}%`,
        `$${s.avgPnl.toFixed(2)}`,
        `$${s.totalPnl.toFixed(2)}`,
      ];
      cells.forEach((text, i) => {
        const td = document.createElement('td');
        Object.assign(td.style, S.td);
        td.textContent = text;
        if (i === 3) td.style.color = s.avgPnl >= 0 ? '#10b981' : '#ef4444';
        if (i === 4) td.style.color = s.totalPnl >= 0 ? '#10b981' : '#ef4444';
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    section.appendChild(table);

    return section;
  }

  // ── Trade History ─────────────────────────────────────────────────────

  private renderTradeHistory(): HTMLDivElement {
    const section = document.createElement('div');
    Object.assign(section.style, S.section);
    const stitle = document.createElement('div');
    Object.assign(stitle.style, S.sectionTitle);
    stitle.textContent = 'Trade History';
    section.appendChild(stitle);

    // Filters
    const filterRow = document.createElement('div');
    Object.assign(filterRow.style, S.filterRow);

    // Symbol filter
    const symbols = [...new Set(this.trades.map((t) => t.symbol))];
    const symSelect = document.createElement('select');
    Object.assign(symSelect.style, S.select);
    const allOpt = document.createElement('option');
    allOpt.value = '';
    allOpt.textContent = 'All Symbols';
    symSelect.appendChild(allOpt);
    for (const s of symbols) {
      const o = document.createElement('option');
      o.value = s;
      o.textContent = s;
      symSelect.appendChild(o);
    }
    symSelect.addEventListener('change', () => {
      this.filterSymbol = symSelect.value;
      this.renderTradeRows();
    });
    filterRow.appendChild(symSelect);

    // Side filter
    const sideSelect = document.createElement('select');
    Object.assign(sideSelect.style, S.select);
    for (const opt of [
      { value: '', label: 'All Sides' },
      { value: 'long', label: 'Long' },
      { value: 'short', label: 'Short' },
    ]) {
      const o = document.createElement('option');
      o.value = opt.value;
      o.textContent = opt.label;
      sideSelect.appendChild(o);
    }
    sideSelect.addEventListener('change', () => {
      this.filterSide = sideSelect.value;
      this.renderTradeRows();
    });
    filterRow.appendChild(sideSelect);

    section.appendChild(filterRow);

    // Table
    const table = document.createElement('table');
    Object.assign(table.style, S.table);

    const thead = document.createElement('thead');
    const headerRow = document.createElement('tr');
    const columns = [
      { key: 'entryTime', label: 'Entry' },
      { key: 'exitTime', label: 'Exit' },
      { key: 'symbol', label: 'Symbol' },
      { key: 'side', label: 'Side' },
      { key: 'entryPrice', label: 'Entry Price' },
      { key: 'exitPrice', label: 'Exit Price' },
      { key: 'pnl', label: 'P&L' },
    ];
    for (const col of columns) {
      const th = document.createElement('th');
      Object.assign(th.style, S.th);
      th.textContent = col.label + (this.sortColumn === col.key ? (this.sortDirection === 'asc' ? ' ↑' : ' ↓') : '');
      th.addEventListener('click', () => {
        if (this.sortColumn === col.key) {
          this.sortDirection = this.sortDirection === 'asc' ? 'desc' : 'asc';
        } else {
          this.sortColumn = col.key;
          this.sortDirection = 'desc';
        }
        this.renderTradeRows();
      });
      headerRow.appendChild(th);
    }
    thead.appendChild(headerRow);
    table.appendChild(thead);

    this.tradeTableBody = document.createElement('tbody');
    table.appendChild(this.tradeTableBody);
    section.appendChild(table);

    this.renderTradeRows();

    return section;
  }

  private renderTradeRows(): void {
    if (!this.tradeTableBody) return;
    this.tradeTableBody.innerHTML = '';

    let filtered = [...this.trades];
    if (this.filterSymbol) filtered = filtered.filter((t) => t.symbol === this.filterSymbol);
    if (this.filterSide) filtered = filtered.filter((t) => t.side === this.filterSide);

    // Sort
    filtered.sort((a, b) => {
      const aVal = (a as any)[this.sortColumn];
      const bVal = (b as any)[this.sortColumn];
      const cmp = typeof aVal === 'string' ? aVal.localeCompare(bVal) : aVal - bVal;
      return this.sortDirection === 'asc' ? cmp : -cmp;
    });

    for (const t of filtered) {
      const tr = document.createElement('tr');
      const cells = [
        new Date(t.entryTime).toISOString().slice(0, 19).replace('T', ' '),
        new Date(t.exitTime).toISOString().slice(0, 19).replace('T', ' '),
        t.symbol,
        t.side.toUpperCase(),
        t.entryPrice.toFixed(2),
        t.exitPrice.toFixed(2),
        `$${t.pnl.toFixed(2)}`,
      ];
      cells.forEach((text, i) => {
        const td = document.createElement('td');
        Object.assign(td.style, S.td);
        td.textContent = text;
        if (i === 3) td.style.color = t.side === 'long' ? '#10b981' : '#ef4444';
        if (i === 6) td.style.color = t.pnl >= 0 ? '#10b981' : '#ef4444';
        tr.appendChild(td);
      });
      this.tradeTableBody.appendChild(tr);
    }
  }
}
