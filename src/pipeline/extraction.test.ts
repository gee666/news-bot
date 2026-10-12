import { expect, it } from 'vitest';
import { validSpans } from './extraction-store.js';
import { sourceUnits } from './extraction-boundaries.js';
import { localInference } from './privacy.js';

it('keeps UTF-16 source coordinates without predicting a story count', () => {
  const text = '  🚀 Acme released A.\n\nBeta shipped B.\n';
  const spans = sourceUnits(text);
  expect(spans.map(span => text.slice(span.start,span.end))).toEqual(['🚀 Acme released A.', 'Beta shipped B.']);
  expect(validSpans(text,spans)).toBe(true);
});
it('rejects overlap, empty ranges and out-of-bounds spans', () => {
  expect(validSpans('hello', [{ start: 0, end: 4 }, { start: 3, end: 5 }])).toBe(false);
  expect(validSpans('hello', [{ start: 1, end: 1 }])).toBe(false);
  expect(validSpans('hello', [{ start: 0, end: 6 }])).toBe(false);
  expect(validSpans('   ', [{ start: 0, end: 3 }])).toBe(false);
});
it('only exempts explicit local inference hosts from the remote privacy guard', () => {
  expect(localInference('http://localhost:8765')).toBe(true);
  expect(localInference('http://host.docker.internal:11434')).toBe(true);
  expect(localInference('https://localhost.evil.example')).toBe(false);
  expect(localInference('https://models.example')).toBe(false);
});
