import { Api } from 'telegram';
import { parseID } from 'telegram/Utils.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readSentMessage, sendMetadata } from './reconciliation.js';
import { render } from './render.js';
import type { Publication } from './store.js';
const mocks = vi.hoisted(() => ({ messages: [] as unknown[], invoke: vi.fn(), config: vi.fn(), query: vi.fn(), history: vi.fn() }));
vi.mock('../db.js', () => ({ db: { query: mocks.query } }));
vi.mock('./store.js', () => ({ state: mocks.config }));
vi.mock('../telegram/client.js', () => ({ withUserClient: async (run: (client: object) => Promise<unknown>) => run({
  invoke: mocks.invoke, iterMessages: async function* (...args: unknown[]) { mocks.history(...args); yield* mocks.messages; },
}) }));
const publication: Publication = { id: 'pub', story_id: null, snapshot_id: 'snap', pending_snapshot_id: null, format_version: 1,
  bot_id: '123', destination_id: '-100123', message_id: null, status: 'uncertain', attempt_count: 1,
  created_at: new Date('2026-01-01'), next_retry_at: null,
  content: { headline: 'Одинаковый заголовок', score: 1, details: 'Все детали', detailsKind: 'summary', sources: [
    { label: 'Автор', url: 'https://author.org', primary: true, access: 'public', classification: 'relevant' },
  ] } };
const rendered = render(publication.content);
const channelId = (() => { const value = parseID('123'); if (!value) throw new Error('Invalid fixture'); return value; })();
function message(id: number, text = rendered.plainText, seconds = 1, url = 'https://author.org'): Api.Message {
  return new Api.Message({ id, peerId: new Api.PeerChannel({ channelId }), date: publication.created_at.getTime()/1000+seconds,
    message: text, entities: rendered.links.map(link => new Api.MessageEntityTextUrl({ ...link, url })) });
}
beforeEach(() => {
  mocks.messages = [];
  mocks.history.mockClear();
  mocks.invoke.mockReset().mockResolvedValue(new Api.ChatInviteAlready({
    chat: new Api.Channel({ id: channelId, title: 'Synthetic', photo: new Api.ChatPhotoEmpty(), date: 1, broadcast: true }),
  }));
  mocks.config.mockReset().mockResolvedValue({ channelId: '-100123', inviteUrl: 'https://t.me/+synthetic' });
  mocks.query.mockReset().mockImplementation(async (sql: string) => ({ rows: sql.includes('p.id<>$2') ? [] : [
    { dispatched_at: publication.created_at, response_metadata: { ...sendMetadata(rendered), requestTimeoutMs:30000 } },
  ] }));
});
describe('read-only send reconciliation without buttons', () => {
  it('matches full content, exact source entities, destination and known attempt window', async () => {
    mocks.messages = [message(4,rendered.plainText,200),message(3,'Одинаковый заголовок'),message(2)];
    expect(await readSentMessage(publication)).toBe('2');
    expect(mocks.invoke).toHaveBeenCalledOnce();
    expect(mocks.invoke.mock.calls[0]?.[0]).toBeInstanceOf(Api.messages.CheckChatInvite);
  });
  it.each([new Api.MessageMediaPhoto({}), new Api.MessageMediaDocument({})])('never adopts a media-first caption as the canonical text receipt: %s', async media => {
    const captioned = message(2); captioned.media = media;
    mocks.messages = [captioned];
    const mediaFirst = { ...publication, delivery_kind: 'media_first' as const };
    expect(await readSentMessage(mediaFirst)).toBeNull();
    mocks.messages = [message(3),captioned];
    expect(await readSentMessage(mediaFirst)).toBe('3');
  });
  it('rejects identical visible text with a different source target', async () => {
    mocks.messages = [message(3,rendered.plainText,1,'https://other.org')];
    expect(await readSentMessage(publication)).toBeNull();
  });
  it('never guesses on a missing match or two matching messages', async () => {
    mocks.messages = [message(3,'Одинаковый заголовок')];
    expect(await readSentMessage(publication)).toBeNull();
    mocks.messages = [message(3),message(2)];
    await expect(readSentMessage(publication)).rejects.toThrow('Multiple publication matches require review');
  });
  it('fails closed when another tracked identical send overlaps or legacy metadata lacks a fingerprint', async () => {
    mocks.query.mockResolvedValue({ rows: [{ dispatched_at: publication.created_at, response_metadata: { ...sendMetadata(rendered), requestTimeoutMs:30000 } }] });
    await expect(readSentMessage(publication)).rejects.toThrow('Overlapping identical sends require review');
    mocks.query.mockResolvedValue({ rows: [{ dispatched_at: publication.created_at, response_metadata: {} }] });
    await expect(readSentMessage(publication)).rejects.toThrow('Legacy send requires review');
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
  it('does not use edited content to infer the original send', async () => {
    const edited = message(2); edited.editDate = edited.date+1; mocks.messages = [edited];
    expect(await readSentMessage(publication)).toBeNull();
  });
  it('refuses another destination without reading Telegram', async () => {
    mocks.config.mockResolvedValue({ channelId: '-100456', inviteUrl: 'https://t.me/+synthetic' });
    await expect(readSentMessage(publication)).rejects.toThrow('Reconciliation destination changed');
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});
