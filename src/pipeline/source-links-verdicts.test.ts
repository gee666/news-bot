import { expect, it } from 'vitest';
import { z } from 'zod';
import { validSourceVerdicts, type SourceConfirmationInput } from './source-links-confirmation.js';
import { sourceConfirmationRequest, SourceConfirmationEvidenceError } from './source-links-verdicts.js';
import { sourceInputFromRequest } from './source-links.test-helpers.js';

const input: SourceConfirmationInput = { revision_id: 'revision', message: 'Релизы DevDay: API и агент.\nПолный обзор.', candidates: [
  { candidate_id: 'link-a:story-a', story_id: 'story-a', link_id: 'link-a', url: 'https://example.org/recap', anchor: 'Все релизы',
    story: 'На DevDay вышел API. Цена $5.' },
  { candidate_id: 'link-b:story-b', story_id: 'story-b', link_id: 'link-b', url: 'https://example.org/agent', anchor: 'Агент\nДетали',
    story: 'На DevDay вышел агент. Он работает локально. Ещё детали.' },
] };
const value = () => ({ items: {
  'link-a:story-a': { verdict: 'relevant', reason: 'Тот же DevDay.', source_excerpt_id: 'message_0', story_excerpt_id: 'story_0' },
  'link-b:story-b': { verdict: 'uncertain', reason: 'Неясная связь.', source_excerpt_id: 'anchor_0', story_excerpt_id: 'story_2' },
} });

it('requires every candidate exactly once in the native schema, without model-generated IDs or quote text', () => {
  const request = sourceConfirmationRequest(input);
  const jsonSchema = z.toJSONSchema(request.validator);
  const schema = z.object({ properties: z.object({ items: z.object({ required: z.array(z.string()), additionalProperties: z.literal(false) }) }) }).parse(jsonSchema);
  expect(schema.properties.items.required).toEqual(input.candidates.map(candidate => candidate.candidate_id));
  const result = request.resolve(request.validator.parse(value()));
  expect(result.map(verdict => verdict.candidate_id)).toEqual(input.candidates.map(candidate => candidate.candidate_id));
  expect(result[0]?.source_quote).toBe('Релизы DevDay: API и агент.');
  expect(result[1]?.source_quote).toBe('Агент');
  expect(result[1]?.story_quote).toBe('Ещё детали.');
  expect(validSourceVerdicts(input, result)).toBe(true);
});

it('rejects missing or extra candidates and arbitrary literal quotations', () => {
  const request = sourceConfirmationRequest(input);
  const response = value();
  expect(request.validator.safeParse({ items: { 'link-a:story-a': response.items['link-a:story-a'] } }).success).toBe(false);
  expect(request.validator.safeParse({ items: { ...response.items, extra: response.items['link-a:story-a'] } }).success).toBe(false);
  expect(request.validator.safeParse({ items: { ...response.items, 'link-a:story-a': {
    ...response.items['link-a:story-a'], source_quote: 'invented', story_quote: 'invented',
  } } }).success).toBe(false);
});

it('rejects citation IDs belonging only to another candidate and blank passages', () => {
  const request = sourceConfirmationRequest(input);
  for (const citation of ['invented', 'message_1', 'anchor_1']) {
    const response = value();
    response.items['link-a:story-a'].source_excerpt_id = citation;
    expect(request.validator.safeParse(response).success).toBe(false);
  }
  const response = value();
  response.items['link-a:story-a'].story_excerpt_id = 'story_2';
  expect(request.validator.safeParse(response).success).toBe(false);
});

it('keeps full Unicode text, whitespace and late qualifications, while bounding resolved quotations', () => {
  const source = { ...input, message: ' \n' + '🙂'.repeat(800) + '\nОговорка в конце.', candidates: input.candidates.map(candidate => ({
    ...candidate, anchor: '', story: 'x'.repeat(1200) + ' Цена не подтверждена.\n \n',
  })) };
  const request = sourceConfirmationRequest(source);
  expect(sourceInputFromRequest({ systemPrompt: '', prompt: request.prompt })).toEqual(source);
  const wire = value();
  wire.items['link-a:story-a'].source_excerpt_id = 'message_2';
  wire.items['link-b:story-b'].source_excerpt_id = 'message_2';
  wire.items['link-a:story-a'].story_excerpt_id = 'story_0';
  wire.items['link-b:story-b'].story_excerpt_id = 'story_0';
  const verdicts = request.resolve(request.validator.parse(wire));
  for (const verdict of verdicts) {
    expect(verdict.source_quote.length).toBeLessThanOrEqual(500);
    expect(verdict.story_quote.length).toBeLessThanOrEqual(500);
    expect(verdict.source_quote).not.toMatch(/[\uD800-\uDBFF]$/u);
    expect(verdict.source_quote).not.toMatch(/^[\uDC00-\uDFFF]/u);
  }
  expect(validSourceVerdicts(source, verdicts)).toBe(true);
  expect(request.prompt).toContain('Цена не подтверждена.');
});

it('handles a weekly roundup of eight links against three separate stories with candidate-local evidence', () => {
  const roundup: SourceConfirmationInput = { revision_id: 'weekly',
    message: 'Посты недели:\n1. Чат-бот диктует номер мошенника\n2. McDonald\'s знает, сколько ты потерпишь\n3. ИИ-агент Meta торговался за хозяина',
    candidates: Array.from({ length: 24 }, (_, i) => ({ candidate_id: `link-${Math.floor(i / 3)}:story-${i % 3}`,
      story_id: `story-${i % 3}`, link_id: `link-${Math.floor(i / 3)}`, url: `https://example.org/${Math.floor(i / 3)}`,
      anchor: ['Телефон мошенника', 'Цена Бигмака', 'Клавиатуру продал ИИ-агент'][i % 3] ?? '',
      story: ['Номер телефона мошенника диктует чат-бот.', "McDonald's внедрила ИИ для цен.", 'ИИ-агент Meta продал клавиатуру.'][i % 3] ?? '',
    })) };
  const request = sourceConfirmationRequest(roundup);
  const wire = { items: Object.fromEntries(roundup.candidates.map(candidate => [candidate.candidate_id, {
    verdict: 'relevant', reason: 'Тот же субъект.', source_excerpt_id: 'anchor_0', story_excerpt_id: 'story_0',
  }])) };
  const verdicts = request.resolve(request.validator.parse(wire));
  expect(verdicts).toHaveLength(24);
  expect(validSourceVerdicts(roundup, verdicts)).toBe(true);
  expect(verdicts[1]?.story_quote).toBe("McDonald's внедрила ИИ для цен.");
  expect(verdicts[2]?.story_quote).toBe('ИИ-агент Meta продал клавиатуру.');
});

it('rejects uncitable evidence instead of fabricating a quote or dropping a candidate', () => {
  expect(() => sourceConfirmationRequest({ ...input, candidates: [{ ...input.candidates[0]!, story: ' \n' }] }))
    .toThrow(SourceConfirmationEvidenceError);
});
