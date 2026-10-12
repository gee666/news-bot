import { expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { removeAnimatedCopies } from './article-dom.js';
import { cleanArticle } from './article.js';

it('removes exact animated copies without removing unique rows or short numeric facts', () => {
  const rows = Array.from({ length: 8 }, (_, index) => `<div><p>14:32:${index} Example policy-gateway response to an illustrative user request.</p></div>`);
  const dom = new JSDOM(`<main><div style="will-change: transform">${rows.join('').repeat(30)}<div>753</div></div></main>`);
  try {
    removeAnimatedCopies(dom.window.document);
    expect(dom.window.document.querySelector('main > div')?.children).toHaveLength(9);
    expect(dom.window.document.body.textContent).toContain('753');
  } finally { dom.window.close(); }
});

it('does not deduplicate static repeated observations or tables', () => {
  const row = '<tr><td>Identical sample</td><td>25</td></tr>';
  const dom = new JSDOM(`<table style="width:100%"><tbody>${row.repeat(12)}</tbody></table>`);
  try {
    removeAnimatedCopies(dom.window.document);
    expect(dom.window.document.querySelectorAll('tr')).toHaveLength(12);
  } finally { dom.window.close(); }
});

it('reads the actual product/pricing sections rather than an oversized animated demo', () => {
  const row = '<div><p>14:32:08 cybersec-research ALLOWED illustrative example request matched authorized policy.</p></div>';
  const article = cleanArticle(`<head><title>Unrestricted API service</title></head><main>
    <section><h1>Unrestricted API service</h1><p>We provide an API with a hosted model and configurable policies. This page describes the actual service and its subscription prices.</p></section>
    <section><h2>Policy Gateway</h2><div style="transition: transform 1200ms; will-change: transform">${row.repeat(240)}</div></section>
    <section><h2>Pay for what you use</h2><h3>Developer</h3><p>$20 per month with $20 monthly usage credit and a 2.5% discount on additional usage. Prepaid top-ups are also supported.</p><a href="/pricing">See full pricing</a></section>
    </main>`, 'https://company.org/');
  expect(article?.content).toContain('$20');
  expect(article?.title).toBe('Unrestricted API service');
  expect(article?.content.match(/illustrative example request/gu)).toHaveLength(1);
  expect(article?.followupLinks).toEqual([{ url: 'https://company.org/pricing', title: 'See full pricing' }]);
});
