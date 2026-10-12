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
