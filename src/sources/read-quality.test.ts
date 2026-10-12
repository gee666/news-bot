import { expect, it } from 'vitest';
import { readFailure, usefulSourceTitle } from './read-quality.js';

it.each([
  ['Sign in to GitHub · GitHub', 'Username Password', 'https://github.com/login', 'restricted'],
  ['Article', 'Checking your browser', 'https://publisher.org/article', 'restricted'],
  ['Article', 'Sign in to continue. Log in to view this content.', 'https://publisher.org/article', 'restricted'],
  ['This page couldn’t load', 'Reload to try again', 'https://x.com/account/status/1', 'unavailable'],
  ['Page not found', 'Try another page', 'https://publisher.org/missing', 'unavailable'],
] as const)('rejects successful transport screen %s', (title, content, url, access) => {
  expect(readFailure(title, content, url)).toBe(access);
});

it('does not confuse an actual CAPTCHA research paper with an access screen', () => {
  const abstract = 'We evaluated a captcha challenge and tools that ask users to verify you are human. Our experiments measured the error rate.';
  expect(readFailure('Measuring CAPTCHA error rates', abstract, 'https://arxiv.org/abs/2609.10001')).toBeNull();
});

it.each([{ status:503 },{ error:'fetch_failed' },{ status:0 },{ status:'200' },null])('rejects failed/corrupt read metadata %j',metadata=>{
  expect(readFailure('Actual article','Actual article content.','https://publisher.org/article',metadata)).toBe('unavailable');
});
it('accepts successful final read metadata despite an earlier crawler fallback error',()=>{
  expect(readFailure('Actual article','Actual article content.','https://publisher.org/article',
    { status:200,crawlerError:'browser_failed',error:null })).toBeNull();
});

it('derives fallback labels from document headings or prose, never error titles', () => {
  expect(usefulSourceTitle(null, '# New research finding\n\nAuthors report actual findings.', 'https://author.org')).toBe('New research finding');
  expect(usefulSourceTitle(null, 'Authors report actual findings.', 'https://author.org')).toBe('Authors report actual findings.');
  expect(usefulSourceTitle('Page not found', '# Page not found', 'https://author.org')).toBeNull();
});
