/**
 * TimeframeSelector.ts
 * TradingView-style timeframe dropdown with all timeframes (seconds, minutes,
 * hours, days, weeks, months) plus custom timeframe input and favorites.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export interface TimeframeDef {
  id: string;          // e.g. '1m', '5s', '2h', '3M'
  label: string;       // Display label e.g. '1m', '5s', '2H', '3M'
  shortLabel: string;  // Short for top-bar quick buttons
  ms: number;          // Duration in milliseconds
  category: TimeframeCategory;
  apiKey: string;      // Key sent to exchange API (BloFin format)
}

export type TimeframeCategory = 'seconds' | 'minutes' | 'hours' | 'days' | 'weeks' | 'months';

interface TimeframeSelectorOptions {
  currentTimeframe: string;
  onSelect: (tf: string) => void;
  favorites?: string[];
}

// ─── Constants ───────────────────────────────────────────────────────────────

const STORAGE_KEY = 'pinned:tf-favorites';

/** All supported timeframes organized by category */
const ALL_TIMEFRAMES: TimeframeDef[] = [
  // Seconds
  { id: '1s',  label: '1s',   shortLabel: '1s',  ms: 1_000,         category: 'seconds', apiKey: '1s' },
  { id: '5s',  label: '5s',   shortLabel: '5s',  ms: 5_000,         category: 'seconds', apiKey: '5s' },
  { id: '10s', label: '10s',  shortLabel: '10s', ms: 10_000,        category: 'seconds', apiKey: '10s' },
  { id: '15s', label: '15s',  shortLabel: '15s', ms: 15_000,        category: 'seconds', apiKey: '15s' },
  { id: '30s', label: '30s',  shortLabel: '30s', ms: 30_000,        category: 'seconds', apiKey: '30s' },

  // Minutes
  { id: '1m',  label: '1',    shortLabel: '1m',  ms: 60_000,        category: 'minutes', apiKey: '1m' },
  { id: '3m',  label: '3',    shortLabel: '3m',  ms: 180_000,       category: 'minutes', apiKey: '3m' },
  { id: '5m',  label: '5',    shortLabel: '5m',  ms: 300_000,       category: 'minutes', apiKey: '5m' },
  { id: '15m', label: '15',   shortLabel: '15m', ms: 900_000,       category: 'minutes', apiKey: '15m' },
  { id: '30m', label: '30',   shortLabel: '30m', ms: 1_800_000,     category: 'minutes', apiKey: '30m' },
  { id: '45m', label: '45',   shortLabel: '45m', ms: 2_700_000,     category: 'minutes', apiKey: '45m' },

  // Hours
  { id: '1h',  label: '1',    shortLabel: '1H',  ms: 3_600_000,     category: 'hours',   apiKey: '1H' },
  { id: '2h',  label: '2',    shortLabel: '2H',  ms: 7_200_000,     category: 'hours',   apiKey: '2H' },
  { id: '3h',  label: '3',    shortLabel: '3H',  ms: 10_800_000,    category: 'hours',   apiKey: '3H' },
  { id: '4h',  label: '4',    shortLabel: '4H',  ms: 14_400_000,    category: 'hours',   apiKey: '4H' },
  { id: '6h',  label: '6',    shortLabel: '6H',  ms: 21_600_000,    category: 'hours',   apiKey: '6H' },
  { id: '8h',  label: '8',    shortLabel: '8H',  ms: 28_800_000,    category: 'hours',   apiKey: '8H' },
  { id: '12h', label: '12',   shortLabel: '12H', ms: 43_200_000,    category: 'hours',   apiKey: '12H' },

  // Days
  { id: '1d',  label: '1',    shortLabel: '1D',  ms: 86_400_000,    category: 'days',    apiKey: '1D' },
  { id: '2d',  label: '2',    shortLabel: '2D',  ms: 172_800_000,   category: 'days',    apiKey: '2D' },
  { id: '3d',  label: '3',    shortLabel: '3D',  ms: 259_200_000,   category: 'days',    apiKey: '3D' },

  // Weeks
  { id: '1w',  label: '1',    shortLabel: '1W',  ms: 604_800_000,   category: 'weeks',   apiKey: '1W' },
  { id: '2w',  label: '2',    shortLabel: '2W',  ms: 1_209_600_000, category: 'weeks',   apiKey: '2W' },

  // Months
  { id: '1M',  label: '1',    shortLabel: '1M',  ms: 2_592_000_000, category: 'months',  apiKey: '1M' },
  { id: '3M',  label: '3',    shortLabel: '3M',  ms: 7_776_000_000, category: 'months',  apiKey: '3M' },
  { id: '6M',  label: '6',    shortLabel: '6M',  ms: 15_552_000_000, category: 'months', apiKey: '6M' },
  { id: '12M', label: '12',   shortLabel: '1Y',  ms: 31_536_000_000, category: 'months', apiKey: '12M' },
];

const CATEGORY_LABELS: Record<TimeframeCategory, string> = {
  seconds: 'Seconds',
  minutes: 'Minutes',
  hours: 'Hours',
  days: 'Days',
  weeks: 'Weeks',
  months: 'Months',
};

const CATEGORY_ORDER: TimeframeCategory[] = ['seconds', 'minutes', 'hours', 'days', 'weeks', 'months'];

const DEFAULT_FAVORITES = ['1m', '5m', '15m', '1h', '4h', '1d'];

const TF_MAP = new Map(ALL_TIMEFRAMES.map(t => [t.id, t]));

// ─── Utility ─────────────────────────────────────────────────────────────────

/**
 * Parse a custom timeframe string like "7m", "2h", "45s" into a TimeframeDef.
 * Returns null if the string is not valid.
 */
export function parseCustomTimeframe(input: string): TimeframeDef | null {
  const trimmed = input.trim().toLowerCase();
  const match = trimmed.match(/^(\d+)\s*(s|sec|second|seconds|m|min|minute|minutes|h|hr|hour|hours|d|day|days|w|wk|week|weeks|mo|month|months|y|yr|year|years)$/);
  if (!match) return null;

  const num = parseInt(match[1]!, 10);
  if (num <= 0 || num > 999) return null;

  const unit = match[2]!;
  let category: TimeframeCategory;
  let ms: number;
  let suffix: string;
  let apiSuffix: string;

  if (/^(s|sec|second|seconds)$/.test(unit)) {
    category = 'seconds'; ms = num * 1_000; suffix = 's'; apiSuffix = 's';
  } else if (/^(m|min|minute|minutes)$/.test(unit)) {
    category = 'minutes'; ms = num * 60_000; suffix = 'm'; apiSuffix = 'm';
  } else if (/^(h|hr|hour|hours)$/.test(unit)) {
    category = 'hours'; ms = num * 3_600_000; suffix = 'h'; apiSuffix = 'H';
  } else if (/^(d|day|days)$/.test(unit)) {
    category = 'days'; ms = num * 86_400_000; suffix = 'd'; apiSuffix = 'D';
  } else if (/^(w|wk|week|weeks)$/.test(unit)) {
    category = 'weeks'; ms = num * 604_800_000; suffix = 'w'; apiSuffix = 'W';
  } else if (/^(mo|month|months)$/.test(unit)) {
    category = 'months'; ms = num * 2_592_000_000; suffix = 'M'; apiSuffix = 'M';
  } else if (/^(y|yr|year|years)$/.test(unit)) {
    category = 'months'; ms = num * 31_536_000_000; suffix = 'M'; apiSuffix = 'M';
    // Years → convert to months for the API
    return {
      id: `${num * 12}M`,
      label: `${num}Y`,
      shortLabel: `${num}Y`,
      ms,
      category,
      apiKey: `${num * 12}M`,
    };
  } else {
    return null;
  }

  const id = `${num}${suffix}`;
  return {
    id,
    label: `${num}${suffix}`,
    shortLabel: `${num}${suffix.toUpperCase()}`,
    ms,
    category,
    apiKey: `${num}${apiSuffix}`,
  };
}

export function getTimeframeDef(id: string): TimeframeDef | undefined {
  return TF_MAP.get(id);
}

export function getTimeframeMs(id: string): number {
  return TF_MAP.get(id)?.ms ?? 60_000;
}

export function getTimeframeApiKey(id: string): string {
  return TF_MAP.get(id)?.apiKey ?? id;
}

// ─── TimeframeSelector Class ─────────────────────────────────────────────────

export class TimeframeSelector {
  private options: TimeframeSelectorOptions;
  private current: string;
  private favorites: Set<string>;
  private overlay: HTMLElement | null = null;
  private topBarEl: HTMLElement | null = null;

  constructor(options: TimeframeSelectorOptions) {
    this.options = options;
    this.current = options.currentTimeframe;
    this.favorites = new Set(options.favorites ?? this.loadFavorites());
  }

  // ── Top Bar Quick Buttons ─────────────────────────────────────────────

  /**
   * Creates the top-bar timeframe strip: favorite TF quick buttons + dropdown arrow.
   */
  createTopBarStrip(): HTMLElement {
    const strip = document.createElement('div');
    strip.className = 'tf-strip';

    this.topBarEl = strip;
    this.renderStrip(strip);

    return strip;
  }

  private renderStrip(strip: HTMLElement): void {
    strip.innerHTML = '';

    // Render favorite/pinned TF buttons
    const favList = [...this.favorites].map(id => TF_MAP.get(id)).filter(Boolean) as TimeframeDef[];
    // Sort by ms
    favList.sort((a, b) => a.ms - b.ms);

    for (const tf of favList) {
      const btn = document.createElement('button');
      btn.className = `tf-btn ${tf.id === this.current ? 'active' : ''}`;
      btn.dataset.tf = tf.id;
      btn.textContent = tf.shortLabel;
      btn.title = this.getFullLabel(tf);
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.selectTimeframe(tf.id);
      });
      strip.appendChild(btn);
    }

    // Dropdown arrow to open full selector
    const dropBtn = document.createElement('button');
    dropBtn.className = 'tf-drop-btn';
    dropBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M3 5L6 8L9 5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    dropBtn.title = 'All timeframes';
    dropBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.open();
    });
    strip.appendChild(dropBtn);
  }

  // ── Full Dropdown Panel ───────────────────────────────────────────────

  open(): void {
    if (this.overlay) { this.close(); return; }

    this.overlay = document.createElement('div');
    this.overlay.className = 'tf-overlay';

    const panel = document.createElement('div');
    panel.className = 'tf-panel';

    // Header
    const header = document.createElement('div');
    header.className = 'tf-panel-header';
    header.innerHTML = `<span class="tf-panel-title">Timeframe</span>`;

    // Close button
    const closeBtn = document.createElement('button');
    closeBtn.className = 'tf-panel-close';
    closeBtn.innerHTML = '✕';
    closeBtn.addEventListener('click', () => this.close());
    header.appendChild(closeBtn);
    panel.appendChild(header);

    // Category sections
    const body = document.createElement('div');
    body.className = 'tf-panel-body';

    for (const cat of CATEGORY_ORDER) {
      const tfs = ALL_TIMEFRAMES.filter(t => t.category === cat);
      if (tfs.length === 0) continue;

      const section = document.createElement('div');
      section.className = 'tf-panel-section';

      const sectionHeader = document.createElement('div');
      sectionHeader.className = 'tf-panel-section-header';
      sectionHeader.textContent = CATEGORY_LABELS[cat];
      section.appendChild(sectionHeader);

      const grid = document.createElement('div');
      grid.className = 'tf-panel-grid';

      for (const tf of tfs) {
        const item = document.createElement('button');
        item.className = `tf-panel-item ${tf.id === this.current ? 'tf-panel-item--active' : ''}`;
        item.dataset.tf = tf.id;

        const labelSpan = document.createElement('span');
        labelSpan.className = 'tf-panel-item-label';
        labelSpan.textContent = tf.label;

        const favBtn = document.createElement('span');
        favBtn.className = `tf-panel-item-fav ${this.favorites.has(tf.id) ? 'tf-panel-item-fav--on' : ''}`;
        favBtn.innerHTML = '★';
        favBtn.title = this.favorites.has(tf.id) ? 'Remove from favorites' : 'Add to favorites';
        favBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          this.toggleFavorite(tf.id);
          favBtn.classList.toggle('tf-panel-item-fav--on');
          favBtn.title = this.favorites.has(tf.id) ? 'Remove from favorites' : 'Add to favorites';
        });

        item.appendChild(labelSpan);
        item.appendChild(favBtn);
        item.addEventListener('click', () => {
          this.selectTimeframe(tf.id);
          this.close();
        });
        grid.appendChild(item);
      }

      section.appendChild(grid);
      body.appendChild(section);
    }

    panel.appendChild(body);

    // Custom timeframe input
    const customSection = document.createElement('div');
    customSection.className = 'tf-panel-custom';

    const customLabel = document.createElement('span');
    customLabel.className = 'tf-panel-custom-label';
    customLabel.textContent = 'Custom';

    const customInput = document.createElement('input');
    customInput.className = 'tf-panel-custom-input';
    customInput.type = 'text';
    customInput.placeholder = 'e.g. 7m, 2h, 45s';
    customInput.spellcheck = false;
    customInput.autocomplete = 'off';

    const customApply = document.createElement('button');
    customApply.className = 'tf-panel-custom-apply';
    customApply.textContent = 'Apply';

    const errorMsg = document.createElement('div');
    errorMsg.className = 'tf-panel-custom-error';

    const applyCustom = () => {
      const parsed = parseCustomTimeframe(customInput.value);
      if (parsed) {
        // Add to map if not already there
        if (!TF_MAP.has(parsed.id)) {
          TF_MAP.set(parsed.id, parsed);
          ALL_TIMEFRAMES.push(parsed);
        }
        this.selectTimeframe(parsed.id);
        this.close();
      } else {
        errorMsg.textContent = 'Invalid format. Try: 7m, 2h, 45s, 3d, 1w';
        errorMsg.style.display = 'block';
        setTimeout(() => { errorMsg.style.display = 'none'; }, 3000);
      }
    };

    customApply.addEventListener('click', applyCustom);
    customInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') applyCustom();
    });

    customSection.appendChild(customLabel);
    customSection.appendChild(customInput);
    customSection.appendChild(customApply);
    customSection.appendChild(errorMsg);
    panel.appendChild(customSection);

    this.overlay.appendChild(panel);
    document.body.appendChild(this.overlay);

    // Close on backdrop click
    this.overlay.addEventListener('click', (e) => {
      if (e.target === this.overlay) this.close();
    });

    // Close on Escape
    const escHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { this.close(); window.removeEventListener('keydown', escHandler); }
    };
    window.addEventListener('keydown', escHandler);

    // Focus custom input
    requestAnimationFrame(() => customInput.focus());

    // Position near the button
    requestAnimationFrame(() => {
      if (this.topBarEl && panel) {
        const rect = this.topBarEl.getBoundingClientRect();
        panel.style.top = `${rect.bottom + 4}px`;
        panel.style.left = `${Math.max(8, rect.left)}px`;
      }
    });
  }

  close(): void {
    if (this.overlay) {
      this.overlay.remove();
      this.overlay = null;
    }
  }

  // ── Internal ──────────────────────────────────────────────────────────

  private selectTimeframe(id: string): void {
    this.current = id;
    this.options.onSelect(id);
    if (this.topBarEl) this.renderStrip(this.topBarEl);
  }

  setCurrent(id: string): void {
    this.current = id;
    if (this.topBarEl) this.renderStrip(this.topBarEl);
  }

  private toggleFavorite(id: string): void {
    if (this.favorites.has(id)) {
      this.favorites.delete(id);
    } else {
      this.favorites.add(id);
    }
    this.saveFavorites();
    if (this.topBarEl) this.renderStrip(this.topBarEl);
  }

  private getFullLabel(tf: TimeframeDef): string {
    const names: Record<TimeframeCategory, string> = {
      seconds: 'second', minutes: 'minute', hours: 'hour',
      days: 'day', weeks: 'week', months: 'month',
    };
    const num = parseInt(tf.label);
    const unit = names[tf.category];
    return `${num} ${unit}${num !== 1 ? 's' : ''}`;
  }

  private loadFavorites(): string[] {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) return JSON.parse(stored);
    } catch { /* ignore */ }
    return DEFAULT_FAVORITES;
  }

  private saveFavorites(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify([...this.favorites]));
    } catch { /* ignore */ }
  }

  destroy(): void {
    this.close();
    this.topBarEl = null;
  }
}
