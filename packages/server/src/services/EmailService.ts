/**
 * EmailService — Email alert delivery via SendGrid.
 *
 * Sends formatted HTML alert emails with branded templates,
 * batching for digest emails, and automatic retry on failure.
 */

import { config } from '../config';
import { logger } from '../utils/logger';

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface EmailAlert {
  symbol: string;
  condition: string;
  price: number;
  time: number;
  chartUrl?: string;
}

interface PendingDigest {
  alerts: EmailAlert[];
  timer: ReturnType<typeof setTimeout>;
}

// ─── Constants ─────────────────────────────────────────────────────────────────

const SENDGRID_API_URL = 'https://api.sendgrid.com/v3/mail/send';
const FROM_EMAIL = 'alerts@pinned.trade';
const FROM_NAME = 'Pinned Alerts';
const DIGEST_WINDOW_MS = 60_000; // 60 seconds
const RETRY_DELAY_MS = 2000;

// ─── Service ───────────────────────────────────────────────────────────────────

class EmailService {
  private digestQueue = new Map<string, PendingDigest>();

  private get apiKey(): string {
    if (!config.SENDGRID_API_KEY) {
      throw new Error('SENDGRID_API_KEY is not configured');
    }
    return config.SENDGRID_API_KEY;
  }

  // ── Send Alert Email (with digest batching) ───────────────────────────

  async sendAlertEmail(to: string, alert: EmailAlert): Promise<void> {
    const pending = this.digestQueue.get(to);

    if (pending) {
      // Already have a pending digest for this user — add to batch
      pending.alerts.push(alert);
      logger.debug('EmailService: alert added to digest batch', {
        to,
        count: pending.alerts.length,
      });
      return;
    }

    // Start a new digest window
    const digest: PendingDigest = {
      alerts: [alert],
      timer: setTimeout(async () => {
        this.digestQueue.delete(to);
        const alerts = digest.alerts;

        if (alerts.length === 1) {
          await this.sendSingleAlert(to, alerts[0]);
        } else {
          await this.sendDigest(to, alerts);
        }
      }, DIGEST_WINDOW_MS),
    };

    this.digestQueue.set(to, digest);
  }

  // ── Immediate Single Alert ────────────────────────────────────────────

  private async sendSingleAlert(to: string, alert: EmailAlert): Promise<void> {
    const subject = `🔔 Alert: ${alert.symbol} — ${alert.condition}`;
    const html = this.buildSingleAlertHtml(alert);
    await this.send(to, subject, html);
  }

  // ── Digest Email ──────────────────────────────────────────────────────

  private async sendDigest(to: string, alerts: EmailAlert[]): Promise<void> {
    const symbols = [...new Set(alerts.map((a) => a.symbol))].join(', ');
    const subject = `🔔 ${alerts.length} Alerts: ${symbols}`;
    const html = this.buildDigestHtml(alerts);
    await this.send(to, subject, html);
  }

  // ── Send via SendGrid (with retry) ────────────────────────────────────

  private async send(to: string, subject: string, html: string): Promise<boolean> {
    const payload = {
      personalizations: [{ to: [{ email: to }] }],
      from: { email: FROM_EMAIL, name: FROM_NAME },
      subject,
      content: [{ type: 'text/html', value: html }],
    };

    try {
      const res = await fetch(SENDGRID_API_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      if (res.status >= 200 && res.status < 300) {
        logger.info('EmailService: email sent', { to, subject });
        return true;
      }

      const errorBody = await res.text();
      logger.warn('EmailService: send failed, retrying', {
        status: res.status,
        error: errorBody,
        to,
      });

      return this.retrySend(to, subject, html);
    } catch (err) {
      logger.error('EmailService: send error, retrying', {
        error: String(err),
        to,
      });
      return this.retrySend(to, subject, html);
    }
  }

  private async retrySend(to: string, subject: string, html: string): Promise<boolean> {
    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));

    const payload = {
      personalizations: [{ to: [{ email: to }] }],
      from: { email: FROM_EMAIL, name: FROM_NAME },
      subject,
      content: [{ type: 'text/html', value: html }],
    };

    try {
      const res = await fetch(SENDGRID_API_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      if (res.status >= 200 && res.status < 300) {
        logger.info('EmailService: retry succeeded', { to });
        return true;
      }

      const errorBody = await res.text();
      logger.error('EmailService: retry failed', {
        status: res.status,
        error: errorBody,
        to,
      });
      return false;
    } catch (err) {
      logger.error('EmailService: retry error', { error: String(err), to });
      return false;
    }
  }

  // ── HTML Templates ────────────────────────────────────────────────────

  private buildSingleAlertHtml(alert: EmailAlert): string {
    const priceStr = alert.price.toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 8,
    });
    const timeStr = new Date(alert.time).toUTCString();
    const chartUrl = alert.chartUrl || `https://app.pinned.trade/chart/${encodeURIComponent(alert.symbol)}`;

    return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="margin:0; padding:0; background:#0a0e17; font-family:Inter,system-ui,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="max-width:600px; margin:0 auto;">
    <!-- Header -->
    <tr>
      <td style="padding:24px 32px; background:#111827; border-bottom:2px solid #6366f1;">
        <img src="https://app.pinned.trade/logo.png" alt="Pinned" width="120" style="display:block;" />
      </td>
    </tr>
    <!-- Body -->
    <tr>
      <td style="padding:32px; background:#111827;">
        <h1 style="color:#f9fafb; font-size:20px; margin:0 0 24px;">🔔 Alert Triggered</h1>
        <table width="100%" cellpadding="8" cellspacing="0" style="border:1px solid #374151; border-radius:8px; border-collapse:collapse;">
          <tr style="border-bottom:1px solid #374151;">
            <td style="color:#9ca3af; font-size:13px; width:120px;">Symbol</td>
            <td style="color:#f9fafb; font-size:14px; font-weight:600;">${this.escapeHtml(alert.symbol)}</td>
          </tr>
          <tr style="border-bottom:1px solid #374151;">
            <td style="color:#9ca3af; font-size:13px;">Condition</td>
            <td style="color:#f9fafb; font-size:14px;">${this.escapeHtml(alert.condition)}</td>
          </tr>
          <tr style="border-bottom:1px solid #374151;">
            <td style="color:#9ca3af; font-size:13px;">Price</td>
            <td style="color:#10b981; font-size:14px; font-weight:600;">$${priceStr}</td>
          </tr>
          <tr>
            <td style="color:#9ca3af; font-size:13px;">Time</td>
            <td style="color:#f9fafb; font-size:14px;">${timeStr}</td>
          </tr>
        </table>
        <!-- CTA -->
        <div style="margin-top:24px; text-align:center;">
          <a href="${chartUrl}" style="display:inline-block; padding:12px 32px; background:#6366f1; color:#fff; font-size:14px; font-weight:600; text-decoration:none; border-radius:6px;">
            📈 Open Chart
          </a>
        </div>
      </td>
    </tr>
    <!-- Footer -->
    <tr>
      <td style="padding:16px 32px; background:#0a0e17; text-align:center;">
        <p style="color:#6b7280; font-size:11px; margin:0;">
          You received this because you have alerts enabled on Pinned.
          <a href="https://app.pinned.trade/settings/notifications" style="color:#6366f1; text-decoration:underline;">Unsubscribe</a>
        </p>
      </td>
    </tr>
  </table>
</body>
</html>`.trim();
  }

  private buildDigestHtml(alerts: EmailAlert[]): string {
    const rows = alerts
      .map((alert) => {
        const priceStr = alert.price.toLocaleString('en-US', {
          minimumFractionDigits: 2,
          maximumFractionDigits: 8,
        });
        const timeStr = new Date(alert.time).toISOString().slice(11, 19) + ' UTC';
        return `
          <tr style="border-bottom:1px solid #374151;">
            <td style="padding:8px; color:#f9fafb; font-size:13px; font-weight:600;">${this.escapeHtml(alert.symbol)}</td>
            <td style="padding:8px; color:#f9fafb; font-size:13px;">${this.escapeHtml(alert.condition)}</td>
            <td style="padding:8px; color:#10b981; font-size:13px;">$${priceStr}</td>
            <td style="padding:8px; color:#9ca3af; font-size:12px;">${timeStr}</td>
          </tr>`;
      })
      .join('');

    return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="margin:0; padding:0; background:#0a0e17; font-family:Inter,system-ui,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="max-width:600px; margin:0 auto;">
    <tr>
      <td style="padding:24px 32px; background:#111827; border-bottom:2px solid #6366f1;">
        <img src="https://app.pinned.trade/logo.png" alt="Pinned" width="120" style="display:block;" />
      </td>
    </tr>
    <tr>
      <td style="padding:32px; background:#111827;">
        <h1 style="color:#f9fafb; font-size:20px; margin:0 0 8px;">🔔 Alert Digest</h1>
        <p style="color:#9ca3af; font-size:13px; margin:0 0 24px;">${alerts.length} alerts triggered in the last minute</p>
        <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #374151; border-radius:8px; border-collapse:collapse;">
          <tr style="border-bottom:2px solid #374151;">
            <th style="padding:8px; color:#6b7280; font-size:11px; text-align:left; text-transform:uppercase;">Symbol</th>
            <th style="padding:8px; color:#6b7280; font-size:11px; text-align:left; text-transform:uppercase;">Condition</th>
            <th style="padding:8px; color:#6b7280; font-size:11px; text-align:left; text-transform:uppercase;">Price</th>
            <th style="padding:8px; color:#6b7280; font-size:11px; text-align:left; text-transform:uppercase;">Time</th>
          </tr>
          ${rows}
        </table>
        <div style="margin-top:24px; text-align:center;">
          <a href="https://app.pinned.trade/alerts" style="display:inline-block; padding:12px 32px; background:#6366f1; color:#fff; font-size:14px; font-weight:600; text-decoration:none; border-radius:6px;">
            View All Alerts
          </a>
        </div>
      </td>
    </tr>
    <tr>
      <td style="padding:16px 32px; background:#0a0e17; text-align:center;">
        <p style="color:#6b7280; font-size:11px; margin:0;">
          You received this because you have alerts enabled on Pinned.
          <a href="https://app.pinned.trade/settings/notifications" style="color:#6366f1; text-decoration:underline;">Unsubscribe</a>
        </p>
      </td>
    </tr>
  </table>
</body>
</html>`.trim();
  }

  private escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
}

export const emailService = new EmailService();
