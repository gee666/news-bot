import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { MEDIA_TTL_MS } from './cache.js';

export type MediaDecision = 'same' | 'different' | 'unresolved';
export type MediaVerdict = boolean | MediaDecision;
export interface MediaPairResults {
  compare(left: string, right: string, judge: () => Promise<MediaVerdict>): Promise<MediaVerdict>;
}
const resultSchema = z.object({ decision: z.enum(['same', 'different']), expiresAt: z.number().finite() });
const active = new Map<string, Promise<MediaVerdict>>();
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

/** Resolved judgments persist across restarts, but not replacement of a container's tmp storage.
 * Files contain hashes/verdicts, never media or source URLs. */
export class MediaPairCache implements MediaPairResults {
  constructor(readonly version: string, readonly root = resolve('tmp/media-pair-cache')) {}

  compare(left: string, right: string, judge: () => Promise<MediaVerdict>): Promise<MediaVerdict> {
    const key = digest(JSON.stringify([this.version, ...[left, right].sort()]));
    const path = join(this.root, `${key}.json`);
    const pending = active.get(path);
    if (pending) return pending;
    const task = this.resolve(path, judge).finally(() => { active.delete(path); });
    active.set(path, task);
    return task;
  }

  private async resolve(path: string, judge: () => Promise<MediaVerdict>): Promise<MediaVerdict> {
    try {
      const cached = resultSchema.safeParse(JSON.parse(await readFile(path, 'utf8')));
      if (cached.success && cached.data.expiresAt > Date.now()) return cached.data.decision;
    } catch (error) {
      if (!(error instanceof SyntaxError) && !missing(error)) throw error;
    }
    const decision = await judge();
    // A legacy boolean false may mean an outage. Require an explicit resolved verdict.
    if (decision !== 'same' && decision !== 'different') return decision;
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const staging = join(this.root, `${randomUUID()}.pending`);
    try {
      await writeFile(staging, JSON.stringify({ decision, expiresAt: Date.now() + MEDIA_TTL_MS }), { mode: 0o600 });
      await rename(staging, path);
    } finally { await rm(staging, { force: true }); }
    return decision;
  }

  async sweep(now = Date.now()): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    for (const name of await readdir(this.root)) {
      if (!/^[a-f0-9]{64}\.json$/u.test(name)) continue;
      const path = join(this.root, name);
      try {
        const cached = resultSchema.safeParse(JSON.parse(await readFile(path, 'utf8')));
        if (!cached.success || cached.data.expiresAt <= now) await rm(path, { force: true });
      } catch (error) {
        if (error instanceof SyntaxError) await rm(path, { force: true });
        else if (!missing(error)) throw error;
      }
    }
  }
}

function missing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
