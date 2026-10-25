import { expect, it } from 'vitest';
import { distinctSourceMedia } from './source-images.js';
import type { MediaDescriptor } from './download.js';

const original = 'https://blogs.nvidia.com/wp-content/uploads/2026/10/NVIDIA-European-Retail.jpg';
const rendition = original.replace('.jpg', '-842x450.jpg');
const image = (url: string): MediaDescriptor => ({ type: 'image', url });

it.each([false, true])('keeps the supplied original rather than its WordPress rendition, reversed=%s', reversed => {
  const input = [image(original), image(rendition)];
  const before = structuredClone(input);
  expect(distinctSourceMedia(reversed ? [...input].reverse() : input)).toEqual([input[0]]);
  expect(input).toEqual(before);
});

it.each(['jpg', 'jpeg', 'png', 'webp', 'avif'])('recognizes %s upload renditions without downloading or judging', extension => {
  const url = original.replace('.jpg', `.${extension}`);
  expect(distinctSourceMedia([image(url), image(url.replace(`.${extension}`, `-300x200.${extension}`))]))
    .toEqual([image(url)]);
});

it('keeps lone renditions and dimension-suffixed filenames outside WordPress uploads', () => {
  const plain = 'https://example.org/charts/chart.jpg';
  const input = [image(rendition), image(plain), image(plain.replace('.jpg', '-842x450.jpg'))];
  expect(distinctSourceMedia(input)).toEqual(input);
});

it('requires the same origin, directory, extension, query and fragment as the supplied original', () => {
  const input = [image(original), ...[
    rendition.replace('blogs.nvidia.com', 'example.org'),
    rendition.replace('https:', 'http:'),
    rendition.replace('/10/', '/09/'),
    rendition.replace('.jpg', '.png'),
    `${rendition}?crop=other`, `${rendition}#other`,
  ].map(image)];
  expect(distinctSourceMedia(input)).toEqual(input);
});

it('preserves shared query parameters and only removes the matching size suffix', () => {
  const url = original.replace('Retail', 'Retail-2026');
  expect(distinctSourceMedia([image(`${url}?version=2`), image(`${url.replace('.jpg', '-842x450.jpg')}?version=2`)]))
    .toEqual([image(`${url}?version=2`)]);
});

it('preserves unrelated images, video, Telegram descriptors and descriptor order', () => {
  const input: MediaDescriptor[] = [
    image(original), image(original.replace('Retail', 'Other')), image(rendition),
    { type: 'video', url: rendition }, { type: 'image', telegramMessageId: 123 },
    image('not a URL'), image('file:///wp-content/uploads/2026/10/Retail-842x450.jpg'),
  ];
  expect(distinctSourceMedia(input)).toEqual(input.filter((_, index) => index !== 2));
});

it('does not treat a video URL as evidence that an image original exists', () => {
  const input: MediaDescriptor[] = [{ type: 'video', url: original }, image(rendition)];
  expect(distinctSourceMedia(input)).toEqual(input);
});

it('rejects stored website logos before download without discarding story graphics or Telegram media', () => {
  const input: MediaDescriptor[] = [
    image('https://example.org/assets/LogoDark.png'), image('https://example.org/assets/wordmark.png'),
    image('https://example.org/author-headshot.jpg'), image('https://example.org/mission-patch.png'),
    image('https://example.org/biological-results.png'), { type: 'image', telegramMessageId: 123 },
  ];
  expect(distinctSourceMedia(input)).toEqual(input.slice(3));
});
