/**
 * TelegramService — Telegram alert delivery.
 *
 * Sends formatted alert messages via the Telegram Bot API with
 * rate limiting (max 30 msg/s) and automatic retry on failure.
 */

import { config } from '../config';
import { pool } from '../db';
import { logger } from '../utils/logger';

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface TelegramAlert {
  symbol: string;
  condition: string;
  price: number;
  time: number;
}

// ─── Constants ─────────────────────────────────────────────────────────────────

const TELEGRAM_API_BASE = 'https://api.telegram.org/bot';
const RATE_LIMIT_PER_SECOND = 30;
const RETRY_DELAY_MS = 1500;

// ─── Rate Limiter ──────────────────────────────────────────────────────────────

class RateLimiter {
  private timestamps: number[] = [];
  private readonly maxPerSecond: number;

  constructor(maxPerSecond: number) {
    this.maxPerSecond = maxPerSecond;
  }

  async acquire(): Promise<void> {
    const now = Date.now();
    // Remove timestamps older than 1 second
    this.timestamps = this.timestamps.filter((t) => now - t < 1000);

    if (this.timestamps.length >= this.maxPerSecond) {
      const oldest = this.timestamps[0];
      const waitMs = 1000 - (now - oldest);
      if (waitMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      }
    }

    this.timestamps.push(Date.now());
  }
}

// ─── Service ───────────────────────────────────────────────────────────────────

class TelegramService {
  private rateLimiter = new RateLimiter(RATE_LIMIT_PER_SECOND);

  private get botToken(): string {
    if (!config.TELEGRAM_BOT_TOKEN) {
      throw new Error('TELEGRAM_BOT_TOKEN is not configured');
    }
    return config.TELEGRAM_BOT_TOKEN;
  }

  private get apiBase(): string {
    return `${TELEGRAM_API_BASE}${this.botToken}`;
  }

  // ── Send Alert ─────────────────────────────────────────────────────────

  async sendAlert(chatId: string, alert: TelegramAlert): Promise<boolean> {
    const message = this.formatAlertMessage(alert);
    return this.sendMessage(chatId, message);
  }

  // ── Register User ─────────────────────────────────────────────────────

  async registerUser(authToken: string, chatId: string): Promise<boolean> {
    try {
      // Verify the auth token maps to a valid user
      const result = await pool.query<{ id: string }>(
        `SELECT id FROM users WHERE telegram_auth_token = $1`,
        [authToken],
      );

      if (result.rows.length === 0) {
        logger.warn('TelegramService: invalid auth token for registration', {
          chatId,
        });
        return false;
      }

      const userId = result.rows[0].id;

      // Store the chatId for the user
      await pool.query(
        `UPDATE users SET telegram_chat_id = $1, updated_at = NOW() WHERE id = $2`,
        [chatId, userId],
      );

      logger.info('TelegramService: user registered', { userId, chatId });

      // Send confirmation message
      await this.sendMessage(
        chatId,
        '✅ <b>Pinned Alerts Connected</b>\n\nYou will now receive trading alerts here.',
      );

      return true;
    } catch (err) {
      logger.error('TelegramService: registration failed', {
        error: String(err),
        chatId,
      });
      return false;
    }
  }

  // ── Format Message ────────────────────────────────────────────────────

  private formatAlertMessage(alert: TelegramAlert): string {
    const symbolEmoji = this.getSymbolEmoji(alert.symbol);
    const timeStr = new Date(alert.time).toUTCString();
    const priceStr = alert.price.toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 8,
    });

    const chartLink = `https://app.pinned.trade/chart/${encodeURIComponent(alert.symbol)}`;

    return [
      `${symbolEmoji} <b>${this.escapeHtml(alert.symbol)}</b>`,
      '',
      `📋 <b>Condition:</b> ${this.escapeHtml(alert.condition)}`,
      `💰 <b>Price:</b> $${priceStr}`,
      `🕐 <b>Time:</b> ${timeStr}`,
      '',
      `<a href="${chartLink}">📈 Open Chart</a>`,
    ].join('\n');
  }

  private getSymbolEmoji(symbol: string): string {
    const s = symbol.toUpperCase();
    if (s.includes('BTC')) return '🟠';
    if (s.includes('ETH')) return '🔷';
    if (s.includes('SOL')) return '🟣';
    if (s.includes('XRP')) return '⚪';
    return '📊';
  }

  private escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ── Send Message (with rate limit & retry) ────────────────────────────

  private async sendMessage(chatId: string, text: string): Promise<boolean> {
    await this.rateLimiter.acquire();

    const url = `${this.apiBase}/sendMessage`;
    const body = {
      chat_id: chatId,
      text,
      parse_mode: 'HTML' as const,
      disable_web_page_preview: true,
    };

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (res.ok) {
        return true;
      }

      const errorBody = await res.text();
      logger.warn('TelegramService: send failed, retrying', {
        status: res.status,
        error: errorBody,
        chatId,
      });

      // Retry once after delay
      return this.retrySend(url, body);
    } catch (err) {
      logger.error('TelegramService: send error, retrying', {
        error: String(err),
        chatId,
      });

      return this.retrySend(url, body);
    }
  }

  private async retrySend(url: string, body: object): Promise<boolean> {
    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    await this.rateLimiter.acquire();

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (res.ok) {
        return true;
      }

      const errorBody = await res.text();
      logger.error('TelegramService: retry failed', {
        status: res.status,
        error: errorBody,
      });
      return false;
    } catch (err) {
      logger.error('TelegramService: retry error', { error: String(err) });
      return false;
    }
  }
}

export const telegramService = new TelegramService();
