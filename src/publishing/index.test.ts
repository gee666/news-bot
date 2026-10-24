import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultSettings } from '../settings.js';
import { BotApi } from './bot-api.js';
import { publishDigest, resumePublications, verifyBot } from './index.js';
import type { Publication } from './store.js';

const mocks = vi.hoisted(() => ({ query: vi.fn(), getSettings: vi.fn(), destination: vi.fn(), state: vi.fn(),
  prepare: vi.fn(), ready: vi.fn(), refresh: vi.fn(), send: vi.fn(), reconcile: vi.fn(), edit: vi.fn(), saveState: vi.fn(), testPublication: vi.fn(), tryLock: vi.fn(), adopt: vi.fn(), retryEdits: vi.fn(), retryReplacements: vi.fn(), admission: vi.fn() }));
vi.mock('../db.js', () => ({ db: { query: mocks.query } }));
vi.mock('./media-plan.js', () => ({ recoverPublicationMedia: vi.fn(), expirePublicationMedia: vi.fn() }));
vi.mock('./media-delivery.js', () => ({ retryPublicationMedia: vi.fn() }));
vi.mock('./text-delivery.js', () => ({ recoverPublicationText: vi.fn(), retryPublicationText: vi.fn() }));
vi.mock('./thread-updates.js', () => ({ prepareThreadUpdates: vi.fn() }));
vi.mock('../settings.js', async importOriginal => {
  const original = await importOriginal<typeof import('../settings.js')>();
  return { ...original, getSettings: mocks.getSettings };
});
vi.mock('./store.js', () => ({ rateLimited: async () => (await mocks.query('AS waiting')).rows[0]?.waiting ?? false, destination: mocks.destination, state: mocks.state,
  locked: async (_name: string, run: () => Promise<unknown>) => run(),
  tryLocked: mocks.tryLock, prepareDigest: mocks.prepare, adoptPreparedPublications: mocks.adopt, unsafeSendAttempt: "a.status IN ('running','unknown')",
  refreshPrepared: mocks.refresh, publicationSelect: 'SELECT p.*, s.content FROM publications p JOIN publication_snapshots s ON s.id=p.snapshot_id',
  saveState: mocks.saveState, testPublication: mocks.testPublication }));
vi.mock('./ready.js', () => ({ prepareReadyStories: mocks.ready }));
vi.mock('./admission.js', () => ({ checkPublicationAdmission: mocks.admission }));
vi.mock('./delivery.js', () => ({ sendPrepared: mocks.send, reconcile: mocks.reconcile, editPublication: mocks.edit }));
vi.mock('./updates.js', () => ({ prepareUpdates: vi.fn(), retryEdits: mocks.retryEdits }));
vi.mock('./repair.js', () => ({ repairExistingPublications: vi.fn(), retryReplacements: mocks.retryReplacements }));

const enabled = { ...defaultSettings, publishingEnabled: true };
const content = { headline: 'Новость', score: 1, details: 'Отрывок', detailsKind: 'excerpt', sources: [] };
function publication(index: number): Publication { return {
  id: String(index), story_id: String(index), snapshot_id: 'snap', pending_snapshot_id: null, format_version: 1, bot_id: '123', destination_id: '-100123', message_id: null,
  status: 'prepared', attempt_count: 0, created_at: new Date(), next_retry_at: null, content,
}; }

beforeEach(() => {
  vi.restoreAllMocks();
  vi.stubEnv('TELEGRAM_BOT_TOKEN','123:synthetic');
  vi.spyOn(BotApi.prototype,'identity').mockResolvedValue({ id: 123, is_bot: true });
  mocks.getSettings.mockReset().mockResolvedValue(enabled);
  mocks.destination.mockReset().mockResolvedValue('-100123');
  mocks.state.mockReset().mockResolvedValue({ verified: true, destinationId: '-100123', botId: 123 });
  mocks.query.mockReset().mockResolvedValue({ rows: [] });
  mocks.prepare.mockReset().mockResolvedValue(undefined);
  mocks.ready.mockReset().mockResolvedValue(undefined);
  mocks.admission.mockReset().mockResolvedValue({ allowed: false, reason: 'current_generation_missing' });
  mocks.adopt.mockReset().mockResolvedValue(undefined);
  mocks.retryEdits.mockReset().mockResolvedValue(undefined);
  mocks.retryReplacements.mockReset().mockResolvedValue(undefined);
  mocks.refresh.mockReset().mockResolvedValue(content);
  mocks.send.mockReset().mockResolvedValue('1');
  mocks.reconcile.mockReset().mockResolvedValue(false);
  mocks.edit.mockReset().mockResolvedValue(true);
  mocks.saveState.mockReset().mockResolvedValue(undefined);
  mocks.testPublication.mockReset().mockResolvedValue({ ...publication(0), story_id: null });
  mocks.tryLock.mockReset().mockImplementation(async (_name: string,run: () => Promise<unknown>) => run());
});

describe('explicit bot verification', () => {
  it('performs one test send and edit and ties success to destination and bot identity', async () => {
    mocks.state.mockResolvedValue(undefined);
    expect(await verifyBot()).toEqual({ verified: true, destinationId: '-100123', messageId: '1' });
    expect(mocks.testPublication).toHaveBeenCalledOnce();
    expect(mocks.send).toHaveBeenCalledOnce();
    expect(mocks.edit).toHaveBeenCalledOnce();
    expect(mocks.saveState.mock.calls.at(-1)?.[1]).toMatchObject({ verified: true, destinationId: '-100123', botId: 123 });
  });

  it('reconciles a previous unknown test send instead of sending another test post', async () => {
    const previous = { ...publication(0), story_id: null, status: 'uncertain' };
    mocks.state.mockResolvedValue({ publicationId: previous.id, destinationId: '-100123', botId: 123 });
    mocks.query.mockResolvedValue({ rows: [previous] });
    expect(await verifyBot()).toEqual({ verified: false, destinationId: '-100123', messageId: null });
    expect(mocks.reconcile).toHaveBeenCalledOnce();
    expect(mocks.testPublication).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  });
});

describe('automatic publication resumption', () => {
  it('resumes only due prepared rows without selecting new stories', async () => {
    const prepared = publication(1);
    mocks.query.mockImplementation(async (sql: string) => ({ rows: sql.includes('AS pending') ? [{ pending: true }]
      : sql.includes("p.status='prepared'") && sql.includes('SELECT p.*') ? [prepared] : [] }));
    await resumePublications(enabled);
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(mocks.ready).not.toHaveBeenCalled();
    expect(mocks.refresh).toHaveBeenCalledWith(prepared,enabled);
    expect(mocks.send).toHaveBeenCalledOnce();
    const selection = mocks.query.mock.calls.find(call => String(call[0]).includes('SELECT p.*') && String(call[0]).includes("p.status='prepared'"));
    expect(selection?.[0]).toContain('p.next_retry_at<=now()');
  });

  it('adopts previously prepared alias work before refreshing a resumed send', async () => {
    mocks.query.mockImplementation(async (sql: string) => ({ rows: sql.includes('AS pending') ? [{ pending: true }]
      : sql.includes("p.status='prepared'") && sql.includes('SELECT p.*') ? [publication(1)] : [] }));
    await resumePublications(enabled);
    expect(mocks.adopt).toHaveBeenCalledWith(enabled,'-100123');
    expect(mocks.adopt.mock.invocationCallOrder[0]).toBeLessThan(mocks.refresh.mock.invocationCallOrder[0]!);
    expect(mocks.prepare).not.toHaveBeenCalled();
  });
  it('waits for the durable Telegram rate-limit deadline before resuming', async () => {
    let waiting = true;
    mocks.query.mockImplementation(async (sql: string) => ({ rows: sql.includes('AS waiting') ? [{ waiting }]
      : sql.includes('AS pending') ? [{ pending: true }]
      : sql.includes("p.status='prepared'") && sql.includes('SELECT p.*') ? [publication(1)] : [] }));
    await resumePublications(enabled);
    expect(BotApi.prototype.identity).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
    waiting = false;
    await resumePublications(enabled);
    expect(mocks.send).toHaveBeenCalledOnce();
    expect(mocks.prepare).not.toHaveBeenCalled();
  });

  it('recovers interrupted sends and reads uncertain outcomes instead of resending', async () => {
    const uncertain = { ...publication(1), status: 'uncertain' };
    mocks.query.mockImplementation(async (sql: string) => ({ rows: sql.includes('AS pending') ? [{ pending: true }]
      : sql.includes("p.status='uncertain'") && sql.includes('SELECT p.*') ? [uncertain] : [] }));
    await resumePublications(enabled);
    expect(mocks.query.mock.calls.some(call => String(call[0]).includes("status='sending'"))).toBe(true);
    expect(mocks.reconcile).toHaveBeenCalledWith(uncertain,enabled);
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.prepare).not.toHaveBeenCalled();
    const selection = mocks.query.mock.calls.find(call => String(call[0]).includes('SELECT p.*') && String(call[0]).includes("p.status='uncertain'"));
    expect(selection?.[0]).toContain("IS DISTINCT FROM 'send_not_found_requires_review'");
    expect(selection?.[0]).toContain('p.next_retry_at<=now()');
  });

  it('avoids bot requests when nothing is due or no-match sends need manual review', async () => {
    mocks.query.mockImplementation(async (sql: string) => ({ rows: sql.includes('AS pending') ? [{ pending: false }] : [] }));
    await resumePublications(enabled);
    expect(BotApi.prototype.identity).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.reconcile).not.toHaveBeenCalled();
  });

  it('does not check ready events or contact the bot when only unselected work exists', async () => {
    mocks.query.mockImplementation(async (sql: string) => ({ rows: sql.includes('AS pending') ? [{ pending: false }] : [] }));
    await resumePublications(enabled);
    const workCheck = mocks.query.mock.calls.find(call => String(call[0]).includes('AS pending'));
    expect(workCheck?.[0]).not.toContain('story_publication_ready');
    expect(workCheck?.[1]).toEqual(['-100123']);
    expect(mocks.ready).not.toHaveBeenCalled();
    expect(BotApi.prototype.identity).not.toHaveBeenCalled();
  });

  it('retries authorized edits and replacements without selecting fresh ready events', async () => {
    mocks.query.mockImplementation(async (sql: string) => ({ rows: sql.includes('AS pending') ? [{ pending: true }] : [] }));
    await resumePublications(enabled);
    expect(mocks.ready).not.toHaveBeenCalled();
    expect(mocks.retryEdits).toHaveBeenCalledWith(expect.any(BotApi),enabled,'-100123');
    expect(mocks.retryReplacements).toHaveBeenCalledWith(expect.any(BotApi),enabled,'-100123');
  });

  it('skips the maintenance tick rather than waiting on an active digest lease', async () => {
    mocks.tryLock.mockResolvedValue(undefined);
    await resumePublications(enabled);
    expect(mocks.tryLock).toHaveBeenCalledWith('news-bot-digest',expect.any(Function));
    expect(mocks.getSettings).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('rechecks eligibility but never regenerates or selects stale prepared stories', async () => {
    mocks.query.mockImplementation(async (sql: string) => ({ rows: sql.includes('AS pending') ? [{ pending: true }]
      : sql.includes("p.status='prepared'") && sql.includes('SELECT p.*') ? [publication(1)] : [] }));
    mocks.refresh.mockResolvedValue(null);
    await resumePublications(enabled);
    expect(mocks.refresh).toHaveBeenCalledOnce();
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.prepare).not.toHaveBeenCalled();
  });

  it('requires the publishing toggle and matching successful bot verification', async () => {
    await resumePublications(defaultSettings);
    expect(mocks.tryLock).not.toHaveBeenCalled();
    mocks.state.mockResolvedValue({ verified: false });
    await resumePublications(enabled);
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.prepare).not.toHaveBeenCalled();
  });
});

describe('digest safety and completeness', () => {
  it('does nothing when publishing is disabled', async () => {
    await publishDigest(defaultSettings);
    expect(mocks.getSettings).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('requires successful verification for this destination and this bot', async () => {
    for (const value of [{ verified: false }, { verified: true, destinationId: '-100456', botId: 123 },
      { verified: true, destinationId: '-100123', botId: 456 }]) {
      mocks.state.mockResolvedValue(value);
      await publishDigest(enabled);
    }
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('does not select with a stale settings snapshot', async () => {
    mocks.getSettings.mockResolvedValue({ ...enabled, profileVersion: enabled.profileVersion+1 });
    await publishDigest(enabled);
    expect(mocks.prepare).not.toHaveBeenCalled();
  });

  it('sends all eligible stories without a cap, after rechecking their current versions', async () => {
    const publications = Array.from({ length: 111 }, (_, index) => publication(index));
    mocks.query.mockImplementation(async (sql: string) => ({ rows: sql.includes("p.status='prepared'") ? publications : [] }));
    await publishDigest(enabled);
    expect(mocks.ready).toHaveBeenCalledWith(enabled,'-100123');
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(mocks.send).toHaveBeenCalledTimes(111);
    expect(mocks.refresh).toHaveBeenCalledTimes(111);
  });

  it('reconciles uncertain sends and does not feed them to the sender', async () => {
    const uncertain = { ...publication(1), status: 'uncertain' };
    mocks.query.mockImplementation(async (sql: string) => ({ rows: sql.includes("p.status='uncertain'") ? [uncertain] : [] }));
    await publishDigest(enabled);
    expect(mocks.reconcile).toHaveBeenCalledWith(uncertain,enabled);
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('does not send prepared snapshots when Telegram rate-limit waiting survives restart', async () => {
    mocks.query.mockImplementation(async (sql: string) => ({ rows: sql.includes('AS waiting') ? [{ waiting: true }] : [] }));
    await publishDigest(enabled);
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  });
});
