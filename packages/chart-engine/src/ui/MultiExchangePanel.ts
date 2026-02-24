/**
 * MultiExchangePanel — Multi-exchange arbitrage view.
 *
 * Displays two heatmaps side-by-side (BloFin left, MEXC right) with a
 * shared Y axis, divergence highlighting, spread subplot, and lead/lag indicator.
 */

import { HeatmapPanel } from '../heatmap/HeatmapPanel';

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface ExchangeData {
  snapshot: ArrayBuffer;
  bestBid: number;
  bestAsk: number;
  lastPrice: number;
  walls: { price: number; size: number; side: 'bid' | 'ask' }[];
}

interface PriceChange {
  time: number;
  blofinPrice: number;
  mexcPrice: number;
}

// ─── Constants ─────────────────────────────────────────────────────────────────

const DIVERGENCE_THRESHOLD = 0.5; // relative wall size threshold
const LEAD_LAG_WINDOW = 50;       // last N price changes

const STYLES = {
  wrapper: {
    display: 'flex',
    flexDirection: 'column',
    width: '100%',
    height: '100%',
    background: '#0a0e17',
    overflow: 'hidden',
  } as Partial<CSSStyleDeclaration>,
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    height: '32px',
    minHeight: '32px',
    padding: '0 12px',
    background: '#111827',
    borderBottom: '1px solid #374151',
    flexShrink: '0',
  } as Partial<CSSStyleDeclaration>,
  title: {
    fontSize: '11px',
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
    color: '#6b7280',
    userSelect: 'none',
  } as Partial<CSSStyleDeclaration>,
  splitContainer: {
    display: 'flex',
    flex: '1',
    overflow: 'hidden',
  } as Partial<CSSStyleDeclaration>,
  panelHalf: {
    flex: '1',
    position: 'relative',
    overflow: 'hidden',
  } as Partial<CSSStyleDeclaration>,
  divider: {
    width: '2px',
    background: '#374151',
    flexShrink: '0',
  } as Partial<CSSStyleDeclaration>,
  spreadBar: {
    height: '80px',
    minHeight: '80px',
    borderTop: '1px solid #374151',
    background: '#0a0e17',
    position: 'relative',
    flexShrink: '0',
  } as Partial<CSSStyleDeclaration>,
  exchangeLabel: {
    position: 'absolute',
    top: '4px',
    left: '8px',
    fontSize: '10px',
    fontWeight: '600',
    color: '#9ca3af',
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
    zIndex: '10',
    pointerEvents: 'none',
  } as Partial<CSSStyleDeclaration>,
  leadLagBadge: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '4px',
    padding: '2px 8px',
    borderRadius: '4px',
    fontSize: '11px',
    fontWeight: '600',
  } as Partial<CSSStyleDeclaration>,
};

// ─── MultiExchangePanel ────────────────────────────────────────────────────────

export class MultiExchangePanel {
  private container: HTMLElement | null = null;
  private wrapperEl: HTMLDivElement | null = null;

  // Child panels
  private blofinPanel: HeatmapPanel | null = null;
  private mexcPanel: HeatmapPanel | null = null;

  // DOM elements
  private blofinContainer: HTMLDivElement | null = null;
  private mexcContainer: HTMLDivElement | null = null;
  private spreadCanvas: HTMLCanvasElement | null = null;
  private leadLagEl: HTMLDivElement | null = null;
  private divergenceOverlay: HTMLCanvasElement | null = null;

  // State
  private priceHistory: PriceChange[] = [];
  private spreadHistory: { time: number; spread: number }[] = [];
  private resizeObserver: ResizeObserver | null = null;

  // ── Mount ──────────────────────────────────────────────────────────────

  mount(container: HTMLElement): void {
    this.container = container;
    this.buildDOM();
    this.initPanels();
    this.setupResizeObserver();
  }

  // ── Update ─────────────────────────────────────────────────────────────

  update(blofinData: ExchangeData, mexcData: ExchangeData): void {
    // Update heatmaps
    if (this.blofinPanel && blofinData.snapshot) {
      this.blofinPanel.setData(blofinData.snapshot);
    }
    if (this.mexcPanel && mexcData.snapshot) {
      this.mexcPanel.setData(mexcData.snapshot);
    }

    // Track price changes for lead/lag
    this.priceHistory.push({
      time: Date.now(),
      blofinPrice: blofinData.lastPrice,
      mexcPrice: mexcData.lastPrice,
    });
    if (this.priceHistory.length > LEAD_LAG_WINDOW) {
      this.priceHistory.shift();
    }

    // Compute spread
    const blofinMid = (blofinData.bestBid + blofinData.bestAsk) / 2;
    const mexcMid = (mexcData.bestBid + mexcData.bestAsk) / 2;
    const spread = blofinMid - mexcMid;
    this.spreadHistory.push({ time: Date.now(), spread });
    if (this.spreadHistory.length > 300) {
      this.spreadHistory.shift();
    }

    // Draw divergences
    this.drawDivergences(blofinData, mexcData);

    // Draw spread subplot
    this.drawSpreadChart();

    // Update lead/lag indicator
    this.updateLeadLag();
  }

  // ── Destroy ────────────────────────────────────────────────────────────

  destroy(): void {
    this.resizeObserver?.disconnect();
    this.blofinPanel?.destroy();
    this.mexcPanel?.destroy();
    this.wrapperEl?.remove();
    this.container = null;
    this.wrapperEl = null;
    this.blofinPanel = null;
    this.mexcPanel = null;
    this.priceHistory = [];
    this.spreadHistory = [];
  }

  // ── DOM Construction ──────────────────────────────────────────────────

  private buildDOM(): void {
    this.wrapperEl = document.createElement('div');
    Object.assign(this.wrapperEl.style, STYLES.wrapper);

    // Header
    const header = document.createElement('div');
    Object.assign(header.style, STYLES.header);

    const title = document.createElement('span');
    Object.assign(title.style, STYLES.title);
    title.textContent = 'Multi-Exchange Arbitrage';
    header.appendChild(title);

    // Lead/lag badge
    this.leadLagEl = document.createElement('div');
    Object.assign(this.leadLagEl.style, STYLES.leadLagBadge);
    this.leadLagEl.style.background = '#1f2937';
    this.leadLagEl.style.color = '#9ca3af';
    this.leadLagEl.textContent = 'Analyzing...';
    header.appendChild(this.leadLagEl);

    this.wrapperEl.appendChild(header);

    // Split container
    const splitContainer = document.createElement('div');
    Object.assign(splitContainer.style, STYLES.splitContainer);

    // BloFin side
    const blofinWrapper = document.createElement('div');
    Object.assign(blofinWrapper.style, STYLES.panelHalf);
    const blofinLabel = document.createElement('div');
    Object.assign(blofinLabel.style, STYLES.exchangeLabel);
    blofinLabel.textContent = 'BloFin';
    blofinWrapper.appendChild(blofinLabel);
    this.blofinContainer = document.createElement('div');
    this.blofinContainer.style.width = '100%';
    this.blofinContainer.style.height = '100%';
    blofinWrapper.appendChild(this.blofinContainer);
    splitContainer.appendChild(blofinWrapper);

    // Divider
    const divider = document.createElement('div');
    Object.assign(divider.style, STYLES.divider);
    splitContainer.appendChild(divider);

    // MEXC side
    const mexcWrapper = document.createElement('div');
    Object.assign(mexcWrapper.style, STYLES.panelHalf);
    const mexcLabel = document.createElement('div');
    Object.assign(mexcLabel.style, STYLES.exchangeLabel);
    mexcLabel.textContent = 'MEXC';
    mexcWrapper.appendChild(mexcLabel);
    this.mexcContainer = document.createElement('div');
    this.mexcContainer.style.width = '100%';
    this.mexcContainer.style.height = '100%';
    mexcWrapper.appendChild(this.mexcContainer);
    splitContainer.appendChild(mexcWrapper);

    // Divergence overlay (draws connecting lines across both panels)
    this.divergenceOverlay = document.createElement('canvas');
    this.divergenceOverlay.style.position = 'absolute';
    this.divergenceOverlay.style.top = '0';
    this.divergenceOverlay.style.left = '0';
    this.divergenceOverlay.style.width = '100%';
    this.divergenceOverlay.style.height = '100%';
    this.divergenceOverlay.style.pointerEvents = 'none';
    this.divergenceOverlay.style.zIndex = '20';
    splitContainer.style.position = 'relative';
    splitContainer.appendChild(this.divergenceOverlay);

    this.wrapperEl.appendChild(splitContainer);

    // Spread subplot
    const spreadBar = document.createElement('div');
    Object.assign(spreadBar.style, STYLES.spreadBar);
    const spreadLabel = document.createElement('div');
    spreadLabel.style.position = 'absolute';
    spreadLabel.style.top = '4px';
    spreadLabel.style.left = '8px';
    spreadLabel.style.fontSize = '10px';
    spreadLabel.style.color = '#6b7280';
    spreadLabel.style.fontWeight = '600';
    spreadLabel.style.textTransform = 'uppercase';
    spreadLabel.style.letterSpacing = '0.05em';
    spreadLabel.textContent = 'Spread';
    spreadBar.appendChild(spreadLabel);

    this.spreadCanvas = document.createElement('canvas');
    this.spreadCanvas.style.width = '100%';
    this.spreadCanvas.style.height = '100%';
    spreadBar.appendChild(this.spreadCanvas);

    this.wrapperEl.appendChild(spreadBar);

    this.container!.appendChild(this.wrapperEl);
  }

  private initPanels(): void {
    if (this.blofinContainer) {
      this.blofinPanel = new HeatmapPanel({ splitMode: true });
      this.blofinPanel.mount(this.blofinContainer);
    }
    if (this.mexcContainer) {
      this.mexcPanel = new HeatmapPanel({ splitMode: true });
      this.mexcPanel.mount(this.mexcContainer);
    }
  }

  private setupResizeObserver(): void {
    if (!this.wrapperEl) return;
    this.resizeObserver = new ResizeObserver(() => {
      this.resizeCanvases();
      this.blofinPanel?.resize();
      this.mexcPanel?.resize();
    });
    this.resizeObserver.observe(this.wrapperEl);
  }

  private resizeCanvases(): void {
    if (this.spreadCanvas) {
      const rect = this.spreadCanvas.parentElement!.getBoundingClientRect();
      this.spreadCanvas.width = rect.width * devicePixelRatio;
      this.spreadCanvas.height = rect.height * devicePixelRatio;
    }
    if (this.divergenceOverlay) {
      const rect = this.divergenceOverlay.parentElement!.getBoundingClientRect();
      this.divergenceOverlay.width = rect.width * devicePixelRatio;
      this.divergenceOverlay.height = rect.height * devicePixelRatio;
    }
  }

  // ── Divergence Highlighting ───────────────────────────────────────────

  private drawDivergences(blofinData: ExchangeData, mexcData: ExchangeData): void {
    const canvas = this.divergenceOverlay;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = devicePixelRatio;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.save();
    ctx.scale(dpr, dpr);

    const w = canvas.width / dpr;
    const h = canvas.height / dpr;
    const halfW = w / 2;

    // Find walls on one exchange that don't have a corresponding wall on the other
    const blofinWallPrices = new Map(blofinData.walls.map((w) => [w.price, w.size]));
    const mexcWallPrices = new Map(mexcData.walls.map((w) => [w.price, w.size]));

    const allPrices = new Set([...blofinWallPrices.keys(), ...mexcWallPrices.keys()]);
    const minPrice = Math.min(...allPrices);
    const maxPrice = Math.max(...allPrices);
    const priceRange = maxPrice - minPrice || 1;

    for (const price of allPrices) {
      const blofinSize = blofinWallPrices.get(price) ?? 0;
      const mexcSize = mexcWallPrices.get(price) ?? 0;

      const maxWall = Math.max(blofinSize, mexcSize);
      const minWall = Math.min(blofinSize, mexcSize);

      if (maxWall > 0 && (minWall === 0 || maxWall / (minWall || 1) > DIVERGENCE_THRESHOLD * 10)) {
        const y = h - ((price - minPrice) / priceRange) * h;

        ctx.beginPath();
        ctx.moveTo(halfW * 0.3, y);
        ctx.lineTo(halfW + halfW * 0.7, y);
        ctx.strokeStyle = '#f59e0b80';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([4, 4]);
        ctx.stroke();
        ctx.setLineDash([]);

        // Divergence marker
        const markerX = blofinSize > mexcSize ? halfW * 0.15 : halfW + halfW * 0.85;
        ctx.beginPath();
        ctx.arc(markerX, y, 4, 0, Math.PI * 2);
        ctx.fillStyle = '#f59e0b';
        ctx.fill();
      }
    }

    ctx.restore();
  }

  // ── Spread Chart ──────────────────────────────────────────────────────

  private drawSpreadChart(): void {
    const canvas = this.spreadCanvas;
    if (!canvas || this.spreadHistory.length < 2) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = devicePixelRatio;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.save();
    ctx.scale(dpr, dpr);

    const w = canvas.width / dpr;
    const h = canvas.height / dpr;
    const padTop = 20;
    const padBottom = 4;
    const plotH = h - padTop - padBottom;

    const spreads = this.spreadHistory.map((s) => s.spread);
    const minSpread = Math.min(...spreads);
    const maxSpread = Math.max(...spreads);
    const range = maxSpread - minSpread || 0.01;

    // Zero line
    const zeroY = padTop + plotH - ((0 - minSpread) / range) * plotH;
    ctx.beginPath();
    ctx.moveTo(0, zeroY);
    ctx.lineTo(w, zeroY);
    ctx.strokeStyle = '#374151';
    ctx.lineWidth = 1;
    ctx.stroke();

    // Spread line
    ctx.beginPath();
    for (let i = 0; i < this.spreadHistory.length; i++) {
      const x = (i / (this.spreadHistory.length - 1)) * w;
      const y = padTop + plotH - ((this.spreadHistory[i].spread - minSpread) / range) * plotH;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = '#6366f1';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Fill gradient
    const lastX = w;
    const lastY =
      padTop +
      plotH -
      ((this.spreadHistory[this.spreadHistory.length - 1].spread - minSpread) / range) * plotH;

    ctx.lineTo(lastX, h);
    ctx.lineTo(0, h);
    ctx.closePath();
    const gradient = ctx.createLinearGradient(0, 0, 0, h);
    gradient.addColorStop(0, '#6366f120');
    gradient.addColorStop(1, '#6366f100');
    ctx.fillStyle = gradient;
    ctx.fill();

    // Current spread value
    const currentSpread = spreads[spreads.length - 1];
    ctx.fillStyle = '#f9fafb';
    ctx.font = '600 11px Inter, system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(`Spread: ${currentSpread.toFixed(4)}`, w - 8, 14);

    ctx.restore();
  }

  // ── Lead/Lag Indicator ────────────────────────────────────────────────

  private updateLeadLag(): void {
    if (!this.leadLagEl || this.priceHistory.length < 3) return;

    let blofinLeads = 0;
    let mexcLeads = 0;

    for (let i = 1; i < this.priceHistory.length; i++) {
      const prev = this.priceHistory[i - 1];
      const curr = this.priceHistory[i];

      const blofinDelta = curr.blofinPrice - prev.blofinPrice;
      const mexcDelta = curr.mexcPrice - prev.mexcPrice;

      // If one moved and the other didn't, the mover leads
      if (Math.abs(blofinDelta) > Math.abs(mexcDelta) * 1.5) {
        blofinLeads++;
      } else if (Math.abs(mexcDelta) > Math.abs(blofinDelta) * 1.5) {
        mexcLeads++;
      }
    }

    if (blofinLeads > mexcLeads * 1.2) {
      this.leadLagEl.textContent = '⚡ BloFin leads';
      this.leadLagEl.style.background = '#1e3a2f';
      this.leadLagEl.style.color = '#10b981';
    } else if (mexcLeads > blofinLeads * 1.2) {
      this.leadLagEl.textContent = '⚡ MEXC leads';
      this.leadLagEl.style.background = '#2d1f3d';
      this.leadLagEl.style.color = '#a78bfa';
    } else {
      this.leadLagEl.textContent = '⚖️ Balanced';
      this.leadLagEl.style.background = '#1f2937';
      this.leadLagEl.style.color = '#9ca3af';
    }
  }
}
