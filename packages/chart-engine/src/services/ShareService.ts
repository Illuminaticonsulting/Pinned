/**
 * ShareService.ts
 * Share chart as high-res image (PNG) or shareable link.
 * Composites all canvas layers + watermark into a single export.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ShareImageOptions {
  paneEl: HTMLElement;
  symbol: string;
  timeframe: string;
  watermark?: boolean;
}

export interface ShareLinkOptions {
  symbol: string;
  timeframe: string;
  layout?: string;
  drawings?: any[];
}

export interface ShareState {
  symbol: string;
  timeframe: string;
  layout?: string;
  drawings?: any[];
  timestamp: number;
}

// ─── ShareService ────────────────────────────────────────────────────────────

export class ShareService {
  
  /**
   * Capture chart pane as high-res PNG by compositing all canvas layers.
   * Returns a Blob of the PNG image.
   */
  static async captureImage(opts: ShareImageOptions): Promise<Blob> {
    const container = opts.paneEl.querySelector('.pane-canvas-container');
    if (!container) throw new Error('No canvas container found');

    const canvases = container.querySelectorAll('canvas');
    if (canvases.length === 0) throw new Error('No canvases found');

    // Get dimensions from first canvas
    const first = canvases[0]!;
    const w = first.width;
    const h = first.height;
    const dpr = window.devicePixelRatio || 1;

    // Create composite canvas
    const composite = document.createElement('canvas');
    composite.width = w;
    composite.height = h;
    const ctx = composite.getContext('2d')!;

    // Dark background
    ctx.fillStyle = '#0a0e17';
    ctx.fillRect(0, 0, w, h);

    // Composite all layers
    for (const canvas of canvases) {
      ctx.drawImage(canvas, 0, 0);
    }

    // Add watermark if enabled
    if (opts.watermark !== false) {
      const fontSize = Math.round(14 * dpr);
      const padding = Math.round(12 * dpr);
      ctx.font = `600 ${fontSize}px Inter, -apple-system, sans-serif`;
      
      // Symbol + timeframe label top-left
      const label = `${opts.symbol} · ${opts.timeframe}`;
      ctx.fillStyle = 'rgba(255, 255, 255, 0.6)';
      ctx.fillText(label, padding, fontSize + padding);

      // "Pinned" branding bottom-right
      const brand = 'Pinned';
      ctx.font = `700 ${Math.round(16 * dpr)}px Inter, -apple-system, sans-serif`;
      const brandWidth = ctx.measureText(brand).width;
      
      // Gradient text effect via fill
      const gradient = ctx.createLinearGradient(
        w - brandWidth - padding, h - padding,
        w - padding, h - padding
      );
      gradient.addColorStop(0, 'rgba(99, 102, 241, 0.5)');
      gradient.addColorStop(1, 'rgba(59, 130, 246, 0.5)');
      ctx.fillStyle = gradient;
      ctx.fillText(brand, w - brandWidth - padding, h - padding);

      // Timestamp bottom-left
      const now = new Date();
      const ts = now.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
      ctx.font = `400 ${Math.round(10 * dpr)}px Inter, -apple-system, sans-serif`;
      ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
      ctx.fillText(ts, padding, h - padding);
    }

    // Convert to blob
    return new Promise<Blob>((resolve, reject) => {
      composite.toBlob(
        (blob) => blob ? resolve(blob) : reject(new Error('Failed to create blob')),
        'image/png',
        1.0,
      );
    });
  }

  /**
   * Download the chart as a PNG file
   */
  static async downloadImage(opts: ShareImageOptions): Promise<void> {
    const blob = await this.captureImage(opts);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `pinned-${opts.symbol}-${opts.timeframe}-${Date.now()}.png`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  /**
   * Copy chart image to clipboard
   */
  static async copyImageToClipboard(opts: ShareImageOptions): Promise<boolean> {
    try {
      const blob = await this.captureImage(opts);
      await navigator.clipboard.write([
        new ClipboardItem({ 'image/png': blob }),
      ]);
      return true;
    } catch (err) {
      console.warn('[ShareService] Clipboard copy failed:', err);
      // Fallback: download
      await this.downloadImage(opts);
      return false;
    }
  }

  /**
   * Generate a shareable link encoding chart state in URL params
   */
  static generateShareLink(opts: ShareLinkOptions): string {
    const params = new URLSearchParams();
    params.set('s', opts.symbol);
    params.set('tf', opts.timeframe);
    if (opts.layout) params.set('l', opts.layout);
    // Encode drawings as compressed base64 if present
    if (opts.drawings && opts.drawings.length > 0) {
      try {
        const json = JSON.stringify(opts.drawings);
        params.set('d', btoa(json));
      } catch {}
    }
    const base = window.location.origin + window.location.pathname;
    return `${base}?${params.toString()}`;
  }

  /**
   * Parse chart state from current URL params
   */
  static parseShareLink(): Partial<ShareState> | null {
    const params = new URLSearchParams(window.location.search);
    const symbol = params.get('s');
    if (!symbol) return null;

    const state: Partial<ShareState> = {
      symbol,
      timeframe: params.get('tf') || '1m',
      layout: params.get('l') || undefined,
    };

    const drawingsB64 = params.get('d');
    if (drawingsB64) {
      try {
        state.drawings = JSON.parse(atob(drawingsB64));
      } catch {}
    }

    return state;
  }

  /**
   * Copy text to clipboard (for shareable link)
   */
  static async copyToClipboard(text: string): Promise<boolean> {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fallback
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(textarea);
      return ok;
    }
  }
}

/**
 * ShareDialog - popup with share options
 */
export class ShareDialog {
  private overlay: HTMLElement | null = null;
  private isOpen = false;
  private opts: {
    paneEl: HTMLElement;
    symbol: string;
    timeframe: string;
    layout: string;
    drawings: any[];
    onToast: (msg: string) => void;
  };

  constructor(opts: {
    paneEl: HTMLElement;
    symbol: string;
    timeframe: string;
    layout: string;
    drawings: any[];
    onToast: (msg: string) => void;
  }) {
    this.opts = opts;
  }

  open(): void {
    if (this.isOpen) return;
    this.isOpen = true;
    this.render();
    requestAnimationFrame(() => this.overlay?.classList.add('open'));
    document.addEventListener('keydown', this.handleKey);
  }

  close(): void {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.overlay?.classList.remove('open');
    document.removeEventListener('keydown', this.handleKey);
    setTimeout(() => {
      this.overlay?.remove();
      this.overlay = null;
    }, 200);
  }

  private render(): void {
    this.overlay = document.createElement('div');
    this.overlay.className = 'share-overlay';
    this.overlay.addEventListener('click', (e) => {
      if (e.target === this.overlay) this.close();
    });

    const link = ShareService.generateShareLink(this.opts);

    const modal = document.createElement('div');
    modal.className = 'share-modal';
    modal.innerHTML = `
      <div class="share-header">
        <h3 class="share-title">Share Chart</h3>
        <button class="share-close">&times;</button>
      </div>
      <div class="share-body">
        <div class="share-section">
          <div class="share-section-label">Export Image</div>
          <div class="share-actions">
            <button class="share-action-btn" id="shareDownload">
              <svg width="20" height="20" viewBox="0 0 20 20" fill="none"><path d="M10 3v10m0 0l-3-3m3 3l3-3M4 15h12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
              <span>Download PNG</span>
            </button>
            <button class="share-action-btn" id="shareCopyImg">
              <svg width="20" height="20" viewBox="0 0 20 20" fill="none"><rect x="6" y="6" width="10" height="10" rx="2" stroke="currentColor" stroke-width="1.5"/><path d="M4 14V5a1 1 0 011-1h9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
              <span>Copy to Clipboard</span>
            </button>
          </div>
        </div>
        <div class="share-section">
          <div class="share-section-label">Shareable Link</div>
          <div class="share-link-row">
            <input class="share-link-input" type="text" readonly value="${link}" />
            <button class="share-copy-link" id="shareCopyLink">Copy</button>
          </div>
        </div>
      </div>
    `;

    this.overlay.appendChild(modal);
    document.body.appendChild(this.overlay);

    // Wire events
    modal.querySelector('.share-close')!.addEventListener('click', () => this.close());

    modal.querySelector('#shareDownload')!.addEventListener('click', async () => {
      try {
        await ShareService.downloadImage({
          paneEl: this.opts.paneEl,
          symbol: this.opts.symbol,
          timeframe: this.opts.timeframe,
        });
        this.opts.onToast('Chart downloaded');
        this.close();
      } catch (err) {
        this.opts.onToast('Download failed');
      }
    });

    modal.querySelector('#shareCopyImg')!.addEventListener('click', async () => {
      try {
        const ok = await ShareService.copyImageToClipboard({
          paneEl: this.opts.paneEl,
          symbol: this.opts.symbol,
          timeframe: this.opts.timeframe,
        });
        this.opts.onToast(ok ? 'Copied to clipboard' : 'Downloaded instead');
        this.close();
      } catch {
        this.opts.onToast('Copy failed');
      }
    });

    modal.querySelector('#shareCopyLink')!.addEventListener('click', async () => {
      const ok = await ShareService.copyToClipboard(link);
      this.opts.onToast(ok ? 'Link copied' : 'Copy failed');
      const btn = modal.querySelector('#shareCopyLink')!;
      btn.textContent = '✓ Copied';
      setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
    });
  }

  private handleKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault();
      this.close();
    }
  };
}
