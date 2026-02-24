/**
 * ToolBar.ts
 * TradingView-style floating toolbar for drawing tools.
 * Displays tool categories with expandable sub-menus.
 * Features: hover tooltips, keyboard shortcuts, active state,
 * favoriting, and smooth animations.
 */

import {
  DRAWING_TOOLS,
  TOOL_CATEGORIES,
  getToolsByCategory,
  getToolById,
  getToolByShortcut,
  TOOL_COLORS,
  LINE_WIDTHS,
  type ToolDefinition,
  type ToolCategory,
} from '../drawing/DrawingTools';

export type ToolBarCallback = (toolId: string | null) => void;

export class ToolBar {
  private container: HTMLElement;
  private el: HTMLElement;
  private activeToolId: string | null = null;
  private onToolSelect: ToolBarCallback;
  private expandedCategory: ToolCategory | null = null;
  private submenuEl: HTMLElement | null = null;
  private favorites: Set<string> = new Set(['hline', 'trendline', 'rectangle', 'fibonacci', 'measure']);
  private keyHandler: (e: KeyboardEvent) => void;

  constructor(container: HTMLElement, onToolSelect: ToolBarCallback) {
    this.container = container;
    this.onToolSelect = onToolSelect;
    this.el = document.createElement('div');
    this.el.className = 'tool-bar';
    this.container.appendChild(this.el);
    this.render();
    this.keyHandler = this.handleKeyDown.bind(this);
    window.addEventListener('keydown', this.keyHandler);
    // Close submenu on click outside
    document.addEventListener('mousedown', (e) => {
      if (!this.el.contains(e.target as Node) && this.submenuEl && !this.submenuEl.contains(e.target as Node)) {
        this.closeSubmenu();
      }
    });
  }

  // ── Public API ─────────────────────────────────────────────────────────

  getActiveTool(): string | null { return this.activeToolId; }

  setActiveTool(id: string | null): void {
    this.activeToolId = id;
    this.updateActiveState();
  }

  destroy(): void {
    window.removeEventListener('keydown', this.keyHandler);
    this.el.remove();
    this.submenuEl?.remove();
  }

  // ── Render ─────────────────────────────────────────────────────────────

  private render(): void {
    this.el.innerHTML = '';

    // Pointer / Select tool (always first)
    this.addToolButton({
      id: '_pointer',
      label: 'Select / Move',
      icon: `<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" stroke="none"><path d="M5 3l14 8-6 2-4 6z"/></svg>`,
      shortcut: 'Esc',
      isPointer: true,
    });

    this.addSeparator();

    // Category buttons with most-recently-used tool displayed
    for (const cat of TOOL_CATEGORIES) {
      this.addCategoryButton(cat.id, cat.label);
    }

    this.addSeparator();

    // Eraser
    this.addToolButton({
      id: '_eraser',
      label: 'Delete Drawing',
      icon: `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M18 13l-5 5H7l-3-3 9-9 5 5z"/><line x1="13" y1="18" x2="21" y2="18"/></svg>`,
      shortcut: 'Del',
      isEraser: true,
    });

    // Crosshair toggle
    this.addToolButton({
      id: '_crosshair',
      label: 'Crosshair',
      icon: `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.5"><line x1="12" y1="2" x2="12" y2="22" stroke-dasharray="3 2"/><line x1="2" y1="12" x2="22" y2="12" stroke-dasharray="3 2"/><circle cx="12" cy="12" r="3"/></svg>`,
      shortcut: 'Space',
      isCrosshair: true,
    });
  }

  private addToolButton(opts: {
    id: string;
    label: string;
    icon: string;
    shortcut?: string;
    isPointer?: boolean;
    isEraser?: boolean;
    isCrosshair?: boolean;
  }): void {
    const btn = document.createElement('button');
    btn.className = 'tb-btn';
    btn.dataset.toolId = opts.id;
    btn.title = opts.label + (opts.shortcut ? ` (${opts.shortcut})` : '');
    btn.innerHTML = `
      <span class="tb-icon">${opts.icon}</span>
      <span class="tb-tooltip">${opts.label}${opts.shortcut ? `<kbd>${opts.shortcut}</kbd>` : ''}</span>
    `;

    if (opts.isPointer) {
      btn.classList.add('tb-pointer');
      btn.addEventListener('click', () => {
        this.selectTool(null);
      });
    } else if (opts.isEraser) {
      btn.addEventListener('click', () => {
        this.onToolSelect('_eraser');
      });
    } else if (opts.isCrosshair) {
      btn.addEventListener('click', () => {
        this.onToolSelect('_crosshair');
      });
    }

    this.el.appendChild(btn);
  }

  private addCategoryButton(category: ToolCategory, label: string): void {
    const tools = getToolsByCategory(category);
    if (tools.length === 0) return;

    // Show the first favorited tool in this category, or the first tool
    const displayTool = tools.find(t => this.favorites.has(t.id)) || tools[0]!;

    const btn = document.createElement('button');
    btn.className = 'tb-btn tb-category';
    btn.dataset.category = category;
    btn.dataset.toolId = displayTool.id;
    btn.title = `${label} — ${displayTool.label}`;
    btn.innerHTML = `
      <span class="tb-icon">${displayTool.icon}</span>
      <span class="tb-expand-dot"></span>
      <span class="tb-tooltip">${displayTool.label}${displayTool.shortcut ? `<kbd>${displayTool.shortcut}</kbd>` : ''}</span>
    `;

    // Left click = use displayed tool
    btn.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('.tb-expand-dot')) {
        this.toggleSubmenu(category, btn);
        return;
      }
      this.selectTool(displayTool.id);
      this.closeSubmenu();
    });

    // Right click or long press = open submenu
    btn.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this.toggleSubmenu(category, btn);
    });

    // Expand dot click
    const dot = btn.querySelector('.tb-expand-dot');
    if (dot) {
      dot.addEventListener('click', (e) => {
        e.stopPropagation();
        this.toggleSubmenu(category, btn);
      });
    }

    this.el.appendChild(btn);
  }

  private addSeparator(): void {
    const sep = document.createElement('div');
    sep.className = 'tb-separator';
    this.el.appendChild(sep);
  }

  // ── Submenu ────────────────────────────────────────────────────────────

  private toggleSubmenu(category: ToolCategory, anchorBtn: HTMLElement): void {
    if (this.expandedCategory === category) {
      this.closeSubmenu();
      return;
    }
    this.closeSubmenu();
    this.expandedCategory = category;

    const tools = getToolsByCategory(category);
    const sub = document.createElement('div');
    sub.className = 'tb-submenu';

    // Position relative to anchor button
    const rect = anchorBtn.getBoundingClientRect();
    sub.style.top = `${rect.top}px`;
    sub.style.left = `${rect.right + 8}px`;

    for (const tool of tools) {
      const item = document.createElement('button');
      item.className = 'tb-sub-item';
      if (tool.id === this.activeToolId) item.classList.add('active');
      item.innerHTML = `
        <span class="tb-sub-icon">${tool.icon}</span>
        <span class="tb-sub-label">${tool.label}</span>
        ${tool.shortcut ? `<kbd class="tb-sub-shortcut">${tool.shortcut}</kbd>` : ''}
      `;
      item.addEventListener('click', () => {
        this.selectTool(tool.id);
        this.closeSubmenu();
        // Update category button to show this tool
        anchorBtn.querySelector('.tb-icon')!.innerHTML = tool.icon;
        anchorBtn.dataset.toolId = tool.id;
        anchorBtn.title = `${tool.label}${tool.shortcut ? ` (${tool.shortcut})` : ''}`;
      });
      sub.appendChild(item);
    }

    document.body.appendChild(sub);
    this.submenuEl = sub;

    // Animate in
    requestAnimationFrame(() => sub.classList.add('visible'));
  }

  private closeSubmenu(): void {
    if (this.submenuEl) {
      this.submenuEl.remove();
      this.submenuEl = null;
    }
    this.expandedCategory = null;
  }

  // ── Selection ──────────────────────────────────────────────────────────

  private selectTool(id: string | null): void {
    this.activeToolId = id;
    this.updateActiveState();
    this.onToolSelect(id);
  }

  private updateActiveState(): void {
    this.el.querySelectorAll('.tb-btn').forEach(btn => {
      const btnEl = btn as HTMLElement;
      const isActive = btnEl.dataset.toolId === this.activeToolId;
      const isPointer = btnEl.classList.contains('tb-pointer') && this.activeToolId === null;
      btnEl.classList.toggle('active', isActive || isPointer);
    });
  }

  // ── Keyboard ───────────────────────────────────────────────────────────

  private handleKeyDown(e: KeyboardEvent): void {
    if ((e.target as HTMLElement).tagName === 'INPUT' || (e.target as HTMLElement).tagName === 'TEXTAREA') return;

    if (e.key === 'Escape') {
      this.selectTool(null);
      return;
    }

    if (e.key === 'Delete' || e.key === 'Backspace') {
      this.onToolSelect('_delete');
      return;
    }

    if (e.key === ' ') {
      e.preventDefault();
      this.onToolSelect('_crosshair');
      return;
    }

    // Check tool shortcuts
    const toolId = getToolByShortcut(e.key);
    if (toolId && !e.ctrlKey && !e.metaKey && !e.altKey) {
      this.selectTool(toolId);
    }
  }
}
