/**
 * TopBar — Main header bar UI component for the Pinned chart engine.
 *
 * Renders logo, symbol selector, timeframe buttons, drawing tools,
 * indicator toggles, settings, and connection status indicator.
 */

// ─── Types ─────────────────────────────────────────────────────────────────────

export type ConnectionStatus = 'connected' | 'connecting' | 'disconnected';

export interface DrawingTool {
  id: string;
  label: string;
  icon: string;
  shortcut: string;
}

export interface IndicatorDef {
  id: string;
  label: string;
  enabled: boolean;
}

// ─── Constants ─────────────────────────────────────────────────────────────────

const SYMBOLS = [
  'BTC-USDT', 'ETH-USDT', 'SOL-USDT', 'BNB-USDT', 'XRP-USDT',
  'ADA-USDT', 'DOGE-USDT', 'AVAX-USDT', 'DOT-USDT', 'MATIC-USDT',
];

const TIMEFRAMES = ['1m', '5m', '15m', '1h', '4h', '1d'];

const DRAWING_TOOLS: DrawingTool[] = [
  { id: 'hline', label: 'H-Line', icon: '─', shortcut: 'H' },
  { id: 'trendline', label: 'Trend', icon: '╱', shortcut: 'T' },
  { id: 'rect', label: 'Rect', icon: '▭', shortcut: 'R' },
  { id: 'fib', label: 'Fib', icon: '𝐅', shortcut: 'F' },
];

const DEFAULT_INDICATORS: IndicatorDef[] = [
  { id: 'footprint', label: 'Footprint', enabled: false },
  { id: 'vwap', label: 'VWAP', enabled: false },
  { id: 'volumeProfile', label: 'Volume Profile', enabled: false },
  { id: 'cumulativeDelta', label: 'Cumulative Delta', enabled: false },
  { id: 'ofi', label: 'OFI', enabled: false },
  { id: 'fundingRate', label: 'Funding Rate', enabled: false },
  { id: 'heatmap', label: 'Heatmap', enabled: false },
];

const STATUS_COLORS: Record<ConnectionStatus, string> = {
  connected: '#22c55e',
  connecting: '#f59e0b',
  disconnected: '#ef4444',
};

// ─── TopBar ────────────────────────────────────────────────────────────────────

export class TopBar {
  private container: HTMLElement | null = null;
  private barEl: HTMLElement | null = null;

  // State
  private symbol: string = SYMBOLS[0]!;
  private timeframe: string = TIMEFRAMES[0]!;
  private activeTool: string | null = null;
  private indicators: IndicatorDef[] = DEFAULT_INDICATORS.map((d) => ({ ...d }));
  private connectionStatus: ConnectionStatus = 'disconnected';

  // DOM refs
  private tfButtons: HTMLButtonElement[] = [];
  private toolButtons: HTMLButtonElement[] = [];
  private statusDot: HTMLElement | null = null;
  private indicatorMenu: HTMLDivElement | null = null;
  private hamburgerBtn: HTMLButtonElement | null = null;
  private mobileMenu: HTMLDivElement | null = null;

  // Callbacks
  private symbolChangeCb?: (symbol: string) => void;
  private timeframeChangeCb?: (tf: string) => void;
  private toolSelectCb?: (toolId: string | null) => void;
  private indicatorToggleCb?: (id: string, enabled: boolean) => void;
  private settingsClickCb?: () => void;

  // ── Public API ───────────────────────────────────────────────────────────

  create(container: HTMLElement): void {
    this.container = container;
    this.buildDOM();
  }

  onSymbolChange(cb: (symbol: string) => void): void {
    this.symbolChangeCb = cb;
  }

  onTimeframeChange(cb: (tf: string) => void): void {
    this.timeframeChangeCb = cb;
  }

  onToolSelect(cb: (toolId: string | null) => void): void {
    this.toolSelectCb = cb;
  }

  onIndicatorToggle(cb: (id: string, enabled: boolean) => void): void {
    this.indicatorToggleCb = cb;
  }

  onSettingsClick(cb: () => void): void {
    this.settingsClickCb = cb;
  }

  setConnectionStatus(status: ConnectionStatus): void {
    this.connectionStatus = status;
    if (this.statusDot) {
      this.statusDot.style.background = STATUS_COLORS[status];
      this.statusDot.title = `Connection: ${status}`;
    }
  }

  destroy(): void {
    if (this.barEl && this.container) {
      this.container.removeChild(this.barEl);
    }
    // Close indicator menu if open
    this.closeIndicatorMenu();
    this.closeMobileMenu();
    document.removeEventListener('click', this.handleDocumentClick);
    this.barEl = null;
    this.container = null;
    this.tfButtons = [];
    this.toolButtons = [];
    this.statusDot = null;
  }

  // ── DOM Construction ─────────────────────────────────────────────────────

  private buildDOM(): void {
    if (!this.container) return;

    this.barEl = document.createElement('header');
    this.barEl.className = 'top-bar';

    // ── Left section ───────────────────────────────────────────────
    const left = document.createElement('div');
    left.className = 'top-bar__left';

    // Logo
    const logo = document.createElement('div');
    logo.className = 'logo';
    logo.textContent = 'Pinned';
    left.appendChild(logo);

    // Symbol selector
    const symbolWrapper = document.createElement('div');
    symbolWrapper.className = 'symbol-selector';
    const select = document.createElement('select');
    select.className = 'symbol-select';
    select.id = 'topbar-symbol-select';
    for (const sym of SYMBOLS) {
      const opt = document.createElement('option');
      opt.value = sym;
      opt.textContent = sym;
      if (sym === this.symbol) opt.selected = true;
      select.appendChild(opt);
    }
    select.addEventListener('change', () => {
      this.symbol = select.value;
      this.symbolChangeCb?.(this.symbol);
    });
    symbolWrapper.appendChild(select);
    left.appendChild(symbolWrapper);

    // Timeframe buttons
    const tfGroup = document.createElement('div');
    tfGroup.className = 'timeframe-group';
    for (const tf of TIMEFRAMES) {
      const btn = document.createElement('button');
      btn.className = `tf-btn${tf === this.timeframe ? ' active' : ''}`;
      btn.textContent = tf;
      btn.dataset.tf = tf;
      btn.addEventListener('click', () => this.selectTimeframe(tf));
      tfGroup.appendChild(btn);
      this.tfButtons.push(btn);
    }
    left.appendChild(tfGroup);

    this.barEl.appendChild(left);

    // ── Center section ─────────────────────────────────────────────
    const center = document.createElement('div');
    center.className = 'top-bar__center';

    // Drawing tools
    const toolGroup = document.createElement('div');
    toolGroup.className = 'drawing-tools';
    for (const dt of DRAWING_TOOLS) {
      const btn = document.createElement('button');
      btn.className = 'tool-btn';
      btn.dataset.tool = dt.id;
      btn.title = `${dt.label} (${dt.shortcut})`;
      btn.innerHTML = `<span class="tool-icon">${dt.icon}</span>`;
      btn.addEventListener('click', () => this.toggleTool(dt.id));
      toolGroup.appendChild(btn);
      this.toolButtons.push(btn);
    }
    center.appendChild(toolGroup);
    this.barEl.appendChild(center);

    // ── Right section ──────────────────────────────────────────────
    const right = document.createElement('div');
    right.className = 'top-bar__right';

    // Indicator toggle button
    const indicatorBtn = document.createElement('button');
    indicatorBtn.className = 'icon-btn';
    indicatorBtn.title = 'Indicators';
    indicatorBtn.innerHTML = '<span>📊</span>';
    indicatorBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggleIndicatorMenu(indicatorBtn);
    });
    right.appendChild(indicatorBtn);

    // Settings button
    const settingsBtn = document.createElement('button');
    settingsBtn.className = 'icon-btn';
    settingsBtn.title = 'Settings';
    settingsBtn.innerHTML = '<span>⚙</span>';
    settingsBtn.addEventListener('click', () => this.settingsClickCb?.());
    right.appendChild(settingsBtn);

    // Connection status dot
    this.statusDot = document.createElement('div');
    Object.assign(this.statusDot.style, {
      width: '8px',
      height: '8px',
      borderRadius: '50%',
      background: STATUS_COLORS[this.connectionStatus],
      flexShrink: '0',
      transition: 'background 300ms ease',
    } as Partial<CSSStyleDeclaration>);
    this.statusDot.title = `Connection: ${this.connectionStatus}`;
    right.appendChild(this.statusDot);

    this.barEl.appendChild(right);

    // ── Hamburger for mobile ───────────────────────────────────────
    this.hamburgerBtn = document.createElement('button');
    Object.assign(this.hamburgerBtn.style, {
      appearance: 'none',
      border: 'none',
      background: 'transparent',
      color: '#e5e7eb',
      fontSize: '20px',
      cursor: 'pointer',
      display: 'none',
      padding: '4px',
      lineHeight: '1',
    } as Partial<CSSStyleDeclaration>);
    this.hamburgerBtn.textContent = '☰';
    this.hamburgerBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggleMobileMenu();
    });
    this.barEl.insertBefore(this.hamburgerBtn, this.barEl.firstChild);

    // Apply responsive media query via style injection
    this.injectResponsiveStyles();

    // Close menus on outside click
    document.addEventListener('click', this.handleDocumentClick);

    this.container.appendChild(this.barEl);
  }

  // ── Interactions ─────────────────────────────────────────────────────────

  private selectTimeframe(tf: string): void {
    this.timeframe = tf;
    for (const btn of this.tfButtons) {
      btn.classList.toggle('active', btn.dataset.tf === tf);
    }
    this.timeframeChangeCb?.(tf);
  }

  private toggleTool(toolId: string): void {
    this.activeTool = this.activeTool === toolId ? null : toolId;
    for (const btn of this.toolButtons) {
      btn.classList.toggle('active', btn.dataset.tool === this.activeTool);
    }
    this.toolSelectCb?.(this.activeTool);
  }

  // ── Indicator Menu ───────────────────────────────────────────────────────

  private toggleIndicatorMenu(anchor: HTMLElement): void {
    if (this.indicatorMenu) {
      this.closeIndicatorMenu();
      return;
    }

    this.indicatorMenu = document.createElement('div');
    Object.assign(this.indicatorMenu.style, {
      position: 'absolute',
      top: '100%',
      right: '0',
      marginTop: '4px',
      background: '#111827',
      border: '1px solid #374151',
      borderRadius: '6px',
      padding: '6px 0',
      minWidth: '200px',
      boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
      zIndex: '300',
      animation: 'fadeIn 150ms ease',
    } as Partial<CSSStyleDeclaration>);

    for (const ind of this.indicators) {
      const row = document.createElement('label');
      Object.assign(row.style, {
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        padding: '6px 14px',
        cursor: 'pointer',
        fontSize: '13px',
        color: '#e5e7eb',
        transition: 'background 150ms ease',
        userSelect: 'none',
      } as Partial<CSSStyleDeclaration>);
      row.addEventListener('mouseenter', () => { row.style.background = '#1f2937'; });
      row.addEventListener('mouseleave', () => { row.style.background = 'transparent'; });

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = ind.enabled;
      Object.assign(checkbox.style, {
        accentColor: '#6366f1',
        width: '14px',
        height: '14px',
        cursor: 'pointer',
      } as Partial<CSSStyleDeclaration>);
      checkbox.addEventListener('change', () => {
        ind.enabled = checkbox.checked;
        this.indicatorToggleCb?.(ind.id, ind.enabled);
      });

      const label = document.createElement('span');
      label.textContent = ind.label;

      row.appendChild(checkbox);
      row.appendChild(label);
      this.indicatorMenu.appendChild(row);
    }

    // Position relative to anchor
    anchor.style.position = 'relative';
    anchor.appendChild(this.indicatorMenu);
  }

  private closeIndicatorMenu(): void {
    if (this.indicatorMenu) {
      this.indicatorMenu.remove();
      this.indicatorMenu = null;
    }
  }

  // ── Mobile Menu ──────────────────────────────────────────────────────────

  private toggleMobileMenu(): void {
    if (this.mobileMenu) {
      this.closeMobileMenu();
      return;
    }

    this.mobileMenu = document.createElement('div');
    Object.assign(this.mobileMenu.style, {
      position: 'absolute',
      top: '100%',
      left: '0',
      right: '0',
      background: '#111827',
      borderBottom: '1px solid #374151',
      padding: '12px',
      display: 'flex',
      flexDirection: 'column',
      gap: '10px',
      zIndex: '200',
      animation: 'slideUp 200ms ease',
    } as Partial<CSSStyleDeclaration>);

    // Clone timeframe group
    const tfLabel = document.createElement('div');
    tfLabel.textContent = 'Timeframe';
    Object.assign(tfLabel.style, { fontSize: '11px', color: '#6b7280', fontWeight: '600', textTransform: 'uppercase' });
    this.mobileMenu.appendChild(tfLabel);

    const tfGroup = document.createElement('div');
    tfGroup.style.display = 'flex';
    tfGroup.style.gap = '4px';
    tfGroup.style.flexWrap = 'wrap';
    for (const tf of TIMEFRAMES) {
      const btn = document.createElement('button');
      btn.className = `tf-btn${tf === this.timeframe ? ' active' : ''}`;
      btn.textContent = tf;
      btn.addEventListener('click', () => {
        this.selectTimeframe(tf);
        this.closeMobileMenu();
      });
      tfGroup.appendChild(btn);
    }
    this.mobileMenu.appendChild(tfGroup);

    // Tools
    const toolLabel = document.createElement('div');
    toolLabel.textContent = 'Drawing Tools';
    Object.assign(toolLabel.style, { fontSize: '11px', color: '#6b7280', fontWeight: '600', textTransform: 'uppercase' });
    this.mobileMenu.appendChild(toolLabel);

    const toolGroup = document.createElement('div');
    toolGroup.style.display = 'flex';
    toolGroup.style.gap = '4px';
    for (const dt of DRAWING_TOOLS) {
      const btn = document.createElement('button');
      btn.className = `tool-btn${this.activeTool === dt.id ? ' active' : ''}`;
      btn.innerHTML = `<span class="tool-icon">${dt.icon}</span>`;
      btn.title = dt.label;
      btn.addEventListener('click', () => {
        this.toggleTool(dt.id);
        this.closeMobileMenu();
      });
      toolGroup.appendChild(btn);
    }
    this.mobileMenu.appendChild(toolGroup);

    this.barEl?.appendChild(this.mobileMenu);
  }

  private closeMobileMenu(): void {
    if (this.mobileMenu) {
      this.mobileMenu.remove();
      this.mobileMenu = null;
    }
  }

  // ── Document Click Handler ───────────────────────────────────────────────

  private handleDocumentClick = (): void => {
    this.closeIndicatorMenu();
    this.closeMobileMenu();
  };

  // ── Responsive Style Injection ───────────────────────────────────────────

  private injectResponsiveStyles(): void {
    const styleId = 'pinned-topbar-responsive';
    if (document.getElementById(styleId)) return;

    const style = document.createElement('style');
    style.id = styleId;
    style.textContent = `
      @media (max-width: 768px) {
        .top-bar .top-bar__center,
        .top-bar .timeframe-group {
          display: none !important;
        }
        .top-bar [data-hamburger] {
          display: block !important;
        }
      }
    `;
    document.head.appendChild(style);

    if (this.hamburgerBtn) {
      this.hamburgerBtn.setAttribute('data-hamburger', '');
    }
  }
}
