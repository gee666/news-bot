import { sourceAuthorityRanks, type PublicationSource } from '../types.js';

export type SourceGroup = 'primary' | 'secondary' | 'previous' | 'unverified' | 'related';
export const SOURCE_GROUPS: ReadonlyArray<{ kind: SourceGroup; heading: string }> = [
  { kind: 'primary', heading: 'Первоисточники' },
  { kind: 'secondary', heading: 'Вторичные источники' },
  { kind: 'previous', heading: 'Предыдущие публикации' },
  { kind: 'unverified', heading: 'Другие публикации' },
  { kind: 'related', heading: 'Связанные новости' },
];
function isTelegram(source: PublicationSource): boolean {
  const host = new URL(source.url).hostname.toLowerCase().replace(/^www\./u, '');
  return host === 't.me' || host === 'telegram.me';
}
export function sourceGroup(source: PublicationSource): SourceGroup {
  if (source.relatedPublication) return 'related';
  if (source.unverifiedPublication) return 'unverified';
  if (source.previousPublication) return 'previous';
  if (source.kind) return source.kind === 'primary' ? 'primary' : 'secondary';
  return source.primary && !isTelegram(source) ? 'primary' : 'secondary';
}
export function orderSources(sources: PublicationSource[]): PublicationSource[] {
  const rank = (source: PublicationSource) => source.relatedPublication ? 5 : source.unverifiedPublication ? 4 : source.previousPublication ? 3 : source.kind ? sourceAuthorityRanks[source.kind] : sourceGroup(source) === 'primary' ? 0 : 2;
  return [...sources].sort((left, right) => rank(left) - rank(right)
    || (left.kind || right.kind ? 0 : Number(isTelegram(left)) - Number(isTelegram(right))));
}
