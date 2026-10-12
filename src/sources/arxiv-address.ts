export interface ArxivAddress { id: string; version: string | null; kind: 'abs' | 'pdf' | 'html' }
export function arxivAddress(input: string, base?: string): ArxivAddress | null {
  try {
    const url = new URL(input, base);
    if (url.hostname !== 'arxiv.org' || !['https:', 'http:'].includes(url.protocol) || url.username || url.password
      || (url.port && !['80', '443'].includes(url.port))) return null;
    const match = /^\/(abs|pdf|html)\/(\d{4}\.\d{4,5}|[a-z-]+\/\d{7})(v\d+)?(?:\.pdf)?\/?$/iu.exec(url.pathname);
    const kind = match?.[1];
    if (!match?.[2] || (kind !== 'abs' && kind !== 'pdf' && kind !== 'html')
      || (url.pathname.endsWith('.pdf') && kind !== 'pdf')) return null;
    return { kind, id: match[2], version: match[3] ?? null };
  } catch { return null; }
}
