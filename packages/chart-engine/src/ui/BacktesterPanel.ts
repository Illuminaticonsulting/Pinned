/**
 * BacktesterPanel — Strategy backtesting UI.
 *
 * Provides a visual entry/exit condition builder, date range picker,
 * results display with equity curve, trade list, and CSV export.
 */

// ─── Types ─────────────────────────────────────────────────────────────────────

export type Metric =
  | 'imbalance_count'
  | 'cumulative_delta'
  | 'ofi'
  | 'absorption_level'
  | 'regime'
  | 'rsi'
  | 'volume_ratio';

export type Operator = '>' | '<' | '=' | '>=' | '<=' | 'crosses_above' | 'crosses_below';

export type LogicalOp = 'AND' | 'OR';

export interface EntryCondition {
  id: string;
  metric: Metric;
  operator: Operator;
  value: number;
  logicalOp: LogicalOp;
}

export interface ExitConditions {
  takeProfitTicks: number | null;
  takeProfitPct: number | null;
  stopLossTicks: number | null;
  stopLossPct: number | null;
  timeExitMinutes: number | null;
  trailingStopTicks: number | null;
  signalReversal: boolean;
}

export interface BacktestConfig {
  symbol: string;
  timeframe: string;
  dateRange: { start: string; end: string };
  entryConditions: EntryCondition[];
  exitConditions: ExitConditions;
}

export interface BacktestTrade {
  entryTime: number;
  exitTime: number;
  entryPrice: number;
  exitPrice: number;
  pnl: number;
  duration: number;
  setup?: string;
}

export interface BacktestResults {
  winRate: number;
  avgWinner: number;
  avgLoser: number;
  maxDrawdown: number;
  profitFactor: number;
  sharpe: number;
  totalPnl: number;
  trades: BacktestTrade[];
  equityCurve: { time: number; equity: number }[];
  perSetup?: { setup: string; winRate: number; avgPnl: number; count: number }[];
}

// ─── Constants ─────────────────────────────────────────────────────────────────

const METRICS: { value: Metric; label: string }[] = [
  { value: 'imbalance_count', label: 'Imbalance Count' },
  { value: 'cumulative_delta', label: 'Cumulative Delta' },
  { value: 'ofi', label: 'Order Flow Imbalance' },
  { value: 'absorption_level', label: 'Absorption Level' },
  { value: 'regime', label: 'Market Regime' },
  { value: 'rsi', label: 'RSI' },
  { value: 'volume_ratio', label: 'Volume Ratio' },
];

const OPERATORS: { value: Operator; label: string }[] = [
  { value: '>', label: '>' },
  { value: '<', label: '<' },
  { value: '=', label: '=' },
  { value: '>=', label: '>=' },
  { value: '<=', label: '<=' },
  { value: 'crosses_above', label: 'Crosses Above' },
  { value: 'crosses_below', label: 'Crosses Below' },
];

const API_BASE = '/api/v1/backtest';

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
  row: {
    display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px',
  } as Partial<CSSStyleDeclaration>,
  select: {
    appearance: 'none', background: '#1f2937', border: '1px solid #374151',
    borderRadius: '4px', color: '#f9fafb', padding: '6px 10px', fontSize: '12px',
    outline: 'none', cursor: 'pointer',
  } as Partial<CSSStyleDeclaration>,
  input: {
    background: '#1f2937', border: '1px solid #374151', borderRadius: '4px',
    color: '#f9fafb', padding: '6px 10px', fontSize: '12px', width: '80px', outline: 'none',
  } as Partial<CSSStyleDeclaration>,
  btn: {
    appearance: 'none', border: 'none', borderRadius: '6px', cursor: 'pointer',
    padding: '8px 16px', fontSize: '12px', fontWeight: '600',
  } as Partial<CSSStyleDeclaration>,
  btnPrimary: {
    background: '#6366f1', color: '#fff',
  } as Partial<CSSStyleDeclaration>,
  btnSecondary: {
    background: '#1f2937', color: '#9ca3af', border: '1px solid #374151',
  } as Partial<CSSStyleDeclaration>,
  btnDanger: {
    background: 'transparent', color: '#ef4444', border: 'none', cursor: 'pointer',
    fontSize: '14px', padding: '4px',
  } as Partial<CSSStyleDeclaration>,
  label: {
    fontSize: '11px', color: '#6b7280', marginBottom: '4px', display: 'block',
  } as Partial<CSSStyleDeclaration>,
  checkbox: {
    accentColor: '#6366f1',
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
  progressBar: {
    width: '100%', height: '4px', background: '#1f2937', borderRadius: '2px', overflow: 'hidden',
  } as Partial<CSSStyleDeclaration>,
  progressFill: {
    height: '100%', background: '#6366f1', transition: 'width 200ms ease', width: '0%',
  } as Partial<CSSStyleDeclaration>,
  table: {
    width: '100%', borderCollapse: 'collapse', fontSize: '12px',
  } as Partial<CSSStyleDeclaration>,
  th: {
    padding: '8px', textAlign: 'left', color: '#6b7280', fontSize: '10px',
    textTransform: 'uppercase', letterSpacing: '0.05em', borderBottom: '1px solid #374151',
  } as Partial<CSSStyleDeclaration>,
  td: {
    padding: '8px', borderBottom: '1px solid #1f2937', color: '#f9fafb', fontSize: '12px',
  } as Partial<CSSStyleDeclaration>,
};

// ─── BacktesterPanel ───────────────────────────────────────────────────────────

export class BacktesterPanel {
  private container: HTMLElement | null = null;
  private wrapperEl: HTMLDivElement | null = null;

  // State
  private entryConditions: EntryCondition[] = [];
  private exitConditions: ExitConditions = {
    takeProfitTicks: null, takeProfitPct: null,
    stopLossTicks: null, stopLossPct: null,
    timeExitMinutes: null, trailingStopTicks: null,
    signalReversal: false,
  };
  private dateStart = '';
  private dateEnd = '';
  private symbol = 'BTC-USDT';
  private timeframe = '5m';
  private results: BacktestResults | null = null;
  private isRunning = false;

  // DOM refs
  private conditionsContainer: HTMLDivElement | null = null;
  private resultsContainer: HTMLDivElement | null = null;
  private progressEl: HTMLDivElement | null = null;
  private equityCanvas: HTMLCanvasElement | null = null;

  // ── Mount ──────────────────────────────────────────────────────────────

  mount(container: HTMLElement): void {
    this.container = container;
    this.addInitialCondition();
    this.buildDOM();
  }

  // ── Destroy ────────────────────────────────────────────────────────────

  destroy(): void {
    this.wrapperEl?.remove();
    this.container = null;
    this.wrapperEl = null;
    this.results = null;
  }

  // ── Condition Management ──────────────────────────────────────────────

  private addInitialCondition(): void {
    this.entryConditions.push({
      id: this.uid(),
      metric: 'cumulative_delta',
      operator: '>',
      value: 0,
      logicalOp: 'AND',
    });
  }

  private addCondition(): void {
    this.entryConditions.push({
      id: this.uid(),
      metric: 'ofi',
      operator: '>',
      value: 0,
      logicalOp: 'AND',
    });
    this.renderConditions();
  }

  private removeCondition(id: string): void {
    this.entryConditions = this.entryConditions.filter((c) => c.id !== id);
    if (this.entryConditions.length === 0) this.addInitialCondition();
    this.renderConditions();
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
    title.textContent = 'Strategy Backtester';
    header.appendChild(title);

    const headerBtns = document.createElement('div');
    headerBtns.style.display = 'flex';
    headerBtns.style.gap = '8px';

    const saveBtn = this.createButton('Save Config', S.btnSecondary, () => this.saveConfig());
    const loadBtn = this.createButton('Load Config', S.btnSecondary, () => this.loadConfigs());
    headerBtns.appendChild(saveBtn);
    headerBtns.appendChild(loadBtn);
    header.appendChild(headerBtns);

    this.wrapperEl.appendChild(header);

    // Body (scrollable)
    const body = document.createElement('div');
    body.style.flex = '1';
    body.style.overflow = 'auto';
    body.style.padding = '0';

    // Symbol / Timeframe / Date Range
    body.appendChild(this.buildConfigSection());

    // Entry Conditions
    body.appendChild(this.buildEntrySection());

    // Exit Conditions
    body.appendChild(this.buildExitSection());

    // Run button + progress
    body.appendChild(this.buildRunSection());

    // Results
    this.resultsContainer = document.createElement('div');
    body.appendChild(this.resultsContainer);

    this.wrapperEl.appendChild(body);
    this.container!.appendChild(this.wrapperEl);
  }

  private buildConfigSection(): HTMLDivElement {
    const section = document.createElement('div');
    Object.assign(section.style, S.section);

    const sTitle = document.createElement('div');
    Object.assign(sTitle.style, S.sectionTitle);
    sTitle.textContent = 'Configuration';
    section.appendChild(sTitle);

    const row = document.createElement('div');
    Object.assign(row.style, S.row);

    // Symbol
    const symbolInput = this.createInput('Symbol', this.symbol, (v) => { this.symbol = v; });
    symbolInput.style.width = '120px';
    row.appendChild(this.wrapField('Symbol', symbolInput));

    // Timeframe
    const tfSelect = this.createSelect(
      ['1m', '5m', '15m', '1h', '4h', '1d'].map((v) => ({ value: v, label: v })),
      this.timeframe,
      (v) => { this.timeframe = v; },
    );
    row.appendChild(this.wrapField('Timeframe', tfSelect));

    // Date range
    const startInput = this.createInput('Start Date', '', (v) => { this.dateStart = v; });
    startInput.type = 'date';
    startInput.style.width = '140px';
    row.appendChild(this.wrapField('Start Date', startInput));

    const endInput = this.createInput('End Date', '', (v) => { this.dateEnd = v; });
    endInput.type = 'date';
    endInput.style.width = '140px';
    row.appendChild(this.wrapField('End Date', endInput));

    section.appendChild(row);
    return section;
  }

  private buildEntrySection(): HTMLDivElement {
    const section = document.createElement('div');
    Object.assign(section.style, S.section);

    const sTitle = document.createElement('div');
    Object.assign(sTitle.style, S.sectionTitle);
    sTitle.textContent = 'Entry Conditions';
    section.appendChild(sTitle);

    this.conditionsContainer = document.createElement('div');
    this.renderConditions();
    section.appendChild(this.conditionsContainer);

    const addBtn = this.createButton('+ Add Condition', S.btnSecondary, () => this.addCondition());
    addBtn.style.marginTop = '8px';
    section.appendChild(addBtn);

    return section;
  }

  private renderConditions(): void {
    if (!this.conditionsContainer) return;
    this.conditionsContainer.innerHTML = '';

    this.entryConditions.forEach((cond, idx) => {
      const row = document.createElement('div');
      Object.assign(row.style, S.row);

      if (idx > 0) {
        const logicSelect = this.createSelect(
          [{ value: 'AND', label: 'AND' }, { value: 'OR', label: 'OR' }],
          cond.logicalOp,
          (v) => { cond.logicalOp = v as LogicalOp; },
        );
        logicSelect.style.width = '70px';
        row.appendChild(logicSelect);
      }

      // Metric
      const metricSelect = this.createSelect(
        METRICS,
        cond.metric,
        (v) => { cond.metric = v as Metric; },
      );
      row.appendChild(metricSelect);

      // Operator
      const opSelect = this.createSelect(
        OPERATORS,
        cond.operator,
        (v) => { cond.operator = v as Operator; },
      );
      opSelect.style.width = '120px';
      row.appendChild(opSelect);

      // Value
      const valInput = this.createInput('Value', String(cond.value), (v) => {
        cond.value = parseFloat(v) || 0;
      });
      valInput.type = 'number';
      valInput.step = 'any';
      row.appendChild(valInput);

      // Remove
      const removeBtn = document.createElement('button');
      Object.assign(removeBtn.style, S.btnDanger);
      removeBtn.textContent = '✕';
      removeBtn.addEventListener('click', () => this.removeCondition(cond.id));
      row.appendChild(removeBtn);

      this.conditionsContainer!.appendChild(row);
    });
  }

  private buildExitSection(): HTMLDivElement {
    const section = document.createElement('div');
    Object.assign(section.style, S.section);

    const sTitle = document.createElement('div');
    Object.assign(sTitle.style, S.sectionTitle);
    sTitle.textContent = 'Exit Conditions';
    section.appendChild(sTitle);

    const grid = document.createElement('div');
    grid.style.display = 'grid';
    grid.style.gridTemplateColumns = 'repeat(3, 1fr)';
    grid.style.gap = '12px';

    const fields: { label: string; key: keyof ExitConditions; type: 'number' | 'checkbox' }[] = [
      { label: 'Take Profit (ticks)', key: 'takeProfitTicks', type: 'number' },
      { label: 'Take Profit (%)', key: 'takeProfitPct', type: 'number' },
      { label: 'Stop Loss (ticks)', key: 'stopLossTicks', type: 'number' },
      { label: 'Stop Loss (%)', key: 'stopLossPct', type: 'number' },
      { label: 'Time Exit (min)', key: 'timeExitMinutes', type: 'number' },
      { label: 'Trailing Stop (ticks)', key: 'trailingStopTicks', type: 'number' },
    ];

    for (const f of fields) {
      const val = this.exitConditions[f.key];
      const input = this.createInput(f.label, val != null ? String(val) : '', (v) => {
        (this.exitConditions as any)[f.key] = v ? parseFloat(v) : null;
      });
      input.type = 'number';
      input.step = 'any';
      input.style.width = '100%';
      grid.appendChild(this.wrapField(f.label, input));
    }

    section.appendChild(grid);

    // Signal reversal checkbox
    const checkRow = document.createElement('div');
    checkRow.style.display = 'flex';
    checkRow.style.alignItems = 'center';
    checkRow.style.gap = '8px';
    checkRow.style.marginTop = '12px';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = this.exitConditions.signalReversal;
    Object.assign(cb.style, S.checkbox);
    cb.addEventListener('change', () => { this.exitConditions.signalReversal = cb.checked; });
    const cbLabel = document.createElement('span');
    cbLabel.style.fontSize = '12px';
    cbLabel.style.color = '#f9fafb';
    cbLabel.textContent = 'Exit on signal reversal';
    checkRow.appendChild(cb);
    checkRow.appendChild(cbLabel);
    section.appendChild(checkRow);

    return section;
  }

  private buildRunSection(): HTMLDivElement {
    const section = document.createElement('div');
    Object.assign(section.style, S.section);
    section.style.display = 'flex';
    section.style.flexDirection = 'column';
    section.style.gap = '12px';

    const runBtn = this.createButton('▶ Run Backtest', S.btnPrimary, () => this.runBacktest());
    runBtn.style.alignSelf = 'flex-start';
    section.appendChild(runBtn);

    // Progress bar
    const progressOuter = document.createElement('div');
    Object.assign(progressOuter.style, S.progressBar);
    progressOuter.style.display = 'none';
    this.progressEl = document.createElement('div');
    Object.assign(this.progressEl.style, S.progressFill);
    progressOuter.appendChild(this.progressEl);
    section.appendChild(progressOuter);

    return section;
  }

  // ── Run Backtest ──────────────────────────────────────────────────────

  private async runBacktest(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;

    const progressOuter = this.progressEl?.parentElement;
    if (progressOuter) progressOuter.style.display = 'block';
    if (this.progressEl) this.progressEl.style.width = '10%';

    const config: BacktestConfig = {
      symbol: this.symbol,
      timeframe: this.timeframe,
      dateRange: { start: this.dateStart, end: this.dateEnd },
      entryConditions: this.entryConditions,
      exitConditions: this.exitConditions,
    };

    try {
      if (this.progressEl) this.progressEl.style.width = '30%';

      const res = await fetch(`${API_BASE}/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(config),
      });

      if (this.progressEl) this.progressEl.style.width = '80%';

      if (!res.ok) {
        throw new Error(`Backtest failed: ${res.status}`);
      }

      this.results = await res.json();
      if (this.progressEl) this.progressEl.style.width = '100%';

      setTimeout(() => {
        if (progressOuter) progressOuter.style.display = 'none';
        this.renderResults();
      }, 400);
    } catch (err) {
      console.error('Backtest error:', err);
      if (progressOuter) progressOuter.style.display = 'none';
      this.renderError(String(err));
    } finally {
      this.isRunning = false;
    }
  }

  // ── Render Results ────────────────────────────────────────────────────

  private renderResults(): void {
    if (!this.resultsContainer || !this.results) return;
    this.resultsContainer.innerHTML = '';
    const r = this.results;

    // Summary stats
    const statsSection = document.createElement('div');
    Object.assign(statsSection.style, S.section);
    const statsTitle = document.createElement('div');
    Object.assign(statsTitle.style, S.sectionTitle);
    statsTitle.textContent = 'Results Summary';
    statsSection.appendChild(statsTitle);

    const grid = document.createElement('div');
    Object.assign(grid.style, S.statsGrid);

    const stats: { label: string; value: string; color?: string }[] = [
      { label: 'Total P&L', value: `$${r.totalPnl.toFixed(2)}`, color: r.totalPnl >= 0 ? '#10b981' : '#ef4444' },
      { label: 'Win Rate', value: `${(r.winRate * 100).toFixed(1)}%`, color: r.winRate >= 0.5 ? '#10b981' : '#ef4444' },
      { label: 'Profit Factor', value: r.profitFactor.toFixed(2) },
      { label: 'Sharpe Ratio', value: r.sharpe.toFixed(2) },
      { label: 'Avg Winner', value: `$${r.avgWinner.toFixed(2)}`, color: '#10b981' },
      { label: 'Avg Loser', value: `$${r.avgLoser.toFixed(2)}`, color: '#ef4444' },
      { label: 'Max Drawdown', value: `$${r.maxDrawdown.toFixed(2)}`, color: '#ef4444' },
      { label: 'Total Trades', value: String(r.trades.length) },
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

    statsSection.appendChild(grid);
    this.resultsContainer.appendChild(statsSection);

    // Equity curve
    const curveSection = document.createElement('div');
    Object.assign(curveSection.style, S.section);
    const curveTitle = document.createElement('div');
    Object.assign(curveTitle.style, S.sectionTitle);
    curveTitle.textContent = 'Equity Curve';
    curveSection.appendChild(curveTitle);

    this.equityCanvas = document.createElement('canvas');
    this.equityCanvas.style.width = '100%';
    this.equityCanvas.style.height = '200px';
    this.equityCanvas.style.borderRadius = '6px';
    this.equityCanvas.style.background = '#1f2937';
    curveSection.appendChild(this.equityCanvas);
    this.resultsContainer.appendChild(curveSection);

    // Draw equity curve after canvas is in DOM
    requestAnimationFrame(() => this.drawEquityCurve());

    // Per-setup breakdown
    if (r.perSetup && r.perSetup.length > 0) {
      const setupSection = document.createElement('div');
      Object.assign(setupSection.style, S.section);
      const setupTitle = document.createElement('div');
      Object.assign(setupTitle.style, S.sectionTitle);
      setupTitle.textContent = 'Per-Setup Breakdown';
      setupSection.appendChild(setupTitle);
      setupSection.appendChild(this.buildPerSetupTable(r.perSetup));
      this.resultsContainer.appendChild(setupSection);
    }

    // Trade list
    const tradeSection = document.createElement('div');
    Object.assign(tradeSection.style, S.section);
    const tradeTitle = document.createElement('div');
    Object.assign(tradeTitle.style, S.sectionTitle);
    tradeTitle.textContent = 'Trade List';
    tradeSection.appendChild(tradeTitle);
    tradeSection.appendChild(this.buildTradeTable(r.trades));

    // Export CSV
    const exportBtn = this.createButton('📥 Export CSV', S.btnSecondary, () => this.exportCSV());
    exportBtn.style.marginTop = '12px';
    tradeSection.appendChild(exportBtn);

    this.resultsContainer.appendChild(tradeSection);
  }

  // ── Equity Curve Drawing ──────────────────────────────────────────────

  private drawEquityCurve(): void {
    const canvas = this.equityCanvas;
    if (!canvas || !this.results) return;

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

    const curve = this.results.equityCurve;
    if (curve.length < 2) return;

    const equities = curve.map((c) => c.equity);
    const minE = Math.min(...equities);
    const maxE = Math.max(...equities);
    const range = maxE - minE || 1;

    // Grid lines
    ctx.strokeStyle = '#37415160';
    ctx.lineWidth = 0.5;
    for (let i = 0; i <= 4; i++) {
      const y = pad + ((h - pad * 2) / 4) * i;
      ctx.beginPath();
      ctx.moveTo(pad, y);
      ctx.lineTo(w - pad, y);
      ctx.stroke();
    }

    // Equity line
    ctx.beginPath();
    for (let i = 0; i < curve.length; i++) {
      const x = pad + (i / (curve.length - 1)) * (w - pad * 2);
      const y = pad + (1 - (curve[i].equity - minE) / range) * (h - pad * 2);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    const finalEquity = equities[equities.length - 1];
    ctx.strokeStyle = finalEquity >= equities[0] ? '#10b981' : '#ef4444';
    ctx.lineWidth = 2;
    ctx.stroke();

    // Fill
    const lastX = pad + (w - pad * 2);
    ctx.lineTo(lastX, h - pad);
    ctx.lineTo(pad, h - pad);
    ctx.closePath();
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    const baseColor = finalEquity >= equities[0] ? '#10b981' : '#ef4444';
    grad.addColorStop(0, baseColor + '30');
    grad.addColorStop(1, baseColor + '00');
    ctx.fillStyle = grad;
    ctx.fill();
  }

  // ── Tables ────────────────────────────────────────────────────────────

  private buildTradeTable(trades: BacktestTrade[]): HTMLTableElement {
    const table = document.createElement('table');
    Object.assign(table.style, S.table);

    const thead = document.createElement('thead');
    const headerRow = document.createElement('tr');
    for (const col of ['Entry Time', 'Exit Time', 'Entry Price', 'Exit Price', 'P&L', 'Duration']) {
      const th = document.createElement('th');
      Object.assign(th.style, S.th);
      th.textContent = col;
      headerRow.appendChild(th);
    }
    thead.appendChild(headerRow);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    for (const t of trades) {
      const tr = document.createElement('tr');

      const cells = [
        new Date(t.entryTime).toISOString().slice(0, 19).replace('T', ' '),
        new Date(t.exitTime).toISOString().slice(0, 19).replace('T', ' '),
        t.entryPrice.toFixed(2),
        t.exitPrice.toFixed(2),
        `$${t.pnl.toFixed(2)}`,
        `${Math.round(t.duration / 60000)}m`,
      ];

      cells.forEach((text, i) => {
        const td = document.createElement('td');
        Object.assign(td.style, S.td);
        td.textContent = text;
        if (i === 4) td.style.color = t.pnl >= 0 ? '#10b981' : '#ef4444';
        tr.appendChild(td);
      });

      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    return table;
  }

  private buildPerSetupTable(setups: NonNullable<BacktestResults['perSetup']>): HTMLTableElement {
    const table = document.createElement('table');
    Object.assign(table.style, S.table);

    const thead = document.createElement('thead');
    const headerRow = document.createElement('tr');
    for (const col of ['Setup', 'Win Rate', 'Avg P&L', 'Count']) {
      const th = document.createElement('th');
      Object.assign(th.style, S.th);
      th.textContent = col;
      headerRow.appendChild(th);
    }
    thead.appendChild(headerRow);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    for (const s of setups) {
      const tr = document.createElement('tr');
      const cells = [
        s.setup,
        `${(s.winRate * 100).toFixed(1)}%`,
        `$${s.avgPnl.toFixed(2)}`,
        String(s.count),
      ];
      cells.forEach((text, i) => {
        const td = document.createElement('td');
        Object.assign(td.style, S.td);
        td.textContent = text;
        if (i === 2) td.style.color = s.avgPnl >= 0 ? '#10b981' : '#ef4444';
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    return table;
  }

  // ── CSV Export ─────────────────────────────────────────────────────────

  private exportCSV(): void {
    if (!this.results) return;

    const header = 'Entry Time,Exit Time,Entry Price,Exit Price,P&L,Duration (min)\n';
    const rows = this.results.trades.map((t) =>
      [
        new Date(t.entryTime).toISOString(),
        new Date(t.exitTime).toISOString(),
        t.entryPrice,
        t.exitPrice,
        t.pnl.toFixed(2),
        Math.round(t.duration / 60000),
      ].join(','),
    );

    const csv = header + rows.join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    a.download = `backtest_${this.symbol}_${Date.now()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // ── Save / Load Configs ───────────────────────────────────────────────

  private async saveConfig(): Promise<void> {
    const config: BacktestConfig = {
      symbol: this.symbol,
      timeframe: this.timeframe,
      dateRange: { start: this.dateStart, end: this.dateEnd },
      entryConditions: this.entryConditions,
      exitConditions: this.exitConditions,
    };

    try {
      await fetch(`${API_BASE}/configs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(config),
      });
    } catch (err) {
      console.error('Failed to save config:', err);
    }
  }

  private async loadConfigs(): Promise<void> {
    try {
      const res = await fetch(`${API_BASE}/configs`, { credentials: 'include' });
      if (!res.ok) return;
      const configs = await res.json();
      if (configs.length > 0) {
        const latest = configs[0];
        this.symbol = latest.symbol || this.symbol;
        this.timeframe = latest.timeframe || this.timeframe;
        this.dateStart = latest.dateRange?.start || '';
        this.dateEnd = latest.dateRange?.end || '';
        this.entryConditions = latest.entryConditions || [];
        this.exitConditions = { ...this.exitConditions, ...(latest.exitConditions || {}) };
        // Rebuild UI
        this.wrapperEl?.remove();
        this.buildDOM();
      }
    } catch (err) {
      console.error('Failed to load configs:', err);
    }
  }

  // ── Error Display ─────────────────────────────────────────────────────

  private renderError(message: string): void {
    if (!this.resultsContainer) return;
    this.resultsContainer.innerHTML = '';
    const errDiv = document.createElement('div');
    Object.assign(errDiv.style, S.section);
    errDiv.style.color = '#ef4444';
    errDiv.style.fontSize = '13px';
    errDiv.textContent = `Error: ${message}`;
    this.resultsContainer.appendChild(errDiv);
  }

  // ── Helpers ───────────────────────────────────────────────────────────

  private uid(): string {
    return Math.random().toString(36).slice(2, 10);
  }

  private createButton(
    text: string,
    style: Partial<CSSStyleDeclaration>,
    onClick: () => void,
  ): HTMLButtonElement {
    const btn = document.createElement('button');
    Object.assign(btn.style, S.btn, style);
    btn.textContent = text;
    btn.addEventListener('click', onClick);
    return btn;
  }

  private createSelect(
    options: { value: string; label: string }[],
    selected: string,
    onChange: (v: string) => void,
  ): HTMLSelectElement {
    const sel = document.createElement('select');
    Object.assign(sel.style, S.select);
    for (const opt of options) {
      const o = document.createElement('option');
      o.value = opt.value;
      o.textContent = opt.label;
      if (opt.value === selected) o.selected = true;
      sel.appendChild(o);
    }
    sel.addEventListener('change', () => onChange(sel.value));
    return sel;
  }

  private createInput(
    placeholder: string,
    value: string,
    onChange: (v: string) => void,
  ): HTMLInputElement {
    const input = document.createElement('input');
    Object.assign(input.style, S.input);
    input.placeholder = placeholder;
    input.value = value;
    input.addEventListener('input', () => onChange(input.value));
    return input;
  }

  private wrapField(label: string, el: HTMLElement): HTMLDivElement {
    const wrapper = document.createElement('div');
    const lbl = document.createElement('label');
    Object.assign(lbl.style, S.label);
    lbl.textContent = label;
    wrapper.appendChild(lbl);
    wrapper.appendChild(el);
    return wrapper;
  }
}
