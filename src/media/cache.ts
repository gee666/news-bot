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
  constructor(readonly root = resolve('tmp/media-cache')) {}
  private directory(storyId: string): string { return join(this.root, z.uuid().parse(storyId)); }

  async load(storyId: string, fingerprint: string, now = Date.now()): Promise<MediaCandidate[] | null> {
    const directory = this.directory(storyId);
    try {
      const manifest = manifestSchema.parse(JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')));
      if (manifest.expiresAt <= now) { await this.release(storyId); return null; }
      if (manifest.fingerprint !== fingerprint) return null;
      return await Promise.all(manifest.entries.map(async ({ sha, ...media }) => {
        const data = await readFile(join(directory, sha));
        if (createHash('sha256').update(data).digest('hex') !== sha) throw new Error('Media cache hash mismatch');
        return { type: media.type, mimeType: media.mimeType, data, expiresAt: manifest.expiresAt,
          ...(media.duration === undefined ? {} : { duration: media.duration }) };
      }));
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
      throw error;
    }
  }

  async save(storyId: string, fingerprint: string, media: MediaCandidate[], now = Date.now()): Promise<number> {
    const directory = this.directory(storyId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    let expiresAt = now + MEDIA_TTL_MS;
    try { expiresAt = Math.min(expiresAt, manifestSchema.parse(JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'))).expiresAt); }
    catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
    expiresAt = Math.min(expiresAt, ...media.map(item => item.expiresAt ?? expiresAt));
    if (expiresAt <= now) throw new Error('Media cache deadline has expired');
    const entries = [];
    for (const { data, ...candidate } of media) {
      const sha = createHash('sha256').update(data).digest('hex');
      await writeFile(join(directory, sha), data, { mode: 0o600 });
      entries.push({ ...candidate, sha });
    }
    const staging = join(directory, `manifest-${randomUUID()}.json`);
    await writeFile(staging, JSON.stringify({ fingerprint, expiresAt, entries }), { mode: 0o600 });
    await rename(staging, join(directory, 'manifest.json'));
    const retained = new Set(['manifest.json', ...entries.map(value => value.sha)]);
    for (const file of await readdir(directory)) if (!retained.has(file)) await rm(join(directory, file), { force: true });
    return expiresAt;
  }

  async release(storyId: string): Promise<void> { await rm(this.directory(storyId), { recursive: true, force: true }); }

  async sweep(now = Date.now()): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    for (const name of await readdir(this.root)) {
      if (!z.uuid().safeParse(name).success) continue;
      const directory = this.directory(name);
      let expired: boolean;
      try { expired = manifestSchema.parse(JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'))).expiresAt <= now; }
      catch { expired = (await stat(directory)).mtimeMs + MEDIA_TTL_MS <= now; }
      if (expired) await this.release(name);
    }
  }
}
