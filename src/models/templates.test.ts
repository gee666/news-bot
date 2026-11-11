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

it('versions release-facet grouping and compares one complete pair rather than isolated wording', () => {
  const template = jevTemplates.duplicate;
  const question = template.questions.relation;
  expect(template.version).toBe('duplicate-v8');
  expect(Object.keys(question.criteria)).toEqual(['same', 'related', 'unrelated']);
  expect(question.instructions).toContain('exactly ONE incoming/candidate pair using ALL supplied reports in both groups');
  expect(question.instructions).toContain('pricing, speed, access, benchmarks and scientific or engineering demonstrations are facets of the SAME release');
  expect(question.instructions).toContain('only one demonstration may be SAME as launch coverage emphasizing different features');
  expect(question.instructions).toContain('underlying announcement, not identical wording or verbs');
  expect(question.instructions).toContain('do not invent an independent later discovery from a narrower excerpt');
  expect(question.criteria.same).toContain('different facets or demonstrations of the same release');
  expect(Object.isFrozen(question)).toBe(true);
  expect(Object.isFrozen(question.criteria)).toBe(true);
});

it('keeps independent later discoveries, releases and pricing decisions distinct', () => {
  const instructions = jevTemplates.duplicate.questions.relation.instructions;
  expect(instructions).toContain("An explicitly independent later study or discovery, another version's release or a subsequent pricing/access decision is a separate development");
  expect(instructions).toContain('Shared vendor or product alone never proves SAME');
  expect(instructions).toContain('Require a concrete connection supported by both reports');
  expect(instructions).toContain('Distinct releases of a common model family are not same');
  expect(instructions).toContain('Independent releases remain UNRELATED even when they share sourceUrl');
});

it('freezes a visual-evidence identity template with a final same/different relation', () => {
  const template = jevTemplates.media_identity;
  expect(template.version).toBe('media-identity-visual-evidence-v2');
  expect(Object.keys(template.questions.relation.criteria)).toEqual(['same', 'different']);
  expect(template.questions.relation.instructions).toContain('You cannot see the images');
  expect(template.questions.relation.instructions).not.toContain('Use only supplied text');
  expect(Object.isFrozen(template.questions.relation)).toBe(true);
});
