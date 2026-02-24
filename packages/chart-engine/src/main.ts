import './styles.css';

// ─── Types ───────────────────────────────────────────────────────────────────

interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface AppState {
  symbol: string;
  timeframe: string;
  candles: Candle[];
  ws: WebSocket | null;
  drawingMode: string | null;
  crosshairEnabled: boolean;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const SYMBOLS = ['BTC-USDT', 'ETH-USDT'];
const TIMEFRAMES = ['1m', '5m', '15m', '1h', '4h', '1d'];
const DRAWING_TOOLS = [
  { id: 'hline', label: 'H-Line', icon: '─', shortcut: 'H' },
  { id: 'trendline', label: 'Trend Line', icon: '╱', shortcut: 'T' },
  { id: 'rect', label: 'Rectangle', icon: '▭', shortcut: 'R' },
  { id: 'fib', label: 'Fibonacci', icon: '𝐅', shortcut: 'F' },
];

// ─── PinnedApp ───────────────────────────────────────────────────────────────

class PinnedApp {
  private root: HTMLElement;
  private state: AppState;
  private chartCanvas: HTMLCanvasElement | null = null;
  private chartCtx: CanvasRenderingContext2D | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private animationFrameId: number | null = null;

  constructor(rootEl: HTMLElement) {
    this.root = rootEl;
    this.state = {
      symbol: 'BTC-USDT',
      timeframe: '1m',
      candles: [],
      ws: null,
      drawingMode: null,
      crosshairEnabled: true,
    };
  }

  // ── Bootstrap ────────────────────────────────────────────────────────────

  async init() {
    this.renderShell();
    this.bindKeyboardShortcuts();
    this.setupResizeHandler();
    await this.loadCandles();
    this.connectWebSocket();
    this.startRenderLoop();
  }

  // ── UI Shell ─────────────────────────────────────────────────────────────

  private renderShell() {
    this.root.innerHTML = /* html */ `
      <div class="pinned-layout">
        <!-- Top Bar -->
        <header class="top-bar">
          <div class="top-bar__left">
            <div class="logo">Pinned</div>
            <div class="symbol-selector">
              <select id="symbolSelect" class="symbol-select">
                ${SYMBOLS.map(
                  (s) =>
                    `<option value="${s}" ${s === this.state.symbol ? 'selected' : ''}>${s}</option>`,
                ).join('')}
              </select>
            </div>
            <div class="timeframe-group" id="timeframeGroup">
              ${TIMEFRAMES.map(
                (tf) =>
                  `<button class="tf-btn ${tf === this.state.timeframe ? 'active' : ''}" data-tf="${tf}">${tf}</button>`,
              ).join('')}
            </div>
          </div>
          <div class="top-bar__center">
            <div class="drawing-tools" id="drawingTools">
              ${DRAWING_TOOLS.map(
                (dt) =>
                  `<button class="tool-btn" data-tool="${dt.id}" title="${dt.label} (${dt.shortcut})">
                    <span class="tool-icon">${dt.icon}</span>
                  </button>`,
              ).join('')}
            </div>
          </div>
          <div class="top-bar__right">
            <button class="icon-btn" id="indicatorToggle" title="Indicators">
              <span>📊</span>
            </button>
            <button class="icon-btn" id="settingsBtn" title="Settings">
              <span>⚙</span>
            </button>
          </div>
        </header>

        <!-- Main Area -->
        <div class="main-area">
          <!-- Sidebar Left (collapsible) -->
          <aside class="sidebar sidebar--left" id="sidebarLeft">
            <div class="sidebar__panel">
              <div class="panel-header">Watchlist</div>
              <div class="panel-body" id="watchlistPanel"></div>
            </div>
          </aside>

          <!-- Chart Area -->
          <div class="chart-container" id="chartContainer">
            <canvas id="chartCanvas"></canvas>
            <div class="crosshair-info" id="crosshairInfo"></div>
          </div>

          <!-- Sidebar Right (collapsible) -->
          <aside class="sidebar sidebar--right" id="sidebarRight">
            <div class="sidebar__panel">
              <div class="panel-header">Order Book</div>
              <div class="panel-body" id="orderbookPanel"></div>
            </div>
            <div class="sidebar__panel">
              <div class="panel-header">Trades</div>
              <div class="panel-body" id="tradesPanel"></div>
            </div>
          </aside>
        </div>
      </div>

      <!-- Toast Container -->
      <div class="toast-container" id="toastContainer"></div>
    `;

    // Bind UI events
    this.bindUIEvents();

    // Set up canvas
    const container = this.root.querySelector<HTMLElement>('#chartContainer')!;
    this.chartCanvas = this.root.querySelector<HTMLCanvasElement>('#chartCanvas')!;
    this.chartCtx = this.chartCanvas.getContext('2d');
    this.sizeCanvas(container);
  }

  // ── UI Event Binding ─────────────────────────────────────────────────────

  private bindUIEvents() {
    // Symbol selector
    const symbolSelect = this.root.querySelector<HTMLSelectElement>('#symbolSelect')!;
    symbolSelect.addEventListener('change', (e) => {
      this.state.symbol = (e.target as HTMLSelectElement).value;
      this.onSymbolOrTimeframeChange();
    });

    // Timeframe buttons
    const tfGroup = this.root.querySelector('#timeframeGroup')!;
    tfGroup.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('.tf-btn');
      if (!btn) return;
      this.state.timeframe = btn.dataset.tf!;
      tfGroup.querySelectorAll('.tf-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      this.onSymbolOrTimeframeChange();
    });

    // Drawing tools
    const toolGroup = this.root.querySelector('#drawingTools')!;
    toolGroup.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('.tool-btn');
      if (!btn) return;
      this.setDrawingMode(btn.dataset.tool!);
    });
  }

  // ── Drawing Mode ─────────────────────────────────────────────────────────

  private setDrawingMode(mode: string | null) {
    this.state.drawingMode = this.state.drawingMode === mode ? null : mode;

    this.root.querySelectorAll('.tool-btn').forEach((btn) => {
      btn.classList.toggle(
        'active',
        (btn as HTMLElement).dataset.tool === this.state.drawingMode,
      );
    });
  }

  // ── Keyboard Shortcuts ───────────────────────────────────────────────────

  private bindKeyboardShortcuts() {
    window.addEventListener('keydown', (e: KeyboardEvent) => {
      // Ignore when typing in inputs
      if ((e.target as HTMLElement).tagName === 'INPUT' || (e.target as HTMLElement).tagName === 'TEXTAREA') return;

      const key = e.key.toUpperCase();

      if (key === 'H') { this.setDrawingMode('hline'); return; }
      if (key === 'T' && !e.ctrlKey && !e.metaKey) { this.setDrawingMode('trendline'); return; }
      if (key === 'R' && !e.ctrlKey && !e.metaKey) { this.setDrawingMode('rect'); return; }
      if (key === 'F' && !e.ctrlKey && !e.metaKey) { this.setDrawingMode('fib'); return; }
      if (key === 'ESCAPE') { this.setDrawingMode(null); return; }
      if (key === ' ') { e.preventDefault(); this.state.crosshairEnabled = !this.state.crosshairEnabled; return; }

      // Undo / Redo
      if ((e.ctrlKey || e.metaKey) && key === 'Z' && !e.shiftKey) {
        e.preventDefault();
        this.undo();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && key === 'Z' && e.shiftKey) {
        e.preventDefault();
        this.redo();
        return;
      }
    });
  }

  private undo() {
    this.showToast('Undo');
  }

  private redo() {
    this.showToast('Redo');
  }

  // ── Resize Handling ──────────────────────────────────────────────────────

  private setupResizeHandler() {
    const container = () => this.root.querySelector<HTMLElement>('#chartContainer');

    this.resizeObserver = new ResizeObserver(() => {
      const c = container();
      if (c && this.chartCanvas) this.sizeCanvas(c);
    });

    // Observe after first render tick
    requestAnimationFrame(() => {
      const c = container();
      if (c) this.resizeObserver!.observe(c);
    });

    window.addEventListener('resize', () => {
      const c = container();
      if (c && this.chartCanvas) this.sizeCanvas(c);
    });
  }

  private sizeCanvas(container: HTMLElement) {
    const dpr = window.devicePixelRatio || 1;
    const rect = container.getBoundingClientRect();
    this.chartCanvas!.width = rect.width * dpr;
    this.chartCanvas!.height = rect.height * dpr;
    this.chartCanvas!.style.width = `${rect.width}px`;
    this.chartCanvas!.style.height = `${rect.height}px`;
    this.chartCtx?.scale(dpr, dpr);
  }

  // ── Data Loading ─────────────────────────────────────────────────────────

  private async loadCandles() {
    try {
      const res = await fetch(`/api/candles?symbol=${this.state.symbol}&interval=${this.state.timeframe}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: Candle[] = await res.json();
      this.state.candles = data;
    } catch (err) {
      console.warn('[Pinned] Failed to load candles, using empty set:', err);
      this.state.candles = [];
    }
  }

  private async onSymbolOrTimeframeChange() {
    this.disconnectWebSocket();
    await this.loadCandles();
    this.connectWebSocket();
  }

  // ── WebSocket ────────────────────────────────────────────────────────────

  private connectWebSocket() {
    const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
    const url = `${protocol}://${location.host}/ws?symbol=${this.state.symbol}&interval=${this.state.timeframe}`;

    try {
      const ws = new WebSocket(url);

      ws.addEventListener('open', () => {
        console.log('[Pinned] WS connected');
      });

      ws.addEventListener('message', (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'candle') {
            this.handleCandleUpdate(msg.data as Candle);
          }
        } catch { /* ignore bad messages */ }
      });

      ws.addEventListener('close', () => {
        console.log('[Pinned] WS disconnected, reconnecting in 3s…');
        setTimeout(() => this.connectWebSocket(), 3000);
      });

      ws.addEventListener('error', (err) => {
        console.warn('[Pinned] WS error', err);
      });

      this.state.ws = ws;
    } catch (err) {
      console.warn('[Pinned] WS connection failed:', err);
    }
  }

  private disconnectWebSocket() {
    if (this.state.ws) {
      this.state.ws.close();
      this.state.ws = null;
    }
  }

  private handleCandleUpdate(candle: Candle) {
    const candles = this.state.candles;
    if (candles.length > 0 && candles[candles.length - 1].time === candle.time) {
      candles[candles.length - 1] = candle;
    } else {
      candles.push(candle);
    }
  }

  // ── Render Loop ──────────────────────────────────────────────────────────

  private startRenderLoop() {
    const loop = () => {
      this.renderChart();
      this.animationFrameId = requestAnimationFrame(loop);
    };
    this.animationFrameId = requestAnimationFrame(loop);
  }

  private renderChart() {
    const ctx = this.chartCtx;
    const canvas = this.chartCanvas;
    if (!ctx || !canvas) return;

    const w = canvas.width / (window.devicePixelRatio || 1);
    const h = canvas.height / (window.devicePixelRatio || 1);

    // Clear
    ctx.clearRect(0, 0, w, h);

    const candles = this.state.candles;
    if (candles.length === 0) {
      // Animated loading state with shimmer effect
      const centerX = w / 2;
      const centerY = h / 2;

      // Pulsing circle
      const now = performance.now();
      const pulse = 0.3 + 0.2 * Math.sin(now / 600);

      // Spinner ring
      ctx.save();
      ctx.translate(centerX, centerY - 28);
      ctx.rotate((now / 800) % (Math.PI * 2));
      ctx.strokeStyle = `rgba(99, 102, 241, ${pulse + 0.3})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(0, 0, 14, 0, Math.PI * 1.5);
      ctx.stroke();
      ctx.restore();

      // Text
      ctx.fillStyle = '#64748b';
      ctx.font = '500 13px Inter, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Connecting to market data\u2026', centerX, centerY + 8);

      // Subtle sub-text
      ctx.fillStyle = '#475569';
      ctx.font = '400 11px Inter, sans-serif';
      ctx.fillText(`${this.state.symbol} \u00B7 ${this.state.timeframe}`, centerX, centerY + 28);
      return;
    }

    // ── Compute visible range ──────────────────────────────────────────
    const candleWidth = 8;
    const gap = 2;
    const step = candleWidth + gap;
    const visibleCount = Math.floor(w / step);
    const startIdx = Math.max(0, candles.length - visibleCount);
    const visible = candles.slice(startIdx);

    let minLow = Infinity;
    let maxHigh = -Infinity;
    for (const c of visible) {
      if (c.low < minLow) minLow = c.low;
      if (c.high > maxHigh) maxHigh = c.high;
    }
    const priceRange = maxHigh - minLow || 1;
    const padding = priceRange * 0.08;
    const priceLow = minLow - padding;
    const priceHigh = maxHigh + padding;
    const totalRange = priceHigh - priceLow;

    const toY = (price: number) => h - ((price - priceLow) / totalRange) * h;

    // ── Grid lines ─────────────────────────────────────────────────────
    ctx.strokeStyle = '#1f2937';
    ctx.lineWidth = 1;
    const gridLines = 6;
    for (let i = 0; i <= gridLines; i++) {
      const y = (h / gridLines) * i;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();

      // Price label
      const price = priceHigh - (totalRange / gridLines) * i;
      ctx.fillStyle = '#6b7280';
      ctx.font = '11px JetBrains Mono, monospace';
      ctx.textAlign = 'right';
      ctx.fillText(price.toFixed(2), w - 6, y - 4);
    }

    // ── Candles ─────────────────────────────────────────────────────────
    for (let i = 0; i < visible.length; i++) {
      const c = visible[i];
      const x = i * step + step / 2;
      const isBull = c.close >= c.open;
      const color = isBull ? '#22c55e' : '#ef4444';

      // Wick
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, toY(c.high));
      ctx.lineTo(x, toY(c.low));
      ctx.stroke();

      // Body
      const bodyTop = toY(Math.max(c.open, c.close));
      const bodyBot = toY(Math.min(c.open, c.close));
      const bodyH = Math.max(bodyBot - bodyTop, 1);

      ctx.fillStyle = color;
      ctx.fillRect(x - candleWidth / 2, bodyTop, candleWidth, bodyH);
    }
  }

  // ── Toast Notifications ──────────────────────────────────────────────────

  private showToast(message: string, duration = 1500) {
    const container = document.getElementById('toastContainer');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = message;
    container.appendChild(toast);

    requestAnimationFrame(() => toast.classList.add('toast--visible'));

    setTimeout(() => {
      toast.classList.remove('toast--visible');
      toast.addEventListener('transitionend', () => toast.remove());
    }, duration);
  }

  // ── Cleanup ──────────────────────────────────────────────────────────────

  destroy() {
    this.disconnectWebSocket();
    if (this.animationFrameId !== null) cancelAnimationFrame(this.animationFrameId);
    if (this.resizeObserver) this.resizeObserver.disconnect();
  }
}

// ─── Bootstrap ───────────────────────────────────────────────────────────────

const appRoot = document.getElementById('app');
if (appRoot) {
  const app = new PinnedApp(appRoot);
  app.init();
}
