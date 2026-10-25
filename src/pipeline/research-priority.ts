import { cleanSourceUrl } from '../source-url.js';
import { arxivAddress } from '../sources/arxiv-address.js';

export function normalizedResearchUrl(input: string): string {
  const paper = arxivAddress(input);
  if (paper) return `https://arxiv.org/abs/${paper.id}${paper.version ?? ''}`;
  try {
    const url = new URL(cleanSourceUrl(input));
    url.hash = '';
    return url.href;
  } catch { return input; }
}

export function isTelegram(input: string): boolean {
  try {
    const host = new URL(input).hostname.toLowerCase().replace(/\.$/u, '');
    return ['t.me', 'telegram.me', 'telegram.dog'].some(domain => host === domain || host.endsWith(`.${domain}`));
  } catch { return false; }
}

function preferredHost(input: string, domains: string[]): boolean {
  try {
    const host = new URL(input).hostname.toLowerCase().replace(/\.$/u, '');
    return domains.some(domain => host === domain || host.endsWith(`.${domain}`));
  } catch { return false; }
}

/** Publisher preference affects reading order, never evidence authority. */
export function prioritizeResearchLinks<T extends { url: string; classification: string }>(links: T[]): T[] {
  const domains = (process.env.RESEARCH_PREFERRED_DOMAINS ?? '').split(',')
    .map(domain => domain.trim().toLowerCase().replace(/\.$/u, ''))
    .filter(domain => /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/u.test(domain));
  return [...links].sort((left, right) =>
    Number(left.classification === 'uncertain') - Number(right.classification === 'uncertain')
    || Number(isTelegram(left.url)) - Number(isTelegram(right.url))
    || Number(preferredHost(right.url, domains)) - Number(preferredHost(left.url, domains)));
}
