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

it('freezes a visual-evidence identity template with a final same/different relation', () => {
  const template = jevTemplates.media_identity;
  expect(template.version).toBe('media-identity-visual-evidence-v1');
  expect(Object.keys(template.questions.relation.criteria)).toEqual(['same', 'different']);
  expect(template.questions.relation.instructions).toContain('You cannot see the images');
  expect(template.questions.relation.instructions).not.toContain('Use only supplied text');
  expect(Object.isFrozen(template.questions.relation)).toBe(true);
});
