import { describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';
import { meaningfulFingerprint, reconcileStory } from './revisions.js';
import { generationHash } from './generation-store.js';
import { defaultSettings } from '../settings.js';
import { storyInput } from './generation.test-helpers.js';

describe('link-only evidence changes', () => {
  it('changes meaningful fingerprints for hidden correction URLs and relevance, without requiring text changes', () => {
    const text = ['Acme announced a release.'];
    const first = [{ url: 'https://example.org/release', classification: 'relevant', anchor_text: 'Source' }];
    const corrected = [{ ...first[0], url: 'https://example.org/correction', classification: 'relevant', anchor_text: 'Source' }];
    expect(meaningfulFingerprint(text, first)).not.toBe(meaningfulFingerprint(text, corrected));
    expect(meaningfulFingerprint(text, first)).not.toBe(meaningfulFingerprint(text, [{ ...first[0], url: first[0]?.url ?? '', classification: 'uncertain', anchor_text: 'Source' }]));
  });
  it('includes links in generation signatures even when meaningful_hash is already populated', () => {
    const input = storyInput(9);
    input.story.meaningful_hash = 'same-text-hash';
    const before = generationHash(input, defaultSettings);
    input.links = [{ url: 'https://example.org/correction', classification: 'relevant' }];
    expect(generationHash(input, defaultSettings)).not.toBe(before);
    const corrected = generationHash(input, defaultSettings);
    input.links[0] = { url: 'https://example.org/correction', classification: 'uncertain' };
    expect(generationHash(input, defaultSettings)).not.toBe(corrected);
  });
  it('invalidates summaries and assessed relationships when reconciling an edited link', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ status: 'processing' }] })
      .mockResolvedValueOnce({ rows: [{ text: 'Acme announced a release.' }] })
      .mockResolvedValueOnce({ rows: [{ url: 'https://example.org/correction', classification: 'relevant', anchor_text: 'Source' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'story' }] });
    const client: Pick<PoolClient, 'query'> = { query };
    await reconcileStory(client, 'story');
    expect(query.mock.calls[2]?.[0]).toContain('i.current_revision_id=r.id');
    expect(query.mock.calls[3]?.[0]).toContain('summary=NULL');
    expect(query.mock.calls[3]?.[1]).toEqual(['story', meaningfulFingerprint(['Acme announced a release.'],
      [{ url: 'https://example.org/correction', classification: 'relevant', anchor_text: 'Source' }])]);
    expect(query.mock.calls[4]?.[0]).toBe('UPDATE story_evidence SET superseded_at=now() WHERE story_id=$1 AND superseded_at IS NULL');
  });
});
