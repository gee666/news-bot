import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PublicationSnapshot, PublicationSource } from '../types.js';
import { fullRepairPlan, snapshotHash, type ReviewedAction } from './approval.js';
import { reconcileUnknownEdit } from './edit-reconciliation.js';
import { renderFullText, withUpdateMarker } from './full-text.js';
import { withoutUpdateMarker } from './message-render.js';
import { contentFingerprint } from './reconciliation.js';
import { escapeHtml, type RenderedMessage } from './render.js';
import type { Publication } from './store.js';

const mocks = vi.hoisted(()=>({ query:vi.fn(),transaction:vi.fn() }));
vi.mock('../db.js',()=>({ db:{ query:mocks.query },transaction:mocks.transaction }));
interface Attempt { id:string; status:string; response_metadata:unknown; next_retry_at:Date|null }
interface Part { content:RenderedMessage; snapshot_content:PublicationSnapshot }
let publication:Publication;
let owned:Publication;
let snapshot:PublicationSnapshot;
let prior:PublicationSnapshot;
let snapshotStory:string|null;
let attempts:Attempt[];
let parts:Part[];
let action:ReviewedAction|null;
let missingSnapshot:boolean;
const desiredId=randomUUID(),priorId=randomUUID(),storyId=randomUUID();
const related:PublicationSource={label:'Связанные новости <&> 😀',url:'https://t.me/c/123/20',primary:false,
  access:'public',classification:'relevant',relatedPublication:true};
const audit:PublicationSource={...related,label:'Сохранённая ссылка',url:'https://t.me/c/123/30',relatedPublication:undefined,unverifiedPublication:true};
const fact:PublicationSource={...related,label:'Исходный документ',url:'https://source.example/doc',relatedPublication:undefined,primary:true};
const fingerprint=(message:RenderedMessage)=>contentFingerprint(message.plainText,message.links);
function first(content:PublicationSnapshot):RenderedMessage {
  const message=renderFullText(content)[0];
  if (!message) throw new Error('Missing rendered fixture'); return message;
}
function record(message:RenderedMessage,extra:object={}) {
  attempts=[{id:randomUUID(),status:'unknown',next_retry_at:null,
    response_metadata:{snapshotId:desiredId,fingerprint:fingerprint(message),...extra}}];
}
function writes() { return mocks.query.mock.calls.filter(([sql])=>/^(UPDATE|INSERT|DELETE) /u.test(String(sql))); }
function frozenCanonical():RenderedMessage {
  const saved=mocks.query.mock.calls.find(([sql])=>String(sql).includes('INSERT INTO publication_text_parts'));
  if (!saved) throw new Error('No canonical saved');
  return JSON.parse(String(saved[1]?.[1]));
}
function appendLegacy(base:RenderedMessage,source:PublicationSource,heading:string):RenderedMessage {
  const prefix='\n\n'+heading+'\n';
  return {...base,text:base.text+`\n\n<b>${heading}</b>\n<a href="${source.url}">${escapeHtml(source.label)}</a>`,
    plainText:base.plainText+prefix+source.label,
    links:[...base.links,{offset:base.plainText.length+prefix.length,length:source.label.length,url:source.url}]};
}
function repairFixture(long=true) {
  publication.delivery_kind='album'; publication.media_snapshot_id=priorId;
  snapshot={...snapshot,details:long?'Полные исходные факты. '.repeat(300):'Все исходные факты.',sources:[fact,related]};
  publication.content=snapshot; owned=structuredClone(publication);
  const plan=fullRepairPlan(snapshot);
  action={approvalId:randomUUID(),operation:'edit',state:'uncertain',publicationId:publication.id,
    destinationId:publication.destination_id,messageId:publication.message_id ?? '',priorSnapshotId:priorId,desiredSnapshotId:desiredId,
    snapshotHash:snapshotHash(snapshot),storyId,contentVersion:1,receiptId:null,coordinator:'Offline reviewer',
    // Expiration prevents new dispatch, not observation of an already-dispatched request.
    expiresAt:new Date(Date.now()-60_000).toISOString(),fullContentRepair:{botId:'123',mediaSnapshotId:priorId,
      priorSnapshotHash:snapshotHash(prior),reason:'Restore complete historical publication'}};
  const caption=plan[0]; if(!caption) throw new Error('Missing repair caption');
  record(caption,{approvalId:action.approvalId,fullContentRepair:true,parts:plan});
  return {plan,caption};
}

beforeEach(()=>{
  vi.restoreAllMocks(); mocks.query.mockReset(); mocks.transaction.mockReset();
  snapshot={headline:'Историческая новость',details:'Факты <&> 😀. Связанные новости остаются буквальной цитатой.',
    score:8,detailsKind:'summary',sources:[]};
  prior=structuredClone(snapshot); snapshotStory=storyId;
  publication={id:randomUUID(),story_id:storyId,destination_id:'-100123',message_id:'10',bot_id:'123',status:'published',
    delivery_kind:'text',media_snapshot_id:null,snapshot_id:priorId,pending_snapshot_id:desiredId,format_version:1,
    attempt_count:0,created_at:new Date(),next_retry_at:null,content:snapshot};
  owned=structuredClone(publication); parts=[]; action=null; missingSnapshot=false;
  record(first(snapshot));
  mocks.transaction.mockImplementation(async(run:(client:Pick<PoolClient,'query'>)=>Promise<unknown>)=>run({query:mocks.query}));
  mocks.query.mockImplementation(async(sql:string,args:unknown[]=[])=>{
    let rows:unknown[]=[];
    if(sql.includes('SELECT id,status,response_metadata,next_retry_at')) rows=structuredClone(attempts);
    else if(sql.includes('SELECT snap.content,snap.story_id')) rows=missingSnapshot?[]:[{
      content:structuredClone(snapshot),story_id:snapshotStory,publication_story_id:owned.story_id,canonical_story_id:owned.story_id}];
    else if(sql.startsWith('SELECT * FROM publications')) rows=[structuredClone(owned)];
    else if(sql.includes('SELECT t.content,s.content AS snapshot_content')) rows=structuredClone(parts);
    else if(sql.includes('SELECT snap.content FROM publications')) rows=[{content:structuredClone(prior)}];
    else if(sql.startsWith('SELECT value FROM operational_state')) rows=action?[{value:structuredClone(action)}]:[];
    else if(sql.startsWith('SELECT content FROM publication_snapshots')) rows=[{content:structuredClone(prior)}];
    else if(sql.startsWith('UPDATE request_attempts')) rows=[{id:args[0]}];
    return {rows,rowCount:rows.length};
  });
});

describe('recorded unknown edit reconciliation',()=>{
  it('reconciles an unchanged current renderer without dispatching a request',async()=>{
    const message=first(snapshot),reader=vi.fn().mockResolvedValue(fingerprint(message));
    expect(await reconcileUnknownEdit(publication,reader)).toBe(true);
    expect(reader).toHaveBeenCalledExactlyOnceWith(publication);
    expect(frozenCanonical()).toEqual(message);
    expect(mocks.query.mock.calls.find(([sql])=>String(sql).startsWith('UPDATE publications'))?.[1]).toEqual([publication.id,desiredId]);
  });
  it.each(['text','album'] as const)('recovers old related headings from frozen %s navigation, preserving literal body and labels',async kind=>{
    publication.delivery_kind=kind; owned.delivery_kind=kind;
    prior={...prior,sources:[fact],navigationVersion:1};
    snapshot={...prior,sources:[fact,related],updatedTo:'https://t.me/c/123/40'}; publication.content=snapshot;
    parts=[{content:first(prior),snapshot_content:prior}];
    const legacy=withUpdateMarker(appendLegacy(first(prior),related,'Связанные новости'),snapshot.updatedTo ?? '');
    record(legacy);
    expect(await reconcileUnknownEdit(publication,async()=>fingerprint(legacy))).toBe(true);
    expect(frozenCanonical()).toEqual(withoutUpdateMarker(legacy,snapshot.updatedTo));
    expect(frozenCanonical().plainText).toContain(snapshot.details);
    expect(frozenCanonical().links.at(-1)?.url).toBe(related.url);
  });
  it('recovers old visible audit links and keeps audit and related sections separate',async()=>{
    prior={...prior,sources:[fact,audit,related],navigationVersion:1}; snapshot=structuredClone(prior); publication.content=snapshot;
    const legacy=appendLegacy(appendLegacy(first({...prior,sources:[fact]}),audit,'Другие публикации'),related,'Связанные новости');
    parts=[{content:legacy,snapshot_content:prior}]; record(legacy);
    expect(await reconcileUnknownEdit(publication,async()=>fingerprint(legacy))).toBe(true);
    expect(frozenCanonical()).toEqual(legacy);
    expect(frozenCanonical().links.map(link=>link.url)).toEqual([fact.url,audit.url,related.url]);
  });
  it('does not reinterpret a version-2 edit as a historical presentation',async()=>{
    prior={...prior,navigationVersion:2,sources:[related]}; snapshot=structuredClone(prior); publication.content=snapshot;
    const legacy=appendLegacy(first({...prior,sources:[]}),related,'Связанные новости');
    parts=[{content:legacy,snapshot_content:prior}]; record(legacy); const reader=vi.fn();
    expect(await reconcileUnknownEdit(publication,reader)).toBe(false); expect(reader).not.toHaveBeenCalled(); expect(writes()).toEqual([]);
  });
  it('does not substitute a newer desired snapshot for the recorded older attempt',async()=>{
    owned.pending_snapshot_id=randomUUID(); publication.pending_snapshot_id=owned.pending_snapshot_id;
    const message=first(snapshot); expect(await reconcileUnknownEdit(publication,async()=>fingerprint(message))).toBe(true);
    expect(mocks.query.mock.calls.find(([sql])=>String(sql).startsWith('UPDATE publications'))?.[1]).toEqual([publication.id,desiredId]);
  });
  it.each(['none','running','multiple','not due','invalid metadata','missing snapshot','unrelated snapshot','wrong fingerprint'])(
    'leaves %s work untouched',async kind=>{
      if(kind==='none') attempts=[];
      if(kind==='running') attempts[0]!.status='running';
      if(kind==='multiple') attempts.push(structuredClone(attempts[0]!));
      if(kind==='not due') attempts[0]!.next_retry_at=new Date(Date.now()+60_000);
      if(kind==='invalid metadata') attempts[0]!.response_metadata={snapshotId:desiredId};
      if(kind==='missing snapshot') missingSnapshot=true;
      if(kind==='unrelated snapshot') snapshotStory=randomUUID();
      if(kind==='wrong fingerprint') record({...first(snapshot),plainText:'Unrecorded message'});
      const reader=vi.fn(); expect(await reconcileUnknownEdit(publication,reader)).toBe(kind==='none'?null:false);
      expect(reader).not.toHaveBeenCalled(); expect(writes()).toEqual([]);
    });
  it('rejects an arbitrary orphan snapshot even when its visible text matches',async()=>{
    owned.story_id=null; publication.story_id=null; snapshotStory=null;
    attempts[0]!.response_metadata={snapshotId:randomUUID(),fingerprint:fingerprint(first(snapshot))};
    const reader=vi.fn(); expect(await reconcileUnknownEdit(publication,reader)).toBe(false);
    expect(reader).not.toHaveBeenCalled(); expect(writes()).toEqual([]);
  });
  it('can reconcile the pinned snapshot of a registered technical publication without a story',async()=>{
    owned.story_id=null; publication.story_id=null; snapshotStory=null;
    expect(await reconcileUnknownEdit(publication,async()=>fingerprint(first(snapshot)))).toBe(true);
  });
  it.each(['missing','different','throws'])('does not commit when observation is %s',async outcome=>{
    const reader=vi.fn().mockImplementation(async()=>{if(outcome==='throws') throw new Error('History unavailable'); return outcome==='missing'?null:'0'.repeat(64);});
    expect(await reconcileUnknownEdit(publication,reader)).toBe(false); expect(writes()).toEqual([]);
  });
  it.each(['message','destination','bot','story','snapshot','pending','status','attempt','metadata','content','second attempt'])(
    'rechecks %s drift after history lookup before writing',async drift=>{
      const expected=fingerprint(first(snapshot));
      const reader=async()=>{
        if(drift==='message') owned.message_id='999';
        if(drift==='destination') owned.destination_id='-100999';
        if(drift==='bot') owned.bot_id='999';
        if(drift==='story') owned.story_id=randomUUID();
        if(drift==='snapshot') owned.snapshot_id=randomUUID();
        if(drift==='pending') owned.pending_snapshot_id=randomUUID();
        if(drift==='status') owned.status='failed';
        if(drift==='attempt') attempts[0]!.status='succeeded';
        if(drift==='metadata') attempts[0]!.response_metadata={snapshotId:randomUUID(),fingerprint:expected};
        if(drift==='content') snapshot={...snapshot,details:'Changed after observation'};
        if(drift==='second attempt') attempts.push({...attempts[0]!,id:randomUUID()});
        return expected;
      };
      expect(await reconcileUnknownEdit(publication,reader)).toBe(false); expect(writes()).toEqual([]);
    });
});

describe('unknown reviewed full-repair captions stay manual-review-only',()=>{
  it.each([true,false])('does not generically reconcile a matching frozen caption, multipart=%s',async long=>{
    const {caption}=repairFixture(long); const reader=vi.fn().mockResolvedValue(fingerprint(caption));
    expect(await reconcileUnknownEdit(publication,reader)).toBe(false);
    expect(reader).not.toHaveBeenCalled(); expect(writes()).toEqual([]);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
  it('does not lose full-repair ownership when both marker and plan are absent from old metadata',async()=>{
    const {caption}=repairFixture(false);
    if(!action) throw new Error('Missing repair');
    record(caption,{approvalId:action.approvalId});
    const reader=vi.fn().mockResolvedValue(fingerprint(caption));
    expect(await reconcileUnknownEdit(publication,reader)).toBe(false);
    expect(reader).not.toHaveBeenCalled(); expect(writes()).toEqual([]);
  });
  it.each(['missing approval','missing parts','missing flag','altered reply','altered caption','wrong fingerprint'])(
    'does not downgrade %s repair metadata to an ordinary edit',async mutation=>{
      const {plan,caption}=repairFixture();
      if(!action) throw new Error('Missing repair');
      const extra:Record<string,unknown>={approvalId:action.approvalId,fullContentRepair:true,parts:plan};
      if(mutation==='missing approval') delete extra.approvalId;
      if(mutation==='missing parts') delete extra.parts;
      if(mutation==='missing flag') delete extra.fullContentRepair;
      if(mutation==='altered reply') extra.parts=[caption,...plan.slice(1).map(part=>({...part,text:'Unapproved reply',plainText:'Unapproved reply'}))];
      if(mutation==='altered caption') extra.parts=[{...caption,text:'Unapproved caption'},...plan.slice(1)];
      record(caption,extra);
      if(mutation==='wrong fingerprint') record({...caption,plainText:'Different caption'},extra);
      const reader=vi.fn().mockResolvedValue(fingerprint(caption));
      expect(await reconcileUnknownEdit(publication,reader)).toBe(false);
      expect(reader).not.toHaveBeenCalled(); expect(writes()).toEqual([]);
    });
});
