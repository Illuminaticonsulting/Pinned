/**
 * ContextMenu.ts
 * TradingView-style right-click context menu for the chart canvas.
 */

export interface ContextMenuItem {
  label: string;
  icon?: string;
  shortcut?: string;
  action?: () => void;
  separator?: boolean;
  submenu?: ContextMenuItem[];
  checked?: boolean;
  disabled?: boolean;
}

export class ContextMenu {
  private overlay: HTMLElement | null = null;

  show(x: number, y: number, items: ContextMenuItem[]): void {
    this.hide();

    this.overlay = document.createElement('div');
    this.overlay.className = 'ctx-overlay';
    this.overlay.addEventListener('click', () => this.hide());
    this.overlay.addEventListener('contextmenu', (e) => { e.preventDefault(); this.hide(); });

    const menu = this.buildMenu(items);
    // Position and clamp to viewport
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    menu.style.left = `${Math.min(x, vw - 220)}px`;
    menu.style.top = `${Math.min(y, vh - 300)}px`;

    this.overlay.appendChild(menu);
    document.body.appendChild(this.overlay);
  }

  hide(): void {
    this.overlay?.remove();
    this.overlay = null;
  }

  private buildMenu(items: ContextMenuItem[]): HTMLElement {
    const menu = document.createElement('div');
    menu.className = 'ctx-menu';

    for (const item of items) {
      if (item.separator) {
        const sep = document.createElement('div');
        sep.className = 'ctx-sep';
        menu.appendChild(sep);
        continue;
      }

      const el = document.createElement('button');
      el.className = 'ctx-item';
      if (item.disabled) el.classList.add('ctx-item--disabled');
      if (item.checked) el.classList.add('ctx-item--checked');

      let html = '';
      if (item.icon) {
        html += `<span class="ctx-icon">${item.icon}</span>`;
      } else if (item.checked !== undefined) {
        html += `<span class="ctx-icon">${item.checked ? '✓' : ''}</span>`;
      } else {
        html += `<span class="ctx-icon"></span>`;
      }

      html += `<span class="ctx-label">${item.label}</span>`;

      if (item.shortcut) {
        html += `<span class="ctx-shortcut">${item.shortcut}</span>`;
      }

      if (item.submenu) {
        html += `<span class="ctx-arrow">›</span>`;
      }

      el.innerHTML = html;

      if (item.action && !item.disabled) {
        el.addEventListener('click', (e) => {
          e.stopPropagation();
          item.action!();
          this.hide();
        });
      }

      if (item.submenu) {
        const sub = this.buildMenu(item.submenu);
        sub.className += ' ctx-submenu';
        el.appendChild(sub);
        el.addEventListener('mouseenter', () => {
          sub.style.display = 'block';
          // Position submenu to the right
          const rect = el.getBoundingClientRect();
          sub.style.left = `${rect.width - 4}px`;
          sub.style.top = '0';
        });
        el.addEventListener('mouseleave', () => {
          sub.style.display = 'none';
        });
      }

      menu.appendChild(el);
    }

    return menu;
  }
}
