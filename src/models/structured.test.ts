import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import { failureMetadata, ModelRequestError, RequestFault } from './errors.js';
import type { PiResult } from './pi.js';
import { generateStructured } from './structured.js';

function result(text: string): PiResult {
  return { text, model: 'synthetic', provider: 'openai-codex', nativeSchema: true, durationMs: 123,
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}
const request = { systemPrompt: 'Synthetic', prompt: 'ID expected',
  validator: z.object({ id: z.string() }), validate: (value: { id: string }) => value.id === 'expected' };

it.each([
  ['not json', 'json'], ['{"id":123}', 'schema'], ['{"id":"wrong"}', 'record_validation'],
])('marks completed invalid output as a known rejection: %s', async (text, code) => {
  const generate = vi.fn().mockResolvedValue(result(text));
  const record = vi.fn();
  await expect(generateStructured({ generate }, request, { operationId: 'stage', attempt: 4 }, record))
    .rejects.toMatchObject({ metadata: { kind: 'invalid_output', outcome: 'rejected', attempt: 4,
      retryable: false, nextRetryAt: null, validation: { codes: [code] } } });
  expect(generate).toHaveBeenCalledTimes(2);
  expect(generate.mock.calls.map(([, context]) => context.operationId)).toEqual(['stage', 'stage:repair']);
  expect(record).toHaveBeenCalledOnce();
  expect(record).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'rejected', durationMs: 123 }));
});

it.each(['initial', 'repair'])('preserves a genuinely uncertain %s request without recording local rejection', async phase => {
  const failure = new ModelRequestError(failureMetadata(new RequestFault('transient', {
    outcome: 'unknown', status: 200, transportKind: 'stream_eof',
  }), `stage${phase === 'repair' ? ':repair' : ''}`, 'pi', 1, 10));
  const generate = vi.fn();
  if (phase === 'repair') generate.mockResolvedValueOnce(result('not json'));
  generate.mockRejectedValueOnce(failure);
  const record = vi.fn();
  await expect(generateStructured({ generate }, request, { operationId: 'stage' }, record)).rejects.toBe(failure);
  expect(generate).toHaveBeenCalledTimes(phase === 'repair' ? 2 : 1);
  expect(record).not.toHaveBeenCalled();
  expect(failure.metadata.outcome).toBe('unknown');
});

it('preserves attachments on the initial request and isolated repair', async () => {
  const images = [{ data: 'aW1hZ2U=', mimeType: 'image/png' }];
  const generate = vi.fn().mockResolvedValueOnce(result('not json')).mockResolvedValueOnce(result('{"id":"expected"}'));
  await generateStructured({ generate }, { ...request, images }, { operationId: 'vision' }, vi.fn());
  expect(generate).toHaveBeenCalledTimes(2);
  for (const [sent] of generate.mock.calls) {
    expect(sent.images).toEqual(images);
    expect(sent.prompt).not.toContain(images[0]?.data);
  }
});
