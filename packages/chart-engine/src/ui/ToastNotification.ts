/**
 * ToastNotification — Toast notification system.
 *
 * Static container in top-right corner. Supports success, error,
 * warning, info, and alert toast types with auto-dismiss, stacking,
 * and optional sound.
 */

// ─── Types ─────────────────────────────────────────────────────────────────────

export type ToastType = 'success' | 'error' | 'warning' | 'info' | 'alert';

interface QueuedToast {
  type: ToastType;
  title: string;
  message: string;
  duration: number;
}

// ─── Constants ─────────────────────────────────────────────────────────────────

const MAX_VISIBLE = 5;
const DEFAULT_DURATION = 5000;
const ALERT_DURATION = 10000;

const TOAST_ICONS: Record<ToastType, string> = {
  success: '✓',
  error: '✕',
  warning: '⚠',
  info: 'ℹ',
  alert: '🔔',
};

const TOAST_COLORS: Record<ToastType, { border: string; icon: string; bg: string }> = {
  success: { border: '#22c55e', icon: '#22c55e', bg: 'rgba(34, 197, 94, 0.06)' },
  error: { border: '#ef4444', icon: '#ef4444', bg: 'rgba(239, 68, 68, 0.06)' },
  warning: { border: '#f59e0b', icon: '#f59e0b', bg: 'rgba(245, 158, 11, 0.06)' },
  info: { border: '#3b82f6', icon: '#3b82f6', bg: 'rgba(59, 130, 246, 0.06)' },
  alert: { border: '#a855f7', icon: '#a855f7', bg: 'rgba(168, 85, 247, 0.06)' },
};

// Alert chime as a very short base64-encoded WAV (subtle click)
// This is a minimal valid WAV file with a short sine burst
const CHIME_DATA_URI = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=';

// ─── ToastNotification ─────────────────────────────────────────────────────────

export class ToastNotification {
  private static containerEl: HTMLDivElement | null = null;
  private static visibleToasts: HTMLDivElement[] = [];
  private static queue: QueuedToast[] = [];
  private static initialized = false;

  // ── Public Static API ────────────────────────────────────────────────────

  static success(title: string, msg: string): void {
    ToastNotification.enqueue('success', title, msg, DEFAULT_DURATION);
  }

  static error(title: string, msg: string): void {
    ToastNotification.enqueue('error', title, msg, DEFAULT_DURATION);
  }

  static warning(title: string, msg: string): void {
    ToastNotification.enqueue('warning', title, msg, DEFAULT_DURATION);
  }

  static info(title: string, msg: string): void {
    ToastNotification.enqueue('info', title, msg, DEFAULT_DURATION);
  }

  static alert(title: string, msg: string, duration?: number): void {
    ToastNotification.enqueue('alert', title, msg, duration ?? ALERT_DURATION);
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private static ensureContainer(): void {
    if (ToastNotification.initialized && ToastNotification.containerEl) return;

    // Check for existing container from styles.css
    let existing = document.getElementById('toastContainer') as HTMLDivElement | null;
    if (!existing) {
      existing = document.createElement('div');
      existing.id = 'toastContainer';
      Object.assign(existing.style, {
        position: 'fixed',
        top: '56px',
        right: '12px',
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
        zIndex: '9999',
        pointerEvents: 'none',
        maxWidth: '380px',
        width: '100%',
      } as Partial<CSSStyleDeclaration>);
      document.body.appendChild(existing);
    }

    ToastNotification.containerEl = existing;
    ToastNotification.initialized = true;
  }

  private static enqueue(type: ToastType, title: string, message: string, duration: number): void {
    ToastNotification.ensureContainer();

    if (ToastNotification.visibleToasts.length >= MAX_VISIBLE) {
      ToastNotification.queue.push({ type, title, message, duration });
      return;
    }

    ToastNotification.showToast(type, title, message, duration);
  }

  private static showToast(type: ToastType, title: string, message: string, duration: number): void {
    const colors = TOAST_COLORS[type];
    const icon = TOAST_ICONS[type];

    const toast = document.createElement('div');
    Object.assign(toast.style, {
      background: '#111827',
      color: '#e5e7eb',
      border: `1px solid #374151`,
      borderLeft: `3px solid ${colors.border}`,
      borderRadius: '6px',
      padding: '10px 14px',
      fontSize: '13px',
      boxShadow: '0 8px 24px rgba(0, 0, 0, 0.4)',
      transform: 'translateX(120%)',
      opacity: '0',
      transition: 'transform 250ms ease, opacity 250ms ease',
      pointerEvents: 'auto',
      display: 'flex',
      alignItems: 'flex-start',
      gap: '10px',
      maxWidth: '380px',
      backgroundColor: colors.bg,
    } as Partial<CSSStyleDeclaration>);

    // Icon
    const iconEl = document.createElement('div');
    Object.assign(iconEl.style, {
      flexShrink: '0',
      width: '20px',
      height: '20px',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontSize: '14px',
      color: colors.icon,
      fontWeight: '700',
    } as Partial<CSSStyleDeclaration>);
    iconEl.textContent = icon;
    toast.appendChild(iconEl);

    // Content
    const content = document.createElement('div');
    Object.assign(content.style, { flex: '1', minWidth: '0' });

    const titleEl = document.createElement('div');
    Object.assign(titleEl.style, {
      fontWeight: '600',
      fontSize: '13px',
      color: '#e5e7eb',
      marginBottom: '2px',
    });
    titleEl.textContent = title;
    content.appendChild(titleEl);

    if (message) {
      const msgEl = document.createElement('div');
      Object.assign(msgEl.style, {
        fontSize: '12px',
        color: '#9ca3af',
        lineHeight: '1.4',
      });
      msgEl.textContent = message;
      content.appendChild(msgEl);
    }

    toast.appendChild(content);

    // Close button
    const closeBtn = document.createElement('button');
    Object.assign(closeBtn.style, {
      appearance: 'none',
      border: 'none',
      background: 'transparent',
      color: '#6b7280',
      fontSize: '14px',
      cursor: 'pointer',
      padding: '0',
      lineHeight: '1',
      flexShrink: '0',
      width: '18px',
      height: '18px',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: '3px',
      transition: 'color 150ms ease, background 150ms ease',
    } as Partial<CSSStyleDeclaration>);
    closeBtn.textContent = '✕';
    closeBtn.addEventListener('mouseenter', () => {
      closeBtn.style.color = '#e5e7eb';
      closeBtn.style.background = '#1f2937';
    });
    closeBtn.addEventListener('mouseleave', () => {
      closeBtn.style.color = '#6b7280';
      closeBtn.style.background = 'transparent';
    });
    closeBtn.addEventListener('click', () => ToastNotification.dismissToast(toast));
    toast.appendChild(closeBtn);

    // Add to container
    ToastNotification.containerEl!.appendChild(toast);
    ToastNotification.visibleToasts.push(toast);

    // Animate in
    requestAnimationFrame(() => {
      toast.style.transform = 'translateX(0)';
      toast.style.opacity = '1';
    });

    // Play chime for alert type
    if (type === 'alert') {
      ToastNotification.playChime();
    }

    // Auto dismiss
    const timerId = window.setTimeout(() => {
      ToastNotification.dismissToast(toast);
    }, duration);

    // Store timer so we can cancel on manual close
    (toast as any).__dismissTimer = timerId;
  }

  private static dismissToast(toast: HTMLDivElement): void {
    // Cancel auto-dismiss timer
    const timerId = (toast as any).__dismissTimer;
    if (timerId) clearTimeout(timerId);

    // Animate out (fade up)
    toast.style.transform = 'translateX(120%)';
    toast.style.opacity = '0';
    toast.style.marginTop = `-${toast.offsetHeight + 8}px`;
    toast.style.transition = 'transform 250ms ease, opacity 250ms ease, margin-top 250ms ease';

    setTimeout(() => {
      toast.remove();
      const idx = ToastNotification.visibleToasts.indexOf(toast);
      if (idx >= 0) ToastNotification.visibleToasts.splice(idx, 1);

      // Drain queue
      if (ToastNotification.queue.length > 0 && ToastNotification.visibleToasts.length < MAX_VISIBLE) {
        const next = ToastNotification.queue.shift()!;
        ToastNotification.showToast(next.type, next.title, next.message, next.duration);
      }
    }, 250);
  }

  private static playChime(): void {
    try {
      const audio = new Audio(CHIME_DATA_URI);
      audio.volume = 0.3;
      audio.play().catch(() => {
        // Autoplay blocked — ignore
      });
    } catch {
      // Audio not supported
    }
  }
}
