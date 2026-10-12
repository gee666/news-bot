export interface TextLink {
  url: string; anchorText: string; startOffset: number; endOffset: number; metadata: Record<string, unknown>;
}
export interface SourceCollectedItem {
  externalId: string; originalText: string; normalizedText: string;
  publishedAt: Date | null; editedAt: Date | null; originalUrl: string | null;
  links: TextLink[]; metadata: Record<string, unknown>;
}
