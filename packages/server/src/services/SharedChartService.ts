/**
 * SharedChartService — Shared chart link service.
 *
 * Generates short unique IDs for sharable chart snapshots,
 * stores serialised chart state in the database, and tracks view counts.
 */

import crypto from 'crypto';
import { pool } from '../db';
import { logger } from '../utils/logger';

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface SharedChart {
  id: string;
  userId: string;
  state: Record<string, unknown>;
  viewCount: number;
  createdAt: string;
}

export interface ShareResult {
  id: string;
  url: string;
}

// ─── Service ───────────────────────────────────────────────────────────────────

class SharedChartService {
  // ── ID Generation ──────────────────────────────────────────────────────

  private generateId(): string {
    const bytes = crypto.randomBytes(6);
    // Base62-style encoding: alphanumeric only, truncated to 8 chars
    return bytes
      .toString('base64url')
      .replace(/[^a-zA-Z0-9]/g, '')
      .slice(0, 8)
      .padEnd(8, '0');
  }

  // ── Share Chart ────────────────────────────────────────────────────────

  async shareChart(userId: string, state: object): Promise<ShareResult> {
    const id = this.generateId();
    const serialised = JSON.stringify(state);

    await pool.query(
      `INSERT INTO shared_charts (id, user_id, state, view_count, created_at)
       VALUES ($1, $2, $3, 0, NOW())`,
      [id, userId, serialised],
    );

    logger.info('SharedChartService: chart shared', { id, userId });

    return {
      id,
      url: `/s/${id}`,
    };
  }

  // ── Get Shared Chart ──────────────────────────────────────────────────

  async getSharedChart(id: string): Promise<SharedChart | null> {
    // Increment view count and return in a single query
    const result = await pool.query<{
      id: string;
      user_id: string;
      state: string;
      view_count: number;
      created_at: string;
    }>(
      `UPDATE shared_charts
       SET view_count = view_count + 1
       WHERE id = $1
       RETURNING id, user_id, state, view_count, created_at`,
      [id],
    );

    if (result.rows.length === 0) {
      return null;
    }

    const row = result.rows[0];
    let parsedState: Record<string, unknown>;
    try {
      parsedState = typeof row.state === 'string' ? JSON.parse(row.state) : row.state;
    } catch {
      parsedState = {};
    }

    return {
      id: row.id,
      userId: row.user_id,
      state: parsedState,
      viewCount: row.view_count,
      createdAt: row.created_at,
    };
  }

  // ── Delete Shared Chart ───────────────────────────────────────────────

  async deleteSharedChart(id: string, userId: string): Promise<boolean> {
    const result = await pool.query(
      `DELETE FROM shared_charts
       WHERE id = $1 AND user_id = $2`,
      [id, userId],
    );

    if (result.rowCount === 0) {
      logger.warn('SharedChartService: delete failed — not found or not owner', {
        id,
        userId,
      });
      return false;
    }

    logger.info('SharedChartService: chart deleted', { id, userId });
    return true;
  }

  // ── List User's Shared Charts ─────────────────────────────────────────

  async listUserSharedCharts(userId: string): Promise<SharedChart[]> {
    const result = await pool.query<{
      id: string;
      user_id: string;
      state: string;
      view_count: number;
      created_at: string;
    }>(
      `SELECT id, user_id, state, view_count, created_at
       FROM shared_charts
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT 100`,
      [userId],
    );

    return result.rows.map((row) => {
      let parsedState: Record<string, unknown>;
      try {
        parsedState = typeof row.state === 'string' ? JSON.parse(row.state) : row.state;
      } catch {
        parsedState = {};
      }
      return {
        id: row.id,
        userId: row.user_id,
        state: parsedState,
        viewCount: row.view_count,
        createdAt: row.created_at,
      };
    });
  }
}

export const sharedChartService = new SharedChartService();
