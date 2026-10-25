import { afterEach, expect, it, vi } from 'vitest';
import { compareMediaIdentity, type MediaVisualEvidence } from './media-identity.js';
import { JevClient, type JevResult } from './jev.js';
import type { PiResult } from './pi.js';
import { ModelRequestError } from './errors.js';

const images = [{ data: 'bGVmdA==', mimeType: 'image/png' }, { data: 'cmlnaHQ=', mimeType: 'image/jpeg' }] as const;
const visual = { readable: true, subject: 'Red bridge', composition: 'Bridge runs from lower left to center',
  distinctiveDetails: ['Three white cables and a blue boat below'], visibleText: [],
  chartOrScreenshotDetails: '', limitations: [] };
const evidence: MediaVisualEvidence = { attachment1: visual, attachment2: visual,
  correspondences: ['Matching cable positions and boat at lower right'], differences: ['Right has a narrow border'],
  possibleTransformations: ['Border added'], sufficientForIdentity: true, limitations: [] };
function generation(value: unknown): PiResult {
  return { text: JSON.stringify(value), model: 'synthetic-vision', provider: 'openai-codex', nativeSchema: true,
    durationMs: 1, usage: { input: 1, output: 1, totalTokens: 2, cacheRead: 0, cacheWrite: 0,
      cost: { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0 } } };
}
function judgment(choice: 'same' | 'different'): JevResult {
  return { model: 'synthetic-jev', template: 'media_identity', promptVersion: 'media-identity-visual-evidence-v2',
    answers: { relation: { type: 'choice', choice, probabilities: { same: choice === 'same' ? 1 : 0,
      different: choice === 'different' ? 1 : 0 }, confidence: 1 } },
    usage: { input_tokens: 1, output_tokens: 0 }, metrics: { durationMs: 1 } };
}
afterEach(() => vi.restoreAllMocks());

it.each(['same', 'different'] as const)('leaves the final %s decision to JEV and sends only visual evidence', async choice => {
  const generate = vi.fn().mockResolvedValue(generation(evidence));
  const judge = vi.fn().mockResolvedValue(judgment(choice));
  const context = { operationId: 'pair', stage: 'media', attempt: 3, signal: new AbortController().signal };
  const result = await compareMediaIdentity({ generate }, { judge }, images, context, vi.fn());
  expect(result).toMatchObject({ decision: choice, evidence, generation: { model: 'synthetic-vision' },
    judgment: { model: 'synthetic-jev' }, repaired: false, evidenceVersion: 'media-visual-evidence-v2' });
  expect(generate).toHaveBeenCalledWith(expect.objectContaining({ images }),
    { ...context, operationId: 'pair:vision', stage: 'media:vision' });
  expect(judge).toHaveBeenCalledExactlyOnceWith('media_identity',
    { evidenceVersion: 'media-visual-evidence-v2', ...evidence },
    { ...context, operationId: 'pair:jev', stage: 'media:jev' });
  expect(JSON.stringify(judge.mock.calls)).not.toContain(images[0].data);
  expect(JSON.stringify(judge.mock.calls)).not.toContain(images[1].data);
});

it.each([
  { ...evidence, sufficientForIdentity: false },
  { ...evidence, attachment1: { ...visual, readable: false } },
  { ...evidence, attachment2: { ...visual, readable: false } },
])('returns unresolved without asking JEV to guess from insufficient evidence', async value => {
  const generate = vi.fn().mockResolvedValue(generation(value));
  const judge = vi.fn();
  expect(await compareMediaIdentity({ generate }, { judge }, images, { operationId: 'pair' }, vi.fn()))
    .toMatchObject({ decision: 'unresolved', judgment: null, evidence: value });
  expect(judge).not.toHaveBeenCalled();
});

it('repairs malformed visual evidence with both attachments and never forwards invalid evidence', async () => {
  const generate = vi.fn().mockResolvedValueOnce(generation({ left: 'not detailed evidence' }))
    .mockResolvedValueOnce(generation(evidence));
  const judge = vi.fn().mockResolvedValue(judgment('same'));
  const result = await compareMediaIdentity({ generate }, { judge }, images, { operationId: 'pair' }, vi.fn());
  expect(result.repaired).toBe(true);
  for (const [request] of generate.mock.calls) expect(request.images).toEqual(images);
  expect(generate.mock.calls[1]?.[1].operationId).toBe('pair:vision:repair');
  expect(judge).toHaveBeenCalledOnce();
});

it('does not classify after invalid output, vision transport failure or JEV failure', async () => {
  const judge = vi.fn();
  const record = vi.fn();
  await expect(compareMediaIdentity({ generate: vi.fn().mockResolvedValue(generation({})) }, { judge },
    images, { operationId: 'pair' }, record)).rejects.toBeInstanceOf(ModelRequestError);
  expect(judge).not.toHaveBeenCalled();
  expect(record).toHaveBeenCalledOnce();
  const error = new Error('synthetic transport failure');
  await expect(compareMediaIdentity({ generate: vi.fn().mockRejectedValue(error) }, { judge },
    images, { operationId: 'pair' }, record)).rejects.toBe(error);
  expect(judge).not.toHaveBeenCalled();
  judge.mockRejectedValue(error);
  await expect(compareMediaIdentity({ generate: vi.fn().mockResolvedValue(generation(evidence)) }, { judge },
    images, { operationId: 'pair' }, record)).rejects.toBe(error);
});

it('rejects invalid image pairs before either provider is called without recording bytes', async () => {
  const generate = vi.fn(); const judge = vi.fn(); const record = vi.fn();
  await expect(compareMediaIdentity({ generate }, { judge },
    [images[0], { data: 'private-invalid-base64', mimeType: 'image/png' }], { operationId: 'pair' }, record))
    .rejects.toMatchObject({ metadata: { kind: 'invalid_request', outcome: 'not_submitted' } });
  expect(generate).not.toHaveBeenCalled(); expect(judge).not.toHaveBeenCalled();
  expect(JSON.stringify(record.mock.calls)).not.toContain('private-invalid-base64');
});

it('rejects direct image input to System One before capability or inference HTTP calls', async () => {
  const recordFailure = vi.fn();
  const client = new JevClient({ baseUrl: 'http://127.0.0.1:1', apiKey: 'test', recordFailure });
  try {
    expect(client.supportsImages).toBe(false);
    await expect(client.judge('media_identity', {}, { operationId: 'direct' }, images)).rejects.toMatchObject({
      metadata: { kind: 'invalid_request', outcome: 'not_submitted', retryable: false,
        message: expect.stringContaining('does not support image input') },
    });
    expect(recordFailure).toHaveBeenCalledOnce();
    expect(JSON.stringify(recordFailure.mock.calls)).not.toContain(images[0].data);
  } finally { await client.close(); }
});

it('compares complete multi-panel attachments rather than left and right scenes inside one canvas', async () => {
  const composite = { ...visual, subject: 'Two-panel illustration: product shopping and warehouse logistics',
    composition: 'Complete canvas has a shopper in green at a desk on the left and a warehouse worker holding a tablet on the right.',
    distinctiveDetails: ['Left panel has shoe product cards and a map; right panel has robots, cartons and a tablet dashboard'] };
  const fullEvidence: MediaVisualEvidence = { attachment1: composite, attachment2: composite,
    correspondences: ['Both attachments contain the same shopper on the left and the same warehouse worker on the right'],
    differences: ['Attachment 1 is blurred; attachment 2 is sharper and smaller'],
    possibleTransformations: ['Resize and recompression'], sufficientForIdentity: true, limitations: [] };
  const generate = vi.fn().mockResolvedValue(generation(fullEvidence));
  const judge = vi.fn().mockResolvedValue(judgment('same'));
  expect(await compareMediaIdentity({ generate }, { judge }, images, { operationId: 'composite' }, vi.fn()))
    .toMatchObject({ decision: 'same', evidence: fullEvidence });
  const request = generate.mock.calls[0]?.[0];
  expect(request.systemPrompt).toContain('ENTIRE first attached image');
  expect(request.systemPrompt).toContain('describe BOTH panels in EACH attachment');
  expect(request.systemPrompt).not.toContain('Image 1 is left');
  expect(judge.mock.calls[0]?.[1]).toMatchObject({ attachment1: composite, attachment2: composite });
});

it('rejects the ambiguous old left/right evidence contract before JEV can classify internal panels', async () => {
  const legacy = { left: visual, right: visual, correspondences: evidence.correspondences,
    differences: evidence.differences, possibleTransformations: evidence.possibleTransformations,
    sufficientForIdentity: true, limitations: [] };
  const generate = vi.fn().mockResolvedValueOnce(generation(legacy)).mockResolvedValueOnce(generation(evidence));
  const judge = vi.fn().mockResolvedValue(judgment('same'));
  const result = await compareMediaIdentity({ generate }, { judge }, images, { operationId: 'old-contract' }, vi.fn());
  expect(result.repaired).toBe(true);
  expect(generate).toHaveBeenCalledTimes(2);
  expect(judge).toHaveBeenCalledExactlyOnceWith('media_identity',
    { evidenceVersion: 'media-visual-evidence-v2', ...evidence }, { operationId: 'old-contract:jev' });
});
