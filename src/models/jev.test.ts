import { createServer } from 'node:http';
import { afterEach, expect, it, vi } from 'vitest';
import { JevClient } from './jev.js';
import { jevTemplates } from './templates.js';
import { measureJevContext } from './jev-context.js';
import type { ModelImage } from './images.js';

const image = { data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', mimeType: 'image/png' };
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture(options: { status?: unknown; capacity?: number; choice?: string; reject?: boolean; onPost?: () => void } = {}) {
  const paths: string[] = []; const sent: unknown[] = []; const headers: Array<Record<string, string | string[] | undefined>> = []; const failure = vi.fn(); const usage = vi.fn();
  const server = createServer((req, res) => {
    paths.push(req.url ?? '');
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/health') {
      res.end(JSON.stringify({ contextTokens: options.capacity ?? 12288, model: 'autojev-27b-q4_k_m' })); return;
    }
    if (req.url === '/local/status') {
      res.end(JSON.stringify(options.status ?? { visionEnabled: true, maxImages: 4, imageMaxTokens: 256 })); return;
    }
    void (async () => {
      let body = '';
      for await (const chunk of req) body += String(chunk);
      sent.push(JSON.parse(body)); headers.push(req.headers);
      if (options.onPost) { options.onPost(); res.destroy(); return; }
      if (options.reject) {
        res.writeHead(400); res.end(JSON.stringify({ detail: 'PRIVATE provider payload ' + image.data })); return;
      }
      res.setHeader('X-AutoJev-Cached-Tokens', '100');
      res.setHeader('X-AutoJev-Cache-Write-Tokens', '50');
      const choice = options.choice ?? 'same';
      const criteria = ['same', 'different', 'unresolved'];
      res.end(JSON.stringify({ model: 'autojev-27b-q4_k_m', usage: { input_tokens: 1000, output_tokens: 0 },
        answers: { relation: { type: 'choice', choice,
          probabilities: Object.fromEntries(criteria.map(key => [key, key === choice ? 1 : 0])), confidence: 1 } } }));
    })();
  });
  server.keepAliveTimeout = 60_000;
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing server port');
  cleanups.push(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const baseUrl = `http://127.0.0.1:${address.port}`;
  function client(contextTokens?: number) {
    const result = new JevClient({ baseUrl, apiKey: 'private-test-key', recordFailure: failure, recordUsage: usage, prefixCache: true,
      ...(contextTokens === undefined ? {} : { contextTokens }) });
    cleanups.push(() => result.close()); return result;
  }
  return { paths, sent, headers, failure, usage, client };
}

it.each(['same', 'different', 'unresolved'])('sends direct ordered image data URLs and records JEV-only usage for %s', async choice => {
  const f = await fixture({ choice }); const client = f.client();
  expect(client.supportsImages).toBe(true);
  const result = await client.judge('media_identity', { comparison: 'whole canvases' }, { operationId: 'direct:jev' }, [image, image]);
  expect(result.answers.relation).toMatchObject({ choice });
  expect(f.paths).toEqual(['/health', '/local/status', '/v1/systemone']);
  expect(f.headers[0]).toMatchObject({ 'x-autojev-prefix-cache': 'false', 'x-autojev-cache-mode': 'none' });
  expect(f.sent).toEqual([{ model: 'jev-latest', state: { comparison: 'whole canvases' }, questions: jevTemplates.media_identity.questions,
    images: [`data:image/png;base64,${image.data}`, `data:image/png;base64,${image.data}`] }]);
  expect(f.usage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ provider: 'jev', operationId: 'direct:jev',
    inputTokens: 850, outputTokens: 0, cacheReadTokens: 100, cacheWriteTokens: 50, totalTokens: 1000, usageKnown: true }));
  expect(f.failure).not.toHaveBeenCalled();
  expect(JSON.stringify(f.usage.mock.calls)).not.toContain(image.data);
});

it.each([
  [{ ...image, data: 'private-invalid-base64' }],
  [{ ...image, mimeType: 'image/gif' }],
  [{ ...image, mimeType: 'image/jpeg' }],
  Array.from({ length: 5 }, () => image),
].map(images => ({ images })))('rejects invalid image payloads before metadata or classifier HTTP calls', async ({ images }) => {
  const f = await fixture();
  await expect(f.client().judge('media_identity', {}, { operationId: 'invalid-images' }, images))
    .rejects.toMatchObject({ metadata: { kind: 'invalid_request', outcome: 'not_submitted', retryable: false } });
  expect(f.paths).toEqual([]); expect(f.usage).not.toHaveBeenCalled(); expect(f.failure).toHaveBeenCalledOnce();
  expect(JSON.stringify(f.failure.mock.calls)).not.toContain('private-invalid-base64');
});

it.each([
  { visionEnabled: false, maxImages: 4, imageMaxTokens: 256 },
  { visionEnabled: true, maxImages: 1, imageMaxTokens: 256 },
  { visionEnabled: true, maxImages: 4 },
  { visionEnabled: true, maxImages: 4, imageMaxTokens: -1 },
])('fails closed when runtime vision capability or its token bound is unusable', async status => {
  const f = await fixture({ status });
  await expect(f.client(12288).judge('media_identity', {}, { operationId: 'vision-unavailable' }, [image, image]))
    .rejects.toMatchObject({ metadata: { kind: 'invalid_request', outcome: 'not_submitted' } });
  expect(f.paths).toEqual(['/local/status']); expect(f.sent).toEqual([]); expect(f.usage).not.toHaveBeenCalled();
});

it('adds one serving image-token cap per attachment without skipping complete text checks', async () => {
  const state = { privateText: 'Keep the entire prompt, including its final qualifier.' };
  const textBudget = await measureJevContext(state, jevTemplates.media_identity.questions, 12288, 'autojev-27b-q4_k_m', false);
  const capacity = textBudget.promptTokens + 512 + 511;
  const f = await fixture(); const client = f.client(capacity);
  // Text fits. Two 256-token images do not fit. One image still fits this same complete text.
  await expect(client.judge('media_identity', state, { operationId: 'image-budget' }, [image, image]))
    .rejects.toMatchObject({ metadata: { kind: 'context_limit', outcome: 'not_submitted', jevContextBudget: {
      promptTokens: textBudget.promptTokens, reservedTokens: 1024, contextTokens: capacity,
    } } });
  expect(f.sent).toEqual([]); expect(f.usage).not.toHaveBeenCalled();
  expect(JSON.stringify(f.failure.mock.calls)).not.toContain(state.privateText);
  await client.judge('media_identity', state, { operationId: 'one-image-budget' }, [image]);
  expect(f.sent).toHaveLength(1);
});

it('keeps oversized complete text refusal when image calls have a small image budget', async () => {
  const f = await fixture();
  const state = { story: 'PRIVATE full text with qualifiers '.repeat(10000) };
  await expect(f.client().judge('media_identity', state, { operationId: 'oversized-image-text' }, [image, image]))
    .rejects.toMatchObject({ metadata: { kind: 'context_limit', outcome: 'not_submitted' } });
  expect(f.sent).toEqual([]); expect(f.usage).not.toHaveBeenCalled();
  expect(state.story).toBe('PRIVATE full text with qualifiers '.repeat(10000));
});

it('honors large advertised image caps without the old framing-only reserve ceiling', async () => {
  const f = await fixture({ status: { visionEnabled: true, maxImages: 4, imageMaxTokens: 2048 } });
  const images: ModelImage[] = Array.from({ length: 4 }, () => image);
  await expect(f.client(4096).judge('media_identity', {}, { operationId: 'large-image-reserve' }, images))
    .rejects.toMatchObject({ metadata: { kind: 'context_limit', jevContextBudget: { reservedTokens: 8704 } } });
  expect(f.sent).toEqual([]); expect(f.usage).not.toHaveBeenCalled();
});

it('preserves cancellation and unknown usage on an interrupted direct image request', async () => {
  const controller = new AbortController();
  const f = await fixture({ onPost: () => controller.abort() });
  await expect(f.client().judge('media_identity', {}, { operationId: 'cancel-images', signal: controller.signal }, [image, image]))
    .rejects.toMatchObject({ metadata: { kind: 'cancelled' } });
  expect(f.usage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ provider: 'jev', usageKnown: false, outcome: 'failed' }));
  expect(JSON.stringify(f.failure.mock.calls)).not.toContain(image.data);
});

it('does not record provider payloads, image bytes or credentials in image failure and usage receipts', async () => {
  const f = await fixture({ reject: true });
  await expect(f.client().judge('media_identity', {}, { operationId: 'private-image-failure' }, [image]))
    .rejects.toMatchObject({ metadata: { kind: 'invalid_request' } });
  const receipts = JSON.stringify([f.failure.mock.calls, f.usage.mock.calls]);
  expect(receipts).not.toContain(image.data); expect(receipts).not.toContain('PRIVATE'); expect(receipts).not.toContain('private-test-key');
});
