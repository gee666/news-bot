import type { PrimarySourceInput } from './config.js';

/** Public availability verified 2026-10-01; connector identity is not claim authority. */
export const PRIMARY_SOURCE_SEEDS: readonly PrimarySourceInput[] = [
  { kind: 'website', name: 'OpenAI News', publisher: 'OpenAI', url: 'https://openai.com/news/',
    articleLinkPolicy: 'same_host', articlePathPrefixes: ['/index/'], maxArticles: 2, enabled: true, unknownPublication: 'skip' },
  { kind: 'website', name: 'Anthropic News', publisher: 'Anthropic', url: 'https://www.anthropic.com/news',
    articleLinkPolicy: 'same_host', articlePathPrefixes: ['/news/'], maxArticles: 2, enabled: true, unknownPublication: 'skip' },
  { kind: 'feed', name: 'Google AI Blog', publisher: 'Google',
    url: 'https://blog.google/innovation-and-ai/technology/ai/rss/',
    articleLinkPolicy: 'same_host', articlePathPrefixes: ['/innovation-and-ai/'], maxArticles: 2, enabled: true, unknownPublication: 'skip' },
  { kind: 'feed', name: 'NVIDIA Blog', publisher: 'NVIDIA', url: 'https://blogs.nvidia.com/feed/',
    articleLinkPolicy: 'same_host', articlePathPrefixes: ['/blog/'], maxArticles: 2, enabled: true, unknownPublication: 'skip' },
  { kind: 'feed', name: 'Hugging Face Blog', publisher: 'Hugging Face', url: 'https://huggingface.co/blog/feed.xml',
    articleLinkPolicy: 'same_host', articlePathPrefixes: ['/blog/'], maxArticles: 2, enabled: true, unknownPublication: 'skip' },
];
