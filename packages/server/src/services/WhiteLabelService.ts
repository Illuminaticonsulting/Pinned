/**
 * WhiteLabelService — White-label theming service.
 *
 * Manages per-community theme configurations, validates themes with zod,
 * and generates CSS custom properties for runtime injection.
 */

import { z } from 'zod';
import { pool } from '../db';
import { logger } from '../utils/logger';

// ─── Schema & Types ────────────────────────────────────────────────────────────

const themeColorsSchema = z.object({
  bg: z.string().min(1),
  bgSecondary: z.string().min(1),
  bull: z.string().min(1),
  bear: z.string().min(1),
  accent: z.string().min(1),
  text: z.string().min(1),
  textSecondary: z.string().min(1),
});

const themeFontsSchema = z.object({
  primary: z.string().min(1),
  mono: z.string().min(1),
});

const themeDefaultsSchema = z.object({
  symbol: z.string().min(1),
  timeframe: z.string().min(1),
  exchange: z.string().min(1),
});

const themePanelsSchema = z.object({
  heatmap: z.boolean(),
  footprint: z.boolean(),
  dom: z.boolean(),
  aiSignals: z.boolean(),
  volumeProfile: z.boolean(),
});

const themeBrandingSchema = z.object({
  hidePinnedBadge: z.boolean(),
});

const themeConfigSchema = z.object({
  name: z.string().min(1).max(100),
  logo: z.string().max(2048).optional(),
  colors: themeColorsSchema,
  fonts: themeFontsSchema,
  defaults: themeDefaultsSchema,
  panels: themePanelsSchema,
  branding: themeBrandingSchema,
});

export type ThemeConfig = z.infer<typeof themeConfigSchema>;

// ─── Default Theme ─────────────────────────────────────────────────────────────

const DEFAULT_THEME: ThemeConfig = {
  name: 'Pinned Dark',
  logo: undefined,
  colors: {
    bg: '#0a0e17',
    bgSecondary: '#111827',
    bull: '#10b981',
    bear: '#ef4444',
    accent: '#6366f1',
    text: '#f9fafb',
    textSecondary: '#9ca3af',
  },
  fonts: {
    primary: 'Inter, system-ui, sans-serif',
    mono: "'JetBrains Mono', 'Fira Code', monospace",
  },
  defaults: {
    symbol: 'BTC-USDT',
    timeframe: '5m',
    exchange: 'blofin',
  },
  panels: {
    heatmap: true,
    footprint: true,
    dom: true,
    aiSignals: true,
    volumeProfile: true,
  },
  branding: {
    hidePinnedBadge: false,
  },
};

// ─── Service ───────────────────────────────────────────────────────────────────

class WhiteLabelService {
  // ── Load Theme ─────────────────────────────────────────────────────────

  async loadTheme(communityId: string): Promise<ThemeConfig | null> {
    try {
      const result = await pool.query<{ theme: string }>(
        `SELECT theme FROM communities WHERE id = $1`,
        [communityId],
      );

      if (result.rows.length === 0) {
        return null;
      }

      const raw = result.rows[0].theme;
      if (!raw) {
        return null;
      }

      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      const validated = themeConfigSchema.parse(parsed);
      return validated;
    } catch (err) {
      logger.error('WhiteLabelService: failed to load theme', {
        communityId,
        error: String(err),
      });
      return null;
    }
  }

  // ── Save Theme ─────────────────────────────────────────────────────────

  async saveTheme(communityId: string, theme: ThemeConfig): Promise<void> {
    // Validate with zod — throws on invalid input
    const validated = themeConfigSchema.parse(theme);
    const serialised = JSON.stringify(validated);

    const result = await pool.query(
      `UPDATE communities SET theme = $1, updated_at = NOW() WHERE id = $2`,
      [serialised, communityId],
    );

    if (result.rowCount === 0) {
      // Community row doesn't exist yet — insert
      await pool.query(
        `INSERT INTO communities (id, theme, created_at, updated_at)
         VALUES ($1, $2, NOW(), NOW())
         ON CONFLICT (id) DO UPDATE SET theme = $2, updated_at = NOW()`,
        [communityId, serialised],
      );
    }

    logger.info('WhiteLabelService: theme saved', {
      communityId,
      name: validated.name,
    });
  }

  // ── Get Default Theme ──────────────────────────────────────────────────

  getDefaultTheme(): ThemeConfig {
    return { ...DEFAULT_THEME };
  }

  // ── Generate CSS Custom Properties ─────────────────────────────────────

  generateCSS(theme: ThemeConfig): string {
    const lines: string[] = [':root {'];

    // Colors
    lines.push(`  --pinned-bg: ${theme.colors.bg};`);
    lines.push(`  --pinned-bg-secondary: ${theme.colors.bgSecondary};`);
    lines.push(`  --pinned-bull: ${theme.colors.bull};`);
    lines.push(`  --pinned-bear: ${theme.colors.bear};`);
    lines.push(`  --pinned-accent: ${theme.colors.accent};`);
    lines.push(`  --pinned-text: ${theme.colors.text};`);
    lines.push(`  --pinned-text-secondary: ${theme.colors.textSecondary};`);

    // Fonts
    lines.push(`  --pinned-font-primary: ${theme.fonts.primary};`);
    lines.push(`  --pinned-font-mono: ${theme.fonts.mono};`);

    // Branding
    lines.push(
      `  --pinned-badge-display: ${theme.branding.hidePinnedBadge ? 'none' : 'block'};`,
    );

    // Logo
    if (theme.logo) {
      lines.push(`  --pinned-logo: url('${theme.logo}');`);
    }

    lines.push('}');

    return lines.join('\n');
  }
}

export const whiteLabelService = new WhiteLabelService();
