import { beforeEach, describe, expect, it, vi } from 'vitest';
import { assessEligibility, guardDigestEligibility, currentDecision } from './eligibility.js';
import { defaultSettings } from '../settings.js';
import type { JevAnswer } from '../models/jev.js';
const mocks = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('../db.js', () => ({ db: { query: mocks.query }, transaction: async (run: (client: { query: typeof mocks.query }) => Promise<unknown>) => run({ query: mocks.query }) }));
const id = '11111111-1111-4111-8111-111111111111';
const context = { id, attempt: 1, batchId: null, revisionId: null, storyId: id };
function judgment(eligible: boolean) {
  const result: JevAnswer = { type: 'choice', choice: eligible ? 'eligible' : 'rejected', confidence: 0.99,
    probabilities: { eligible: eligible ? 0.99 : 0.01, rejected: eligible ? 0.01 : 0.99 } };
  return { judge: vi.fn().mockResolvedValue(result) };
}
beforeEach(() => { mocks.query.mockReset().mockImplementation(async (sql: string) => {
  if (sql.startsWith('SELECT chosen_excerpt')) return { rows: [{ chosen_excerpt: 'A course promotion.', content_version: 3 }] };
  if (sql.startsWith('SELECT id FROM stories')) return { rows: [{ id }] };
  return { rows: [] };
}); });
describe('eligibility separate from interest', () => {
  it('rejects excluded material with a durable versioned decision, not a publishable score of one', async () => {
    const judge = judgment(false);
    expect(await assessEligibility(id, defaultSettings, judge, context)).toBe(false);
    expect(judge.judge).toHaveBeenCalledWith('news_eligibility', expect.objectContaining({ interestProfile: defaultSettings.interestProfile }), context);
    const update = mocks.query.mock.calls.find(call => String(call[0]).includes("SET status='rejected'"));
    expect(update?.[0]).toContain('interest_score=NULL,interest_stale=false');
    expect(mocks.query.mock.calls.some(call => String(call[0]).includes('UPDATE story_evidence SET superseded_at'))).toBe(true);
    const stamp = mocks.query.mock.calls.find(call => String(call[0]).includes('INSERT INTO judgments'));
    expect(stamp?.[1]).toContain('news-eligibility-v3');
    expect(stamp?.[1]).toContain(JSON.stringify({ eligible: false, contentVersion: 3 }));
  });
  it('preserves already complete low-interest news without regenerating its display', async () => {
    expect(await assessEligibility(id, { ...defaultSettings, minimumPublicationScore: 1 }, judgment(true), context)).toBe(true);
    const sql = mocks.query.mock.calls.map(call => String(call[0])).join('\n');
    expect(sql).not.toContain('summary=NULL');
    expect(sql).not.toContain('interest_score=');
    expect(sql).toContain("WHERE id=$1 AND status='rejected'");
  });
  it('rechecks rejected stories when profile/model/content versions change', async () => {
    expect(currentDecision).toContain('j.profile_version=$1 AND j.model_version=$2');
    expect(currentDecision).toContain("j.result->>'contentVersion'=s.content_version::text");
    expect(currentDecision).toContain('j.expires_at>now()');
  });
  it('can guard only the stories owned by a bounded manual run', async () => {
    await guardDigestEligibility(defaultSettings, [id]);
    expect(mocks.query.mock.calls[0]?.[0]).toContain('($3::uuid[] IS NULL OR s.id=ANY($3))');
    expect(mocks.query.mock.calls[0]?.[1]).toEqual([defaultSettings.profileVersion, defaultSettings.modelVersion, [id]]);
  });
  it('hides missing or rejected eligibility from digest selection even when refresh could not take its lease', async () => {
    await guardDigestEligibility(defaultSettings);
    const sql = String(mocks.query.mock.calls[0]?.[0]);
    expect(sql).toMatch(/status='completed'\s+AND/u);
    expect(sql).toContain('blocked_stories');
    expect(sql).toContain('OR NOT EXISTS');
    expect(sql).toContain("j.result->>'eligible'='true'");
    expect(sql).not.toContain('interest_score');
  });
});
