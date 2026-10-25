import { cleanSourceUrl } from '../source-url.js';
import { sourceAuthorityRanks, type PublicationSource } from '../types.js';

export const RELATED_PUBLICATION_LIMIT = 5;

export type SourceGroup = 'primary' | 'secondary' | 'previous' | 'unverified' | 'related';
export const SOURCE_GROUPS: ReadonlyArray<{ kind: SourceGroup; heading: string }> = [
  { kind: 'primary', heading: 'Первоисточники' },
  { kind: 'secondary', heading: 'Вторичные источники' },
  { kind: 'previous', heading: 'Предыдущие публикации' },
  { kind: 'related', heading: 'Другие публикации' },
];
function isTelegram(source: PublicationSource): boolean {
  const host = new URL(source.url).hostname.toLowerCase().replace(/^www\./u, '');
  return host === 't.me' || host === 'telegram.me';
}
export function sourceGroup(source: PublicationSource): SourceGroup {
  // Unverified historical navigation is retained for audit, never displayed as evidence or related news.
  if (source.unverifiedPublication) return 'unverified';
  if (source.relatedPublication) return 'related';
  if (source.previousPublication) return 'previous';
  if (source.kind) return source.kind === 'primary' ? 'primary' : 'secondary';
  return source.primary && !isTelegram(source) ? 'primary' : 'secondary';
}
export function orderSources(sources: PublicationSource[]): PublicationSource[] {
  const rank = (source: PublicationSource) => source.relatedPublication ? 5 : source.unverifiedPublication ? 4 : source.previousPublication ? 3 : source.kind ? sourceAuthorityRanks[source.kind] : sourceGroup(source) === 'primary' ? 0 : 2;
  return [...sources].sort((left, right) => rank(left) - rank(right)
    || (left.kind || right.kind ? 0 : Number(isTelegram(left)) - Number(isTelegram(right))));
}

/** Rendering persisted snapshots must not bypass the related-only cap. Storage keeps every audit link. */
export function visibleSources(sources: PublicationSource[]): PublicationSource[] {
  const related = new Set<string>();
  const seen = new Set<string>();
  return orderSources(sources).map(source => ({ ...source,url:cleanSourceUrl(source.url) })).filter(source => {
    if (source.unverifiedPublication || seen.has(source.url)) return false;
    seen.add(source.url);
    if (sourceGroup(source) !== 'related') return true;
    if (related.has(source.url) || related.size >= RELATED_PUBLICATION_LIMIT) return false;
    related.add(source.url);
    return true;
  });
}
