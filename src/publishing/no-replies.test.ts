import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';
import { defaultSettings } from '../settings.js';
import type { PublicationSnapshot } from '../types.js';
import { BotApi } from './bot-api.js';
import { renderCanonicalText } from './canonical-text.js';
import { renderStoredPublication } from './message-render.js';
import { retryNavigationParts } from './navigation-delivery.js';
import { prepareNavigationParts } from './navigation-parts.js';
import { deliverPublicationText, preparePublicationText } from './text-delivery.js';
import type { Publication } from './store.js';

const mocks = vi.hoisted(() => ({ query:vi.fn(),transaction:vi.fn() }));
vi.mock('../db.js', () => ({ db:{ query:mocks.query },transaction:mocks.transaction }));
vi.mock('./store.js', async original => ({ ...await original<typeof import('./store.js')>(),rateLimited:async () => false,
  locked:async (_key:string, run:(client:Pick<PoolClient,'query'>) => Promise<unknown>) => run({ query:mocks.query }) }));
const body:PublicationSnapshot = { headline:'Событие',details:'Все факты в одном сообщении.',score:7,detailsKind:'summary',presentationVersion:1,sources:[] };
const links:PublicationSnapshot['sources'] = [1624,1663].map(id => ({ url:`https://t.me/c/123/${id}`,label:`Событие ${id}`,
  primary:false,access:'public',classification:'relevant',relatedPublication:true }));
const publication:Publication = { id:'publication',snapshot_id:'snapshot',pending_snapshot_id:null,story_id:'story',destination_id:'-100123',
  message_id:'1615',bot_id:'123',status:'published',delivery_kind:'media_first',media_status:'complete',format_version:1,
  attempt_count:0,next_retry_at:null,created_at:new Date(),content:body };
const settings = { ...defaultSettings,publishingEnabled:true };
beforeEach(() => {
  vi.restoreAllMocks(); mocks.query.mockReset().mockResolvedValue({ rows:[] });
  mocks.transaction.mockReset().mockImplementation(async (run:(client:Pick<PoolClient,'query'>) => Promise<unknown>) => run({ query:mocks.query }));
});
describe('navigation never creates separate links messages', () => {
  it('places both 1624 and 1663 inside the canonical text when they fit', async () => {
    mocks.query.mockResolvedValue({ rows:[{ content:renderCanonicalText(body),snapshot_content:body }] });
    const rendered = await renderStoredPublication({ query:mocks.query },publication.id,{ ...body,sources:links });
    expect(rendered.links.map(link => link.url)).toEqual(links.map(link => link.url));
    expect(rendered.plainText).toContain(body.details);
  });
  it.each(['album','media_first'] as const)('rejects overflowing %s navigation even with a historical overflow flag', async kind => {
    const limit = kind === 'album' ? 1024 : 4096;
    const overhead = renderCanonicalText({ ...body,details:'x' }).plainText.length-1;
    const sent = { ...body,details:'x'.repeat(limit-overhead) };
    const canonical = renderCanonicalText(sent,limit);
    mocks.query.mockResolvedValue({ rows:[{ content:canonical,snapshot_content:sent }] });
    await expect(renderStoredPublication({ query:mocks.query },publication.id,{ ...sent,sources:links,navigationOverflow:true },kind))
      .rejects.toThrow('publication_message_too_long');
    expect(canonical.links).toHaveLength(0); expect(canonical.plainText).toHaveLength(limit);
  });
  it.each(['prepared','retryable','unknown'] as const)('never dispatches a persisted %s footer:0, even through a mocked API', async status => {
    mocks.query.mockImplementation(async (sql:string) => ({ rows:
      sql.includes('SELECT p.id FROM publications') ? [{ id:publication.id }]
        : sql.includes('SELECT p.*,') ? [publication]
          : sql.includes('SELECT * FROM publication_navigation_parts') ? [{ slot:'footer:0',snapshot_id:'snapshot',message_id:null,
            content:renderCanonicalText({ ...body,sources:links }),status,attempt_count:1,next_retry_at:null,text_part_number:null }] : [] }));
    const api = new BotApi('123:synthetic'); vi.spyOn(api,'identity').mockResolvedValue({ id:123,is_bot:true });
    const send = vi.spyOn(api,'send'); const edit = vi.spyOn(api,'edit');
    await retryNavigationParts(api,settings,'-100123');
    expect(send).not.toHaveBeenCalled(); expect(edit).not.toHaveBeenCalled();
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes(status === 'unknown' ? 'publication_navigation_requires_review' : 'publication_navigation_requires_new_edition'))).toBe(true);
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO request_attempts'))).toBe(false);
  });
  it('blocks a previously staged edit of a separate footer too', async () => {
    mocks.query.mockImplementation(async (sql:string) => ({ rows:sql.includes('SELECT p.id FROM publications') ? [{ id:publication.id }]
      : sql.includes('SELECT p.*,') ? [publication]
        : sql.includes('SELECT * FROM publication_navigation_parts') ? [{ slot:'footer:0',snapshot_id:'snapshot',message_id:'1664',
          content:renderCanonicalText({ ...body,sources:links }),status:'prepared',attempt_count:0,next_retry_at:null,text_part_number:null }] : [] }));
    const api = new BotApi('123:synthetic'); vi.spyOn(api,'identity').mockResolvedValue({ id:123,is_bot:true });
    const edit = vi.spyOn(api,'edit'); const send = vi.spyOn(api,'send');
    await retryNavigationParts(api,settings,'-100123');
    expect(edit).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
  });
  it.each([false,true])('caps an unattempted frozen 26-link plan, but rejects an attempted one: attempted=%s', async attempted => {
    const sources:PublicationSnapshot['sources'] = Array.from({ length:26 },(_,index) => ({ label:`Related ${index}`,url:`https://t.me/c/123/${index+1}`,
      primary:false,access:'public',classification:'relevant',relatedPublication:true }));
    const snapshot = { ...body,sources };
    const frozen = renderCanonicalText(body);
    for (const source of sources) {
      frozen.text += `\n<a href="${source.url}">${source.label}</a>`;
      frozen.links.push({ offset:frozen.plainText.length+1,length:source.label.length,url:source.url });
      frozen.plainText += '\n'+source.label;
    }
    mocks.query.mockImplementation(async (sql:string) => ({ rows:sql.includes('SELECT * FROM publications') ? [{ ...publication,status:'prepared',message_id:null }]
      : sql.includes('SELECT 1 FROM request_attempts') ? attempted ? [{ id:'attempt' }] : []
        : sql.includes('SELECT content,snapshot_id') ? [{ snapshot_id:'snapshot',content:frozen }] : [] }));
    const pending = { ...publication,status:'prepared' as const,message_id:null,content:snapshot };
    if (attempted) {
      await expect(preparePublicationText(pending)).rejects.toThrow('publication_text_requires_new_edition');
      expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO publication_text_parts'))).toBe(false);
    } else {
      const message = await preparePublicationText(pending);
      expect(message.links).toHaveLength(5);
      expect(message.links.map(link => link.url)).toEqual(sources.slice(0,5).map(source => source.url));
      expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO publication_text_parts'))).toBe(true);
    }
  });
  it('does not return26 old related links during a same-content UPD-only edit', async () => {
    const sources:PublicationSnapshot['sources'] = Array.from({ length:26 },(_,index) => ({ label:`Related ${index}`,url:`https://t.me/c/123/${index+1}`,
      primary:false,access:'public',classification:'relevant',relatedPublication:true }));
    const sent = { ...body,sources };
    const frozen = renderCanonicalText(sent);
    // A stale stored prefix can contain an excluded URL. It must not pass a same-content branch.
    frozen.links.push({ offset:0,length:1,url:'https://t.me/c/123/26' });
    mocks.query.mockResolvedValue({ rows:[{ content:frozen,snapshot_content:sent }] });
    await expect(renderStoredPublication({ query:mocks.query },publication.id,{ ...sent,updatedTo:'https://t.me/c/123/99' }))
      .rejects.toThrow('publication_text_requires_new_edition');
  });
  it('stages no footer and only retires known-unsent historical navigation work', async () => {
    mocks.query.mockImplementation(async (sql:string) => ({ rows:sql.includes('SELECT delivery_kind') ? [{ delivery_kind:'media_first' }]
      : sql.includes('SELECT t.content') ? [{ content:renderCanonicalText(body),snapshot_content:body }] : [] }));
    await prepareNavigationParts({ query:mocks.query },publication.id,'new-snapshot',{ ...body,sources:links });
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO publication_navigation_parts'))).toBe(false);
    const cleanup = mocks.query.mock.calls.find(([sql]) => String(sql).startsWith('DELETE'));
    expect(cleanup?.[0]).toContain("status IN ('prepared','retryable')");
    expect(cleanup?.[0]).toContain('message_id IS NULL');
  });
  it.each(['prepared','retryable','unknown','running'])('blocks a pending %s text continuation without changing its state', async status => {
    mocks.query.mockImplementation(async (sql:string) => ({ rows:sql.includes('part_number>0') ? [{ status }] : [] }));
    const api = new BotApi('123:synthetic'); vi.spyOn(api,'identity').mockResolvedValue({ id:123,is_bot:true });
    const send = vi.spyOn(api,'send');
    expect(await deliverPublicationText(publication,api,settings)).toBe(false);
    expect(send).not.toHaveBeenCalled();
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes('publication_text_requires_new_edition'))).toBe(true);
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes('UPDATE publication_text_parts'))).toBe(false);
  });
});
