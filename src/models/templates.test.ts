import { expect, it } from 'vitest';
import { jevTemplates } from './templates.js';

it('keeps news eligibility separate from personal interest scoring and versioned for reuse', () => {
  expect(jevTemplates.news_eligibility.version).toBe('news-eligibility-v3');
  expect(jevTemplates.news_eligibility.questions.eligible.type).toBe('choice');
  expect(Object.keys(jevTemplates.news_eligibility.questions.eligible.criteria)).toEqual(['eligible', 'rejected']);
  expect(jevTemplates.interest.questions.interest.type).toBe('score');
  expect(jevTemplates.news_eligibility.questions.eligible.instructions).toContain("scope='message'");
  expect(jevTemplates.news_eligibility.questions.eligible.instructions).toContain('ANY independently reportable');
  expect(jevTemplates.news_eligibility.questions.eligible.instructions).toContain("scope='story'");
  expect(Object.isFrozen(jevTemplates.news_eligibility.questions)).toBe(true);
  expect(Object.isFrozen(jevTemplates.news_eligibility.questions.eligible.criteria)).toBe(true);
  expect(Object.isFrozen(jevTemplates.news_eligibility.questions.eligible)).toBe(true);
});

it('versions the stricter event-level split contract for cached judgments', () => {
  const template = jevTemplates.split_validation;
  expect(template.version).toBe('split-validation-v2');
  expect(template.questions.valid.instructions).toContain('EACH contiguous excerpt');
  expect(template.questions.valid.instructions).toContain('NOT event boundaries');
  expect(template.questions.valid.instructions).toContain('feature-only');
  expect(template.questions.valid.instructions).toContain('two independent events');
  expect(Object.isFrozen(template.questions)).toBe(true);
  expect(Object.isFrozen(template.questions.valid.criteria)).toBe(true);
  expect(Object.isFrozen(template.questions.valid)).toBe(true);
});
