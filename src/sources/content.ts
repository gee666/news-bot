import { createHash } from 'node:crypto';
import type { SourceCollectedItem } from './types.js';
export function normalizeText(text: string): string { return text.replace(/\r\n?/gu, '\n').trim(); }
export function revisionHash(item: Pick<SourceCollectedItem, 'originalText' | 'links'>): string {
  return createHash('sha256').update(JSON.stringify({ text: item.originalText,
    links: item.links.map(link => [link.url, link.anchorText, link.startOffset, link.endOffset,
      ...(link.metadata.format === 'markdown' ? [link.metadata.kind, link.metadata.evidenceEligible] : [])]),
  })).digest('hex');
}
