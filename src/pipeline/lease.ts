import { db } from '../db.js';

export async function withLease(name: string, run: () => Promise<void>): Promise<boolean> {
  const client = await db.connect();
  let held = false;
  try {
    const result = await client.query<{ held: boolean }>('SELECT pg_try_advisory_lock(hashtext($1)) AS held', [name]);
    held = result.rows[0]?.held ?? false;
    if (held) await run();
    return held;
  } finally {
    try { if (held) await client.query('SELECT pg_advisory_unlock(hashtext($1))', [name]); }
    finally { client.release(); }
  }
}
