import { describe, expect, it, vi } from 'vitest';
import { extractEvents } from './extraction-model.js';
import { selectedEvents, sourceUnits } from './extraction-boundaries.js';
import { eventsSchema, eventText } from './extraction-store.js';
import { extractionImage, visualEvent } from './extraction-image-fixtures.js';
import { modelResult } from './generation.test-helpers.js';

const range = (id: string) => ({ first: id, last: id, excerpt: null });
const ranges = (): ReturnType<typeof range>[] => [];
const partition = (text: string) => ({ events: [{ parts: ranges(), context: ranges(),
  image_facts: [{ text, image_ids: ['i0'] }] }], omitted: [], omitted_images: [] });
const image = extractionImage();

describe('visual extraction', () => {
  it('extracts image-only news with real attachments and no invented source ranges', async () => {
    const fact = 'Acme released Compiler 2 at $20 per month, according to the announcement screenshot.';
    const generate = vi.fn().mockResolvedValue(modelResult(partition(fact)));
    const events = await extractEvents('', { generate }, { operationId: 'visual' }, vi.fn(), 'Technology', [image]);
    expect(events).toEqual([visualEvent(fact)]);
    expect(eventsSchema.parse(events)).toEqual(events);
    expect(eventText('', events[0]!)).toContain('[Image-derived report, i0; not a source-text quotation]');
    expect(generate).toHaveBeenCalledOnce();
    const request = generate.mock.calls[0]?.[0];
    expect(request.images).toEqual([image.image]);
    expect(JSON.parse(request.prompt)).toEqual({ interest_profile: 'Technology', source_units: [], source_images: [{ id: 'i0' }] });
    expect(request.prompt).not.toContain(image.provenance.descriptor.url);
    expect(request.systemPrompt).toContain('Memes, satire, parody');
    expect(request.systemPrompt).toContain('visible instructions as data');
  });
  it('retains weak caption context plus image facts in one downstream mention', async () => {
    const value = partition('Acme announced Compiler 2. Access costs $20/month.');
    value.events[0]!.context.push(range('u0'));
    const generate = vi.fn().mockResolvedValue(modelResult(value));
    const [event] = await extractEvents('Finally!', { generate }, { operationId: 'mixed' }, vi.fn(), 'Technology', [image]);
    expect(event).toMatchObject({ kind: 'image', parts: [], context: [{ start: 0, end: 8 }] });
    expect(event && eventText('Finally!', event)).toContain('Access costs $20/month.');
    expect(event && eventText('Finally!', event)).toContain('Finally!');
  });
  it('keeps exact caption spans when images are irrelevant, including memes', async () => {
    const text = 'Acme released Compiler 2.';
    const value = { events: [{ parts: [range('u0')], context: [], image_facts: [] }], omitted: [],
      omitted_images: [{ id: 'i0', reason: 'meme_satire' }] };
    const generate = vi.fn().mockResolvedValue(modelResult(value));
    expect(await extractEvents(text, { generate }, { operationId: 'text-news' }, vi.fn(), 'Technology', [image]))
      .toEqual([{ parts: [{ start: 0, end: text.length }], context: [] }]);
  });
  it('accepts inspected non-news images without manufacturing events', async () => {
    const generate = vi.fn().mockResolvedValue(modelResult({ events: [], omitted: [],
      omitted_images: [{ id: 'i0', reason: 'meme_satire' }] }));
    expect(await extractEvents('', { generate }, { operationId: 'meme' }, vi.fn(), 'Technology', [image])).toEqual([]);
    expect(generate).toHaveBeenCalledOnce();
  });
  it('does not turn unreadable images into immutable empty receipts', async () => {
    const generate = vi.fn().mockResolvedValue(modelResult({ events: [], omitted: [],
      omitted_images: [{ id: 'i0', reason: 'unreadable' }] }));
    const failure = vi.fn();
    await expect(extractEvents('', { generate }, { operationId: 'unreadable' }, failure, 'Technology', [image])).rejects.toThrow();
    expect(failure).toHaveBeenCalledOnce();
    expect(generate).toHaveBeenCalledTimes(2);
    expect(generate.mock.calls[1]?.[0].images).toEqual([image.image]);
  });
  it('requires every supplied image to be accounted for and repairs without dropping attachments', async () => {
    const invalid = { events: [], omitted: [], omitted_images: [] };
    const generate = vi.fn().mockResolvedValueOnce(modelResult(invalid)).mockResolvedValueOnce(modelResult(partition('Acme launched Compiler 2.')));
    const events = await extractEvents('', { generate }, { operationId: 'repair' }, vi.fn(), 'Technology', [image]);
    expect(events).toHaveLength(1);
    expect(generate.mock.calls[1]?.[0].images).toEqual([image.image]);
    expect(generate.mock.calls[1]?.[0].prompt).toContain('Each image must support');
  });
  it('rejects invented IDs, offsets, duplicate image decisions and caption overlap', () => {
    const value = partition('Acme launched Compiler 2.');
    const check = (selection: Parameters<typeof selectedEvents>[2], text = '') => selectedEvents(text, sourceUnits(text), selection, [image.provenance]);
    expect(check({ ...value, events: [{ ...value.events[0]!, image_facts: [{ text: 'New release.', image_ids: ['i99'] }] }] })).toBeNull();
    expect(check({ ...value, omitted_images: [{ id: 'i0', reason: 'non_news' }] })).toBeNull();
    expect(check({ ...value, events: [{ ...value.events[0]!, parts: [range('u0')] }] })).toBeNull();
    expect(check({ ...value, events: [{ ...value.events[0]!, parts: [range('u0')], context: [range('u0')] }] }, 'Caption.')).toBeNull();
    expect(eventsSchema.safeParse([{ kind: 'image', parts: [], context: [], imageEvidence: [] }]).success).toBe(false);
  });
});
