/**
 * OrderFlowSidebar.ts
 * Right sidebar panel with tab-switching between OrderBook, Trades, and Patterns.
 * Integrates OrderBookPanel, TradesPanel, and a PatternFeed display.
 */

import { OrderBookPanel } from './OrderBookPanel';
import { TradesPanel, type Trade } from './TradesPanel';
import type { OrderbookSnapshot } from '../core/DataManager';

// ─── Types ───────────────────────────────────────────────────────────────────

export type SidebarTab = 'orderbook' | 'trades' | 'patterns';

export interface PatternFeedItem {
  type: 'iceberg' | 'spoof' | 'absorption';
  time: number;
  price: number;
  confidence: number;
  direction: 'bid' | 'ask';
  estimatedSize?: number;
}

// ─── OrderFlowSidebar ────────────────────────────────────────────────────────

export class OrderFlowSidebar {
  private container: HTMLElement | null = null;
  private wrapperEl: HTMLDivElement | null = null;
  private tabContentEl: HTMLDivElement | null = null;
  private tabBtns: HTMLButtonElement[] = [];

  private activeTab: SidebarTab = 'orderbook';
  private visible = false;

  // Sub-panels
  private orderbookPanel: OrderBookPanel | null = null;
  private tradesPanel: TradesPanel | null = null;

  // Pattern feed
  private patternFeedEl: HTMLDivElement | null = null;
  private patternItems: PatternFeedItem[] = [];

  // Panel containers (kept alive for tab switching)
  private orderbookContainer: HTMLDivElement | null = null;
  private tradesContainer: HTMLDivElement | null = null;
  private patternsContainer: HTMLDivElement | null = null;

  // ── Public API ─────────────────────────────────────────────────────────

  mount(container: HTMLElement): void {
    this.container = container;
    this.buildDOM();
    this.initPanels();
    this.switchTab(this.activeTab);
  }

  show(): void {
    this.visible = true;
    if (this.wrapperEl) this.wrapperEl.style.display = 'flex';
  }

  hide(): void {
    this.visible = false;
    if (this.wrapperEl) this.wrapperEl.style.display = 'none';
  }

  toggle(): void {
    this.visible ? this.hide() : this.show();
  }

  isVisible(): boolean {
    return this.visible;
  }

  /** Feed orderbook snapshot to the OrderBook panel */
  updateOrderbook(snapshot: OrderbookSnapshot): void {
    this.orderbookPanel?.update(snapshot);
  }

  /** Feed a trade to the Trades panel */
  addTrade(trade: Trade): void {
    this.tradesPanel?.addTrade(trade);
  }

  /** Feed a big trade to the Trades panel */
  addBigTrade(bigTrade: {
    exchange: string;
    symbol: string;
    side: 'buy' | 'sell';
    price: number;
    quantity: number;
    usdValue: number;
    timestamp: number;
  }): void {
    this.tradesPanel?.addBigTrade(bigTrade);
  }

  /** Update absorption meter in the OrderBook panel */
  setAbsorption(value: number): void {
    this.orderbookPanel?.setAbsorption(value);
  }

  /** Add a pattern event to the pattern feed */
  addPattern(item: PatternFeedItem): void {
    this.patternItems.unshift(item);
    if (this.patternItems.length > 100) {
      this.patternItems = this.patternItems.slice(0, 80);
    }
    this.renderPatternFeed();
  }

  destroy(): void {
    this.orderbookPanel?.destroy();
    this.tradesPanel?.destroy();
    if (this.wrapperEl && this.container) {
      this.container.removeChild(this.wrapperEl);
    }
    this.wrapperEl = null;
    this.tabContentEl = null;
    this.container = null;
  }

  // ── DOM Construction ───────────────────────────────────────────────────

  private buildDOM(): void {
    if (!this.container) return;

    this.wrapperEl = document.createElement('div');
    this.wrapperEl.className = 'of-sidebar';
    Object.assign(this.wrapperEl.style, {
      display: 'none',
      flexDirection: 'column',
      width: '280px',
      minWidth: '280px',
      height: '100%',
      background: '#0d1117',
      borderLeft: '1px solid #21262d',
      overflow: 'hidden',
    } as Partial<CSSStyleDeclaration>);

    // Tab bar
    const tabBar = document.createElement('div');
    tabBar.className = 'of-sidebar__tabs';
    Object.assign(tabBar.style, {
      display: 'flex',
      borderBottom: '1px solid #21262d',
      background: '#0d1117',
      flexShrink: '0',
    } as Partial<CSSStyleDeclaration>);

    const tabs: { label: string; value: SidebarTab; icon: string }[] = [
      { label: 'Book', value: 'orderbook', icon: '📊' },
      { label: 'Trades', value: 'trades', icon: '📈' },
      { label: 'Patterns', value: 'patterns', icon: '🔍' },
    ];

    for (const tab of tabs) {
      const btn = document.createElement('button');
      btn.className = 'of-sidebar__tab';
      btn.dataset.tab = tab.value;
      btn.innerHTML = `<span style="margin-right:3px">${tab.icon}</span>${tab.label}`;
      Object.assign(btn.style, {
        flex: '1',
        appearance: 'none',
        border: 'none',
        borderBottom: '2px solid transparent',
        background: 'transparent',
        color: '#8b949e',
        fontFamily: 'Inter, sans-serif',
        fontSize: '11px',
        fontWeight: '500',
        padding: '8px 4px',
        cursor: 'pointer',
        transition: 'all 150ms ease',
      } as Partial<CSSStyleDeclaration>);
      btn.addEventListener('click', () => this.switchTab(tab.value));
      tabBar.appendChild(btn);
      this.tabBtns.push(btn);
    }

    this.wrapperEl.appendChild(tabBar);

    // Tab content area
    this.tabContentEl = document.createElement('div');
    Object.assign(this.tabContentEl.style, {
      flex: '1',
      overflow: 'hidden',
      position: 'relative',
    } as Partial<CSSStyleDeclaration>);

    // Create tab containers
    this.orderbookContainer = this.createTabPanel();
    this.tradesContainer = this.createTabPanel();
    this.patternsContainer = this.createTabPanel();

    this.tabContentEl.appendChild(this.orderbookContainer);
    this.tabContentEl.appendChild(this.tradesContainer);
    this.tabContentEl.appendChild(this.patternsContainer);

    this.wrapperEl.appendChild(this.tabContentEl);
    this.container.appendChild(this.wrapperEl);
  }

  private createTabPanel(): HTMLDivElement {
    const panel = document.createElement('div');
    Object.assign(panel.style, {
      position: 'absolute',
      top: '0',
      left: '0',
      right: '0',
      bottom: '0',
      display: 'none',
      overflow: 'hidden',
    } as Partial<CSSStyleDeclaration>);
    return panel;
  }

  private initPanels(): void {
    if (!this.orderbookContainer || !this.tradesContainer || !this.patternsContainer) return;

    this.orderbookPanel = new OrderBookPanel();
    this.orderbookPanel.mount(this.orderbookContainer);

    this.tradesPanel = new TradesPanel();
    this.tradesPanel.mount(this.tradesContainer);

    // Pattern feed
    this.patternFeedEl = document.createElement('div');
    Object.assign(this.patternFeedEl.style, {
      height: '100%',
      overflowY: 'auto',
      padding: '8px',
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: '11px',
    } as Partial<CSSStyleDeclaration>);

    const feedTitle = document.createElement('div');
    Object.assign(feedTitle.style, {
      fontSize: '10px',
      color: '#6b7280',
      textTransform: 'uppercase',
      letterSpacing: '0.05em',
      marginBottom: '8px',
      fontWeight: '600',
    } as Partial<CSSStyleDeclaration>);
    feedTitle.textContent = 'Pattern Detection Feed';
    this.patternFeedEl.appendChild(feedTitle);

    this.patternsContainer.appendChild(this.patternFeedEl);
  }

  // ── Tab Switching ──────────────────────────────────────────────────────

  private switchTab(tab: SidebarTab): void {
    this.activeTab = tab;

    // Update button styles
    for (const btn of this.tabBtns) {
      const isActive = btn.dataset.tab === tab;
      btn.style.color = isActive ? '#e6edf3' : '#8b949e';
      btn.style.borderBottom = isActive ? '2px solid #6366f1' : '2px solid transparent';
      btn.style.background = isActive ? 'rgba(99, 102, 241, 0.06)' : 'transparent';
    }

    // Show/hide panels
    if (this.orderbookContainer) this.orderbookContainer.style.display = tab === 'orderbook' ? 'block' : 'none';
    if (this.tradesContainer) this.tradesContainer.style.display = tab === 'trades' ? 'block' : 'none';
    if (this.patternsContainer) this.patternsContainer.style.display = tab === 'patterns' ? 'block' : 'none';
  }

  // ── Pattern Feed Rendering ─────────────────────────────────────────────

  private renderPatternFeed(): void {
    if (!this.patternFeedEl) return;

    // Keep title, remove old items
    while (this.patternFeedEl.children.length > 1) {
      this.patternFeedEl.removeChild(this.patternFeedEl.lastChild!);
    }

    if (this.patternItems.length === 0) {
      const empty = document.createElement('div');
      empty.style.color = '#484f58';
      empty.style.textAlign = 'center';
      empty.style.padding = '24px';
      empty.textContent = 'No patterns detected yet';
      this.patternFeedEl.appendChild(empty);
      return;
    }

    for (const item of this.patternItems.slice(0, 50)) {
      const row = document.createElement('div');
      Object.assign(row.style, {
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        padding: '4px 6px',
        marginBottom: '2px',
        borderRadius: '4px',
        background: 'rgba(255,255,255,0.02)',
        transition: 'background 150ms',
      } as Partial<CSSStyleDeclaration>);

      // Type badge
      const badge = document.createElement('span');
      const colors: Record<string, string> = {
        iceberg: '#3b82f6',
        spoof: '#f97316',
        absorption: '#22c55e',
      };
      const icons: Record<string, string> = {
        iceberg: '⬡',
        spoof: '⚡',
        absorption: '◉',
      };
      Object.assign(badge.style, {
        fontSize: '8px',
        fontWeight: '700',
        textTransform: 'uppercase',
        padding: '1px 4px',
        borderRadius: '2px',
        background: `${colors[item.type] ?? '#6366f1'}20`,
        color: colors[item.type] ?? '#6366f1',
        flexShrink: '0',
      } as Partial<CSSStyleDeclaration>);
      badge.textContent = `${icons[item.type] ?? '●'} ${item.type.substring(0, 3).toUpperCase()}`;
      row.appendChild(badge);

      // Price
      const priceEl = document.createElement('span');
      priceEl.style.color = '#e5e7eb';
      priceEl.style.flex = '1';
      priceEl.textContent = item.price.toFixed(2);
      row.appendChild(priceEl);

      // Confidence
      const confEl = document.createElement('span');
      confEl.style.color = '#6b7280';
      confEl.style.fontSize = '10px';
      confEl.textContent = `${Math.round(item.confidence * 100)}%`;
      row.appendChild(confEl);

      // Time
      const timeEl = document.createElement('span');
      timeEl.style.color = '#484f58';
      timeEl.style.fontSize = '10px';
      timeEl.style.flexShrink = '0';
      const d = new Date(item.time);
      timeEl.textContent = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
      row.appendChild(timeEl);

      this.patternFeedEl.appendChild(row);
    }
  }
}
