/**
 * DrawingPropertiesDialog.ts
 * TradingView-style modal dialog for editing drawing properties.
 *
 * Features:
 * - Tabbed interface (Style, Text, Coordinates, Visibility)
 * - Per-tool option configurations (Fibonacci levels, extends, fills, etc.)
 * - Color picker with opacity slider
 * - Line style visual previews
 * - Level editor for Fibonacci tools (checkboxes + custom values + per-level colors)
 * - Extend direction dropdown
 * - Template save/load
 * - Cancel/Ok flow
 */

import type { Drawing, DrawingType, DrawingProperties, ChartPoint } from '../core/ChartState';
import { TOOL_COLORS, LINE_WIDTHS } from '../drawing/DrawingTools';

// ─── Types ─────────────────────────────────────────────────────────────────────

export type DialogCallback = (drawingId: string, props: Partial<DrawingProperties>) => void;
export type DeleteCallback = (drawingId: string) => void;
export type CloneCallback = (drawingId: string) => void;

/** Per-level configuration for Fibonacci tools. */
interface FibLevelConfig {
  value: number;
  enabled: boolean;
  color: string;
}

// ─── Default Fibonacci Levels ──────────────────────────────────────────────────

const DEFAULT_FIB_RETRACEMENT_LEVELS: FibLevelConfig[] = [
  { value: 0, enabled: true, color: '#787B86' },
  { value: 0.236, enabled: true, color: '#F7525F' },
  { value: 0.382, enabled: false, color: '#22AB94' },
  { value: 0.5, enabled: false, color: '#2962FF' },
  { value: 0.618, enabled: false, color: '#22AB94' },
  { value: 0.786, enabled: false, color: '#FF9800' },
  { value: 1, enabled: true, color: '#787B86' },
  { value: 1.272, enabled: false, color: '#22AB94' },
  { value: 1.414, enabled: false, color: '#F7525F' },
  { value: 1.618, enabled: false, color: '#22AB94' },
  { value: 2, enabled: false, color: '#22AB94' },
  { value: 2.272, enabled: false, color: '#22AB94' },
  { value: 2.414, enabled: false, color: '#22AB94' },
  { value: 2.618, enabled: false, color: '#22AB94' },
  { value: 3, enabled: false, color: '#22AB94' },
  { value: 3.272, enabled: false, color: '#22AB94' },
  { value: 3.414, enabled: false, color: '#22AB94' },
  { value: 3.618, enabled: false, color: '#22AB94' },
  { value: 4, enabled: false, color: '#22AB94' },
  { value: 4.236, enabled: false, color: '#22AB94' },
  { value: 0.09, enabled: true, color: '#22AB94' },
  { value: 0.333, enabled: true, color: '#787B86' },
  { value: 0.75, enabled: false, color: '#787B86' },
];

const DEFAULT_FIB_EXTENSION_LEVELS: FibLevelConfig[] = [
  { value: 0, enabled: true, color: '#787B86' },
  { value: 0.618, enabled: true, color: '#22AB94' },
  { value: 1, enabled: true, color: '#787B86' },
  { value: 1.272, enabled: true, color: '#22AB94' },
  { value: 1.618, enabled: true, color: '#22AB94' },
  { value: 2, enabled: true, color: '#F7525F' },
  { value: 2.618, enabled: true, color: '#22AB94' },
  { value: 3.618, enabled: false, color: '#22AB94' },
  { value: 4.236, enabled: false, color: '#22AB94' },
];

// ─── Extend Options ────────────────────────────────────────────────────────────

const EXTEND_OPTIONS = [
  { value: 'none', label: 'None' },
  { value: 'right', label: 'Extend right' },
  { value: 'left', label: 'Extend left' },
  { value: 'both', label: 'Extend both' },
] as const;

// ─── Type Labels ───────────────────────────────────────────────────────────────

const TYPE_LABELS: Record<string, string> = {
  horizontal_line: 'Horizontal Line',
  vertical_line: 'Vertical Line',
  trendline: 'Trend Line',
  ray: 'Ray',
  extended_line: 'Extended Line',
  parallel_channel: 'Parallel Channel',
  fibonacci_retracement: 'Fib Retracement',
  fibonacci_extension: 'Fib Extension',
  rectangle: 'Rectangle',
  ellipse: 'Ellipse',
  text: 'Text',
  price_range: 'Price Range',
  date_range: 'Date Range',
  measure: 'Measure',
  anchored_vwap: 'Anchored VWAP',
};

// ─── DrawingPropertiesDialog ───────────────────────────────────────────────────

export class DrawingPropertiesDialog {
  private overlay: HTMLElement;
  private dialog: HTMLElement;
  private drawing: Drawing | null = null;
  private editedProps: DrawingProperties = {};
  private activeTab: 'style' | 'text' | 'coordinates' | 'visibility' = 'style';

  private onChange: DialogCallback;
  private onDelete: DeleteCallback;
  private onClone: CloneCallback;

  // Track fib levels independently
  private fibLevels: FibLevelConfig[] = [];

  constructor(onChange: DialogCallback, onDelete: DeleteCallback, onClone: CloneCallback) {
    this.onChange = onChange;
    this.onDelete = onDelete;
    this.onClone = onClone;

    // Create overlay
    this.overlay = document.createElement('div');
    this.overlay.className = 'dpd-overlay';
    this.overlay.style.display = 'none';
    this.overlay.addEventListener('click', (e) => {
      if (e.target === this.overlay) this.close();
    });

    // Create dialog container
    this.dialog = document.createElement('div');
    this.dialog.className = 'dpd-dialog';
    this.overlay.appendChild(this.dialog);

    document.body.appendChild(this.overlay);
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  open(drawing: Drawing): void {
    this.drawing = drawing;
    this.editedProps = { ...drawing.properties };
    this.activeTab = 'style';

    // Initialize fib levels from drawing or defaults
    if (drawing.type === 'fibonacci_retracement') {
      this.fibLevels = this.parseFibLevels(drawing, DEFAULT_FIB_RETRACEMENT_LEVELS);
    } else if (drawing.type === 'fibonacci_extension') {
      this.fibLevels = this.parseFibLevels(drawing, DEFAULT_FIB_EXTENSION_LEVELS);
    }

    this.render();
    this.overlay.style.display = '';
    requestAnimationFrame(() => this.overlay.classList.add('dpd-open'));

    // Trap keyboard
    document.addEventListener('keydown', this.handleKeyDown);
  }

  close(): void {
    this.overlay.classList.remove('dpd-open');
    setTimeout(() => {
      this.overlay.style.display = 'none';
      this.drawing = null;
    }, 200);
    document.removeEventListener('keydown', this.handleKeyDown);
  }

  isOpen(): boolean {
    return this.overlay.style.display !== 'none';
  }

  destroy(): void {
    document.removeEventListener('keydown', this.handleKeyDown);
    this.overlay.remove();
  }

  // ── Keyboard Handler ───────────────────────────────────────────────────────

  private handleKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      this.close();
    } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.stopPropagation();
      this.applyAndClose();
    }
  };

  // ── Apply Changes ──────────────────────────────────────────────────────────

  private applyAndClose(): void {
    if (!this.drawing) return;

    // Merge fib levels back into editedProps
    if (this.fibLevels.length > 0) {
      this.editedProps.levels = this.fibLevels
        .filter(l => l.enabled)
        .map(l => l.value);
      // Store full level config as custom property for persistence
      (this.editedProps as any).levelConfigs = this.fibLevels;
    }

    this.onChange(this.drawing.id, this.editedProps);
    this.close();
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  private render(): void {
    if (!this.drawing) return;
    const d = this.drawing;
    const p = this.editedProps;
    const tabs = this.getTabsForType(d.type);

    this.dialog.innerHTML = `
      <div class="dpd-header">
        <span class="dpd-title">${TYPE_LABELS[d.type] ?? d.type}</span>
        <button class="dpd-icon-btn dpd-rename" title="Rename">✏️</button>
        <button class="dpd-close" title="Close">&times;</button>
      </div>

      <div class="dpd-tabs">
        ${tabs.map(t => `
          <button class="dpd-tab${this.activeTab === t.id ? ' dpd-tab-active' : ''}"
                  data-tab="${t.id}">${t.label}</button>
        `).join('')}
      </div>
      <div class="dpd-tab-indicator" style="width:${100 / tabs.length}%;left:${tabs.findIndex(t => t.id === this.activeTab) * (100 / tabs.length)}%"></div>

      <div class="dpd-body">
        ${this.renderActiveTab(d, p)}
      </div>

      <div class="dpd-footer">
        <div class="dpd-footer-left">
          <button class="dpd-template-btn">Template ▾</button>
        </div>
        <div class="dpd-footer-right">
          <button class="dpd-cancel-btn">Cancel</button>
          <button class="dpd-ok-btn">Ok</button>
        </div>
      </div>
    `;

    this.bindEvents();
  }

  // ── Tabs Configuration ─────────────────────────────────────────────────────

  private getTabsForType(type: DrawingType): { id: string; label: string }[] {
    const tabs: { id: string; label: string }[] = [
      { id: 'style', label: 'Style' },
    ];

    // Text tab for text annotations
    if (type === 'text') {
      tabs.push({ id: 'text', label: 'Text' });
    }

    tabs.push({ id: 'coordinates', label: 'Coordinates' });
    tabs.push({ id: 'visibility', label: 'Visibility' });

    return tabs;
  }

  // ── Tab Content Rendering ──────────────────────────────────────────────────

  private renderActiveTab(d: Drawing, p: DrawingProperties): string {
    switch (this.activeTab) {
      case 'style': return this.renderStyleTab(d, p);
      case 'text': return this.renderTextTab(d, p);
      case 'coordinates': return this.renderCoordinatesTab(d);
      case 'visibility': return this.renderVisibilityTab(d);
      default: return '';
    }
  }

  // ── Style Tab ──────────────────────────────────────────────────────────────

  private renderStyleTab(d: Drawing, p: DrawingProperties): string {
    let html = '';

    // ── Extend option (for lines, channels, etc.) ──
    if (this.hasExtend(d.type)) {
      const currentExtend = this.getExtendValue(p);
      html += `
        <div class="dpd-row">
          <label class="dpd-label">Extend</label>
          <select class="dpd-select" id="dpdExtend">
            ${EXTEND_OPTIONS.map(o => `
              <option value="${o.value}"${o.value === currentExtend ? ' selected' : ''}>${o.label}</option>
            `).join('')}
          </select>
        </div>
      `;
    }

    // ── Trend line toggle (for fib) ──
    if (d.type === 'fibonacci_retracement' || d.type === 'fibonacci_extension') {
      html += `
        <div class="dpd-row dpd-check-row">
          <label class="dpd-check">
            <input type="checkbox" id="dpdTrendLine" ${p.showLabels !== false ? 'checked' : ''}>
            <span>Trend line</span>
          </label>
          <div class="dpd-inline-controls">
            <button class="dpd-color-btn" id="dpdTrendColor" style="background:${p.color ?? '#FF9800'}"></button>
            <span class="dpd-line-preview dpd-line-dashed"></span>
          </div>
        </div>
      `;
    }

    // ── Border / Line controls ──
    html += `
      <div class="dpd-row">
        <label class="dpd-label">${this.getLineLabel(d.type)}</label>
        <div class="dpd-line-controls">
          <div class="dpd-width-picker">
            ${LINE_WIDTHS.map(w => `
              <button class="dpd-width-btn${w === (p.lineWidth ?? 1) ? ' active' : ''}"
                      data-width="${w}" title="${w}px">
                <span style="height:${w}px"></span>
              </button>
            `).join('')}
          </div>
          <div class="dpd-style-picker">
            ${(['solid', 'dashed', 'dotted'] as const).map(s => `
              <button class="dpd-style-btn${s === (p.lineStyle ?? 'solid') ? ' active' : ''}"
                      data-style="${s}" title="${s}">
                <svg width="28" height="4" viewBox="0 0 28 4">
                  <line x1="0" y1="2" x2="28" y2="2" stroke="currentColor" stroke-width="2"
                        ${s === 'dashed' ? 'stroke-dasharray="6 4"' : ''}
                        ${s === 'dotted' ? 'stroke-dasharray="2 3"' : ''}/>
                </svg>
              </button>
            `).join('')}
          </div>
        </div>
      </div>
    `;

    // ── Color palette ──
    html += `
      <div class="dpd-row">
        <label class="dpd-label">Color</label>
        <div class="dpd-colors">
          ${TOOL_COLORS.map(c => `
            <button class="dpd-color-swatch${c === (p.color ?? '#2196F3') ? ' active' : ''}"
                    style="background:${c}" data-color="${c}" title="${c}"></button>
          `).join('')}
        </div>
      </div>
    `;

    // ── Fibonacci levels editor ──
    if (d.type === 'fibonacci_retracement' || d.type === 'fibonacci_extension') {
      html += this.renderFibLevels();
    }

    // ── Fill / Background controls ──
    if (this.hasFill(d.type)) {
      html += `
        <div class="dpd-row dpd-check-row">
          <label class="dpd-check">
            <input type="checkbox" id="dpdFillEnabled" ${(p.fillOpacity ?? 0) > 0 ? 'checked' : ''}>
            <span>Background</span>
          </label>
          <button class="dpd-color-btn dpd-checker" id="dpdFillColor"
                  style="background:${p.fillColor ?? p.color ?? '#2196F3'};opacity:${p.fillOpacity ?? 0.1}"></button>
        </div>

        <div class="dpd-row">
          <label class="dpd-label">Fill Opacity</label>
          <div class="dpd-slider-row">
            <input type="range" class="dpd-range" id="dpdOpacity"
                   min="0" max="100" step="1"
                   value="${Math.round((p.fillOpacity ?? 0.1) * 100)}">
            <span class="dpd-range-val" id="dpdOpacityVal">${Math.round((p.fillOpacity ?? 0.1) * 100)}%</span>
          </div>
        </div>
      `;
    }

    // ── Middle line toggle (for shapes) ──
    if (d.type === 'rectangle' || d.type === 'parallel_channel') {
      html += `
        <div class="dpd-row dpd-check-row">
          <label class="dpd-check">
            <input type="checkbox" id="dpdMiddleLine" ${(p as any).middleLine !== false ? 'checked' : ''}>
            <span>Middle line</span>
          </label>
          <div class="dpd-inline-controls">
            <button class="dpd-color-btn" id="dpdMiddleColor" style="background:${(p as any).middleLineColor ?? '#22AB94'}"></button>
            <span class="dpd-line-preview dpd-line-dashed"></span>
          </div>
        </div>
      `;
    }

    // ── Show labels toggle ──
    if (this.hasLabels(d.type)) {
      html += `
        <div class="dpd-row dpd-check-row">
          <label class="dpd-check">
            <input type="checkbox" id="dpdShowLabels" ${p.showLabels !== false ? 'checked' : ''}>
            <span>Show labels</span>
          </label>
        </div>
      `;
    }

    return html;
  }

  // ── Text Tab ───────────────────────────────────────────────────────────────

  private renderTextTab(_d: Drawing, p: DrawingProperties): string {
    return `
      <div class="dpd-row">
        <label class="dpd-label">Text</label>
        <textarea class="dpd-textarea" id="dpdText" rows="4"
                  placeholder="Type your note…">${p.text ?? ''}</textarea>
      </div>

      <div class="dpd-row">
        <label class="dpd-label">Font Size</label>
        <div class="dpd-slider-row">
          <input type="range" class="dpd-range" id="dpdFontSize"
                 min="8" max="48" step="1" value="${p.fontSize ?? 14}">
          <span class="dpd-range-val" id="dpdFontSizeVal">${p.fontSize ?? 14}px</span>
        </div>
      </div>

      <div class="dpd-row">
        <label class="dpd-label">Font Weight</label>
        <div class="dpd-toggle-group">
          <button class="dpd-toggle-btn${(p as any).fontWeight === 'bold' ? ' active' : ''}" data-weight="bold">Bold</button>
          <button class="dpd-toggle-btn${(p as any).fontWeight === 'normal' || !(p as any).fontWeight ? ' active' : ''}" data-weight="normal">Normal</button>
          <button class="dpd-toggle-btn${(p as any).fontStyle === 'italic' ? ' active' : ''}" data-fontstyle="italic">Italic</button>
        </div>
      </div>
    `;
  }

  // ── Coordinates Tab ────────────────────────────────────────────────────────

  private renderCoordinatesTab(d: Drawing): string {
    let html = '';

    d.points.forEach((pt, i) => {
      const label = d.points.length === 1 ? 'Position' : `Point ${i + 1}`;
      const date = new Date(pt.time);
      const dateStr = date.toISOString().slice(0, 10);
      const timeStr = date.toISOString().slice(11, 19);

      html += `
        <div class="dpd-coord-group">
          <div class="dpd-coord-label">${label}</div>
          <div class="dpd-coord-row">
            <div class="dpd-coord-field">
              <label>Price</label>
              <input type="number" class="dpd-coord-input" data-point="${i}" data-field="price"
                     value="${pt.price}" step="0.01">
            </div>
            <div class="dpd-coord-field">
              <label>Date</label>
              <input type="date" class="dpd-coord-input" data-point="${i}" data-field="date"
                     value="${dateStr}">
            </div>
            <div class="dpd-coord-field">
              <label>Time</label>
              <input type="time" class="dpd-coord-input" data-point="${i}" data-field="time"
                     value="${timeStr}" step="1">
            </div>
          </div>
        </div>
      `;
    });

    return html;
  }

  // ── Visibility Tab ─────────────────────────────────────────────────────────

  private renderVisibilityTab(d: Drawing): string {
    const timeframes = ['1s', '5s', '15s', '1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '12h', '1D', '1W', '1M'];
    const visibleOn = (d.properties as any).visibleTimeframes ?? timeframes;

    return `
      <div class="dpd-row">
        <p class="dpd-hint">Choose which timeframes this drawing appears on:</p>
      </div>

      <div class="dpd-vis-grid">
        ${timeframes.map(tf => `
          <label class="dpd-vis-item">
            <input type="checkbox" data-tf="${tf}" ${visibleOn.includes(tf) ? 'checked' : ''}>
            <span>${tf}</span>
          </label>
        `).join('')}
      </div>

      <div class="dpd-row dpd-actions-row">
        <button class="dpd-link-btn" id="dpdVisAll">Select All</button>
        <button class="dpd-link-btn" id="dpdVisNone">Deselect All</button>
      </div>

      <div class="dpd-divider"></div>

      <div class="dpd-row dpd-actions-row">
        <button class="dpd-action-btn dpd-clone-btn">⧉ Clone</button>
        <button class="dpd-action-btn dpd-lock-btn">${d.locked ? '🔓 Unlock' : '🔒 Lock'}</button>
        <button class="dpd-action-btn dpd-delete-btn">🗑 Delete</button>
      </div>
    `;
  }

  // ── Fibonacci Levels Renderer ──────────────────────────────────────────────

  private renderFibLevels(): string {
    const levels = this.fibLevels;
    const half = Math.ceil(levels.length / 2);
    const col1 = levels.slice(0, half);
    const col2 = levels.slice(half);

    const renderLevel = (lvl: FibLevelConfig, idx: number) => `
      <div class="dpd-fib-level">
        <label class="dpd-fib-check">
          <input type="checkbox" data-fib-idx="${idx}" ${lvl.enabled ? 'checked' : ''}>
        </label>
        <input type="number" class="dpd-fib-value" data-fib-idx="${idx}"
               value="${lvl.value}" step="0.001" min="-10" max="100">
        <button class="dpd-fib-color" data-fib-idx="${idx}"
                style="background:${lvl.color}"></button>
      </div>
    `;

    return `
      <div class="dpd-section-label">Levels</div>
      <div class="dpd-fib-grid">
        <div class="dpd-fib-col">
          ${col1.map((l, i) => renderLevel(l, i)).join('')}
        </div>
        <div class="dpd-fib-col">
          ${col2.map((l, i) => renderLevel(l, i + half)).join('')}
        </div>
      </div>
    `;
  }

  // ── Event Binding ──────────────────────────────────────────────────────────

  private bindEvents(): void {
    if (!this.drawing) return;

    // Close button
    this.dialog.querySelector('.dpd-close')?.addEventListener('click', () => this.close());

    // Cancel button
    this.dialog.querySelector('.dpd-cancel-btn')?.addEventListener('click', () => this.close());

    // Ok button
    this.dialog.querySelector('.dpd-ok-btn')?.addEventListener('click', () => this.applyAndClose());

    // Tab switching
    this.dialog.querySelectorAll('.dpd-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        this.activeTab = (tab as HTMLElement).dataset.tab as any;
        this.render();
      });
    });

    // Color swatches
    this.dialog.querySelectorAll('.dpd-color-swatch').forEach(sw => {
      sw.addEventListener('click', () => {
        const color = (sw as HTMLElement).dataset.color!;
        this.editedProps.color = color;
        if (this.editedProps.fillColor !== undefined) {
          this.editedProps.fillColor = color;
        }
        this.dialog.querySelectorAll('.dpd-color-swatch').forEach(s => s.classList.remove('active'));
        sw.classList.add('active');
      });
    });

    // Line width buttons
    this.dialog.querySelectorAll('.dpd-width-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        this.editedProps.lineWidth = Number((btn as HTMLElement).dataset.width);
        this.dialog.querySelectorAll('.dpd-width-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
      });
    });

    // Line style buttons
    this.dialog.querySelectorAll('.dpd-style-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        this.editedProps.lineStyle = (btn as HTMLElement).dataset.style as 'solid' | 'dashed' | 'dotted';
        this.dialog.querySelectorAll('.dpd-style-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
      });
    });

    // Extend dropdown
    const extendSel = this.dialog.querySelector('#dpdExtend') as HTMLSelectElement | null;
    extendSel?.addEventListener('change', () => {
      const v = extendSel.value;
      this.editedProps.extendLeft = v === 'left' || v === 'both';
      this.editedProps.extendRight = v === 'right' || v === 'both';
    });

    // Fill opacity slider
    const opSlider = this.dialog.querySelector('#dpdOpacity') as HTMLInputElement | null;
    const opVal = this.dialog.querySelector('#dpdOpacityVal');
    opSlider?.addEventListener('input', () => {
      const v = Number(opSlider.value) / 100;
      this.editedProps.fillOpacity = v;
      if (opVal) opVal.textContent = `${opSlider.value}%`;
    });

    // Fill enabled toggle
    const fillCheck = this.dialog.querySelector('#dpdFillEnabled') as HTMLInputElement | null;
    fillCheck?.addEventListener('change', () => {
      this.editedProps.fillOpacity = fillCheck.checked ? 0.1 : 0;
    });

    // Show labels toggle
    const labelsCheck = this.dialog.querySelector('#dpdShowLabels') as HTMLInputElement | null;
    labelsCheck?.addEventListener('change', () => {
      this.editedProps.showLabels = labelsCheck.checked;
    });

    // Middle line toggle
    const middleCheck = this.dialog.querySelector('#dpdMiddleLine') as HTMLInputElement | null;
    middleCheck?.addEventListener('change', () => {
      (this.editedProps as any).middleLine = middleCheck.checked;
    });

    // Text input
    const textArea = this.dialog.querySelector('#dpdText') as HTMLTextAreaElement | null;
    textArea?.addEventListener('input', () => {
      this.editedProps.text = textArea.value;
    });

    // Font size slider
    const fontSlider = this.dialog.querySelector('#dpdFontSize') as HTMLInputElement | null;
    const fontVal = this.dialog.querySelector('#dpdFontSizeVal');
    fontSlider?.addEventListener('input', () => {
      this.editedProps.fontSize = Number(fontSlider.value);
      if (fontVal) fontVal.textContent = `${fontSlider.value}px`;
    });

    // Font weight/style toggles
    this.dialog.querySelectorAll('.dpd-toggle-btn[data-weight]').forEach(btn => {
      btn.addEventListener('click', () => {
        (this.editedProps as any).fontWeight = (btn as HTMLElement).dataset.weight;
        this.dialog.querySelectorAll('.dpd-toggle-btn[data-weight]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
      });
    });

    this.dialog.querySelector('.dpd-toggle-btn[data-fontstyle]')?.addEventListener('click', (e) => {
      const btn = e.currentTarget as HTMLElement;
      const isActive = btn.classList.toggle('active');
      (this.editedProps as any).fontStyle = isActive ? 'italic' : 'normal';
    });

    // Fibonacci level checkboxes
    this.dialog.querySelectorAll('input[data-fib-idx]').forEach(input => {
      if ((input as HTMLInputElement).type === 'checkbox') {
        input.addEventListener('change', () => {
          const idx = Number((input as HTMLElement).dataset.fibIdx);
          if (this.fibLevels[idx]) {
            this.fibLevels[idx]!.enabled = (input as HTMLInputElement).checked;
          }
        });
      }
    });

    // Fibonacci level value inputs
    this.dialog.querySelectorAll('.dpd-fib-value').forEach(input => {
      input.addEventListener('change', () => {
        const idx = Number((input as HTMLElement).dataset.fibIdx);
        if (this.fibLevels[idx]) {
          this.fibLevels[idx]!.value = Number((input as HTMLInputElement).value);
        }
      });
    });

    // Visibility checkboxes
    this.dialog.querySelectorAll('.dpd-vis-item input').forEach(input => {
      input.addEventListener('change', () => {
        const checked: string[] = [];
        this.dialog.querySelectorAll('.dpd-vis-item input').forEach(cb => {
          if ((cb as HTMLInputElement).checked) {
            checked.push((cb as HTMLElement).dataset.tf!);
          }
        });
        (this.editedProps as any).visibleTimeframes = checked;
      });
    });

    // Select All / Deselect All
    this.dialog.querySelector('#dpdVisAll')?.addEventListener('click', () => {
      this.dialog.querySelectorAll('.dpd-vis-item input').forEach(cb => {
        (cb as HTMLInputElement).checked = true;
      });
    });
    this.dialog.querySelector('#dpdVisNone')?.addEventListener('click', () => {
      this.dialog.querySelectorAll('.dpd-vis-item input').forEach(cb => {
        (cb as HTMLInputElement).checked = false;
      });
    });

    // Clone / Lock / Delete buttons
    this.dialog.querySelector('.dpd-clone-btn')?.addEventListener('click', () => {
      if (this.drawing) this.onClone(this.drawing.id);
      this.close();
    });
    this.dialog.querySelector('.dpd-lock-btn')?.addEventListener('click', () => {
      if (this.drawing) {
        (this.editedProps as any).locked = !this.drawing.locked;
        this.onChange(this.drawing.id, this.editedProps);
      }
      this.close();
    });
    this.dialog.querySelector('.dpd-delete-btn')?.addEventListener('click', () => {
      if (this.drawing) this.onDelete(this.drawing.id);
      this.close();
    });

    // Coordinate inputs
    this.dialog.querySelectorAll('.dpd-coord-input').forEach(input => {
      input.addEventListener('change', () => {
        const el = input as HTMLInputElement;
        const ptIdx = Number(el.dataset.point);
        const field = el.dataset.field;
        if (!this.drawing || !this.drawing.points[ptIdx]) return;

        const pt = { ...this.drawing.points[ptIdx]! };

        if (field === 'price') {
          pt.price = Number(el.value);
        } else if (field === 'date' || field === 'time') {
          // Reconstruct timestamp from date + time
          const dateInput = this.dialog.querySelector(
            `.dpd-coord-input[data-point="${ptIdx}"][data-field="date"]`
          ) as HTMLInputElement;
          const timeInput = this.dialog.querySelector(
            `.dpd-coord-input[data-point="${ptIdx}"][data-field="time"]`
          ) as HTMLInputElement;
          if (dateInput && timeInput) {
            pt.time = new Date(`${dateInput.value}T${timeInput.value}Z`).getTime();
          }
        }

        // Store updated points
        const newPoints = [...this.drawing.points];
        newPoints[ptIdx] = pt;
        (this.editedProps as any)._updatedPoints = newPoints;
      });
    });
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private parseFibLevels(d: Drawing, defaults: FibLevelConfig[]): FibLevelConfig[] {
    const storedConfigs = (d.properties as any).levelConfigs as FibLevelConfig[] | undefined;
    if (storedConfigs && Array.isArray(storedConfigs)) {
      return storedConfigs.map(c => ({ ...c }));
    }

    // Parse from the simple levels array
    const enabledLevels = new Set(d.properties.levels ?? []);
    return defaults.map(def => ({
      ...def,
      enabled: enabledLevels.has(def.value),
    }));
  }

  private hasExtend(type: DrawingType): boolean {
    return ['ray', 'extended_line', 'trendline', 'fibonacci_retracement', 'fibonacci_extension'].includes(type);
  }

  private hasFill(type: DrawingType): boolean {
    return [
      'rectangle', 'ellipse', 'parallel_channel',
      'fibonacci_retracement', 'fibonacci_extension',
      'price_range', 'date_range',
    ].includes(type);
  }

  private hasLabels(type: DrawingType): boolean {
    return [
      'horizontal_line', 'trendline', 'fibonacci_retracement', 'fibonacci_extension',
      'price_range', 'date_range', 'measure',
    ].includes(type);
  }

  private getLineLabel(type: DrawingType): string {
    if (type === 'rectangle' || type === 'ellipse') return 'Border';
    if (type === 'fibonacci_retracement' || type === 'fibonacci_extension') return 'Levels line';
    return 'Line';
  }

  private getExtendValue(p: DrawingProperties): string {
    if (p.extendLeft && p.extendRight) return 'both';
    if (p.extendLeft) return 'left';
    if (p.extendRight) return 'right';
    return 'none';
  }
}
