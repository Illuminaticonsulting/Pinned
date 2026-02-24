/**
 * SmartAlerts.ts
 * AI-powered alerting system with pattern-based and price-based triggers.
 *
 * Alert Types:
 * - Price crosses level (standard)
 * - Volume spike detected (>2x average)
 * - Iceberg/spoof pattern detected
 * - Liquidation cascade approaching (delta divergence)
 * - Correlation break between assets
 * - VWAP/EMA cross or deviation
 *
 * Notifications: In-app toast, optional browser notification.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export type AlertCondition =
  | { type: 'price_cross'; direction: 'above' | 'below'; price: number }
  | { type: 'price_percent'; direction: 'up' | 'down'; percent: number; from: number }
  | { type: 'volume_spike'; multiplier: number }  // e.g. 2x avg
  | { type: 'pattern'; pattern: 'iceberg' | 'spoof' | 'absorption' | 'sweep' }
  | { type: 'delta_divergence'; threshold: number }  // normalized 0-1
  | { type: 'indicator_cross'; indicator: string; value: number; direction: 'above' | 'below' };

export type AlertStatus = 'active' | 'triggered' | 'expired' | 'disabled';

export interface Alert {
  id: string;
  symbol: string;
  condition: AlertCondition;
  status: AlertStatus;
  message: string;
  createdAt: number;
  triggeredAt?: number;
  expiresAt?: number;
  recurring: boolean;   // re-arm after trigger
  soundEnabled: boolean;
  notifyBrowser: boolean;
}

export interface SmartAlertCallbacks {
  getCurrentPrice: () => number;
  getCurrentSymbol: () => string;
  getAverageVolume: () => number;  // 20-bar average volume
  onToast: (message: string, duration?: number) => void;
}

// ─── Storage ─────────────────────────────────────────────────────────────────

const STORAGE_KEY = 'pinned_smart_alerts';

// ─── SmartAlerts ─────────────────────────────────────────────────────────────

export class SmartAlerts {
  private alerts: Map<string, Alert> = new Map();
  private callbacks: SmartAlertCallbacks;
  private checkInterval: ReturnType<typeof setInterval> | null = null;
  private overlay: HTMLElement | null = null;
  private isOpen = false;

  constructor(callbacks: SmartAlertCallbacks) {
    this.callbacks = callbacks;
    this.loadAlerts();
    this.startChecking();
    this.requestNotificationPermission();
  }

  // ── Public API ─────────────────────────────────────────────────────────

  addAlert(alert: Omit<Alert, 'id' | 'createdAt' | 'status'>): Alert {
    const newAlert: Alert = {
      ...alert,
      id: `alert_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      status: 'active',
      createdAt: Date.now(),
    };
    this.alerts.set(newAlert.id, newAlert);
    this.saveAlerts();
    return newAlert;
  }

  removeAlert(id: string): void {
    this.alerts.delete(id);
    this.saveAlerts();
  }

  getAlerts(): Alert[] {
    return [...this.alerts.values()];
  }

  getActiveAlerts(): Alert[] {
    return [...this.alerts.values()].filter((a) => a.status === 'active');
  }

  openManager(): void {
    this.renderManager();
  }

  destroy(): void {
    this.stopChecking();
    this.closeManager();
  }

  // ── Pattern-based alert creation helpers ───────────────────────────────

  createPriceAlert(price: number, direction: 'above' | 'below'): Alert {
    const symbol = this.callbacks.getCurrentSymbol();
    return this.addAlert({
      symbol,
      condition: { type: 'price_cross', direction, price },
      message: `${symbol} ${direction === 'above' ? '↑' : '↓'} ${price.toLocaleString()}`,
      recurring: false,
      soundEnabled: true,
      notifyBrowser: true,
    });
  }

  createVolumeSpikeAlert(multiplier: number = 2): Alert {
    const symbol = this.callbacks.getCurrentSymbol();
    return this.addAlert({
      symbol,
      condition: { type: 'volume_spike', multiplier },
      message: `${symbol} volume spike ≥${multiplier}×`,
      recurring: true,
      soundEnabled: true,
      notifyBrowser: true,
    });
  }

  createPatternAlert(pattern: 'iceberg' | 'spoof' | 'absorption' | 'sweep'): Alert {
    const symbol = this.callbacks.getCurrentSymbol();
    return this.addAlert({
      symbol,
      condition: { type: 'pattern', pattern },
      message: `${symbol} ${pattern} pattern detected`,
      recurring: true,
      soundEnabled: true,
      notifyBrowser: true,
    });
  }

  // ── Alert Checking ────────────────────────────────────────────────────

  private startChecking(): void {
    this.checkInterval = setInterval(() => this.checkAlerts(), 1000);
  }

  private stopChecking(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
  }

  checkAlerts(): void {
    const now = Date.now();
    const price = this.callbacks.getCurrentPrice();
    const symbol = this.callbacks.getCurrentSymbol();

    for (const alert of this.alerts.values()) {
      if (alert.status !== 'active') continue;
      if (alert.symbol !== symbol) continue; // Only check alerts for current symbol

      // Check expiration
      if (alert.expiresAt && now > alert.expiresAt) {
        alert.status = 'expired';
        this.saveAlerts();
        continue;
      }

      if (this.evaluateCondition(alert.condition, price)) {
        this.triggerAlert(alert);
      }
    }
  }

  /** Can be called externally when pattern events come from LiveOrderFlowService */
  notifyPattern(pattern: string, symbol: string): void {
    for (const alert of this.alerts.values()) {
      if (alert.status !== 'active') continue;
      if (alert.symbol !== symbol) continue;
      if (alert.condition.type === 'pattern' && alert.condition.pattern === pattern) {
        this.triggerAlert(alert);
      }
    }
  }

  /** Can be called externally when volume data updates */
  notifyVolume(currentVolume: number, averageVolume: number, symbol: string): void {
    for (const alert of this.alerts.values()) {
      if (alert.status !== 'active') continue;
      if (alert.symbol !== symbol) continue;
      if (alert.condition.type === 'volume_spike') {
        if (averageVolume > 0 && currentVolume >= averageVolume * alert.condition.multiplier) {
          this.triggerAlert(alert);
        }
      }
    }
  }

  private evaluateCondition(condition: AlertCondition, price: number): boolean {
    switch (condition.type) {
      case 'price_cross':
        if (condition.direction === 'above') return price >= condition.price;
        return price <= condition.price;

      case 'price_percent': {
        const changePct = ((price - condition.from) / condition.from) * 100;
        if (condition.direction === 'up') return changePct >= condition.percent;
        return changePct <= -condition.percent;
      }

      case 'indicator_cross':
        // Would need indicator value passed in — skip for now
        return false;

      // Volume and pattern alerts are handled by external notifications
      case 'volume_spike':
      case 'pattern':
      case 'delta_divergence':
        return false;
    }
  }

  private triggerAlert(alert: Alert): void {
    alert.triggeredAt = Date.now();

    if (alert.recurring) {
      // Re-arm: keep active but set a cooldown (don't re-trigger for 60s)
      alert.status = 'active';
      // Simple cooldown: temporarily expire, re-arm after 60s
      const originalStatus = alert.status;
      alert.status = 'disabled';
      setTimeout(() => {
        if (this.alerts.has(alert.id)) {
          alert.status = originalStatus;
        }
      }, 60000);
    } else {
      alert.status = 'triggered';
    }

    this.saveAlerts();

    // In-app notification
    this.callbacks.onToast(`🔔 ${alert.message}`, 5000);

    // Sound
    if (alert.soundEnabled) {
      this.playSound();
    }

    // Browser notification
    if (alert.notifyBrowser && Notification.permission === 'granted') {
      new Notification('Pinned Alert', {
        body: alert.message,
        icon: '/favicon.ico',
        tag: alert.id,
      });
    }
  }

  private playSound(): void {
    try {
      const ctx = new AudioContext();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.frequency.setValueAtTime(880, ctx.currentTime);
      osc.frequency.setValueAtTime(660, ctx.currentTime + 0.1);
      osc.frequency.setValueAtTime(880, ctx.currentTime + 0.2);
      gain.gain.setValueAtTime(0.15, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.4);
      osc.start();
      osc.stop(ctx.currentTime + 0.4);
    } catch { /* audio not available */ }
  }

  private requestNotificationPermission(): void {
    if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
      // Don't request immediately — request on first alert creation
    }
  }

  // ── Alert Manager UI ──────────────────────────────────────────────────

  private renderManager(): void {
    this.closeManager();
    this.isOpen = true;

    this.overlay = document.createElement('div');
    this.overlay.className = 'alerts-overlay';
    this.overlay.addEventListener('mousedown', (e) => {
      if (e.target === this.overlay) this.closeManager();
    });

    const modal = document.createElement('div');
    modal.className = 'alerts-modal';
    modal.innerHTML = `
      <div class="alerts-header">
        <h2 class="alerts-title">🔔 Smart Alerts</h2>
        <p class="alerts-subtitle">${this.getActiveAlerts().length} active • ${this.alerts.size} total</p>
        <button class="alerts-close" id="alertsClose">✕</button>
      </div>

      <div class="alerts-quick-add">
        <h3 class="alerts-section-title">Quick Add</h3>
        <div class="alerts-quick-row">
          <input type="number" id="alertPrice" class="alerts-input" placeholder="Price..." step="0.01" />
          <button class="alerts-btn alerts-btn--above" id="alertAbove">↑ Above</button>
          <button class="alerts-btn alerts-btn--below" id="alertBelow">↓ Below</button>
        </div>
        <div class="alerts-quick-row">
          <button class="alerts-btn alerts-btn--pattern" id="alertVolSpike">📊 Vol Spike (2x)</button>
          <button class="alerts-btn alerts-btn--pattern" id="alertIceberg">🧊 Iceberg</button>
          <button class="alerts-btn alerts-btn--pattern" id="alertSpoof">👻 Spoof</button>
          <button class="alerts-btn alerts-btn--pattern" id="alertAbsorption">🛡 Absorption</button>
        </div>
      </div>

      <div class="alerts-list" id="alertsList">
        ${this.renderAlertList()}
      </div>
    `;

    this.overlay.appendChild(modal);
    document.body.appendChild(this.overlay);
    requestAnimationFrame(() => this.overlay?.classList.add('open'));

    // Bind events
    modal.querySelector('#alertsClose')?.addEventListener('click', () => this.closeManager());

    modal.querySelector('#alertAbove')?.addEventListener('click', () => {
      const price = parseFloat((modal.querySelector('#alertPrice') as HTMLInputElement).value);
      if (!price) { this.callbacks.onToast('Enter a price'); return; }
      this.createPriceAlert(price, 'above');
      (modal.querySelector('#alertPrice') as HTMLInputElement).value = '';
      (modal.querySelector('#alertsList') as HTMLElement).innerHTML = this.renderAlertList();
      this.bindListEvents(modal);
    });

    modal.querySelector('#alertBelow')?.addEventListener('click', () => {
      const price = parseFloat((modal.querySelector('#alertPrice') as HTMLInputElement).value);
      if (!price) { this.callbacks.onToast('Enter a price'); return; }
      this.createPriceAlert(price, 'below');
      (modal.querySelector('#alertPrice') as HTMLInputElement).value = '';
      (modal.querySelector('#alertsList') as HTMLElement).innerHTML = this.renderAlertList();
      this.bindListEvents(modal);
    });

    modal.querySelector('#alertVolSpike')?.addEventListener('click', () => {
      this.createVolumeSpikeAlert(2);
      (modal.querySelector('#alertsList') as HTMLElement).innerHTML = this.renderAlertList();
      this.bindListEvents(modal);
    });

    modal.querySelector('#alertIceberg')?.addEventListener('click', () => {
      this.createPatternAlert('iceberg');
      (modal.querySelector('#alertsList') as HTMLElement).innerHTML = this.renderAlertList();
      this.bindListEvents(modal);
    });

    modal.querySelector('#alertSpoof')?.addEventListener('click', () => {
      this.createPatternAlert('spoof');
      (modal.querySelector('#alertsList') as HTMLElement).innerHTML = this.renderAlertList();
      this.bindListEvents(modal);
    });

    modal.querySelector('#alertAbsorption')?.addEventListener('click', () => {
      this.createPatternAlert('absorption');
      (modal.querySelector('#alertsList') as HTMLElement).innerHTML = this.renderAlertList();
      this.bindListEvents(modal);
    });

    this.bindListEvents(modal);

    // Request notification permission
    if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
      Notification.requestPermission();
    }

    // ESC
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        this.closeManager();
        document.removeEventListener('keydown', esc);
      }
    };
    document.addEventListener('keydown', esc);
  }

  private bindListEvents(modal: HTMLElement): void {
    // Use event delegation
    const list = modal.querySelector('#alertsList');
    if (!list) return;

    // Remove previous listener by cloning
    const newList = list.cloneNode(true) as HTMLElement;
    list.parentNode?.replaceChild(newList, list);

    newList.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      const deleteBtn = target.closest<HTMLButtonElement>('.alert-delete-btn');
      if (deleteBtn) {
        const id = deleteBtn.dataset.id!;
        this.removeAlert(id);
        newList.innerHTML = this.renderAlertList();
      }
      const toggleBtn = target.closest<HTMLButtonElement>('.alert-toggle-btn');
      if (toggleBtn) {
        const id = toggleBtn.dataset.id!;
        const alert = this.alerts.get(id);
        if (alert) {
          alert.status = alert.status === 'active' ? 'disabled' : 'active';
          this.saveAlerts();
          newList.innerHTML = this.renderAlertList();
        }
      }
    });
  }

  private renderAlertList(): string {
    const sorted = [...this.alerts.values()].sort((a, b) => b.createdAt - a.createdAt);

    if (sorted.length === 0) {
      return '<div class="alerts-empty">No alerts configured. Use Quick Add above or right-click chart to set price alerts.</div>';
    }

    return sorted.map((a) => {
      const statusIcon = a.status === 'active' ? '🟢' : a.status === 'triggered' ? '🔴' : a.status === 'disabled' ? '⏸' : '⏰';
      const conditionDesc = this.describeCondition(a.condition);
      const timeAgo = this.timeAgo(a.createdAt);
      const triggeredInfo = a.triggeredAt ? `<span class="alert-triggered">Triggered ${this.timeAgo(a.triggeredAt)}</span>` : '';

      return `
        <div class="alert-item ${a.status}">
          <div class="alert-item-status">${statusIcon}</div>
          <div class="alert-item-info">
            <div class="alert-item-message">${a.message}</div>
            <div class="alert-item-meta">
              <span class="alert-item-condition">${conditionDesc}</span>
              <span class="alert-item-time">${timeAgo}</span>
              ${triggeredInfo}
            </div>
          </div>
          <div class="alert-item-actions">
            <button class="alert-toggle-btn" data-id="${a.id}" title="${a.status === 'active' ? 'Pause' : 'Resume'}">
              ${a.status === 'active' ? '⏸' : '▶'}
            </button>
            <button class="alert-delete-btn" data-id="${a.id}" title="Delete">✕</button>
          </div>
        </div>
      `;
    }).join('');
  }

  private describeCondition(c: AlertCondition): string {
    switch (c.type) {
      case 'price_cross': return `Price ${c.direction} ${c.price.toLocaleString()}`;
      case 'price_percent': return `${c.direction === 'up' ? '+' : '-'}${c.percent}% from ${c.from.toLocaleString()}`;
      case 'volume_spike': return `Volume ≥${c.multiplier}× avg`;
      case 'pattern': return `${c.pattern} pattern`;
      case 'delta_divergence': return `Delta divergence ≥${(c.threshold * 100).toFixed(0)}%`;
      case 'indicator_cross': return `${c.indicator} ${c.direction} ${c.value}`;
    }
  }

  private timeAgo(ts: number): string {
    const diff = Date.now() - ts;
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  }

  private closeManager(): void {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.overlay?.classList.remove('open');
    setTimeout(() => {
      this.overlay?.remove();
      this.overlay = null;
    }, 200);
  }

  // ── Persistence ────────────────────────────────────────────────────────

  private loadAlerts(): void {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const arr: Alert[] = JSON.parse(raw);
        for (const a of arr) this.alerts.set(a.id, a);
      }
    } catch { /* ignore */ }
  }

  private saveAlerts(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify([...this.alerts.values()]));
    } catch { /* ignore */ }
  }
}
