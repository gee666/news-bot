import { expect, it } from 'vitest';
import { cleanArticle } from './article.js';

it('reads the original arXiv abstract, authors and title without navigation or related papers', () => {
  const article = cleanArticle('<head><title>[2609.16247] The Pain Axis</title>'
    + '<meta name="citation_title" content="The Pain Axis: LLMs Represent Self-Directed Harm and Act on It">'
    + '<meta name="citation_author" content="Valen Tagliabue"><meta name="citation_author" content="Leonard Dung">'
    + '<meta name="citation_date" content="2026/09/14"></head><body><nav>Search arXiv</nav>'
    + '<h1 class="title">Title:The Pain Axis</h1><blockquote class="abstract">Abstract:We identified representations of self-directed harm in LLMs and measured their behavioral effects.</blockquote>'
    + '<div>Related paper: unrelated claims</div></body>', 'https://arxiv.org/abs/2609.16247');
  expect(article).toEqual({ title: 'The Pain Axis: LLMs Represent Self-Directed Harm and Act on It',
    byline: 'Valen Tagliabue, Leonard Dung', publishedAt: '2026-09-14', cleaning: 'arxiv_abstract',
    paper: { id: '2609.16247', version: null, extent: 'abstract' },
    content: '# The Pain Axis: LLMs Represent Self-Directed Harm and Act on It\n\nAuthors: Valen Tagliabue, Leonard Dung\n\n## Abstract\n\nWe identified representations of self-directed harm in LLMs and measured their behavioral effects.' });
});

it('preserves full-paper sections and numeric tables without duplicate TeX annotations', () => {
  const article = cleanArticle('<a href="/abs/2609.38036v2">Back to Abstract</a><article class="ltx_document">'
    + '<h1 class="ltx_title_document">Gender bias study</h1><span class="ltx_personname">Edoardo Bolzoni</span>'
    + '<section class="ltx_section"><h2>Methods</h2><p>Agreement scale 1–7, not a probability.</p></section>'
    + '<section class="ltx_section"><h2>Results</h2><table><tr><th>Model</th><th>Torture woman</th><th>Torture man</th></tr>'
    + '<tr><td>GPT-5.5</td><td><math><mn>1.22</mn><annotation encoding="application/x-tex">1.22</annotation></math></td><td>5.44</td></tr></table></section>'
    + '<section class="ltx_section"><h2>Appendix</h2><p>Full statistical limitations.</p></section></article><nav>Unrelated links</nav>', 'https://arxiv.org/html/2609.38036v2');
  expect(article).toMatchObject({ byline: 'Edoardo Bolzoni', paper: { id: '2609.38036', version: 'v2', extent: 'full_text' } });
  expect(article?.content).toContain('| GPT-5.5');
  expect(article?.content?.match(/1\.22/gu)).toHaveLength(1);
  expect(article?.content).toContain('5.44');
  expect(article?.content).toContain('Full statistical limitations');
  expect(article?.content).not.toContain('Unrelated links');
});

it('does not infer authorship or an abstract from the domain alone', () => {
  const article = cleanArticle('<head><title>arXiv search</title></head><main>Unrelated search result</main>', 'https://arxiv.org/search');
  expect(article?.content).not.toContain('## Abstract');
});
