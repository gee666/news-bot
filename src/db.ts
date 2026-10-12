import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pg, { type PoolClient, type PoolConfig } from 'pg';

const poolConfig: PoolConfig = {
  max: 10,
  connectionTimeoutMillis: 10_000,
  idleTimeoutMillis: 30_000,
  application_name: 'news-bot',
};
if (process.env.DATABASE_URL) poolConfig.connectionString = process.env.DATABASE_URL;
// Without DATABASE_URL, pg reads the standard PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE.
export const db = new pg.Pool(poolConfig);

db.on('error', () => {
  // Connection errors can contain connection strings. Keep logs credential-free.
  console.error('An idle database connection failed.');
});

export async function transaction<T>(
  run: (client: PoolClient) => Promise<T>,
  pool: pg.Pool = db,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await run(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* Preserve the original failure. */ }
    throw error;
  } finally {
    client.release();
  }
}

const migrationDirectory = fileURLToPath(new URL('../migrations/', import.meta.url));

export async function migrate(pool: pg.Pool = db): Promise<void> {
  const client = await pool.connect();
  try {
    // A session lock covers all migrations, not just one migration transaction.
    await client.query('SELECT pg_advisory_lock(736428109)');
    // Extensions are database-wide. Keep vector types outside disposable application/test schemas.
    await client.query('CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public');
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const files = (await readdir(migrationDirectory)).filter(name => /^\d+_[a-z_]+\.sql$/u.test(name)).sort();
    for (const name of files) {
      const sql = await readFile(resolve(migrationDirectory, name), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const existing = await client.query<{ checksum: string }>(
        'SELECT checksum FROM schema_migrations WHERE name = $1', [name],
      );
      if (existing.rows[0]) {
        if (existing.rows[0].checksum !== checksum) throw new Error(`Applied migration changed: ${name}`);
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [name, checksum]);
        await client.query('COMMIT');
      } catch (error) {
        try { await client.query('ROLLBACK'); } catch { /* Preserve the migration failure. */ }
        throw error;
      }
    }
  } finally {
    try { await client.query('SELECT pg_advisory_unlock(736428109)'); } finally { client.release(); }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    await migrate();
    console.info('Database migrations applied.');
  } catch {
    console.error('Database migration failed. Check database connectivity, privileges and migration compatibility.');
    process.exitCode = 1;
  } finally {
    await db.end();
  }
}
