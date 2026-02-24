/**
 * AdaptiveLayoutMemory.ts
 * The platform watches which panels you actually use and hides the ones
 * you don't after 7 days. Quietly asks "You haven't used the DOM heatmap
 * in 2 weeks — hide it?" Learns your workflow.
 *
 * No other trading platform does this.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export interface PanelUsage {
  panelId: string;
  label: string;
  lastUsed: number;        // timestamp
  totalActivations: number;
  totalTimeMs: number;     // total time panel was open
  lastSessionStart: number;
}

export interface AdaptiveCallbacks {
  onSuggestHide: (panelId: string, label: string, daysSinceUsed: number) => void;
  onAutoHide: (panelId: string) => void;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const STORAGE_KEY = 'pinned_panel_usage';
const SUGGEST_AFTER_DAYS = 7;     // Suggest hiding after 7 days of non-use
const AUTO_HIDE_AFTER_DAYS = 30;  // Auto-hide after 30 days (with undo option)
const CHECK_INTERVAL = 60_000;    // Check every minute

// ─── AdaptiveLayoutMemory ────────────────────────────────────────────────────

export class AdaptiveLayoutMemory {
  private usage: Map<string, PanelUsage> = new Map();
  private callbacks: AdaptiveCallbacks;
  private checkTimer: ReturnType<typeof setInterval> | null = null;
  private dismissed: Set<string> = new Set(); // Panels where user dismissed suggestion

  constructor(callbacks: AdaptiveCallbacks) {
    this.callbacks = callbacks;
    this.loadUsage();
  }

  // ── Public API ─────────────────────────────────────────────────────────

  /**
   * Register a panel so we can track its usage.
   */
  registerPanel(panelId: string, label: string): void {
    if (!this.usage.has(panelId)) {
      this.usage.set(panelId, {
        panelId,
        label,
        lastUsed: 0,
        totalActivations: 0,
        totalTimeMs: 0,
        lastSessionStart: 0,
      });
    }
  }

  /**
   * Record that a panel was activated (opened/toggled on).
   */
  recordActivation(panelId: string): void {
    const u = this.usage.get(panelId);
    if (!u) return;
    u.lastUsed = Date.now();
    u.totalActivations++;
    u.lastSessionStart = Date.now();
    this.saveUsage();
  }

  /**
   * Record that a panel was deactivated (closed/toggled off).
   */
  recordDeactivation(panelId: string): void {
    const u = this.usage.get(panelId);
    if (!u) return;
    if (u.lastSessionStart > 0) {
      u.totalTimeMs += Date.now() - u.lastSessionStart;
      u.lastSessionStart = 0;
    }
    this.saveUsage();
  }

  /**
   * Start periodic checks for underused panels.
   */
  startMonitoring(): void {
    this.stopMonitoring();
    this.checkTimer = setInterval(() => this.checkUnderusedPanels(), CHECK_INTERVAL);
    // Initial check
    setTimeout(() => this.checkUnderusedPanels(), 5000);
  }

  stopMonitoring(): void {
    if (this.checkTimer) {
      clearInterval(this.checkTimer);
      this.checkTimer = null;
    }
  }

  /**
   * User dismissed the "hide this panel?" suggestion for a panel.
   * Don't suggest again this session.
   */
  dismissSuggestion(panelId: string): void {
    this.dismissed.add(panelId);
    // Update last used so we don't re-suggest immediately
    const u = this.usage.get(panelId);
    if (u) u.lastUsed = Date.now();
    this.saveUsage();
  }

  /**
   * Get usage stats for all panels — useful for the Settings panel.
   */
  getUsageStats(): PanelUsage[] {
    return [...this.usage.values()].sort((a, b) => b.totalActivations - a.totalActivations);
  }

  /**
   * Get the most-used panels (for adaptive defaults).
   */
  getMostUsedPanels(topN: number = 5): string[] {
    return [...this.usage.values()]
      .sort((a, b) => b.totalActivations - a.totalActivations)
      .slice(0, topN)
      .map((u) => u.panelId);
  }

  destroy(): void {
    this.stopMonitoring();
  }

  // ── Internals ──────────────────────────────────────────────────────────

  private checkUnderusedPanels(): void {
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;

    for (const [id, usage] of this.usage) {
      if (this.dismissed.has(id)) continue;
      if (usage.lastUsed === 0) continue; // Never used — don't suggest; might be new

      const daysSinceUsed = (now - usage.lastUsed) / dayMs;

      if (daysSinceUsed >= AUTO_HIDE_AFTER_DAYS) {
        this.callbacks.onAutoHide(id);
      } else if (daysSinceUsed >= SUGGEST_AFTER_DAYS) {
        this.callbacks.onSuggestHide(id, usage.label, Math.floor(daysSinceUsed));
      }
    }
  }

  // ── Persistence ────────────────────────────────────────────────────────

  private loadUsage(): void {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const arr: PanelUsage[] = JSON.parse(raw);
        for (const u of arr) this.usage.set(u.panelId, u);
      }
    } catch { /* ignore */ }
  }

  private saveUsage(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify([...this.usage.values()]));
    } catch { /* ignore */ }
  }
}
