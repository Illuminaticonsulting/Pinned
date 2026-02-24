#!/usr/bin/env node
/**
 * Standalone migration runner for the Pinned platform.
 *
 * Usage:
 *   npx ts-node src/db/migrate.ts
 *   node dist/db/migrate.js
 *
 * Reads all .sql files from the migrations/ directory (sorted by name),
 * executes each inside a transaction, and tracks completed migrations
 * in the `migrations_log` table.
 */

import fs from 'fs';
import path from 'path';
import { Pool } from 'pg';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://pinned:pinned_dev@localhost:5432/pinned';

async function migrate(): Promise<void> {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const client = await pool.connect();

  try {
    console.log('[migrate] Connected to database.');

    // Create migrations tracking table if it doesn't exist
    await client.query(`
      CREATE TABLE IF NOT EXISTS migrations_log (
        id          SERIAL PRIMARY KEY,
        filename    TEXT UNIQUE NOT NULL,
        executed_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // Get already-executed migrations
    const { rows: executed } = await client.query<{ filename: string }>(
      'SELECT filename FROM migrations_log ORDER BY filename'
    );
    const executedSet = new Set(executed.map((r) => r.filename));

    // Read migration files
    const migrationsDir = path.join(__dirname, 'migrations');
    if (!fs.existsSync(migrationsDir)) {
      console.log('[migrate] No migrations directory found at', migrationsDir);
      return;
    }

    const files = fs
      .readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    if (files.length === 0) {
      console.log('[migrate] No migration files found.');
      return;
    }

    let applied = 0;
    let skipped = 0;

    for (const file of files) {
      if (executedSet.has(file)) {
        skipped++;
        continue;
      }

      const filePath = path.join(migrationsDir, file);
      const sql = fs.readFileSync(filePath, 'utf-8');

      console.log(`[migrate] Running: ${file}`);

      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO migrations_log (filename) VALUES ($1)', [file]);
        await client.query('COMMIT');
        applied++;
        console.log(`[migrate] Applied: ${file}`);
      } catch (err) {
        await client.query('ROLLBACK');
        console.error(`[migrate] FAILED: ${file}`);
        console.error(err);
        process.exit(1);
      }
    }

    console.log(
      `[migrate] Done. Applied: ${applied}, Skipped (already run): ${skipped}, Total: ${files.length}`
    );
  } finally {
    client.release();
    await pool.end();
  }
}

migrate().catch((err) => {
  console.error('[migrate] Fatal error:', err);
  process.exit(1);
});
