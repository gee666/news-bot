import { describe, expect, it } from 'vitest';
import { describeJev, measureJevContext, requireJevContext } from './jev-context.js';
import { prepareJevState, referenceInstructions, type Json } from './jev-state.js';
import { jevTemplates, type JevQuestion, type JevTemplate } from './templates.js';
import { failureMetadata, failureResponseMetadata, RequestFault } from './errors.js';

function resolve(value: Json, texts: Record<string, Json>): Json {
  if (Array.isArray(value)) return value.map(child => resolve(child, texts));
  if (value && typeof value === 'object') {
    if (Object.keys(value).length === 1 && typeof value.$jevTextRef === 'string') {
      const text = texts[value.$jevTextRef];
      if (typeof text !== 'string') throw new Error('Missing complete text');
      return text;
    }
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, resolve(child, texts)]));
  }
  return value;
}
function expanded(state: Json): Json {
  if (state && !Array.isArray(state) && typeof state === 'object' && state.encoding === 'jev-text-references-v1') {
    const texts = state.texts;
    if (!texts || Array.isArray(texts) || typeof texts !== 'object') throw new Error('Missing text table');
    return resolve(state.data ?? null, texts);
  }
  return state;
}
const text = 'A public article reports an attributable model release, prices and restrictions. '.repeat(200);

describe('shared complete-prompt JEV budgeting', () => {
  it.each(Object.keys(jevTemplates).filter((name): name is JevTemplate => Object.hasOwn(jevTemplates, name)))('guards every %s template, preserving all original facts and links', async template => {
    const state = { sourceText: text, candidate: text, left: text, right: text,
      report: { text, sourceUrl: 'https://vendor.example/model', links: ['https://distributor.example/artifact'] } };
    const prepared = prepareJevState(template, state);
    expect(prepared.references).toBe(true);
    expect(expanded(prepared.state)).toEqual(state);
    const questions: Record<string, JevQuestion> = Object.fromEntries(Object.entries(jevTemplates[template].questions)
      .map(([key, question]) => [key, { ...question, instructions: question.instructions + referenceInstructions }]));
    const budget = await measureJevContext(prepared.state, questions, 12288, 'autojev-27b-q4_k_m', true);
    expect(budget.method).toBe('autojev_qwen35');
    expect(budget.promptTokens).toBeGreaterThan(0);
    expect(budget.promptTokens + budget.reservedTokens).toBeLessThan(12288);
    expect(() => requireJevContext(budget)).not.toThrow();
  });

  it('eliminates verified aggregate copies without losing either distribution identity', () => {
    const groups = [[{ text, sourceUrl: 'https://one.example', links: ['https://one.example/weights'] }],
      [{ text, sourceUrl: 'https://two.example', links: ['https://two.example/api'] }]];
    const prepared = expanded(prepareJevState('duplicate', { mention: text, candidate: text, reportGroups: groups }).state);
    expect(prepared).toEqual({ mention: { reportGroup: groups[0] }, candidate: { reportGroup: groups[1] } });
  });

  it('does not remove unverified aggregates or reinterpret colliding reference fields', () => {
    const original = { mention: text, candidate: 'Independent event', reportGroups: [] };
    expect(expanded(prepareJevState('duplicate', original).state)).toEqual(original);
    const collision = { a: text, b: text, nested: { $jevTextRef: 'untrusted source value' } };
    expect(prepareJevState('interest', collision)).toEqual({ state: collision, references: false });
  });

  it('applies the exact safety boundary without recording requested tokens as evaluated usage', () => {
    const budget = { method: 'autojev_qwen35' as const, promptTokens: 11776, reservedTokens: 512,
      contextTokens: 12288, inputBytes: 40000 };
    expect(() => requireJevContext({ ...budget, promptTokens: 11775 })).not.toThrow();
    let fault: RequestFault | undefined;
    try { requireJevContext(budget); } catch (error) { if (error instanceof RequestFault) fault = error; else throw error; }
    if (!fault) throw new Error('Expected preflight refusal');
    const failure = failureMetadata(fault, 'context-test', 'jev', 1, 0);
    expect(failure).toMatchObject({ kind: 'context_limit', outcome: 'not_submitted', jevContextBudget: budget, retryable: false });
    expect(failure.providerContextLimit).toBeUndefined();
    expect(failureResponseMetadata(failure)).toMatchObject({ jevContextBudget: budget });
  });

  it('includes complete profile/criteria/instructions and handles non-ASCII conservatively for unknown models', async () => {
    const state = { story: 'Новости 🛰️'.repeat(10000), interestProfile: 'Do not lose attribution, pricing or restrictions.' };
    const budget = await measureJevContext(state, jevTemplates.interest.questions, 12288, 'unknown-tokenizer', false);
    expect(budget.method).toBe('utf8_upper_bound');
    expect(budget.promptTokens).toBe(budget.inputBytes);
    expect(budget.promptTokens).toBeGreaterThan(Buffer.byteLength(state.story));
    expect(() => requireJevContext(budget)).toThrow(RequestFault);
    expect(state.story).toBe('Новости 🛰️'.repeat(10000));
  });

  it('matches the provider state serializer, including sorted keys and JSON whitespace', () => {
    expect(describeJev({ z: ['Новый релиз', true], a: { text: 'line\nquote"' } }))
      .toBe('{"a": {"text": ' + JSON.stringify('line\nquote"') + '}, "z": ["Новый релиз", true]}');
  });
});
