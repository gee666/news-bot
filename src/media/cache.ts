import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, rm, readdir, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { z } from 'zod';
import type { MediaCandidate } from './comparison.js';

export const MEDIA_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const entry = z.object({ type: z.enum(['image', 'video']), mimeType: z.string(), sha: z.string().regex(/^[a-f0-9]{64}$/u),
  duration: z.number().positive().optional(), expiresAt: z.number().optional() });
const manifestSchema = z.object({ fingerprint: z.string(), expiresAt: z.number(), entries: z.array(entry) });

/** Each story owns temporary files so publishing cannot delete another story's media. */
export class MediaCache {
  private readonly pending = new Map<string, Promise<unknown>>();
  constructor(readonly root = resolve('tmp/media-cache')) {}
  private directory(storyId: string): string { return join(this.root, z.uuid().parse(storyId)); }

  async load(storyId: string, fingerprint: string, now = Date.now(), signal?: AbortSignal): Promise<MediaCandidate[] | null> {
    signal?.throwIfAborted();
    const directory = this.directory(storyId);
    try {
      const manifest = manifestSchema.parse(JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')));
      signal?.throwIfAborted();
      if (manifest.expiresAt <= now) { await this.release(storyId); signal?.throwIfAborted(); return null; }
      if (manifest.fingerprint !== fingerprint) return null;
      return await Promise.all(manifest.entries.map(async ({ sha, ...media }) => {
        signal?.throwIfAborted();
        const data = await readFile(join(directory, sha), { signal });
        signal?.throwIfAborted();
        if (createHash('sha256').update(data).digest('hex') !== sha) throw new Error('Media cache hash mismatch');
        return { type: media.type, mimeType: media.mimeType, data, expiresAt: manifest.expiresAt,
          ...(media.duration === undefined ? {} : { duration: media.duration }) };
      }));
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
      throw error;
    }
  }

  save(storyId: string, fingerprint: string, media: MediaCandidate[], now = Date.now(), signal?: AbortSignal): Promise<number> {
    return this.serialize(storyId, () => this.write(storyId, fingerprint, media, now, signal));
  }

  private async write(storyId: string, fingerprint: string, media: MediaCandidate[], now: number, signal?: AbortSignal): Promise<number> {
    signal?.throwIfAborted();
    const directory = this.directory(storyId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    signal?.throwIfAborted();
    let expiresAt = now + MEDIA_TTL_MS;
    try { expiresAt = Math.min(expiresAt, manifestSchema.parse(JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'))).expiresAt); }
    catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
    signal?.throwIfAborted();
    expiresAt = Math.min(expiresAt, ...media.map(item => item.expiresAt ?? expiresAt));
    if (expiresAt <= now) throw new Error('Media cache deadline has expired');
    const entries = [];
    for (const { data, ...candidate } of media) {
      const sha = createHash('sha256').update(data).digest('hex');
      signal?.throwIfAborted();
      await writeFile(join(directory, sha), data, { mode: 0o600, signal });
      signal?.throwIfAborted();
      entries.push({ ...candidate, sha });
    }
    const staging = join(directory, `manifest-${randomUUID()}.json`);
    try {
      signal?.throwIfAborted();
      await writeFile(staging, JSON.stringify({ fingerprint, expiresAt, entries }), { mode: 0o600, signal });
      signal?.throwIfAborted();
      await rename(staging, join(directory, 'manifest.json'));
      if (signal?.aborted) {
        await rm(join(directory, 'manifest.json'), { force: true });
        signal.throwIfAborted();
      }
    } finally { await rm(staging, { force: true }); }
    signal?.throwIfAborted();
    const retained = new Set(['manifest.json', ...entries.map(value => value.sha)]);
    for (const file of await readdir(directory)) {
      signal?.throwIfAborted();
      if (!retained.has(file)) await rm(join(directory, file), { force: true });
    }
    signal?.throwIfAborted();
    return expiresAt;
  }

  release(storyId: string): Promise<void> {
    return this.serialize(storyId, () => rm(this.directory(storyId), { recursive: true, force: true }));
  }

  // Release must run after the real save settles, not its caller's abort race.
  private serialize<T>(storyId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.pending.get(storyId) ?? Promise.resolve();
    const task = previous.catch(() => {}).then(work).finally(() => {
      if (this.pending.get(storyId) === task) this.pending.delete(storyId);
    });
    this.pending.set(storyId, task);
    return task;
  }

  async sweep(now = Date.now(), storyExists?: (storyId: string) => Promise<boolean>): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    for (const name of await readdir(this.root)) {
      if (!z.uuid().safeParse(name).success) continue;
      // Check ownership before the TTL, including directories with broken manifests.
      // Database failures must leave the files intact so a later sweep can retry.
      if (storyExists && !await storyExists(name)) { await this.release(name); continue; }
      const directory = this.directory(name);
      let expired: boolean;
      try { expired = manifestSchema.parse(JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'))).expiresAt <= now; }
      catch { expired = (await stat(directory)).mtimeMs + MEDIA_TTL_MS <= now; }
      if (expired) await this.release(name);
    }
  }
}
