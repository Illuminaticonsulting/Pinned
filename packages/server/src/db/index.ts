import { Pool, QueryResult, QueryResultRow } from 'pg';
import fs from 'fs';
import path from 'path';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://pinned:pinned_dev@localhost:5432/pinned';

export const pool = new Pool({
  connectionString: DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  console.error('[DB] Unexpected pool error:', err.message);
});

/**
 * Execute a parameterized query against the database.
 */
export async function query<T extends QueryResultRow = any>(
  text: string,
  params?: any[]
): Promise<QueryResult<T>> {
  const start = Date.now();
  const result = await pool.query<T>(text, params);
  const duration = Date.now() - start;

  if (duration > 1000) {
    console.warn(`[DB] Slow query (${duration}ms):`, text.substring(0, 120));
  }

  return result;
}

/**
 * Check database connectivity.
 */
export async function healthCheck(): Promise<boolean> {
  try {
    const result = await pool.query('SELECT 1 AS ok');
    return result.rows[0]?.ok === 1;
  } catch (err) {
    console.error('[DB] Health check failed:', err);
    return false;
  }
}

/**
 * Run all pending SQL migrations from the migrations/ directory.
 * Tracks executed migrations in a `migrations_log` table.
 */
export async function runMigrations(): Promise<void> {
  const client = await pool.connect();

  try {
    // Ensure migrations tracking table exists
    await client.query(`
      CREATE TABLE IF NOT EXISTS migrations_log (
        id          SERIAL PRIMARY KEY,
        filename    TEXT UNIQUE NOT NULL,
        executed_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // Determine which migrations have already been applied
    const { rows: executed } = await client.query<{ filename: string }>(
      'SELECT filename FROM migrations_log ORDER BY filename'
    );
    const executedSet = new Set(executed.map((r) => r.filename));

    // Read all .sql files from the migrations directory
    const migrationsDir = path.join(__dirname, 'migrations');
    if (!fs.existsSync(migrationsDir)) {
      console.log('[DB] No migrations directory found — skipping.');
      return;
    }

    const files = fs
      .readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    for (const file of files) {
      if (executedSet.has(file)) {
        continue;
      }

      const filePath = path.join(migrationsDir, file);
      const sql = fs.readFileSync(filePath, 'utf-8');

      console.log(`[DB] Running migration: ${file}`);

      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO migrations_log (filename) VALUES ($1)', [file]);
        await client.query('COMMIT');
        console.log(`[DB] Migration complete: ${file}`);
      } catch (err) {
        await client.query('ROLLBACK');
        console.error(`[DB] Migration failed: ${file}`, err);
        throw err;
      }
    }

    console.log('[DB] All migrations up to date.');
  } finally {
    client.release();
  }
}

export default { pool, query, healthCheck, runMigrations };
