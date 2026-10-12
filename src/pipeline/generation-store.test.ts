import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultSettings } from '../settings.js';
import { alreadyGenerated, assessEvidence, GENERATION_VERSION, generationHash, loadEvidence, loadStory,
  evidenceSnapshotHash, saveEvidence, saveGenerations } from './generation-store.js';
import { evidenceDocument, evidenceId, secondId, storyId, storyInput } from './generation.test-helpers.js';

const mocks = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('../db.js', () => ({ db: { query: mocks.query },
  transaction: async (fn: (client: { query: typeof mocks.query }) => Promise<unknown>) => fn({ query: mocks.query }),
}));
beforeEach(() => {
  vi.resetAllMocks();
  mocks.query.mockResolvedValue({ rows: [] });
});

describe('generation database boundary', () => {
  it('loads only current-revision mentions and links, preserving source access and classifications', async () => {
    const input = storyInput();
    mocks.query.mockResolvedValueOnce({ rows: [input.story] }).mockResolvedValueOnce({ rows: input.mentions })
      .mockResolvedValueOnce({ rows: input.links });
    expect(await loadStory(storyId)).toEqual(input);
    expect(mocks.query.mock.calls[1]?.[0]).toContain('s.access');
    expect(mocks.query.mock.calls[1]?.[0]).toContain('JOIN sources s');
    for (const query of mocks.query.mock.calls.slice(1, 3)) {
      expect(query[0]).toContain('JOIN item_revisions r ON r.id = m.revision_id');
      expect(query[0]).toContain('JOIN source_items i ON i.current_revision_id = r.id');
      expect(query[0]).toMatch(/^SELECT /u);
    }
    expect(mocks.query.mock.calls[2]?.[0]).toContain("ml.classification <> 'irrelevant'");
    expect(mocks.query.mock.calls[2]?.[0]).toContain("sl.classification='relevant'");
    expect(mocks.query.mock.calls[2]?.[0]).toContain("story_link_sources");
    expect(mocks.query.mock.calls[2]?.[0]).not.toContain("LIMIT 100");
    expect(mocks.query.mock.calls.every(call => call[1]?.[0] === storyId)).toBe(true);
  });

  it('loads approved current source-only report text once and excludes mentioned or quarantined revisions', async () => {
    const input = storyInput();
    const report = { source_id: secondId, revision_id: evidenceId, text: 'Pro $200 now 10x Plus, previously 20x; $500 25x.',
      source_name: 'ForgetMe', original_url: 'https://t.me/forgetmeai/6403', access: 'public',
      published_at: new Date('2026-09-29T21:58:00Z'), collected_at: new Date('2026-09-30T08:00:00Z') };
    mocks.query.mockResolvedValueOnce({ rows: [input.story] }).mockResolvedValueOnce({ rows: input.mentions })
      .mockResolvedValueOnce({ rows: input.links }).mockResolvedValueOnce({ rows: [report] });
    const loaded = await loadStory(storyId);
    expect(loaded.supplementary_reports).toEqual([{ ...report,
      published_at: report.published_at.toISOString(), collected_at: report.collected_at.toISOString() }]);
    const sql = String(mocks.query.mock.calls[3]?.[0]);
    expect(sql).toContain("SELECT DISTINCT");
    expect(sql).toContain("sl.classification='relevant'");
    expect(sql).toContain('i.current_revision_id=r.id');
    expect(sql).toContain('m.story_id=$1 AND m.revision_id=r.id');
    expect(sql).toContain("pipelineFailure");
    expect(sql).toContain("pipeline_failed_item:");
    expect(sql).not.toContain('INSERT');
    const hash = generationHash(loaded, defaultSettings);
    loaded.supplementary_reports![0]!.text += ' changed tail';
    expect(generationHash(loaded, defaultSettings)).not.toBe(hash);
  });

  it('normalizes source publication/collection dates and fingerprints their chronology', async () => {
    const input=storyInput();
    const published=new Date('2026-09-29T17:10:02Z');
    const collected=new Date('2026-09-30T08:27:29Z');
    mocks.query.mockResolvedValueOnce({rows:[input.story]})
      .mockResolvedValueOnce({rows:[{...input.mentions[0],published_at:published,collected_at:collected}]})
      .mockResolvedValueOnce({rows:[]});
    const loaded=await loadStory(storyId);
    expect(loaded.mentions[0]).toMatchObject({published_at:published.toISOString(),collected_at:collected.toISOString()});
    expect(mocks.query.mock.calls[1]?.[0]).toContain('i.published_at, i.collected_at');
    const first=generationHash(loaded,defaultSettings);
    loaded.mentions[0]!.published_at='2026-09-29T16:00:00Z';
    expect(generationHash(loaded,defaultSettings)).not.toBe(first);
    const second=generationHash(loaded,defaultSettings);
    loaded.mentions[0]!.collected_at='2026-09-30T09:00:00Z';
    expect(generationHash(loaded,defaultSettings)).not.toBe(second);
  });

  it('returns only bounded extraction-selected exact referent spans, never the whole parent item', async () => {
    const input = storyInput();
    const parent = 'OpenAI DevDay в Сан-Франциско.\n\nУ входа протестуют.\n\nДругая компания выпустила GPU.';
    const end = parent.indexOf('\n');
    mocks.query.mockResolvedValueOnce({ rows: [input.story] })
      .mockResolvedValueOnce({ rows: [{ ...input.mentions[0], parent_text: parent,
        metadata: { contextSpans: [{ start: 0, end }] } }] }).mockResolvedValueOnce({ rows: [] });
    const loaded = await loadStory(storyId);
    expect(loaded.mentions[0]?.referent_context).toEqual([parent.slice(0, end)]);
    expect(JSON.stringify(loaded)).not.toContain('Другая компания');
    expect(loaded.mentions[0]).not.toHaveProperty('metadata');
    expect(loaded.mentions[0]).not.toHaveProperty('parent_text');
  });

  it.each([{}, { contextSpans: [{ start: -1, end: 20 }] }, { contextSpans: [{ start: 0, end: 1000 }] },
    { contextSpans: [{ start: 5, end: 1 }] }, { contextSpans: [{ start: 0, end: 301 }] }])('does not guess referents from absent or invalid metadata: %j', async metadata => {
    const input = storyInput();
    mocks.query.mockResolvedValueOnce({ rows: [input.story] })
      .mockResolvedValueOnce({ rows: [{ ...input.mentions[0], parent_text: 'x'.repeat(350), metadata }] })
      .mockResolvedValueOnce({ rows: [] });
    expect((await loadStory(storyId)).mentions[0]).not.toHaveProperty('referent_context');
  });

  it('rejects invalid UUIDs before querying and malformed stored access before inference', async () => {
    await expect(loadStory('not-a-uuid')).rejects.toThrow();
    expect(mocks.query).not.toHaveBeenCalled();
    const input = storyInput();
    mocks.query.mockResolvedValueOnce({ rows: [input.story] })
      .mockResolvedValueOnce({ rows: [{ ...input.mentions[0], access: 'unspecified' }] }).mockResolvedValueOnce({ rows: [] });
    await expect(loadStory(storyId)).rejects.toThrow();
  });

  it('persists evidence content and access with a story relationship, initially unverified', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [{ id: evidenceId }] });
    const page = { url: 'https://example.org/start', canonicalUrl: 'https://example.org/final', title: 'Release',
      content: 'Version 2.0', access: 'public' as const, metadata: { status: 200 } };
    expect(await saveEvidence(storyId, page, defaultSettings, 'research-hash')).toMatchObject({ id: evidenceId, role: 'candidate', assessment: null });
    const insertion = mocks.query.mock.calls[0];
    expect(insertion?.[0]).toContain('INSERT INTO evidence_documents');
    expect(insertion?.[1]).toEqual([page.url, page.canonicalUrl, expect.stringMatching(/^[\da-f]{64}$/u),
      page.title, page.content, 'public', defaultSettings.retentionDays, JSON.stringify({ status: 200, originStoryId: storyId, publishedAt: null, updatedAt: null, researchInputHash: 'research-hash' })]);
    expect(mocks.query.mock.calls[1]?.[0]).toContain("VALUES ($1, $2, 'candidate')");
    expect(mocks.query.mock.calls[1]?.[1]).toEqual([storyId, evidenceId]);
  });

  it('saves primary assessment on the relationship and model provenance in judgments', async () => {
    const document = evidenceDocument();
    expect(await assessEvidence(storyId, document, 'primary', 'Оригинальное заявление.', defaultSettings, 'relevant'))
      .toMatchObject({ role: 'primary', assessment: 'Оригинальное заявление.' });
    expect(mocks.query.mock.calls[0]?.[0]).toContain('UPDATE story_evidence');
    expect(mocks.query.mock.calls[0]?.[1]).toEqual([storyId, evidenceId, 'primary', 'Оригинальное заявление.', 'relevant', expect.any(String)]);
    expect(mocks.query.mock.calls[1]?.[0]).toContain('primary_assessment');
    expect(mocks.query.mock.calls[1]?.[1]).toContain('openai-codex/gpt-6-luna');
  });

  it('cannot persist an irrelevant or primary assessment for blocked/empty content', async () => {
    const document = { ...evidenceDocument(), content: null, access: 'restricted' as const };
    expect(await assessEvidence(storyId, document, 'primary', 'HTTP 403', defaultSettings, 'irrelevant'))
      .toMatchObject({ role: 'candidate', relevance: 'uncertain', assessed_at: expect.any(String) });
    expect(mocks.query.mock.calls[0]?.[1]).toEqual([
      storyId, evidenceId, 'candidate', 'HTTP 403', 'uncertain', expect.any(String),
    ]);
  });

  it('loads unexpired assessed evidence including access, without trusting unknown role values', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [evidenceDocument()] });
    expect(await loadEvidence(storyId, 'research-hash')).toEqual([evidenceDocument()]);
    expect(mocks.query.mock.calls[0]?.[0]).toContain("e.metadata->>'researchInputHash' IS DISTINCT FROM $2");
    expect(mocks.query.mock.calls[0]?.[0]).toContain('SET superseded_at=coalesce(se.superseded_at,now())');
    expect(mocks.query.mock.calls[1]?.[0]).toContain('e.expires_at > now()');
    expect(mocks.query.mock.calls[1]?.[0]).toContain('se.superseded_at IS NULL');
    expect(mocks.query.mock.calls.every(([sql]) => !String(sql).includes('DELETE FROM story_evidence'))).toBe(true);
    mocks.query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ ...evidenceDocument(), role: 'trusted' }] });
    expect(await loadEvidence(storyId, 'research-hash')).toMatchObject([{ role: 'candidate', access: 'unavailable',
      content: null, metadata: { error: 'invalid_cached_evidence' } }]);
  });

  it('saves generated content and generation signature without changing completion or rank', async () => {
    const input = storyInput();
    mocks.query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ id: storyId }] });
    const value = { id: storyId, headline: 'Acme выпустила 2.0.', summary: 'Исправлена ошибка безопасности.', translatedExcerpt: null };
    await saveGenerations([input], [value], defaultSettings);
    expect(mocks.query.mock.calls[0]?.[0]).toMatch(/^SELECT /u);
    expect(mocks.query.mock.calls[1]?.[1]).toEqual([storyId, value.headline, value.summary, null, true, 1,
      input.story.chosen_excerpt, null]);
    expect(mocks.query.mock.calls[1]?.[0]).not.toContain('status =');
    expect(mocks.query.mock.calls[2]?.[0]).toContain(`'${GENERATION_VERSION}'`);
    expect(mocks.query.mock.calls[2]?.[1]).toContain('generation_research');
    expect(mocks.query.mock.calls[2]?.[1]).toContain(generationHash(input, defaultSettings));
  });

  it('rejects obsolete results rather than overwriting a story changed during inference', async () => {
    await expect(saveGenerations([storyInput()], [{ id: storyId, headline: 'Новость.', summary: 'Текст.', translatedExcerpt: null }],
      defaultSettings)).rejects.toThrow('Story changed during generation');
    expect(mocks.query).toHaveBeenCalledTimes(2);
    expect(mocks.query.mock.calls[1]?.[0]).toContain('UPDATE stories');
  });

  it('requires the signature and current stored output to match before reusing generation', async () => {
    const input = storyInput();
    expect(await alreadyGenerated(input, defaultSettings)).toBe(false);
    expect(mocks.query).not.toHaveBeenCalled();
    input.story.headline = 'Новость.';
    expect(await alreadyGenerated(input, defaultSettings)).toBe(false);
    expect(mocks.query).not.toHaveBeenCalled();
    input.story.summary = 'Подробности.'; input.story.researched = true;
    const evidenceSignature = await evidenceSnapshotHash(storyId);
    mocks.query.mockClear().mockResolvedValueOnce({ rows: [{ result: { evidenceSignature } }] });
    expect(await alreadyGenerated(input, defaultSettings)).toBe(true);
    expect(mocks.query.mock.calls[0]?.[0]).toContain("result->>'headline' = $5");
    expect(mocks.query.mock.calls[0]?.[0]).toContain('expires_at > now()');
    expect(GENERATION_VERSION).toBe('generation-v10');
    expect(mocks.query.mock.calls[0]?.[0]).toContain(`prompt_version = '${GENERATION_VERSION}'`);
  });

  it('changes generation signature for meaningful evidence, model or selected excerpt changes', () => {
    const input = storyInput();
    const hash = generationHash(input, defaultSettings);
    expect(generationHash(input, { ...defaultSettings, piModel: 'different' })).not.toBe(hash);
    input.story.content_version++;
    expect(generationHash(input, defaultSettings)).not.toBe(hash);
    input.story.content_version--;
    input.story.chosen_excerpt = 'Different source excerpt';
    expect(generationHash(input, defaultSettings)).not.toBe(hash);
  });

  it('invalidates generation when headline supporting facts or anchored referents change despite a fixed meaningful hash', () => {
    const input = storyInput();
    input.story.meaningful_hash = 'stable';
    const hash = generationHash(input, defaultSettings);
    input.mentions[0]!.referent_context = ['OpenAI DevDay в Сан-Франциско.'];
    expect(generationHash(input, defaultSettings)).not.toBe(hash);
    input.mentions[0]!.referent_context = [];
    const noReferents = generationHash(input, defaultSettings);
    expect(noReferents).toBe(hash);
    input.mentions.push({ ...input.mentions[0]!, id: secondId, text: 'Относительно плана Plus.' });
    expect(generationHash(input, defaultSettings)).not.toBe(hash);
  });

  it('fingerprints evidence content, authority and expiry with a read-only snapshot', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [{ ...evidenceDocument(), content: 'original', role: 'primary', unexpired: true }] });
    const original = await evidenceSnapshotHash(storyId);
    mocks.query.mockResolvedValueOnce({ rows: [{ ...evidenceDocument(), content: 'original', role: 'supporting', unexpired: true }] });
    expect(await evidenceSnapshotHash(storyId)).not.toBe(original);
    mocks.query.mockResolvedValueOnce({ rows: [{ ...evidenceDocument(), content: 'original', role: 'primary', unexpired: false }] });
    expect(await evidenceSnapshotHash(storyId)).not.toBe(original);
    expect(mocks.query.mock.calls.every(([sql]) => String(sql).startsWith('SELECT'))).toBe(true);
  });

  it('requires research output to match current evidence even when collected mentions remain unchanged', async () => {
    const input = storyInput();
    input.story.headline = 'Новость.'; input.story.summary = 'Подробности.'; input.story.researched = true;
    const signature = await evidenceSnapshotHash(storyId);
    mocks.query.mockResolvedValueOnce({ rows: [{ result: { evidenceSignature: signature } }] });
    expect(await alreadyGenerated(input, defaultSettings)).toBe(true);
    mocks.query.mockResolvedValueOnce({ rows: [{ result: { evidenceSignature: 'obsolete' } }] });
    expect(await alreadyGenerated(input, defaultSettings)).toBe(false);
    mocks.query.mockResolvedValueOnce({ rows: [{ result: {} }] });
    expect(await alreadyGenerated(input, defaultSettings)).toBe(false);
    expect(generationHash(input, { ...defaultSettings, modelVersion: 100 }))
      .not.toBe(generationHash(input, defaultSettings));
  });

  it('rejects evidence changed during generation before writing the story', async () => {
    await expect(saveGenerations([storyInput()], [{ id: storyId, headline: 'Новость.', summary: 'Текст.',
      translatedExcerpt: null, evidenceSignature: 'obsolete' }], defaultSettings))
      .rejects.toThrow('Evidence changed during generation');
    expect(mocks.query).toHaveBeenCalledOnce();
    expect(mocks.query.mock.calls[0]?.[0]).toMatch(/^SELECT /u);
  });

  it('invalidates saved citation provenance when current mention IDs or access change', () => {
    const input = storyInput();
    const original = generationHash(input, defaultSettings);
    input.mentions[0]!.id = secondId;
    expect(generationHash(input, defaultSettings)).not.toBe(original);
    input.mentions[0]!.id = storyInput().mentions[0]!.id;
    input.mentions[0]!.access = 'unknown';
    expect(generationHash(input, defaultSettings)).not.toBe(original);
  });

});
