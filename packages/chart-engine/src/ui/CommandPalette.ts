/**
 * CommandPalette.ts
 * VS Code / Raycast-style universal Command Palette (⌘K).
 *
 * Type anything: "Add RSI", "Alert at 67,400", "Switch to ETH 15m",
 * "Load my breakout template". Universal search across every function.
 *
 * No trading platform has this. It's the single fastest UX upgrade possible.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export type CommandCategory =
  | 'navigation'
  | 'drawing'
  | 'indicator'
  | 'alert'
  | 'layout'
  | 'orderflow'
  | 'settings'
  | 'replay'
  | 'journal'
  | 'ai';

export interface CommandAction {
  id: string;
  label: string;
  description?: string;
  category: CommandCategory;
  icon: string;
  shortcut?: string;
  keywords?: string[];     // Extra search terms
  execute: () => void;
}

export type CommandPaletteCallback = (action: CommandAction) => void;

// ─── Category Styling ────────────────────────────────────────────────────────

const CATEGORY_CONFIG: Record<CommandCategory, { label: string; color: string }> = {
  navigation: { label: 'Navigation', color: '#3b82f6' },
  drawing:    { label: 'Drawing',    color: '#8b5cf6' },
  indicator:  { label: 'Indicator',  color: '#10b981' },
  alert:      { label: 'Alert',      color: '#f59e0b' },
  layout:     { label: 'Layout',     color: '#06b6d4' },
  orderflow:  { label: 'Orderflow',  color: '#ec4899' },
  settings:   { label: 'Settings',   color: '#6b7280' },
  replay:     { label: 'Replay',     color: '#f97316' },
  journal:    { label: 'Journal',    color: '#14b8a6' },
  ai:         { label: 'AI',         color: '#a855f7' },
};

// ─── Fuzzy Match ─────────────────────────────────────────────────────────────

interface MatchResult {
  score: number;
  indices: number[];
}

function fuzzyMatch(query: string, text: string): MatchResult | null {
  const q = query.toLowerCase();
  const t = text.toLowerCase();

  // Exact substring → highest score
  const subIdx = t.indexOf(q);
  if (subIdx !== -1) {
    const indices = Array.from({ length: q.length }, (_, i) => subIdx + i);
    return { score: 100 + (q.length / t.length) * 50, indices };
  }

  // Word-start matching (e.g. "sw eth" matches "Switch to ETH")
  const words = t.split(/\s+/);
  const queryWords = q.split(/\s+/);
  let allMatch = true;
  const indices: number[] = [];

  for (const qw of queryWords) {
    let found = false;
    let pos = 0;
    for (const w of words) {
      const wStart = t.indexOf(w, pos);
      if (w.startsWith(qw)) {
        for (let i = 0; i < qw.length; i++) indices.push(wStart + i);
        found = true;
        break;
      }
      pos = wStart + w.length;
    }
    if (!found) { allMatch = false; break; }
  }

  if (allMatch && indices.length > 0) {
    return { score: 70 + (indices.length / t.length) * 30, indices };
  }

  // Character-by-character fuzzy
  let qi = 0;
  const fuzzyIndices: number[] = [];
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      fuzzyIndices.push(ti);
      qi++;
    }
  }

  if (qi === q.length) {
    // Score based on how "tight" the match is
    const spread = fuzzyIndices[fuzzyIndices.length - 1]! - fuzzyIndices[0]!;
    const tightness = 1 - spread / t.length;
    return { score: 30 + tightness * 40, indices: fuzzyIndices };
  }

  return null;
}

function highlightMatch(text: string, indices: number[]): string {
  const chars = text.split('');
  const set = new Set(indices);
  return chars
    .map((c, i) => (set.has(i) ? `<b>${c}</b>` : c))
    .join('');
}

// ─── CommandPalette ──────────────────────────────────────────────────────────

export class CommandPalette {
  private overlay: HTMLElement | null = null;
  private modal: HTMLElement | null = null;
  private input: HTMLInputElement | null = null;
  private resultsList: HTMLElement | null = null;
  private footerEl: HTMLElement | null = null;

  private actions: CommandAction[] = [];
  private filtered: (CommandAction & { match: MatchResult })[] = [];
  private highlightIdx = 0;
  private isOpen = false;
  private recentIds: string[] = [];

  private static RECENT_KEY = 'pinned_cmd_recent';
  private static MAX_RECENT = 8;

  constructor() {
    this.loadRecent();
  }

  // ── Action Registry ────────────────────────────────────────────────────

  registerActions(actions: CommandAction[]): void {
    this.actions.push(...actions);
  }

  clearActions(): void {
    this.actions = [];
  }

  // ── Open / Close ───────────────────────────────────────────────────────

  open(): void {
    if (this.isOpen) return;
    this.isOpen = true;
    this.highlightIdx = 0;
    this.render();
    requestAnimationFrame(() => {
      this.overlay?.classList.add('open');
      this.input?.focus();
    });
  }

  close(): void {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.overlay?.classList.remove('open');
    setTimeout(() => {
      this.overlay?.remove();
      this.overlay = null;
      this.modal = null;
      this.input = null;
      this.resultsList = null;
      this.footerEl = null;
    }, 180);
  }

  toggle(): void {
    this.isOpen ? this.close() : this.open();
  }

  // ── Render ─────────────────────────────────────────────────────────────

  private render(): void {
    // Overlay
    this.overlay = document.createElement('div');
    this.overlay.className = 'cmd-palette-overlay';
    this.overlay.addEventListener('mousedown', (e) => {
      if (e.target === this.overlay) this.close();
    });

    // Modal
    this.modal = document.createElement('div');
    this.modal.className = 'cmd-palette';
    this.modal.innerHTML = `
      <div class="cmd-header">
        <svg class="cmd-search-icon" width="18" height="18" viewBox="0 0 18 18" fill="none">
          <circle cx="8" cy="8" r="5.5" stroke="currentColor" stroke-width="1.5"/>
          <path d="M12.5 12.5l3 3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
        </svg>
        <input class="cmd-input" type="text"
               placeholder="Type a command… (e.g. 'add RSI', 'alert at 67400', 'switch ETH 15m')"
               autocomplete="off" spellcheck="false" />
        <kbd class="cmd-esc">ESC</kbd>
      </div>
      <div class="cmd-results"></div>
      <div class="cmd-footer">
        <span class="cmd-hint"><kbd>↑↓</kbd> navigate</span>
        <span class="cmd-hint"><kbd>↵</kbd> select</span>
        <span class="cmd-hint"><kbd>esc</kbd> close</span>
      </div>
    `;

    this.overlay.appendChild(this.modal);
    document.body.appendChild(this.overlay);

    // Refs
    this.input = this.modal.querySelector('.cmd-input')!;
    this.resultsList = this.modal.querySelector('.cmd-results')!;
    this.footerEl = this.modal.querySelector('.cmd-footer')!;

    // Events
    this.input.addEventListener('input', () => this.onInput());
    this.input.addEventListener('keydown', (e) => this.onKeyDown(e));

    // Initial render: show recent or all
    this.onInput();
  }

  private onInput(): void {
    const query = this.input?.value.trim() ?? '';
    this.highlightIdx = 0;

    if (!query) {
      // Show recent actions first, then popular
      const recent = this.recentIds
        .map((id) => this.actions.find((a) => a.id === id))
        .filter(Boolean) as CommandAction[];

      const rest = this.actions
        .filter((a) => !this.recentIds.includes(a.id))
        .slice(0, 20);

      this.renderResults(recent, rest, '');
      return;
    }

    // Fuzzy search across label + description + keywords
    const matches: (CommandAction & { match: MatchResult })[] = [];

    for (const action of this.actions) {
      const searchText = [
        action.label,
        action.description ?? '',
        ...(action.keywords ?? []),
      ].join(' ');

      const m = fuzzyMatch(query, searchText);
      if (m) {
        // Re-match against label specifically for highlighting
        const labelMatch = fuzzyMatch(query, action.label);
        matches.push({
          ...action,
          match: labelMatch ?? m,
        });
      }
    }

    matches.sort((a, b) => b.match.score - a.match.score);
    this.filtered = matches.slice(0, 30);
    this.renderFilteredResults(query);
  }

  private renderResults(recent: CommandAction[], rest: CommandAction[], query: string): void {
    if (!this.resultsList) return;

    let html = '';

    if (recent.length > 0) {
      html += `<div class="cmd-group-label">Recent</div>`;
      for (let i = 0; i < recent.length; i++) {
        html += this.renderItem(recent[i]!, i, false);
      }
    }

    const startIdx = recent.length;
    if (rest.length > 0) {
      html += `<div class="cmd-group-label">All Commands</div>`;
      for (let i = 0; i < rest.length; i++) {
        html += this.renderItem(rest[i]!, startIdx + i, false);
      }
    }

    this.resultsList.innerHTML = html;
    this.bindResultEvents();
    this.updateHighlight();
  }

  private renderFilteredResults(query: string): void {
    if (!this.resultsList) return;

    if (this.filtered.length === 0) {
      this.resultsList.innerHTML = `
        <div class="cmd-empty">
          <div class="cmd-empty-icon">🔍</div>
          <div class="cmd-empty-text">No commands found for "${query}"</div>
        </div>
      `;
      return;
    }

    // Group by category
    const groups = new Map<CommandCategory, typeof this.filtered>();
    for (const item of this.filtered) {
      if (!groups.has(item.category)) groups.set(item.category, []);
      groups.get(item.category)!.push(item);
    }

    let html = '';
    let idx = 0;
    for (const [cat, items] of groups) {
      const cfg = CATEGORY_CONFIG[cat];
      html += `<div class="cmd-group-label" style="color:${cfg.color}">${cfg.label}</div>`;
      for (const item of items) {
        const labelHtml = highlightMatch(item.label, item.match.indices);
        html += this.renderItemHtml(item, idx, labelHtml);
        idx++;
      }
    }

    this.resultsList.innerHTML = html;
    this.bindResultEvents();
    this.updateHighlight();
  }

  private renderItem(action: CommandAction, index: number, highlighted: boolean): string {
    return this.renderItemHtml(action, index, action.label);
  }

  private renderItemHtml(action: CommandAction, index: number, labelHtml: string): string {
    const cat = CATEGORY_CONFIG[action.category];
    const shortcutHtml = action.shortcut
      ? `<kbd class="cmd-shortcut">${action.shortcut}</kbd>`
      : '';
    const descHtml = action.description
      ? `<span class="cmd-item-desc">${action.description}</span>`
      : '';

    return `
      <div class="cmd-item" data-idx="${index}" data-id="${action.id}">
        <span class="cmd-item-icon">${action.icon}</span>
        <div class="cmd-item-content">
          <span class="cmd-item-label">${labelHtml}</span>
          ${descHtml}
        </div>
        <span class="cmd-item-badge" style="background:${cat.color}15;color:${cat.color}">${cat.label}</span>
        ${shortcutHtml}
      </div>
    `;
  }

  private bindResultEvents(): void {
    if (!this.resultsList) return;
    const items = this.resultsList.querySelectorAll<HTMLElement>('.cmd-item');
    items.forEach((el) => {
      el.addEventListener('mouseenter', () => {
        this.highlightIdx = parseInt(el.dataset.idx ?? '0', 10);
        this.updateHighlight();
      });
      el.addEventListener('click', () => {
        const id = el.dataset.id!;
        this.executeAction(id);
      });
    });
  }

  private updateHighlight(): void {
    if (!this.resultsList) return;
    const items = this.resultsList.querySelectorAll<HTMLElement>('.cmd-item');
    items.forEach((el, i) => {
      el.classList.toggle('active', i === this.highlightIdx);
    });
    // Scroll into view
    items[this.highlightIdx]?.scrollIntoView({ block: 'nearest' });
  }

  private onKeyDown(e: KeyboardEvent): void {
    const items = this.resultsList?.querySelectorAll('.cmd-item') ?? [];
    const count = items.length;

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        this.highlightIdx = (this.highlightIdx + 1) % Math.max(1, count);
        this.updateHighlight();
        break;
      case 'ArrowUp':
        e.preventDefault();
        this.highlightIdx = (this.highlightIdx - 1 + count) % Math.max(1, count);
        this.updateHighlight();
        break;
      case 'Enter':
        e.preventDefault();
        if (items[this.highlightIdx]) {
          const id = (items[this.highlightIdx] as HTMLElement).dataset.id!;
          this.executeAction(id);
        }
        break;
      case 'Escape':
        e.preventDefault();
        this.close();
        break;
      case 'Tab':
        e.preventDefault();
        // Tab to autocomplete the highlighted item
        if (items[this.highlightIdx]) {
          const id = (items[this.highlightIdx] as HTMLElement).dataset.id!;
          const action = this.actions.find((a) => a.id === id);
          if (action && this.input) {
            this.input.value = action.label;
            this.onInput();
          }
        }
        break;
    }
  }

  private executeAction(id: string): void {
    const action = this.actions.find((a) => a.id === id);
    if (!action) return;

    // Track recent
    this.recentIds = [id, ...this.recentIds.filter((r) => r !== id)].slice(0, CommandPalette.MAX_RECENT);
    this.saveRecent();

    this.close();

    // Execute after close animation
    setTimeout(() => action.execute(), 50);
  }

  // ── Persistence ────────────────────────────────────────────────────────

  private loadRecent(): void {
    try {
      const raw = localStorage.getItem(CommandPalette.RECENT_KEY);
      if (raw) this.recentIds = JSON.parse(raw);
    } catch { /* ignore */ }
  }

  private saveRecent(): void {
    try {
      localStorage.setItem(CommandPalette.RECENT_KEY, JSON.stringify(this.recentIds));
    } catch { /* ignore */ }
  }
}
