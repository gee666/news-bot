import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  value: undefined as unknown,
  activeKey: '',
  missingEmbedding: false,
  candidateKey: '',
  candidateStatus: 'pending',
  query: vi.fn<(sql: string, args?: unknown[]) => Promise<{ rows: unknown[] }>>(),
}));
vi.mock('./db.js', () => ({
  transaction: async (run: (client: { query: typeof state.query }) => Promise<unknown>) =>
    run({ query: state.query }),
}));
import {
  activateEmbeddingConfig, defaultSettings, embeddingConfigKey, getActiveEmbeddingConfig, getSettings,
  publicSettings, saveSettings, settingsSchema,
} from './settings.js';
import { publicationSnapshotSchema } from './types.js';

beforeEach(() => {
  state.value = { ...defaultSettings };
  state.activeKey = embeddingConfigKey(defaultSettings);
  state.missingEmbedding = false;
  state.candidateKey = '';
  state.candidateStatus = 'pending';
  state.query.mockReset();
  state.query.mockImplementation(async (sql, args = []) => {
    if (sql.startsWith('SELECT value')) return { rows: [{ value: state.value }] };
    if (sql.startsWith('SELECT config_key FROM')) return { rows: [{ config_key: state.activeKey }] };
    if (sql.startsWith('SELECT jsonb_build_object')) {
      return { rows: [{ config: {
        id: '00000000-0000-4000-8000-000000000001', config_key: state.activeKey,
        model: defaultSettings.embeddingModel, endpoint: defaultSettings.embeddingUrl,
        dimensions: defaultSettings.embeddingDimensions, input_version: defaultSettings.embeddingInputVersion,
        context_tokens: defaultSettings.embeddingContextTokens,
      } }] };
    }
    if (sql.startsWith('SELECT config_key, status')) {
      return { rows: [{ config_key: state.candidateKey, status: state.candidateStatus }] };
    }
    if (sql.startsWith('SELECT EXISTS')) return { rows: [{ exists: state.missingEmbedding }] };
    if (sql.startsWith('UPDATE app_settings')) state.value = JSON.parse(String(args[0]));
    return { rows: [] };
  });
});

describe('settings validation', () => {
  it('keeps publication and research scores separate and publishing off', () => {
    expect(defaultSettings.minimumPublicationScore).toBe(1);
    expect(defaultSettings.researchThreshold).toBe(5);
    expect(defaultSettings.researchMaxSearches).toBe(2);
    expect(defaultSettings.publishingEnabled).toBe(false);
    expect(defaultSettings.timezone).toBe('Europe/Berlin');
    expect(defaultSettings.collectionCron).toBe('0 5,9,13,17,21 * * *');
    expect(defaultSettings.digestCron).toBe('0 */3 * * *');
    expect(defaultSettings.piModel).toBe('gpt-6-luna');
    expect(defaultSettings.jevTimeoutMs).toBe(1_200_000);
    expect(defaultSettings.piTimeoutMs).toBe(300_000);
  });

  it.each([
    { minimumPublicationScore: 0 }, { researchThreshold: 11 }, { collectionCron: 'invalid' },
    { timezone: 'Nowhere/Fiction' }, { jevTimeoutMs: 1000 }, { embeddingDimensions: 0 },
    { jevUrl: 'https://user:password@example.com' }, { jevUrl: 'https://example.com?token=secret' },
  ])('rejects invalid configuration %j', patch => {
    expect(settingsSchema.safeParse({ ...defaultSettings, ...patch }).success).toBe(false);
  });

  it('rejects unknown keys, secret fields and client-written versions', async () => {
    for (const patch of [{ token: 'synthetic' }, { JEV_API_KEY: 'synthetic' }, { profileVersion: 7 }]) {
      await expect(saveSettings(patch)).rejects.toThrow();
    }
    expect(state.query).not.toHaveBeenCalled();
  });

  it('picks public settings without re-parsing and excludes unknown secret fields', () => {
    expect(publicSettings({ ...defaultSettings, ...{ token: 'synthetic' } })).toEqual(defaultSettings);
  });
});

describe('saved settings', () => {
  it('loads validated settings and does not increment versions for a no-op', async () => {
    expect(await getSettings()).toEqual(defaultSettings);
    const saved = await saveSettings({ interestProfile: defaultSettings.interestProfile });
    expect(saved.profileVersion).toBe(1);
    expect(saved.modelVersion).toBe(1);
    expect(state.query.mock.calls.some(([sql]) => sql.startsWith('UPDATE stories'))).toBe(false);
  });

  it('increments the profile version and marks scores stale', async () => {
    const saved = await saveSettings({ interestProfile: 'AI research announcements' });
    expect(saved.profileVersion).toBe(2);
    expect(saved.modelVersion).toBe(1);
    expect(state.query).toHaveBeenCalledWith('UPDATE stories SET interest_stale = true WHERE interest_stale = false');
  });

  it('changes the model version and stages embedding configuration without switching active search', async () => {
    const saved = await saveSettings({ embeddingModel: 'new-model' });
    expect(saved.modelVersion).toBe(2);
    const insert = state.query.mock.calls.find(([sql]) => sql.startsWith('INSERT INTO embedding_configs'));
    expect(insert?.[1]?.[6]).toBe('pending');
    expect(state.query).not.toHaveBeenCalledWith("UPDATE embedding_configs SET status = 'retired' WHERE status = 'active'");
  });

  it('keeps retrieval on the active configuration while a saved change is pending', async () => {
    await saveSettings({ embeddingModel: 'pending-model' });
    const active = await getActiveEmbeddingConfig();
    expect(active.model).toBe(defaultSettings.embeddingModel);
    expect(active.config_key).toBe(embeddingConfigKey(defaultSettings));
  });

  it('rejects inconsistent backoff settings', async () => {
    await expect(saveSettings({ retryBaseMs: 60_000, retryMaxMs: 30_000 })).rejects.toThrow('retryMaxMs');
    expect(state.query.mock.calls.some(([sql]) => sql.startsWith('UPDATE app_settings'))).toBe(false);
  });

  it('keeps vectors with different input preparation in different configurations', () => {
    expect(embeddingConfigKey({ ...defaultSettings, embeddingInputVersion: 'mention-v2' }))
      .not.toBe(embeddingConfigKey(defaultSettings));
  });
});

describe('embedding activation', () => {
  const configId = '00000000-0000-4000-8000-000000000001';
  beforeEach(() => { state.candidateKey = embeddingConfigKey(defaultSettings); });

  it('refuses to switch while an active story lacks the new embedding', async () => {
    state.missingEmbedding = true;
    await expect(activateEmbeddingConfig(configId)).rejects.toThrow('needs re-embedding');
    expect(state.query).not.toHaveBeenCalledWith("UPDATE embedding_configs SET status = 'retired' WHERE status = 'active'");
  });

  it('activates only the current saved configuration after corpus completion', async () => {
    await activateEmbeddingConfig(configId);
    expect(state.query).toHaveBeenCalledWith(
      "UPDATE embedding_configs SET status = 'active', activated_at = now() WHERE id = $1", [configId],
    );
  });

  it('rejects superseded configurations', async () => {
    state.candidateKey = 'old-key';
    await expect(activateEmbeddingConfig(configId)).rejects.toThrow('does not match saved settings');
  });
});

it('validates a self-contained publication snapshot without temporary history IDs', () => {
  expect(publicationSnapshotSchema.safeParse({
    headline: 'Новая модель выпущена', score: 8, details: 'Подробности', detailsKind: 'summary',
    sources: [{ label: 'Источник', url: 'https://example.com/post', primary: true,
      access: 'public', classification: 'relevant' }],
  }).success).toBe(true);
  expect(publicationSnapshotSchema.safeParse({ headline: 'Missing sources' }).success).toBe(false);
});
