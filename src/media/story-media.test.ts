import { expect, it, vi } from 'vitest';
import { mocks, image, video } from './story-media.test-helpers.js';
import { randomUUID } from 'node:crypto';
import { defaultSettings } from '../settings.js';
import { publicationMedia, summaryImages, releaseStoryMedia, cleanupMedia } from './story-media.js';

it('downloads repeated source URLs once and persists only deduplicated media', async () => {
  const id = randomUUID();
  mocks.dedup.mockResolvedValue([image]);
  expect(await publicationMedia(id, defaultSettings)).toEqual([expect.objectContaining(image)]);
  expect(mocks.download).toHaveBeenCalledTimes(2);
  expect(mocks.save).toHaveBeenCalledWith(id, expect.any(String), [expect.objectContaining(image)], expect.any(Number), expect.any(AbortSignal));
  await releaseStoryMedia(id);
  expect(mocks.release).toHaveBeenCalledWith(id);
});

it('selects one original from the NVIDIA WordPress pair before downloads or visual judgment', async () => {
  const id = randomUUID();
  const url = 'https://blogs.nvidia.com/wp-content/uploads/2026/10/NVIDIA-European-Retail.jpg';
  mocks.query.mockResolvedValue({ rows: [{ revision_id: randomUUID(), metadata: { media: [
    { type: 'image', url }, { type: 'image', url: url.replace('.jpg', '-842x450.jpg') },
  ] }, source_metadata: {}, access: 'public', own_media: false }] });
  expect(await publicationMedia(id, defaultSettings)).toEqual([expect.objectContaining(image)]);
  expect(mocks.download).toHaveBeenCalledExactlyOnceWith({ type: 'image', url }, { metadata: {} }, expect.any(AbortSignal));
  expect(mocks.dedup.mock.calls[0]?.[0]).toHaveLength(1);
  expect(mocks.judge).not.toHaveBeenCalled();
  expect(mocks.privacy).toHaveBeenCalledBefore(mocks.load);
  expect(mocks.load).toHaveBeenCalledBefore(mocks.download);
  expect(mocks.save).toHaveBeenCalledWith(id, mocks.load.mock.calls[0]?.[1], [expect.objectContaining(image)], expect.any(Number), expect.any(AbortSignal));
});

it('does not infer rendition identity across separate source revisions', async () => {
  const url = 'https://example.org/wp-content/uploads/2026/10/chart.jpg';
  mocks.query.mockResolvedValue({ rows: [url, url.replace('.jpg', '-842x450.jpg')].map(url => ({
    revision_id: randomUUID(), metadata: { media: [{ type: 'image', url }] }, source_metadata: {}, access: 'public', own_media: false,
  })) });
  mocks.download.mockReset().mockResolvedValue(image);
  expect(await publicationMedia(randomUUID(), defaultSettings)).toHaveLength(2);
  expect(mocks.download).toHaveBeenCalledTimes(2);
  expect(mocks.dedup.mock.calls[0]?.[0]).toHaveLength(2);
});

it('excludes videos from summarization and obeys the configurable image cap', async () => {
  vi.stubEnv('MEDIA_SUMMARY_MAX_IMAGES', '2');
  mocks.dedup.mockResolvedValue([video, ...Array.from({ length: 12 }, () => image)]);
  expect(await summaryImages(randomUUID(), defaultSettings)).toEqual([
    { data: Buffer.from('png').toString('base64'), mimeType: 'image/webp' },
    { data: Buffer.from('png').toString('base64'), mimeType: 'image/webp' },
  ]);
  expect(mocks.normalize).toHaveBeenCalledTimes(2);
});

it('rejects an image cap above ten', async () => {
  vi.stubEnv('MEDIA_SUMMARY_MAX_IMAGES', '11');
  await expect(summaryImages(randomUUID(), defaultSettings)).rejects.toThrow('MEDIA_SUMMARY_MAX_IMAGES');
  expect(mocks.query).not.toHaveBeenCalled();
});

it('uses cached media without downloading and checks privacy first', async () => {
  mocks.load.mockResolvedValue([image]);
  expect(await publicationMedia(randomUUID(), defaultSettings)).toEqual([image]);
  expect(mocks.privacy).toHaveBeenCalledWith(['public'], expect.any(String));
  expect(mocks.download).not.toHaveBeenCalled();
});

it('does not download or send private media without approval', async () => {
  mocks.privacy.mockRejectedValue(new Error('private inference forbidden'));
  expect(await publicationMedia(randomUUID(), defaultSettings)).toEqual([]);
  expect(mocks.load).not.toHaveBeenCalled();
  expect(mocks.judge).not.toHaveBeenCalled();
  expect(mocks.relevance).not.toHaveBeenCalled();
  expect(mocks.download).not.toHaveBeenCalled();
});


it.each(['unresolved', 'same', 'different'])('only saves a final selection after resolved %s comparisons', async decision => {
  const id = randomUUID();
  mocks.judge.mockResolvedValue(decision);
  mocks.dedup.mockImplementation(async (items, compare) => {
    await compare(image.data, image.data);
    return items;
  });
  expect(await publicationMedia(id, defaultSettings)).toHaveLength(2);
  if (decision === 'unresolved') {
    expect(mocks.save.mock.calls[0]?.[1]).toBe(`unresolved:${mocks.load.mock.calls[0]?.[1]}`);
    // A second call must retry, not freeze the outage as a final selection.
    mocks.download.mockResolvedValue(image);
    await publicationMedia(id, defaultSettings);
    expect(mocks.judge).toHaveBeenCalledTimes(2);
  } else expect(mocks.save).toHaveBeenCalledTimes(1);
});

it('invalidates final selections when model identity changes', async () => {
  const id = randomUUID();
  await publicationMedia(id, defaultSettings);
  const first = mocks.load.mock.calls[0]?.[1];
  mocks.download.mockResolvedValue(image);
  await publicationMedia(id, { ...defaultSettings, piProvider: 'openai', piModel: 'new-vision-model' });
  expect(mocks.load.mock.calls[1]?.[1]).not.toBe(first);
});

it('keeps all attachments above the old 100-item processing cap', async () => {
  mocks.query.mockResolvedValue({ rows: [{ revision_id: randomUUID(), metadata: { media:
    Array.from({ length: 103 }, (_, i) => ({ type: 'image', url: `https://example.org/${i}.jpg` })),
  }, source_metadata: {}, access: 'public', own_media: false }] });
  mocks.download.mockReset().mockResolvedValue(image);
  expect(await publicationMedia(randomUUID(), defaultSettings)).toHaveLength(103);
  expect(mocks.download).toHaveBeenCalledTimes(103);
});

it('does not impose a second seven-day retention window on retained source rows or ancestor evidence', async () => {
  await publicationMedia(randomUUID(),defaultSettings);
  const sql = mocks.query.mock.calls[0]?.[0];
  expect(sql).not.toContain("interval '7 days'");
  expect(sql).toContain('se.story_id<>$1 OR e.expires_at>now()');
  expect(sql).toContain('se.superseded_at IS NULL');
});

it('filters after deduplication and caches only story-relevant attachments', async () => {
  const id = randomUUID();
  const logo = { ...image, data: Buffer.from('logo') };
  mocks.dedup.mockResolvedValue([logo, image, video]);
  mocks.relevance.mockResolvedValue({ media: [image, video], resolved: true });
  expect(await publicationMedia(id, defaultSettings)).toEqual([
    expect.objectContaining(image), expect.objectContaining(video),
  ]);
  expect(mocks.relevance).toHaveBeenCalledAfter(mocks.dedup);
  expect(mocks.relevance).toHaveBeenCalledWith([logo, image, video], await mocks.context.mock.results[0]?.value, id, defaultSettings, expect.any(AbortSignal));
  expect(mocks.save).toHaveBeenCalledAfter(mocks.relevance);
  expect(mocks.save).toHaveBeenCalledWith(id, mocks.load.mock.calls[0]?.[1], [image, video], expect.any(Number), expect.any(AbortSignal));
});

it('omits unresolved relevance images and retries rather than caching an outage as final', async () => {
  const id = randomUUID();
  mocks.relevance.mockResolvedValue({ media: [video], resolved: false });
  expect(await publicationMedia(id, defaultSettings)).toEqual([expect.objectContaining(video)]);
  expect(mocks.save).toHaveBeenCalledWith(id, `unresolved:${mocks.load.mock.calls[0]?.[1]}`, [video], expect.any(Number), expect.any(AbortSignal));
  mocks.download.mockResolvedValue(image);
  await publicationMedia(id, defaultSettings);
  expect(mocks.relevance).toHaveBeenCalledTimes(2);
});

it('invalidates cached relevance decisions when the specific story context changes', async () => {
  const id = randomUUID();
  await publicationMedia(id, defaultSettings);
  const first = mocks.load.mock.calls[0]?.[1];
  mocks.context.mockResolvedValue({ headline: 'Different mission', summary: null, chosenExcerpt: null, mentions: [] });
  mocks.download.mockResolvedValue(image);
  await publicationMedia(id, defaultSettings);
  expect(mocks.load.mock.calls[1]?.[1]).not.toBe(first);
});

it('does not load story text or classify images on a video-only source', async () => {
  mocks.query.mockResolvedValue({ rows: [{ revision_id: randomUUID(), metadata: { media: [
    { type: 'video', url: 'https://example.org/a.mp4' },
  ] }, source_metadata: {}, access: 'public', own_media: false }] });
  mocks.download.mockReset().mockResolvedValue(video);
  expect(await publicationMedia(randomUUID(), defaultSettings)).toHaveLength(1);
  expect(mocks.context).not.toHaveBeenCalled();
  expect(mocks.relevance).toHaveBeenCalledWith([expect.objectContaining(video)], null, expect.any(String), defaultSettings, expect.any(AbortSignal));
});

it('drops decoded spacer images before deduplication, vision and cache, regardless of URL or claimed metadata', async () => {
  const id = randomUUID();
  const spacer = { ...image, data: Buffer.from('decoded 1x1 JPEG pretending to be image/png') };
  mocks.download.mockReset().mockResolvedValueOnce(spacer).mockResolvedValueOnce(video);
  mocks.publishable.mockResolvedValue(false);
  expect(await publicationMedia(id, defaultSettings)).toEqual([expect.objectContaining(video)]);
  expect(mocks.publishable).toHaveBeenCalledExactlyOnceWith(spacer.data, { signal: expect.any(AbortSignal) });
  expect(mocks.publishable).toHaveBeenCalledBefore(mocks.dedup);
  expect(mocks.dedup.mock.calls[0]?.[0]).toEqual([expect.objectContaining(video)]);
  expect(mocks.relevance).toHaveBeenCalledWith([expect.objectContaining(video)], expect.any(Object), id, defaultSettings, expect.any(AbortSignal));
  expect(mocks.save).toHaveBeenCalledWith(id, mocks.load.mock.calls[0]?.[1], [expect.objectContaining(video)], expect.any(Number), expect.any(AbortSignal));
});

it('keeps healthy attachments and source processing when one download fails', async () => {
  const id = randomUUID();
  mocks.download.mockReset().mockRejectedValueOnce(new Error('CDN unavailable')).mockResolvedValueOnce(video);
  expect(await publicationMedia(id, defaultSettings)).toEqual([expect.objectContaining(video)]);
  expect(mocks.save).toHaveBeenCalledWith(id, `unresolved:${mocks.load.mock.calls[0]?.[1]}`, [expect.objectContaining(video)], expect.any(Number), expect.any(AbortSignal));
  mocks.download.mockResolvedValue(image);
  await publicationMedia(id, defaultSettings);
  expect(mocks.download).toHaveBeenCalledTimes(4);
});

it('allows text-only generation when every attachment is unavailable', async () => {
  mocks.download.mockReset().mockRejectedValue(new Error('Source media removed'));
  expect(await summaryImages(randomUUID(), defaultSettings)).toEqual([]);
  expect(mocks.save).toHaveBeenCalledWith(expect.any(String), expect.stringMatching(/^unresolved:/u), [], expect.any(Number), expect.any(AbortSignal));
  expect(mocks.normalize).not.toHaveBeenCalled();
});

it('omits undecodable attachments without dropping healthy siblings', async () => {
  mocks.publishable.mockRejectedValueOnce(new Error('Invalid image'));
  expect(await publicationMedia(randomUUID(), defaultSettings)).toEqual([expect.objectContaining(video)]);
  expect(mocks.save.mock.calls[0]?.[1]).toMatch(/^unresolved:/u);
});

it('omits an image that cannot be encoded for summarization', async () => {
  mocks.dedup.mockResolvedValue([image, { ...image, data: Buffer.from('second') }]);
  mocks.normalize.mockRejectedValueOnce(new Error('Encoding failed')).mockResolvedValueOnce(Buffer.from('good'));
  expect(await summaryImages(randomUUID(), defaultSettings)).toEqual([
    { data: Buffer.from('good').toString('base64'), mimeType: 'image/webp' },
  ]);
});

it('checks database ownership during the startup and periodic media sweep', async () => {
  const live = randomUUID(); const deleted = randomUUID();
  mocks.query.mockImplementation(async (_sql, [id]) => ({ rows: id === live ? [{ id }] : [] }));
  mocks.sweep.mockImplementation(async (_now, storyExists) => {
    expect(await storyExists(live)).toBe(true);
    expect(await storyExists(deleted)).toBe(false);
  });
  await cleanupMedia();
  expect(mocks.sweep).toHaveBeenCalledExactlyOnceWith(expect.any(Number), expect.any(Function));
  expect(mocks.query).toHaveBeenCalledWith('SELECT id FROM stories WHERE id=$1', [deleted]);
  expect(mocks.pairSweep).toHaveBeenCalledOnce();
  expect(mocks.tempSweep).toHaveBeenCalledOnce();
});
