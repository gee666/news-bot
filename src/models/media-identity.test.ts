import { expect, it, vi } from 'vitest';
import { compareMediaIdentity, MEDIA_IDENTITY_VERSION } from './media-identity.js';
import type { JevResult } from './jev.js';
import { jevTemplates } from './templates.js';

const image = { data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', mimeType: 'image/png' };
const images = [image, image] as const;
function judgment(choice: string): JevResult {
  return { model: 'synthetic-jev', template: 'media_identity', promptVersion: jevTemplates.media_identity.version,
    answers: { relation: { type: 'choice', choice, probabilities: { same: choice === 'same' ? 1 : 0,
      different: choice === 'different' ? 1 : 0, unresolved: choice === 'unresolved' ? 1 : 0 }, confidence: 1 } },
    usage: { input_tokens: 1, output_tokens: 0 }, metrics: { durationMs: 1 } };
}

it.each(['same', 'different', 'unresolved'] as const)('returns the direct JEV %s decision and receipt without a generation contract', async choice => {
  const receipt = judgment(choice);
  const judge = vi.fn().mockResolvedValue(receipt);
  const record = vi.fn();
  const context = { operationId: 'pair', stage: 'media', attempt: 3, signal: new AbortController().signal };
  const result = await compareMediaIdentity({ judge }, images, context, record);
  expect(result).toEqual({ decision: choice, judgment: receipt });
  expect(judge).toHaveBeenCalledExactlyOnceWith('media_identity', { comparisonVersion: MEDIA_IDENTITY_VERSION },
    { ...context, operationId: 'pair:jev', stage: 'media:jev' }, images);
  expect(record).not.toHaveBeenCalled();
});

it('rejects invalid pairs before dispatch without recording image bytes', async () => {
  const judge = vi.fn(); const record = vi.fn();
  await expect(compareMediaIdentity({ judge }, [image, { data: 'private-invalid-base64', mimeType: 'image/png' }],
    { operationId: 'pair' }, record)).rejects.toMatchObject({ metadata: {
    service: 'jev', operationId: 'pair:jev', kind: 'invalid_request', outcome: 'not_submitted',
  } });
  expect(judge).not.toHaveBeenCalled();
  expect(record).toHaveBeenCalledOnce();
  expect(JSON.stringify(record.mock.calls)).not.toContain('private-invalid-base64');
});

it.each(['same-ish', ''])('rejects invalid JEV decision %s instead of claiming identity', async choice => {
  const record = vi.fn();
  await expect(compareMediaIdentity({ judge: vi.fn().mockResolvedValue(judgment(choice)) }, images,
    { operationId: 'pair' }, record)).rejects.toMatchObject({ metadata: { kind: 'invalid_output', service: 'jev', outcome: 'rejected' } });
  expect(record).toHaveBeenCalledOnce();
});

it('propagates JEV transport and cancellation errors without another model call or duplicate failure receipt', async () => {
  const error = new Error('synthetic failure');
  const judge = vi.fn().mockRejectedValue(error); const record = vi.fn();
  await expect(compareMediaIdentity({ judge }, images, { operationId: 'pair' }, record)).rejects.toBe(error);
  expect(judge).toHaveBeenCalledOnce(); expect(record).not.toHaveBeenCalled();
});

it('compares whole collages across attachments, not internal panels or descriptions', () => {
  const instructions = jevTemplates.media_identity.questions.relation.instructions;
  expect(instructions).toContain('COMPLETE canvases');
  expect(instructions).toContain('every panel, split screen, collage, border and inset in EACH attachment');
  expect(instructions).toContain('corresponding panels ACROSS attachments');
  expect(instructions).toContain('NEVER left and right regions within one canvas');
  expect(instructions).toContain('A shared panel alone does not establish identity');
  expect(instructions).toContain('Choose unresolved');
  expect(instructions).not.toContain('You cannot see the images');
});
