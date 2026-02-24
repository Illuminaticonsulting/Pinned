/**
 * HotkeyMacros.ts
 * Record a macro: Ctrl+1 = "Add EMA 9, EMA 21, VWAP, horizontal line at
 * last high, set alert at last high." One keystroke deploys full setup.
 * Basically scripting without coding.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export type MacroAction =
  | { type: 'set_tool'; tool: string }
  | { type: 'toggle_panel'; panel: string; enabled: boolean }
  | { type: 'set_timeframe'; timeframe: string }
  | { type: 'set_symbol'; symbol: string }
  | { type: 'add_indicator'; indicator: string; params?: Record<string, number> }
  | { type: 'draw_hline'; price: number | 'last_high' | 'last_low' | 'last_close' }
  | { type: 'set_alert'; price: number | 'last_high' | 'last_low' | 'last_close' }
  | { type: 'custom'; label: string; callback: string };  // callback = registered action ID

export interface MacroDefinition {
  id: string;
  name: string;
  description?: string;
  hotkey: string;            // e.g. 'Ctrl+1', 'Ctrl+Shift+B'
  actions: MacroAction[];
  createdAt: number;
}

export type MacroExecutor = (action: MacroAction) => void;

// ─── Constants ───────────────────────────────────────────────────────────────

const STORAGE_KEY = 'pinned_macros';

// ─── Preset Macros ───────────────────────────────────────────────────────────

const PRESET_MACROS: MacroDefinition[] = [
  {
    id: 'preset_scalp_setup',
    name: 'Scalp Setup',
    description: 'EMA 9 + EMA 21 + VWAP + Footprint — ideal for scalping',
    hotkey: 'Ctrl+1',
    actions: [
      { type: 'add_indicator', indicator: 'ema', params: { period: 9 } },
      { type: 'add_indicator', indicator: 'ema', params: { period: 21 } },
      { type: 'add_indicator', indicator: 'vwap' },
      { type: 'toggle_panel', panel: 'footprint', enabled: true },
    ],
    createdAt: Date.now(),
  },
  {
    id: 'preset_swing_setup',
    name: 'Swing Setup',
    description: 'EMA 50 + EMA 200 + Volume Profile + Daily timeframe',
    hotkey: 'Ctrl+2',
    actions: [
      { type: 'set_timeframe', timeframe: '4h' },
      { type: 'add_indicator', indicator: 'ema', params: { period: 50 } },
      { type: 'add_indicator', indicator: 'ema', params: { period: 200 } },
      { type: 'toggle_panel', panel: 'volumeProfile', enabled: true },
    ],
    createdAt: Date.now(),
  },
  {
    id: 'preset_orderflow_setup',
    name: 'Orderflow Setup',
    description: 'Footprint + Heatmap + DOM — full orderflow view',
    hotkey: 'Ctrl+3',
    actions: [
      { type: 'toggle_panel', panel: 'footprint', enabled: true },
      { type: 'toggle_panel', panel: 'heatmap', enabled: true },
      { type: 'toggle_panel', panel: 'orderbook', enabled: true },
    ],
    createdAt: Date.now(),
  },
  {
    id: 'preset_clean_chart',
    name: 'Clean Chart',
    description: 'Remove all overlays — just candles and price',
    hotkey: 'Ctrl+0',
    actions: [
      { type: 'toggle_panel', panel: 'footprint', enabled: false },
      { type: 'toggle_panel', panel: 'heatmap', enabled: false },
      { type: 'toggle_panel', panel: 'orderbook', enabled: false },
      { type: 'toggle_panel', panel: 'volumeProfile', enabled: false },
      { type: 'toggle_panel', panel: 'patterns', enabled: false },
    ],
    createdAt: Date.now(),
  },
];

// ─── HotkeyMacros ────────────────────────────────────────────────────────────

export class HotkeyMacros {
  private macros: Map<string, MacroDefinition> = new Map();
  private executor: MacroExecutor;
  private keyHandler: (e: KeyboardEvent) => void;
  private overlay: HTMLElement | null = null;
  private isEditorOpen = false;

  constructor(executor: MacroExecutor) {
    this.executor = executor;
    this.loadMacros();

    // Load presets if no custom macros exist
    if (this.macros.size === 0) {
      for (const preset of PRESET_MACROS) {
        this.macros.set(preset.id, preset);
      }
      this.saveMacros();
    }

    // Global key handler
    this.keyHandler = (e: KeyboardEvent) => this.handleKey(e);
    document.addEventListener('keydown', this.keyHandler);
  }

  // ── Public API ─────────────────────────────────────────────────────────

  getMacros(): MacroDefinition[] {
    return [...this.macros.values()];
  }

  addMacro(macro: MacroDefinition): void {
    this.macros.set(macro.id, macro);
    this.saveMacros();
  }

  removeMacro(id: string): void {
    this.macros.delete(id);
    this.saveMacros();
  }

  executeMacro(id: string): void {
    const macro = this.macros.get(id);
    if (!macro) return;
    for (const action of macro.actions) {
      try {
        this.executor(action);
      } catch (err) {
        console.error(`[HotkeyMacros] Failed to execute action:`, action, err);
      }
    }
  }

  /** Open the macro editor modal */
  openEditor(): void {
    this.renderEditor();
  }

  destroy(): void {
    document.removeEventListener('keydown', this.keyHandler);
    this.closeEditor();
  }

  // ── Key Handler ────────────────────────────────────────────────────────

  private handleKey(e: KeyboardEvent): void {
    if (this.isEditorOpen) return;
    const tag = (e.target as HTMLElement).tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

    const hotkeyStr = this.eventToHotkey(e);
    for (const macro of this.macros.values()) {
      if (macro.hotkey === hotkeyStr) {
        e.preventDefault();
        e.stopPropagation();
        this.executeMacro(macro.id);
        return;
      }
    }
  }

  private eventToHotkey(e: KeyboardEvent): string {
    const parts: string[] = [];
    if (e.ctrlKey || e.metaKey) parts.push('Ctrl');
    if (e.shiftKey) parts.push('Shift');
    if (e.altKey) parts.push('Alt');
    const key = e.key.length === 1 ? e.key.toUpperCase() : e.key;
    if (!['Control', 'Meta', 'Shift', 'Alt'].includes(key)) {
      parts.push(key);
    }
    return parts.join('+');
  }

  // ── Editor Modal ───────────────────────────────────────────────────────

  private renderEditor(): void {
    this.closeEditor();
    this.isEditorOpen = true;

    this.overlay = document.createElement('div');
    this.overlay.className = 'macro-overlay';
    this.overlay.addEventListener('mousedown', (e) => {
      if (e.target === this.overlay) this.closeEditor();
    });

    const modal = document.createElement('div');
    modal.className = 'macro-modal';
    modal.innerHTML = `
      <div class="macro-header">
        <h2 class="macro-title">⌨️ Hotkey Macros</h2>
        <p class="macro-subtitle">One keystroke deploys your full setup. Basically scripting without coding.</p>
        <button class="macro-close" id="macroClose">✕</button>
      </div>
      <div class="macro-list" id="macroList">
        ${this.renderMacroList()}
      </div>
      <div class="macro-footer">
        <button class="macro-btn macro-btn--secondary" id="macroResetBtn">Reset to Presets</button>
        <button class="macro-btn macro-btn--primary" id="macroAddBtn">+ Add Macro</button>
      </div>
    `;

    this.overlay.appendChild(modal);
    document.body.appendChild(this.overlay);
    requestAnimationFrame(() => this.overlay?.classList.add('open'));

    modal.querySelector('#macroClose')?.addEventListener('click', () => this.closeEditor());
    modal.querySelector('#macroResetBtn')?.addEventListener('click', () => {
      this.macros.clear();
      for (const preset of PRESET_MACROS) this.macros.set(preset.id, preset);
      this.saveMacros();
      const list = modal.querySelector('#macroList');
      if (list) list.innerHTML = this.renderMacroList();
    });

    // Delete buttons
    modal.querySelectorAll<HTMLButtonElement>('.macro-delete-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = btn.dataset.id!;
        this.removeMacro(id);
        const list = modal.querySelector('#macroList');
        if (list) list.innerHTML = this.renderMacroList();
      });
    });

    // Run buttons
    modal.querySelectorAll<HTMLButtonElement>('.macro-run-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = btn.dataset.id!;
        this.executeMacro(id);
        this.closeEditor();
      });
    });

    const escHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        this.closeEditor();
        document.removeEventListener('keydown', escHandler);
      }
    };
    document.addEventListener('keydown', escHandler);
  }

  private renderMacroList(): string {
    if (this.macros.size === 0) {
      return '<div class="macro-empty">No macros configured. Click "Add Macro" to create one.</div>';
    }

    return [...this.macros.values()].map((m) => `
      <div class="macro-item" data-id="${m.id}">
        <div class="macro-item-info">
          <div class="macro-item-name">${m.name}</div>
          <div class="macro-item-desc">${m.description ?? ''}</div>
          <div class="macro-item-actions-preview">
            ${m.actions.map((a) => `<span class="macro-action-badge">${this.actionLabel(a)}</span>`).join('')}
          </div>
        </div>
        <div class="macro-item-right">
          <kbd class="macro-hotkey">${m.hotkey}</kbd>
          <button class="macro-run-btn" data-id="${m.id}" title="Run now">▶</button>
          <button class="macro-delete-btn" data-id="${m.id}" title="Delete">✕</button>
        </div>
      </div>
    `).join('');
  }

  private actionLabel(action: MacroAction): string {
    switch (action.type) {
      case 'set_tool': return `Tool: ${action.tool}`;
      case 'toggle_panel': return `${action.enabled ? 'Show' : 'Hide'} ${action.panel}`;
      case 'set_timeframe': return `TF: ${action.timeframe}`;
      case 'set_symbol': return `Symbol: ${action.symbol}`;
      case 'add_indicator': return `+ ${action.indicator}${action.params?.period ? ` (${action.params.period})` : ''}`;
      case 'draw_hline': return `H-Line @ ${action.price}`;
      case 'set_alert': return `Alert @ ${action.price}`;
      case 'custom': return action.label;
    }
  }

  private closeEditor(): void {
    if (!this.isEditorOpen) return;
    this.isEditorOpen = false;
    this.overlay?.classList.remove('open');
    setTimeout(() => {
      this.overlay?.remove();
      this.overlay = null;
    }, 200);
  }

  // ── Persistence ────────────────────────────────────────────────────────

  private loadMacros(): void {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const arr: MacroDefinition[] = JSON.parse(raw);
        for (const m of arr) this.macros.set(m.id, m);
      }
    } catch { /* ignore */ }
  }

  private saveMacros(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify([...this.macros.values()]));
    } catch { /* ignore */ }
  }
}
