/**
 * SyncControls.ts
 * Controls for synchronizing symbol and/or timeframe across all chart panes.
 * Shows inline toggle buttons in the top bar.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export interface SyncState {
  syncSymbol: boolean;
  syncTimeframe: boolean;
}

type SyncListener = (state: SyncState) => void;

// ─── SyncControls ────────────────────────────────────────────────────────────

export class SyncControls {
  private state: SyncState;
  private el: HTMLElement | null = null;
  private listeners: Set<SyncListener> = new Set();
  private static STORAGE_KEY = 'pinned:sync-state';

  constructor() {
    this.state = this.loadState();
  }

  // ── Public API ─────────────────────────────────────────────────────────

  getState(): SyncState {
    return { ...this.state };
  }

  isSyncSymbol(): boolean {
    return this.state.syncSymbol;
  }

  isSyncTimeframe(): boolean {
    return this.state.syncTimeframe;
  }

  onChange(cb: SyncListener): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** Create and return the sync controls element */
  createControls(): HTMLElement {
    this.el = document.createElement('div');
    this.el.className = 'sync-controls';
    this.el.innerHTML = `
      <button class="sync-btn${this.state.syncSymbol ? ' active' : ''}" id="syncSymbolBtn"
              title="Sync symbol across all panes">
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
          <path d="M1 7h12M9.5 3.5L13 7l-3.5 3.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        <span>Sym</span>
      </button>
      <button class="sync-btn${this.state.syncTimeframe ? ' active' : ''}" id="syncTfBtn"
              title="Sync timeframe across all panes">
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
          <circle cx="7" cy="7" r="5.5" stroke="currentColor" stroke-width="1.5"/>
          <path d="M7 4v3.5l2.5 1.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        <span>TF</span>
      </button>
    `;

    const symBtn = this.el.querySelector('#syncSymbolBtn')!;
    const tfBtn = this.el.querySelector('#syncTfBtn')!;

    symBtn.addEventListener('click', () => {
      this.state.syncSymbol = !this.state.syncSymbol;
      symBtn.classList.toggle('active', this.state.syncSymbol);
      this.saveState();
      this.notify();
    });

    tfBtn.addEventListener('click', () => {
      this.state.syncTimeframe = !this.state.syncTimeframe;
      tfBtn.classList.toggle('active', this.state.syncTimeframe);
      this.saveState();
      this.notify();
    });

    return this.el;
  }

  // ── Private ────────────────────────────────────────────────────────────

  private notify(): void {
    const s = this.getState();
    for (const cb of this.listeners) {
      try { cb(s); } catch {}
    }
  }

  private loadState(): SyncState {
    try {
      const raw = localStorage.getItem(SyncControls.STORAGE_KEY);
      if (raw) return JSON.parse(raw);
    } catch {}
    return { syncSymbol: false, syncTimeframe: false };
  }

  private saveState(): void {
    try {
      localStorage.setItem(SyncControls.STORAGE_KEY, JSON.stringify(this.state));
    } catch {}
  }
}
