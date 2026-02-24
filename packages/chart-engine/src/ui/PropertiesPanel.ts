/**
 * PropertiesPanel.ts
 * Floating properties panel for editing selected drawing attributes.
 * Appears when a drawing is selected. Shows color picker, line width,
 * line style, opacity, and type-specific controls (fib levels, text, etc).
 */

import type { Drawing, DrawingProperties } from '../core/ChartState';
import { TOOL_COLORS, LINE_WIDTHS } from '../drawing/DrawingTools';

export type PropertiesCallback = (drawingId: string, props: Partial<DrawingProperties>) => void;
export type DeleteCallback = (drawingId: string) => void;

export class PropertiesPanel {
  private el: HTMLElement;
  private currentDrawing: Drawing | null = null;
  private onChange: PropertiesCallback;
  private onDelete: DeleteCallback;

  constructor(onChange: PropertiesCallback, onDelete: DeleteCallback) {
    this.onChange = onChange;
    this.onDelete = onDelete;

    this.el = document.createElement('div');
    this.el.className = 'props-panel';
    this.el.style.display = 'none';
    document.body.appendChild(this.el);
  }

  show(drawing: Drawing, anchorX: number, anchorY: number): void {
    this.currentDrawing = drawing;
    this.render();
    this.el.style.display = '';

    // Position near the drawing but not off-screen
    const w = 260;
    const h = this.el.offsetHeight || 200;
    const x = Math.min(anchorX + 20, window.innerWidth - w - 16);
    const y = Math.min(anchorY - 20, window.innerHeight - h - 16);
    this.el.style.left = `${Math.max(8, x)}px`;
    this.el.style.top = `${Math.max(8, y)}px`;

    requestAnimationFrame(() => this.el.classList.add('visible'));
  }

  hide(): void {
    this.el.classList.remove('visible');
    this.el.style.display = 'none';
    this.currentDrawing = null;
  }

  isVisible(): boolean {
    return this.el.style.display !== 'none';
  }

  destroy(): void {
    this.el.remove();
  }

  private render(): void {
    if (!this.currentDrawing) return;
    const d = this.currentDrawing;
    const p = d.properties;

    this.el.innerHTML = `
      <div class="pp-header">
        <span class="pp-title">${this.getTypeLabel(d.type)}</span>
        <button class="pp-close" title="Close">✕</button>
      </div>

      <div class="pp-section">
        <label class="pp-label">Color</label>
        <div class="pp-colors">
          ${TOOL_COLORS.map(c => `
            <button class="pp-color-swatch${c === p.color ? ' active' : ''}"
                    style="background:${c}" data-color="${c}" title="${c}"></button>
          `).join('')}
        </div>
      </div>

      <div class="pp-section pp-row">
        <div class="pp-field">
          <label class="pp-label">Width</label>
          <div class="pp-widths">
            ${LINE_WIDTHS.map(w => `
              <button class="pp-width-btn${w === (p.lineWidth ?? 1) ? ' active' : ''}"
                      data-width="${w}">
                <span style="height:${w}px"></span>
              </button>
            `).join('')}
          </div>
        </div>
        <div class="pp-field">
          <label class="pp-label">Style</label>
          <div class="pp-styles">
            ${(['solid', 'dashed', 'dotted'] as const).map(s => `
              <button class="pp-style-btn${s === (p.lineStyle ?? 'solid') ? ' active' : ''}"
                      data-style="${s}" title="${s}">
                <svg width="32" height="4" viewBox="0 0 32 4">
                  <line x1="0" y1="2" x2="32" y2="2" stroke="currentColor" stroke-width="2"
                        ${s === 'dashed' ? 'stroke-dasharray="6 4"' : ''}
                        ${s === 'dotted' ? 'stroke-dasharray="2 3"' : ''}/>
                </svg>
              </button>
            `).join('')}
          </div>
        </div>
      </div>

      ${p.fillColor !== undefined ? `
        <div class="pp-section pp-row">
          <div class="pp-field" style="flex:1">
            <label class="pp-label">Fill Opacity</label>
            <input type="range" class="pp-range" id="ppOpacity"
                   min="0" max="100" step="1"
                   value="${Math.round((p.fillOpacity ?? 0.1) * 100)}">
          </div>
          <span class="pp-range-val" id="ppOpacityVal">${Math.round((p.fillOpacity ?? 0.1) * 100)}%</span>
        </div>
      ` : ''}

      ${d.type === 'text' ? `
        <div class="pp-section">
          <label class="pp-label">Text</label>
          <input type="text" class="pp-text-input" id="ppText"
                 value="${p.text ?? ''}" placeholder="Type note…">
        </div>
        <div class="pp-section">
          <label class="pp-label">Font Size</label>
          <input type="range" class="pp-range" id="ppFontSize"
                 min="8" max="36" step="1" value="${p.fontSize ?? 14}">
        </div>
      ` : ''}

      <div class="pp-section pp-actions">
        <button class="pp-btn pp-clone" title="Clone">⧉ Clone</button>
        <button class="pp-btn pp-lock" title="Lock/Unlock">${d.locked ? '🔓 Unlock' : '🔒 Lock'}</button>
        <button class="pp-btn pp-delete" title="Delete">🗑 Delete</button>
      </div>
    `;

    this.bindEvents();
  }

  private bindEvents(): void {
    if (!this.currentDrawing) return;
    const id = this.currentDrawing.id;

    // Close
    this.el.querySelector('.pp-close')?.addEventListener('click', () => this.hide());

    // Colors
    this.el.querySelectorAll('.pp-color-swatch').forEach(sw => {
      sw.addEventListener('click', () => {
        const color = (sw as HTMLElement).dataset.color!;
        this.onChange(id, { color, fillColor: color });
        this.el.querySelectorAll('.pp-color-swatch').forEach(s => s.classList.remove('active'));
        sw.classList.add('active');
      });
    });

    // Line width
    this.el.querySelectorAll('.pp-width-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const lw = Number((btn as HTMLElement).dataset.width);
        this.onChange(id, { lineWidth: lw });
        this.el.querySelectorAll('.pp-width-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
      });
    });

    // Line style
    this.el.querySelectorAll('.pp-style-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const style = (btn as HTMLElement).dataset.style as DrawingProperties['lineStyle'];
        this.onChange(id, { lineStyle: style });
        this.el.querySelectorAll('.pp-style-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
      });
    });

    // Opacity
    const opSlider = this.el.querySelector('#ppOpacity') as HTMLInputElement | null;
    const opVal = this.el.querySelector('#ppOpacityVal');
    opSlider?.addEventListener('input', () => {
      const v = Number(opSlider.value) / 100;
      this.onChange(id, { fillOpacity: v });
      if (opVal) opVal.textContent = `${opSlider.value}%`;
    });

    // Text
    const textInput = this.el.querySelector('#ppText') as HTMLInputElement | null;
    textInput?.addEventListener('input', () => {
      this.onChange(id, { text: textInput.value });
    });

    // Font size
    const fontSize = this.el.querySelector('#ppFontSize') as HTMLInputElement | null;
    fontSize?.addEventListener('input', () => {
      this.onChange(id, { fontSize: Number(fontSize.value) });
    });

    // Delete
    this.el.querySelector('.pp-delete')?.addEventListener('click', () => {
      this.onDelete(id);
      this.hide();
    });

    // Clone
    this.el.querySelector('.pp-clone')?.addEventListener('click', () => {
      this.onChange(id, {}); // trigger a clone action via special handling
    });
  }

  private getTypeLabel(type: string): string {
    const labels: Record<string, string> = {
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
    };
    return labels[type] ?? type;
  }
}
