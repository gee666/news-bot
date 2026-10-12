import type { PiResult } from '../models/index.js';
import type { StoryInput, Evidence } from './generation-store.js';

export const storyId = '11111111-1111-4111-8111-111111111111';
export const secondId = '22222222-2222-4222-8222-222222222222';
export const evidenceId = '33333333-3333-4333-8333-333333333333';
export const mentionId = '44444444-4444-4444-8444-444444444444';

export function storyInput(score = 3, id = storyId): StoryInput {
  return { story: { id, chosen_excerpt: 'Acme released version 2.0 with a security fix.', interest_score: score,
    headline: null, summary: null, researched: false, translated_excerpt: null, content_version: 1, meaningful_hash: null },
  mentions: [{ id: mentionId, text: 'Acme released version 2.0 with a security fix.', access: 'public', original_url: 'https://example.org/post' }],
  links: [{ url: 'https://example.org/release', classification: 'relevant' }] };
}

export function modelResult(value: unknown): PiResult {
  return { text: typeof value === 'string' ? value : JSON.stringify(value), provider: 'openai-codex', model: 'gpt-6-luna',
    durationMs: 1, nativeSchema: true, usage: { input: 1, output: 1, totalTokens: 2, cacheRead: 0, cacheWrite: 0,
      cost: { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0 } } };
}

/** Reset retained research fixtures without exposing a production reset API. */
export async function resetResearchFixture(storyId: string): Promise<void> {
  const { db } = await import('../db.js');
  await db.query("UPDATE story_evidence SET superseded_at=coalesce(superseded_at,now()) WHERE story_id = $1 AND relevance<>'irrelevant'", [storyId]);
  await db.query(`UPDATE stories SET summary = NULL, researched = false, updated_at = now()
    WHERE id = $1 AND (summary IS NOT NULL OR researched)`, [storyId]);
}

export function evidenceDocument(): Evidence {
  return { id: evidenceId, url: 'https://example.org/release', canonical_url: 'https://example.org/release',
    title: 'Release 2.0', content: 'Acme announces version 2.0 with a security fix.', access: 'public', role: 'candidate', relevance: 'uncertain', assessment: null };
}
