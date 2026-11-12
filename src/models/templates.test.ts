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

it('freezes direct image identity and relevance templates with explicit unresolved choices', () => {
  const template = jevTemplates.media_identity;
  expect(template.version).toBe('media-identity-direct-images-v3');
  expect(Object.keys(template.questions.relation.criteria)).toEqual(['same', 'different', 'unresolved']);
  expect(template.questions.relation.instructions).toContain('attached images themselves');
  expect(template.questions.relation.instructions).not.toContain('Use only supplied text');
  expect(Object.isFrozen(template.questions.relation)).toBe(true);
  const relevance = jevTemplates.media_relevance;
  expect(relevance.version).toBe('media-relevance-direct-images-v1');
  expect(Object.keys(relevance.questions.relation.criteria)).toEqual(['relevant', 'irrelevant', 'unresolved']);
  expect(relevance.questions.relation.instructions).toContain('COMPLETE canvas');
  expect(relevance.questions.relation.instructions).toContain('positive story-specific visual evidence');
  expect(relevance.questions.relation.instructions).toContain('named mission patch');
  expect(relevance.questions.relation.instructions).toContain('author portraits used only as a byline');
  expect(relevance.questions.relation.instructions).toContain('other roundup items');
  expect(relevance.questions.relation.instructions).toContain("An editorial portrait of the story's named subject can be relevant");
  expect(Object.isFrozen(relevance.questions.relation)).toBe(true);
});
