import { describe, expect, it } from 'vitest';
import { deterministicSpans, validSpans } from './extraction.js';
import { localInference } from './privacy.js';

describe('grounded spans', () => {
  it('keeps UTF-16 offsets and does not require the predicted count', () => {
    const text = '  🚀 Acme released A.\n\nBeta shipped B.\n';
    const spans = deterministicSpans(text, '3');
    expect(spans.map(s => text.slice(s.start, s.end))).toEqual(['🚀 Acme released A.', 'Beta shipped B.']);
    expect(validSpans(text, spans)).toBe(true);
  });
  it('rejects overlap, empty ranges and out-of-bounds spans', () => {
    expect(validSpans('hello', [{ start: 0, end: 4 }, { start: 3, end: 5 }])).toBe(false);
    expect(validSpans('hello', [{ start: 1, end: 1 }])).toBe(false);
    expect(validSpans('hello', [{ start: 0, end: 6 }])).toBe(false);
    expect(validSpans('   ', [{ start: 0, end: 3 }])).toBe(false);
  });
  it('does not invent news from none or empty text', () => {
    expect(deterministicSpans('Advertising', 'none')).toEqual([]);
    expect(deterministicSpans('', '1')).toEqual([]);
  });
});
it('only exempts explicit local inference hosts from remote privacy guard', () => {
  expect(localInference('http://localhost:8765')).toBe(true);
  expect(localInference('http://host.docker.internal:11434')).toBe(true);
  expect(localInference('https://localhost.evil.example')).toBe(false);
  expect(localInference('https://models.example')).toBe(false);
});
