import { describe, expect, it, vi } from 'vitest';
import { imageEvidenceText, type ImageEvidence } from '../pipeline/extraction-evidence.js';
import { admitPublicationInputs } from './input-admission.js';
import { novelPublicationInputs, publicationBoundarySchema, reportBoundary, type PublicationBoundary } from './input-evidence.js';

vi.mock('../db.js', () => ({ db: { query: vi.fn() } }));
const now = Date.parse('2026-11-03T08:00:00Z');
const item = '5df47752-f683-478b-9875-7874456046bb';
const empty: PublicationBoundary = { version: 'publication-input-v2', inputs: [] };
function visual(text = 'Acme released model weights', hash = 'a', caption = '', modelHash = 'b') {
  const evidence: ImageEvidence[] = [{ text, images: [{ id: 'i0', descriptor: { type: 'image', url: 'https://example.org/news.jpg' },
    sourceSha256: hash.repeat(64), modelSha256: modelHash.repeat(64) }] }];
  return { item_id: item, content_hash: `${caption}:${hash}:${text}`, source_time: new Date(now - 3_600_000),
    revision_time: new Date(now - 3_600_000), collected_text: caption, urls: [],
    text: [caption, imageEvidenceText(evidence)].filter(Boolean).join('\n\n'),
    image_evidence: evidence, extraction: [{ kind: 'image', parts: [], context: [], imageEvidence: evidence }] };
}
const admit = (next: ReturnType<typeof reportBoundary>, prior = empty) =>
  admitPublicationInputs(next, prior, !!prior.inputs.length, true, 48, now);

describe('publication visual input provenance', () => {
  it.each(['', 'Look at this'])('admits first image news with caption %j from persisted image facts', caption => {
    const boundary = reportBoundary([visual(undefined, undefined, caption)]);
    expect(publicationBoundarySchema.safeParse(boundary).success).toBe(true);
    expect(boundary.inputs).toContainEqual(expect.objectContaining({ payload: { kind: 'image', sha256: 'a'.repeat(64),
      tokens: ['acme', 'released', 'model', 'weights'] } }));
    expect(boundary.inputs[0]?.collectedTokens).toContain('weights');
    expect(admit(boundary)).toEqual({ allowed: true });
  });
  it('does not count model rewordings or model-input transcodes as new collection', () => {
    const prior = reportBoundary([visual()]);
    const reworded = reportBoundary([visual('Acme makes its artificial intelligence weights available', 'a', '', 'c')]);
    expect(reworded.inputs[0]?.collectedFingerprint).toBe(prior.inputs[0]?.collectedFingerprint);
    expect(novelPublicationInputs(reworded, prior)).toEqual([]);
    expect(admit(reworded, prior)).toEqual({ allowed: false, reason: 'no_new_source_input' });
  });
  it('allows changed original image bytes even when the caption and observed words stay the same', () => {
    const prior = reportBoundary([visual()]);
    expect(admit(reportBoundary([visual(undefined, 'c')]), prior)).toEqual({ allowed: true });
  });
  it('does not count a different image observation after an unrelated caption edit', () => {
    const prior = reportBoundary([visual(undefined, 'a', 'Caption 10')]);
    const row = visual('A totally reworded visual observation', 'a', 'Caption 20');
    // This event contains image-only facts. The unrelated caption was not extracted into this story.
    row.text = imageEvidenceText(row.image_evidence);
    const old = visual(undefined, 'a', 'Caption 10'); old.text = imageEvidenceText(old.image_evidence);
    expect(admit(reportBoundary([row]), reportBoundary([old])))
      .toEqual({ allowed: false, reason: 'no_new_source_input' });
    expect(admit(reportBoundary([visual(undefined, 'a', 'Caption 20')]), prior)).toEqual({ allowed: true });
  });
  it('does not use reworded image facts as proof of a raw-caption extraction expansion', () => {
    const old = visual('Picture', 'a', 'Model Model');
    old.text = `Model\n\n${imageEvidenceText(old.image_evidence)}`;
    const row = visual('Model picture', 'a', 'Model Model. Unrelated edit.');
    row.text = `Model Model\n\n${imageEvidenceText(row.image_evidence)}`;
    expect(admit(reportBoundary([row]), reportBoundary([old])))
      .toEqual({ allowed: false, reason: 'no_new_source_input' });
  });
  it('keeps old image-only sources stale despite a recent extraction', () => {
    const row = visual(); row.source_time = new Date(now - 300 * 3_600_000);
    expect(admit(reportBoundary([row]))).toEqual({ allowed: false, reason: 'stale_source_input' });
  });
  it.each(['absent', 'mismatch', 'invalid', 'unlabeled'] as const)('rejects %s persisted visual proof', kind => {
    const row = visual();
    const boundary = reportBoundary([{ ...row,
      ...(kind === 'absent' ? { extraction: [] } : {}),
      ...(kind === 'mismatch' ? { extraction: visual(undefined, 'c').extraction } : {}),
      ...(kind === 'invalid' ? { image_evidence: [{ text: 'Invented', images: [] }] } : {}),
      ...(kind === 'unlabeled' ? { text: 'Acme released model weights' } : {}),
    }]);
    expect(boundary.inputs).toEqual([]);
  });
});
