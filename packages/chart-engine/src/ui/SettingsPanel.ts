/**
 * SettingsPanel.ts
 * Comprehensive settings panel — chart appearance, colors, grid, crosshair,
 * trading preferences, and keyboard shortcut reference.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ChartSettings {
  // Appearance
  theme: 'dark' | 'midnight' | 'light';
  candleUpColor: string;
  candleDownColor: string;
  wickColor: string;
  backgroundColor: string;
  gridColor: string;
  crosshairColor: string;
  crosshairStyle: 'crosshair' | 'dot' | 'line';

  // Grid & axes
  showGrid: boolean;
  showPriceScale: boolean;
  showTimeScale: boolean;
  showVolume: boolean;
  volumeOpacity: number;

  // Behavior
  autoScale: boolean;
  magnet: boolean;
  snapToCandles: boolean;

  // Display
  showHighLow: boolean;
  showOHLC: boolean;
  showChangePercent: boolean;
  showCountdown: boolean;
  showWatermark: boolean;
}

const STORAGE_KEY = 'pinned:settings';

const DEFAULT_SETTINGS: ChartSettings = {
  theme: 'dark',
  candleUpColor: '#22c55e',
  candleDownColor: '#ef4444',
  wickColor: '#4b5563',
  backgroundColor: '#0a0e17',
  gridColor: '#1e293b',
  crosshairColor: '#94a3b8',
  crosshairStyle: 'crosshair',

  showGrid: true,
  showPriceScale: true,
  showTimeScale: true,
  showVolume: true,
  volumeOpacity: 0.3,

  autoScale: true,
  magnet: false,
  snapToCandles: true,

  showHighLow: true,
  showOHLC: true,
  showChangePercent: true,
  showCountdown: false,
  showWatermark: true,
};

// ─── Keyboard shortcuts reference ────────────────────────────────────────────

const SHORTCUTS = [
  { keys: '/', desc: 'Symbol search' },
  { keys: 'Any letter', desc: 'Quick symbol search' },
  { keys: '⌘K', desc: 'Command palette' },
  { keys: 'Esc', desc: 'Deselect tool' },
  { keys: '⌘Z', desc: 'Undo' },
  { keys: '⌘⇧Z', desc: 'Redo' },
  { keys: 'Del', desc: 'Delete drawing' },
  { keys: 'T', desc: 'Trend line' },
  { keys: 'H', desc: 'Horizontal line' },
  { keys: 'V', desc: 'Vertical line' },
  { keys: 'R', desc: 'Ray' },
  { keys: 'F', desc: 'Fibonacci' },
  { keys: 'P', desc: 'Pitchfork' },
  { keys: 'M', desc: 'Measure' },
  { keys: 'J', desc: 'Trade journal' },
  { keys: '⇧R', desc: 'Replay mode' },
  { keys: '⇧S', desc: 'Session stats' },
  { keys: '⇧A', desc: 'Smart alerts' },
  { keys: '⇧C', desc: 'Comparison' },
  { keys: '⌘⇧S', desc: 'Share chart' },
  { keys: '⌘⇧P', desc: 'Screenshot' },
];

// ─── SettingsPanel ───────────────────────────────────────────────────────────

export interface SettingsPanelOptions {
  onSettingsChange?: (settings: ChartSettings) => void;
}

export class SettingsPanel {
  private overlay: HTMLElement | null = null;
  private settings: ChartSettings;
  private opts: SettingsPanelOptions;
  private activeTab = 'appearance';

  constructor(opts: SettingsPanelOptions = {}) {
    this.opts = opts;
    this.settings = this.load();
  }

  getSettings(): ChartSettings { return { ...this.settings }; }

  open(): void {
    if (this.overlay) return;
    this.render();
  }

  close(): void {
    this.overlay?.remove();
    this.overlay = null;
  }

  toggle(): void {
    this.overlay ? this.close() : this.open();
  }

  private render(): void {
    this.overlay = document.createElement('div');
    this.overlay.className = 'settings-overlay';
    this.overlay.addEventListener('mousedown', (e) => {
      if (e.target === this.overlay) this.close();
    });

    const panel = document.createElement('div');
    panel.className = 'settings-panel';

    panel.innerHTML = `
      <div class="settings-header">
        <h2 class="settings-title">Settings</h2>
        <button class="settings-close">&times;</button>
      </div>
      <div class="settings-body">
        <div class="settings-tabs">
          <button class="settings-tab active" data-tab="appearance">Appearance</button>
          <button class="settings-tab" data-tab="trading">Trading</button>
          <button class="settings-tab" data-tab="display">Display</button>
          <button class="settings-tab" data-tab="shortcuts">Shortcuts</button>
        </div>
        <div class="settings-content" id="settingsContent"></div>
      </div>
    `;

    panel.querySelector('.settings-close')!.addEventListener('click', () => this.close());

    // Tab switching
    panel.querySelector('.settings-tabs')!.addEventListener('click', (e) => {
      const tab = (e.target as HTMLElement).closest<HTMLElement>('.settings-tab');
      if (!tab) return;
      this.activeTab = tab.dataset.tab!;
      panel.querySelectorAll('.settings-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      this.renderContent(panel.querySelector('#settingsContent')!);
    });

    // Escape
    const escHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { this.close(); document.removeEventListener('keydown', escHandler); }
    };
    document.addEventListener('keydown', escHandler);

    this.overlay.appendChild(panel);
    document.body.appendChild(this.overlay);
    this.renderContent(panel.querySelector('#settingsContent')!);
  }

  private renderContent(container: HTMLElement): void {
    switch (this.activeTab) {
      case 'appearance': this.renderAppearance(container); break;
      case 'trading': this.renderTrading(container); break;
      case 'display': this.renderDisplay(container); break;
      case 'shortcuts': this.renderShortcuts(container); break;
    }
  }

  private renderAppearance(container: HTMLElement): void {
    container.innerHTML = `
      <div class="settings-section">
        <div class="settings-section-title">Theme</div>
        <div class="settings-theme-grid">
          ${(['dark', 'midnight', 'light'] as const).map(t => `
            <button class="settings-theme-btn${this.settings.theme === t ? ' active' : ''}" data-theme="${t}">
              <div class="settings-theme-preview settings-theme-preview--${t}"></div>
              <span>${t.charAt(0).toUpperCase() + t.slice(1)}</span>
            </button>
          `).join('')}
        </div>
      </div>
      <div class="settings-section">
        <div class="settings-section-title">Candle Colors</div>
        <div class="settings-row">
          <label>Up (Bullish)</label>
          <input type="color" value="${this.settings.candleUpColor}" data-key="candleUpColor"/>
        </div>
        <div class="settings-row">
          <label>Down (Bearish)</label>
          <input type="color" value="${this.settings.candleDownColor}" data-key="candleDownColor"/>
        </div>
        <div class="settings-row">
          <label>Wick</label>
          <input type="color" value="${this.settings.wickColor}" data-key="wickColor"/>
        </div>
      </div>
      <div class="settings-section">
        <div class="settings-section-title">Background & Grid</div>
        <div class="settings-row">
          <label>Background</label>
          <input type="color" value="${this.settings.backgroundColor}" data-key="backgroundColor"/>
        </div>
        <div class="settings-row">
          <label>Grid Lines</label>
          <input type="color" value="${this.settings.gridColor}" data-key="gridColor"/>
        </div>
        <div class="settings-row">
          <label>Crosshair</label>
          <input type="color" value="${this.settings.crosshairColor}" data-key="crosshairColor"/>
        </div>
      </div>
    `;

    container.querySelectorAll('input[type="color"]').forEach(input => {
      input.addEventListener('change', (e) => {
        const key = (e.target as HTMLInputElement).dataset.key as keyof ChartSettings;
        (this.settings as any)[key] = (e.target as HTMLInputElement).value;
        this.save();
      });
    });

    container.querySelectorAll('.settings-theme-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        this.settings.theme = (btn as HTMLElement).dataset.theme as any;
        this.save();
        this.renderContent(container);
      });
    });
  }

  private renderTrading(container: HTMLElement): void {
    container.innerHTML = `
      <div class="settings-section">
        <div class="settings-section-title">Chart Behavior</div>
        ${this.toggleRow('Auto-scale price axis', 'autoScale')}
        ${this.toggleRow('Magnet mode (snap to OHLC)', 'magnet')}
        ${this.toggleRow('Snap drawings to candles', 'snapToCandles')}
      </div>
      <div class="settings-section">
        <div class="settings-section-title">Crosshair</div>
        <div class="settings-row">
          <label>Style</label>
          <select data-key="crosshairStyle" class="settings-select">
            <option value="crosshair" ${this.settings.crosshairStyle === 'crosshair' ? 'selected' : ''}>Full Crosshair</option>
            <option value="dot" ${this.settings.crosshairStyle === 'dot' ? 'selected' : ''}>Dot</option>
            <option value="line" ${this.settings.crosshairStyle === 'line' ? 'selected' : ''}>Line Only</option>
          </select>
        </div>
      </div>
    `;
    this.wireToggles(container);
    container.querySelectorAll('.settings-select').forEach(sel => {
      sel.addEventListener('change', (e) => {
        const key = (e.target as HTMLSelectElement).dataset.key as keyof ChartSettings;
        (this.settings as any)[key] = (e.target as HTMLSelectElement).value;
        this.save();
      });
    });
  }

  private renderDisplay(container: HTMLElement): void {
    container.innerHTML = `
      <div class="settings-section">
        <div class="settings-section-title">Overlays</div>
        ${this.toggleRow('Show grid', 'showGrid')}
        ${this.toggleRow('Show price scale', 'showPriceScale')}
        ${this.toggleRow('Show time scale', 'showTimeScale')}
        ${this.toggleRow('Show volume bars', 'showVolume')}
      </div>
      <div class="settings-section">
        <div class="settings-section-title">Volume</div>
        <div class="settings-row">
          <label>Opacity</label>
          <input type="range" min="0" max="100" value="${Math.round(this.settings.volumeOpacity * 100)}" data-key="volumeOpacity" class="settings-range"/>
          <span class="settings-range-value">${Math.round(this.settings.volumeOpacity * 100)}%</span>
        </div>
      </div>
      <div class="settings-section">
        <div class="settings-section-title">Information</div>
        ${this.toggleRow('Show high/low markers', 'showHighLow')}
        ${this.toggleRow('Show OHLC values', 'showOHLC')}
        ${this.toggleRow('Show % change', 'showChangePercent')}
        ${this.toggleRow('Show candle countdown', 'showCountdown')}
        ${this.toggleRow('Show watermark', 'showWatermark')}
      </div>
    `;
    this.wireToggles(container);

    container.querySelectorAll('input[type="range"]').forEach(range => {
      range.addEventListener('input', (e) => {
        const val = Number((e.target as HTMLInputElement).value);
        this.settings.volumeOpacity = val / 100;
        const span = (e.target as HTMLElement).nextElementSibling;
        if (span) span.textContent = `${val}%`;
        this.save();
      });
    });
  }

  private renderShortcuts(container: HTMLElement): void {
    container.innerHTML = `
      <div class="settings-section">
        <div class="settings-section-title">Keyboard Shortcuts</div>
        <div class="settings-shortcuts-grid">
          ${SHORTCUTS.map(s => `
            <div class="settings-shortcut-row">
              <kbd class="settings-kbd">${s.keys}</kbd>
              <span class="settings-shortcut-desc">${s.desc}</span>
            </div>
          `).join('')}
        </div>
      </div>
    `;
  }

  private toggleRow(label: string, key: keyof ChartSettings): string {
    const checked = this.settings[key] ? 'checked' : '';
    return `
      <div class="settings-row">
        <label>${label}</label>
        <label class="settings-switch">
          <input type="checkbox" data-key="${key}" ${checked}/>
          <span class="settings-switch-track"><span class="settings-switch-thumb"></span></span>
        </label>
      </div>
    `;
  }

  private wireToggles(container: HTMLElement): void {
    container.querySelectorAll('input[type="checkbox"]').forEach(cb => {
      cb.addEventListener('change', (e) => {
        const key = (e.target as HTMLInputElement).dataset.key as keyof ChartSettings;
        (this.settings as any)[key] = (e.target as HTMLInputElement).checked;
        this.save();
      });
    });
  }

  private save(): void {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(this.settings)); } catch {}
    this.opts.onSettingsChange?.(this.settings);
  }

  private load(): ChartSettings {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
    } catch {}
    return { ...DEFAULT_SETTINGS };
  }
}
