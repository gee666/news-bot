import { expect, it, vi } from 'vitest';
import { readArxiv } from './research-arxiv.js';
import type { ResearchPage } from './research-page.js';

function paper(extent: 'abstract' | 'full_text', version = 'v2'): ResearchPage {
  return { url: 'https://arxiv.org/html/2609.38036v2', canonicalUrl: 'https://arxiv.org/html/2609.38036v2',
    content: extent === 'full_text' ? 'Methods and table: GPT-5.5 torture women 1.22, men 5.44 on a 1–7 scale.' : 'Author abstract.',
    title: 'Study', access: 'public', metadata: { paper: { id: '2609.38036', version, extent } } };
}

it.each(['pdf', 'abs', 'html'])('reads full HTML first for %s while retaining citation and exact version', async kind => {
  const read = vi.fn().mockResolvedValue(paper('full_text'));
  const result = await readArxiv(`https://arxiv.org/${kind}/2609.38036v2`, read);
  expect(read).toHaveBeenCalledExactlyOnceWith('https://arxiv.org/html/2609.38036v2');
  expect(result).toMatchObject({ canonicalUrl: 'https://arxiv.org/abs/2609.38036v2',
    metadata: { paper: { extent: 'full_text', version: 'v2' }, readUrl: 'https://arxiv.org/html/2609.38036v2', representationReads: 1 } });
});

it('falls back once to the matching abstract when the HTML endpoint is unavailable', async () => {
  const read = vi.fn().mockResolvedValueOnce({ ...paper('full_text'), content: null, access: 'unavailable', metadata: { status: 404 } })
    .mockResolvedValueOnce(paper('abstract'));
  expect(await readArxiv('https://arxiv.org/pdf/2609.38036', read)).toMatchObject({ content: 'Author abstract.',
    metadata: { paper: { extent: 'abstract' }, fullTextError: 'http_404', representationReads: 2 } });
  expect(read.mock.calls.map(call => call[0])).toEqual(['https://arxiv.org/html/2609.38036', 'https://arxiv.org/abs/2609.38036']);
});

it('does not fetch an abstract beyond the caller page allowance', async () => {
  const read = vi.fn().mockResolvedValue({ ...paper('full_text'), content: null, access: 'unavailable', metadata: { status: 404 } });
  expect(await readArxiv('https://arxiv.org/pdf/2609.38036', read, 1)).toMatchObject({ access: 'unavailable', content: null,
    metadata: { representationReads: 1, abstractFallbackSkipped: 'page_budget' } });
  expect(read).toHaveBeenCalledOnce();
});

it('rejects another revision or a generic HTML page as full text', async () => {
  const read = vi.fn().mockResolvedValueOnce(paper('full_text', 'v3')).mockResolvedValueOnce(paper('abstract'));
  expect(await readArxiv('https://arxiv.org/pdf/2609.38036v2', read)).toMatchObject({ content: 'Author abstract.', metadata: { paper: { extent: 'abstract', version: 'v2' } } });
  const unverified = vi.fn().mockResolvedValue({ ...paper('full_text'), metadata: {} });
  expect(await readArxiv('https://arxiv.org/abs/2609.38036', unverified)).toMatchObject({ access: 'unavailable', content: null });
  expect(unverified).toHaveBeenCalledTimes(2);
});

it('does not promote restrictions or unrelated papers and ignores other hosts', async () => {
  const read = vi.fn().mockResolvedValue({ ...paper('full_text'), access: 'restricted', content: null });
  expect(await readArxiv('https://arxiv.org/pdf/2609.38036v1', read)).toMatchObject({ access: 'restricted', content: null });
  expect(await readArxiv('https://other.org/pdf/2609.38036', read)).toBeNull();
  expect(read).toHaveBeenCalledTimes(2);
});
