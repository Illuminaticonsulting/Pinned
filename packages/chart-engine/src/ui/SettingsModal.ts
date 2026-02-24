/**
 * SettingsModal — Application settings modal.
 *
 * Sections: Theme, Chart, Orderflow, Connection, Account.
 * Saves to localStorage and optionally syncs to server.
 */

// ─── Types ─────────────────────────────────────────────────────────────────────

export type ThemePreset = 'dark' | 'midnight' | 'abyss';
export type CandleStyle = 'candlestick' | 'bar' | 'hollow';
export type FootprintMode = 'bid-ask' | 'delta' | 'volume';

export interface SettingsData {
  theme: {
    preset: ThemePreset;
  };
  chart: {
    candleStyle: CandleStyle;
    gridOpacity: number;    // 0-100
    fontSize: number;       // 10-18
  };
  orderflow: {
    footprintMode: FootprintMode;
    imbalanceRatio: number;  // e.g. 3.0
    bigTradeSize: number;    // USD threshold
  };
  connection: {
    exchange: string;
    symbols: string[];
  };
  account: {
    displayName: string;
    email: string;
    linkedExchanges: string[];
    loggedIn: boolean;
  };
}

// ─── Constants ─────────────────────────────────────────────────────────────────

const STORAGE_KEY = 'pinned_settings';

const THEME_PRESETS: { value: ThemePreset; label: string; bg: string }[] = [
  { value: 'dark', label: 'Dark', bg: '#111827' },
  { value: 'midnight', label: 'Midnight', bg: '#0f172a' },
  { value: 'abyss', label: 'Abyss', bg: '#020617' },
];

const CANDLE_STYLES: { value: CandleStyle; label: string }[] = [
  { value: 'candlestick', label: 'Candlestick' },
  { value: 'bar', label: 'Bar' },
  { value: 'hollow', label: 'Hollow' },
];

const FOOTPRINT_MODES: { value: FootprintMode; label: string }[] = [
  { value: 'bid-ask', label: 'Bid / Ask' },
  { value: 'delta', label: 'Delta' },
  { value: 'volume', label: 'Volume' },
];

const defaultSettings: SettingsData = {
  theme: { preset: 'dark' },
  chart: { candleStyle: 'candlestick', gridOpacity: 30, fontSize: 13 },
  orderflow: { footprintMode: 'bid-ask', imbalanceRatio: 3.0, bigTradeSize: 50000 },
  connection: { exchange: 'Binance', symbols: ['BTC-USDT', 'ETH-USDT'] },
  account: { displayName: '', email: '', linkedExchanges: [], loggedIn: false },
};

// ─── SettingsModal ─────────────────────────────────────────────────────────────

export class SettingsModal {
  private overlayEl: HTMLDivElement | null = null;
  private modalEl: HTMLDivElement | null = null;
  private settings: SettingsData;
  private saveCb?: (settings: SettingsData) => void;

  constructor() {
    this.settings = this.loadFromStorage();
  }

  // ── Public API ───────────────────────────────────────────────────────────

  show(): void {
    if (this.overlayEl) this.hide();
    this.settings = this.loadFromStorage();
    this.buildDOM();

    requestAnimationFrame(() => {
      if (this.overlayEl) this.overlayEl.style.opacity = '1';
      if (this.modalEl) {
        this.modalEl.style.transform = 'translateY(0)';
        this.modalEl.style.opacity = '1';
      }
    });
  }

  hide(): void {
    if (this.overlayEl) {
      this.overlayEl.style.opacity = '0';
      if (this.modalEl) {
        this.modalEl.style.transform = 'translateY(12px)';
        this.modalEl.style.opacity = '0';
      }
      setTimeout(() => {
        this.overlayEl?.remove();
        this.overlayEl = null;
        this.modalEl = null;
      }, 200);
    }
  }

  onSave(cb: (settings: SettingsData) => void): void {
    this.saveCb = cb;
  }

  getSettings(): SettingsData {
    return { ...this.settings };
  }

  // ── DOM Construction ─────────────────────────────────────────────────────

  private buildDOM(): void {
    // Overlay
    this.overlayEl = document.createElement('div');
    this.overlayEl.className = 'modal-overlay';
    Object.assign(this.overlayEl.style, {
      opacity: '0',
      transition: 'opacity 200ms ease',
    });
    this.overlayEl.addEventListener('click', (e) => {
      if (e.target === this.overlayEl) this.hide();
    });

    // Modal
    this.modalEl = document.createElement('div');
    this.modalEl.className = 'modal';
    Object.assign(this.modalEl.style, {
      transform: 'translateY(12px)',
      opacity: '0',
      transition: 'transform 200ms ease, opacity 200ms ease',
      maxWidth: '520px',
      maxHeight: '85vh',
    });

    // Header
    const header = document.createElement('div');
    header.className = 'modal__header';
    const headerTitle = document.createElement('div');
    headerTitle.className = 'modal__title';
    headerTitle.textContent = 'Settings';
    header.appendChild(headerTitle);
    const closeBtn = document.createElement('button');
    closeBtn.className = 'modal__close';
    closeBtn.textContent = '✕';
    closeBtn.addEventListener('click', () => this.hide());
    header.appendChild(closeBtn);
    this.modalEl.appendChild(header);

    // Body
    const body = document.createElement('div');
    body.className = 'modal__body';
    Object.assign(body.style, {
      display: 'flex',
      flexDirection: 'column',
      gap: '20px',
    });

    body.appendChild(this.buildThemeSection());
    body.appendChild(this.buildChartSection());
    body.appendChild(this.buildOrderflowSection());
    body.appendChild(this.buildConnectionSection());
    body.appendChild(this.buildAccountSection());

    this.modalEl.appendChild(body);

    // Footer
    const footer = document.createElement('div');
    footer.className = 'modal__footer';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn btn--secondary';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', () => this.hide());
    footer.appendChild(cancelBtn);

    const saveBtn = document.createElement('button');
    saveBtn.className = 'btn btn--primary';
    saveBtn.textContent = 'Save';
    saveBtn.addEventListener('click', () => this.handleSave());
    footer.appendChild(saveBtn);

    this.modalEl.appendChild(footer);

    this.overlayEl.appendChild(this.modalEl);
    document.body.appendChild(this.overlayEl);

    // ESC to close
    const escHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        this.hide();
        document.removeEventListener('keydown', escHandler);
      }
    };
    document.addEventListener('keydown', escHandler);
  }

  // ── Sections ─────────────────────────────────────────────────────────────

  private buildThemeSection(): HTMLElement {
    const section = this.createSection('Theme');

    const presetRow = document.createElement('div');
    Object.assign(presetRow.style, { display: 'flex', gap: '8px' });

    for (const preset of THEME_PRESETS) {
      const btn = document.createElement('button');
      Object.assign(btn.style, {
        flex: '1',
        padding: '10px',
        background: preset.bg,
        border: `2px solid ${this.settings.theme.preset === preset.value ? '#6366f1' : '#374151'}`,
        borderRadius: '6px',
        color: '#e5e7eb',
        fontSize: '12px',
        fontWeight: '500',
        cursor: 'pointer',
        transition: 'border-color 150ms ease',
        textAlign: 'center',
        fontFamily: 'Inter, sans-serif',
      } as Partial<CSSStyleDeclaration>);
      btn.textContent = preset.label;
      btn.addEventListener('click', () => {
        this.settings.theme.preset = preset.value;
        presetRow.querySelectorAll('button').forEach((b) => {
          (b as HTMLElement).style.borderColor = '#374151';
        });
        btn.style.borderColor = '#6366f1';
      });
      presetRow.appendChild(btn);
    }

    section.appendChild(presetRow);
    return section;
  }

  private buildChartSection(): HTMLElement {
    const section = this.createSection('Chart');

    // Candle style
    const styleSelect = this.createSelect('Candle Style', CANDLE_STYLES, this.settings.chart.candleStyle);
    styleSelect.querySelector('select')!.addEventListener('change', (e) => {
      this.settings.chart.candleStyle = (e.target as HTMLSelectElement).value as CandleStyle;
    });
    section.appendChild(styleSelect);

    // Grid opacity slider
    section.appendChild(this.createSlider('Grid Opacity', 0, 100, this.settings.chart.gridOpacity, (v) => {
      this.settings.chart.gridOpacity = v;
    }));

    // Font size
    section.appendChild(this.createSlider('Font Size', 10, 18, this.settings.chart.fontSize, (v) => {
      this.settings.chart.fontSize = v;
    }));

    return section;
  }

  private buildOrderflowSection(): HTMLElement {
    const section = this.createSection('Orderflow');

    // Footprint mode
    const modeSelect = this.createSelect('Footprint Mode', FOOTPRINT_MODES, this.settings.orderflow.footprintMode);
    modeSelect.querySelector('select')!.addEventListener('change', (e) => {
      this.settings.orderflow.footprintMode = (e.target as HTMLSelectElement).value as FootprintMode;
    });
    section.appendChild(modeSelect);

    // Imbalance ratio
    section.appendChild(this.createNumberInput('Imbalance Ratio', this.settings.orderflow.imbalanceRatio, 0.5, 20, 0.5, (v) => {
      this.settings.orderflow.imbalanceRatio = v;
    }));

    // Big trade size threshold
    section.appendChild(this.createNumberInput('Big Trade Size ($)', this.settings.orderflow.bigTradeSize, 1000, 10_000_000, 1000, (v) => {
      this.settings.orderflow.bigTradeSize = v;
    }));

    return section;
  }

  private buildConnectionSection(): HTMLElement {
    const section = this.createSection('Connection');

    // Exchange display
    const exchangeRow = document.createElement('div');
    Object.assign(exchangeRow.style, { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' });

    const exchangeLabel = document.createElement('span');
    Object.assign(exchangeLabel.style, { fontSize: '12px', color: '#9ca3af' });
    exchangeLabel.textContent = 'Exchange:';
    exchangeRow.appendChild(exchangeLabel);

    const exchangeValue = document.createElement('span');
    Object.assign(exchangeValue.style, { fontSize: '13px', color: '#e5e7eb', fontWeight: '500' });
    exchangeValue.textContent = this.settings.connection.exchange;
    exchangeRow.appendChild(exchangeValue);

    section.appendChild(exchangeRow);

    // Symbols
    const symbolLabel = document.createElement('div');
    Object.assign(symbolLabel.style, { fontSize: '12px', color: '#9ca3af', marginBottom: '4px' });
    symbolLabel.textContent = 'Symbols:';
    section.appendChild(symbolLabel);

    const symbolText = document.createElement('div');
    Object.assign(symbolText.style, {
      fontSize: '12px',
      color: '#e5e7eb',
      background: '#0a0e17',
      padding: '6px 8px',
      borderRadius: '4px',
      border: '1px solid #374151',
      marginBottom: '8px',
    });
    symbolText.textContent = this.settings.connection.symbols.join(', ');
    section.appendChild(symbolText);

    // Reconnect button
    const reconnectBtn = document.createElement('button');
    reconnectBtn.className = 'btn btn--secondary btn--sm';
    reconnectBtn.textContent = 'Reconnect';
    reconnectBtn.addEventListener('click', () => {
      reconnectBtn.textContent = 'Reconnecting…';
      reconnectBtn.disabled = true;
      setTimeout(() => {
        reconnectBtn.textContent = 'Reconnect';
        reconnectBtn.disabled = false;
      }, 2000);
    });
    section.appendChild(reconnectBtn);

    return section;
  }

  private buildAccountSection(): HTMLElement {
    const section = this.createSection('Account');

    if (!this.settings.account.loggedIn) {
      const msg = document.createElement('div');
      Object.assign(msg.style, { fontSize: '12px', color: '#6b7280', fontStyle: 'italic' });
      msg.textContent = 'Not logged in. Sign in to sync settings across devices.';
      section.appendChild(msg);
      return section;
    }

    // Display name
    section.appendChild(this.createTextInput('Display Name', this.settings.account.displayName, (v) => {
      this.settings.account.displayName = v;
    }));

    // Email (read-only)
    const emailGroup = document.createElement('div');
    Object.assign(emailGroup.style, { display: 'flex', flexDirection: 'column', gap: '4px' });

    const emailLabel = document.createElement('label');
    Object.assign(emailLabel.style, {
      fontSize: '12px', fontWeight: '600', color: '#9ca3af',
      textTransform: 'uppercase', letterSpacing: '0.03em',
    });
    emailLabel.textContent = 'Email';
    emailGroup.appendChild(emailLabel);

    const emailInput = document.createElement('input');
    emailInput.className = 'input';
    emailInput.value = this.settings.account.email;
    emailInput.readOnly = true;
    emailInput.style.opacity = '0.6';
    emailInput.style.cursor = 'not-allowed';
    emailGroup.appendChild(emailInput);
    section.appendChild(emailGroup);

    // Linked exchanges
    if (this.settings.account.linkedExchanges.length > 0) {
      const exchLabel = document.createElement('div');
      Object.assign(exchLabel.style, { fontSize: '12px', color: '#9ca3af', marginTop: '8px' });
      exchLabel.textContent = 'Linked Exchanges:';
      section.appendChild(exchLabel);

      const exchList = document.createElement('div');
      Object.assign(exchList.style, { fontSize: '12px', color: '#e5e7eb' });
      exchList.textContent = this.settings.account.linkedExchanges.join(', ');
      section.appendChild(exchList);
    }

    // Logout button
    const logoutBtn = document.createElement('button');
    logoutBtn.className = 'btn btn--danger btn--sm';
    logoutBtn.textContent = 'Logout';
    logoutBtn.style.marginTop = '8px';
    logoutBtn.addEventListener('click', () => {
      this.settings.account.loggedIn = false;
      this.hide();
    });
    section.appendChild(logoutBtn);

    return section;
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private createSection(title: string): HTMLDivElement {
    const section = document.createElement('div');
    Object.assign(section.style, {
      display: 'flex',
      flexDirection: 'column',
      gap: '10px',
    });

    const heading = document.createElement('div');
    Object.assign(heading.style, {
      fontSize: '13px',
      fontWeight: '700',
      color: '#e5e7eb',
      paddingBottom: '4px',
      borderBottom: '1px solid #1f2937',
    });
    heading.textContent = title;
    section.appendChild(heading);

    return section;
  }

  private createSelect(
    label: string,
    options: { value: string; label: string }[],
    current: string,
  ): HTMLDivElement {
    const group = document.createElement('div');
    Object.assign(group.style, { display: 'flex', flexDirection: 'column', gap: '4px' });

    const labelEl = document.createElement('label');
    Object.assign(labelEl.style, {
      fontSize: '12px', fontWeight: '600', color: '#9ca3af',
      textTransform: 'uppercase', letterSpacing: '0.03em',
    });
    labelEl.textContent = label;
    group.appendChild(labelEl);

    const select = document.createElement('select');
    select.className = 'select';
    for (const opt of options) {
      const o = document.createElement('option');
      o.value = opt.value;
      o.textContent = opt.label;
      if (opt.value === current) o.selected = true;
      select.appendChild(o);
    }
    group.appendChild(select);

    return group;
  }

  private createSlider(
    label: string,
    min: number,
    max: number,
    current: number,
    onChange: (v: number) => void,
  ): HTMLDivElement {
    const group = document.createElement('div');
    Object.assign(group.style, { display: 'flex', flexDirection: 'column', gap: '4px' });

    const row = document.createElement('div');
    Object.assign(row.style, { display: 'flex', justifyContent: 'space-between', alignItems: 'center' });

    const labelEl = document.createElement('label');
    Object.assign(labelEl.style, {
      fontSize: '12px', fontWeight: '600', color: '#9ca3af',
      textTransform: 'uppercase', letterSpacing: '0.03em',
    });
    labelEl.textContent = label;

    const valueEl = document.createElement('span');
    Object.assign(valueEl.style, { fontSize: '12px', color: '#e5e7eb', fontWeight: '500' });
    valueEl.textContent = current.toString();

    row.appendChild(labelEl);
    row.appendChild(valueEl);
    group.appendChild(row);

    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = min.toString();
    slider.max = max.toString();
    slider.value = current.toString();
    Object.assign(slider.style, {
      width: '100%',
      accentColor: '#6366f1',
      cursor: 'pointer',
    });
    slider.addEventListener('input', () => {
      const v = parseInt(slider.value, 10);
      valueEl.textContent = v.toString();
      onChange(v);
    });
    group.appendChild(slider);

    return group;
  }

  private createNumberInput(
    label: string,
    current: number,
    min: number,
    max: number,
    step: number,
    onChange: (v: number) => void,
  ): HTMLDivElement {
    const group = document.createElement('div');
    Object.assign(group.style, { display: 'flex', flexDirection: 'column', gap: '4px' });

    const labelEl = document.createElement('label');
    Object.assign(labelEl.style, {
      fontSize: '12px', fontWeight: '600', color: '#9ca3af',
      textTransform: 'uppercase', letterSpacing: '0.03em',
    });
    labelEl.textContent = label;
    group.appendChild(labelEl);

    const input = document.createElement('input');
    input.className = 'input';
    input.type = 'number';
    input.min = min.toString();
    input.max = max.toString();
    input.step = step.toString();
    input.value = current.toString();
    input.addEventListener('input', () => {
      onChange(parseFloat(input.value) || 0);
    });
    group.appendChild(input);

    return group;
  }

  private createTextInput(
    label: string,
    current: string,
    onChange: (v: string) => void,
  ): HTMLDivElement {
    const group = document.createElement('div');
    Object.assign(group.style, { display: 'flex', flexDirection: 'column', gap: '4px' });

    const labelEl = document.createElement('label');
    Object.assign(labelEl.style, {
      fontSize: '12px', fontWeight: '600', color: '#9ca3af',
      textTransform: 'uppercase', letterSpacing: '0.03em',
    });
    labelEl.textContent = label;
    group.appendChild(labelEl);

    const input = document.createElement('input');
    input.className = 'input';
    input.type = 'text';
    input.value = current;
    input.addEventListener('input', () => {
      onChange(input.value);
    });
    group.appendChild(input);

    return group;
  }

  // ── Save / Load ──────────────────────────────────────────────────────────

  private handleSave(): void {
    this.saveToStorage();
    this.saveCb?.(this.settings);
    this.hide();
  }

  private saveToStorage(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.settings));
    } catch {
      console.warn('[Settings] Failed to save to localStorage');
    }
  }

  private loadFromStorage(): SettingsData {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        return this.mergeDefaults(parsed);
      }
    } catch {
      console.warn('[Settings] Failed to load from localStorage');
    }
    return { ...defaultSettings };
  }

  private mergeDefaults(partial: Partial<SettingsData>): SettingsData {
    return {
      theme: { ...defaultSettings.theme, ...partial.theme },
      chart: { ...defaultSettings.chart, ...partial.chart },
      orderflow: { ...defaultSettings.orderflow, ...partial.orderflow },
      connection: { ...defaultSettings.connection, ...partial.connection },
      account: { ...defaultSettings.account, ...partial.account },
    };
  }
}
