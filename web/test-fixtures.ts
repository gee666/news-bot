import type { Settings, RuntimeStatus } from './api';
import type { Usage, UsageCalls } from './usage';

export const testRuntime: RuntimeStatus = { automaticWorkEnabled: true, manualMutationsAllowed: true };
export const testSettings: Settings = {
  interestProfile: 'Keep this exact interest profile.', jevUrl: 'http://localhost:8765', jevModel: 'test-jev',
  embeddingUrl: 'http://localhost:11434', embeddingModel: 'test-embedding', embeddingDimensions: 4096,
  embeddingInputVersion: 'mention-v1', embeddingContextTokens: 2048, piProvider: 'openai-codex', piModel: 'test-pi',
  researchThreshold: 5, minimumPublicationScore: 1, collectionCron: '0 */3 * * *', digestCron: '0 9,21 * * *',
  cleanupCron: '0 4 * * *', timezone: 'UTC', retentionDays: 14, publishingEnabled: false,
  jevTimeoutMs: 1200000, embeddingTimeoutMs: 600000, piTimeoutMs: 1200000, connectionTimeoutMs: 10000,
  prefixCacheEnabled: true, collectionWindowHours: 48, matchCandidateLimit: 20, headlineBatchSize: 10,
  researchMaxPages: 5, researchMaxSearches: 2, requestMaxAttempts: 5, retryBaseMs: 30000, retryMaxMs: 3600000,
};
export const testUsage: Usage = {
  accountingStartedAt: '2026-10-02T00:00:00.000Z', historicalUsageAvailable: false, currency: 'USD',
  totals: { calls: 3, completedCalls: 2, unknownUsageCalls: 1, inputTokens: 100, outputTokens: 20,
    cacheReadTokens: 30, cacheWriteTokens: 0, totalTokens: 150,
    estimatedCost: { input: 0.001, output: 0.002, cacheRead: 0.0001, cacheWrite: 0, total: 0.0031 },
    estimatedCostCalls: 1, actualBilledCost: null, actualBilledCostCalls: 0 },
  series: [], seriesTruncated: false, groups: [], options: { models: ['test-pi'], providers: ['openai-codex'], stages: ['research'] },
};
export const testUsageCalls: UsageCalls = {
  total: 26, limit: 25, offset: 0,
  calls: Array.from({ length: 25 }, (_, index) => ({
    id: `00000000-0000-4000-8000-${(index + 1).toString(16).padStart(12, '0')}`, timestamp: '2026-10-02T10:00:00.000Z', provider: 'openai-codex', model: 'test-pi',
    operationId: null, stage: 'research', attempt: 1, outcome: 'failed', usageKnown: false,
    inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, totalTokens: null,
    estimatedCost: null, actualBilledCost: null, durationMs: 100,
  })),
};
