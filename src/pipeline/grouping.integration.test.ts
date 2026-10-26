import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { z } from 'zod';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '../settings.js';
import { BotApi } from '../publishing/bot-api.js';
import { expectFollowupMarker } from './grouping.test-helpers.js';
import { ModelRequestError, failureMetadata, RequestFault } from '../models/errors.js';

const model = vi.hoisted(() => ({ groupingCalls: 0, extractionCalls: 0, linksCalls: 0, relation: '' }));
vi.mock('./collection.js', () => ({ collectBatch: async () => {} }));
vi.mock('./extraction-model.js', () => ({ extractEvents: async (text: string) => {
  model.extractionCalls++;
  return text.startsWith('Ссылки') ? [] : [{ parts: [{ start: 0, end: text.length }], context: [] }];
} }));
vi.mock('./generation-model.js', async original => ({ ...await original<typeof import('./generation-model.js')>(), recordGenerationFailure: vi.fn(),
  generationClient: async () => ({ generate: async (request: { prompt: string; systemPrompt: string }) => {
    const { modelResult } = await import('./generation.test-helpers.js');
    const raw: unknown = JSON.parse(request.prompt);
    const links = z.object({ message: z.string(), links: z.array(z.object({ id:z.uuid() })),
      targets: z.array(z.object({ id:z.uuid(), reports:z.array(z.object({ text:z.string() })) })) }).safeParse(raw);
    if (links.success) {
      model.linksCalls++;
      return modelResult({ associations: links.data.targets.filter(target=>target.reports.some(report=>report.text.includes('Compiler 2')))
        .flatMap(target=>links.data.links.map(link=>({linkId:link.id,targetId:target.id,classification:'relevant'}))) });
    }
    const event = z.object({ id: z.uuid(), reports: z.array(z.object({ text: z.string() })) })
      .transform(value => ({ ...value, text: value.reports.map(report => report.text).join('\n\n') }));
    const input = z.object({ incoming: event, candidates: z.array(event) }).parse(raw);

    model.groupingCalls++;
    if (input.incoming.text.includes('Сбой')) throw new ModelRequestError(
      failureMetadata(new RequestFault('transient'), 'grouping', 'pi', 1, 0));
    return modelResult({ matches: input.candidates.map(candidate => ({ storyId: candidate.id,
      relatedEvidence: { incomingQuote:input.incoming.reports[0]?.text,candidateQuote:candidate.reports[0]?.text,
        connection:'The shutdown is a consequence of the PHP vulnerability.' }, relation: model.relation ||
      (candidate.text.includes('PHP') && input.incoming.text.includes('PHP')
        ? (candidate.text.includes('Alderon') === input.incoming.text.includes('Alderon') ? 'same' : 'related')
        : candidate.text.includes('Compiler 2') && input.incoming.text.includes('Compiler 2') ? 'same' : 'unrelated') })) });
  } }),
}));
vi.mock('../models/jev.js', async original => ({ ...await original<typeof import('../models/jev.js')>(), JevClient: class {
  async judge(template: string) {
    const answer = template==='interest' ? { type: 'score', score: 7, probabilities: {}, confidence: 1, legend: {} }
      : { type: 'choice', choice: template==='event_group_integrity' ? 'coherent' : template==='representative' ? 'left' : 'eligible', probabilities: {}, confidence: 1 };
    return { answers: { answer }, metrics: {}, model: 'fixture' };
  }
  async close() {}
} }));
vi.mock('../models/embedding.js', () => ({ EmbeddingClient: class {
  async embed() { return { vectors: [[1,2,3]] }; }
  async close() {}
} }));
vi.mock('./generation.js', () => ({ researchStory: async (id: string, settings: AppSettings) => {
  const { loadStory, saveGenerations } = await import('./generation-store.js');
  const input = await loadStory(id);
  await saveGenerations([input],[{ id, headline: 'Новости разработки',
    summary: [...new Set(input.mentions.map(mention=>mention.text))].join('\n'), translatedExcerpt: null }],settings);
} }));
const url = process.env.TEST_DATABASE_URL;
const schema = `grouping_${randomUUID().replaceAll('-','')}`;
let admin: pg.Pool;
let database: typeof import('../db.js');
let settings: AppSettings;
async function one(sql: string, values: unknown[] = []): Promise<string> {
  const row=(await database.db.query<{id:string}>(sql,values)).rows[0];
  if (!row) throw new Error('Missing fixture');
  return row.id;
}
async function intake(texts: string[],ageHours=0): Promise<string> {
  const batch=await one(`INSERT INTO processing_batches(status,cutoff_at,settings_snapshot,profile_version,model_version)
    VALUES('processing',now(),$1,$2,$3) RETURNING id`,[JSON.stringify(settings),settings.profileVersion,settings.modelVersion]);
  for (const text of texts) {
    const source=await one("INSERT INTO sources(connector_type,external_id,name,access) VALUES('feed',$1,'Fixture','public') RETURNING id",[randomUUID()]);
    const item=await one("INSERT INTO source_items(source_id,external_id,original_url,collected_at) VALUES($1,'1',$2,now()-$3*interval '1 hour') RETURNING id",[source,`https://example.org/${source}`,ageHours]);
    const revision=await one(`INSERT INTO item_revisions(item_id,revision_number,content_hash,original_text,normalized_text,created_at)
      VALUES($1,1,$2,$3,$3,now()-$4*interval '1 hour') RETURNING id`,[item,randomUUID(),text,ageHours]);
    await database.db.query(`UPDATE item_revisions SET metadata=jsonb_build_object('connectorKind','feed',
      'canonicalUrl',$2::text,'title','Fixture article') WHERE id=$1`,[revision,`https://example.org/${source}`]);
    await database.db.query('UPDATE source_items SET current_revision_id=$2 WHERE id=$1',[item,revision]);
    await database.db.query('INSERT INTO batch_items(batch_id,revision_id) VALUES($1,$2)',[batch,revision]);
  }
  return batch;
}
async function processIntake(batch: string) { await (await import('./batches.js')).processBatch(false,true,batch); }
async function publish() { await (await import('../publishing/digest.js')).publishDigest(settings); }
describe.skipIf(!url)('grouping through Telegram delivery', { timeout: 60_000 }, () => {
  beforeAll(async () => {
    admin=new pg.Pool({connectionString:url}); await admin.query(`CREATE SCHEMA ${schema}`);
    const scoped=new URL(url ?? ''); scoped.searchParams.set('options',`-c search_path=${schema},public`);
    vi.stubEnv('DATABASE_URL',scoped.toString()); vi.stubEnv('EMBEDDING_DIMENSIONS','3'); vi.stubEnv('TELEGRAM_BOT_TOKEN','123:fixture'); vi.stubEnv('ALLOW_PRIVATE_INFERENCE','false');
    database=await import('../db.js'); await database.migrate();
    settings=await (await import('../settings.js')).saveSettings({publishingEnabled:true,embeddingDimensions:3});
  });
  beforeEach(async () => {
    vi.restoreAllMocks(); model.groupingCalls=0; model.extractionCalls=0; model.linksCalls=0; model.relation='';
    await database.db.query('TRUNCATE processing_batches,sources,stories,publications,model_cache,operational_state CASCADE');
    const { saveState }=await import('../publishing/store.js');
    await saveState('telegram_destination',{channelId:'-100123'});
    await saveState('bot_verified',{verified:true,destinationId:'-100123',botId:123});
    vi.spyOn(BotApi.prototype,'identity').mockResolvedValue({id:123,is_bot:true});
    vi.spyOn(BotApi.prototype,'send').mockImplementation(async () => String(100 + vi.mocked(BotApi.prototype.send).mock.calls.length));
    vi.spyOn(BotApi.prototype,'edit').mockResolvedValue(undefined);
  });
  afterAll(async () => {
    vi.restoreAllMocks(); await database?.db.end();
    if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); }
    vi.unstubAllEnvs();
  });
  it('explicitly expires old orphans without deleting or recreating their extraction', async () => {
    const batch=await intake(['Old report.'],72); const revision=await one('SELECT revision_id AS id FROM batch_items WHERE batch_id=$1',[batch]);
    await (await import('./extraction-store.js')).applyExtraction(batch,revision,'Old report.',[{start:0,end:11}]);
    const {expireUnassignedMentions}=await import('./item-failures.js');
    await expireUnassignedMentions(settings); await processIntake(batch); await expireUnassignedMentions(settings);
    expect((await database.db.query("SELECT metadata->>'disposition' AS disposition FROM story_mentions WHERE revision_id=$1",[revision])).rows)
      .toEqual([{disposition:'outside_collection_window'}]);
    expect((await database.db.query('SELECT status,disposition_reason FROM batch_items WHERE batch_id=$1',[batch])).rows)
      .toEqual([{status:'rejected',disposition_reason:'outside_collection_window'}]);
    expect((await database.db.query("SELECT jsonb_array_length(metadata->'pipelineExtraction') AS n FROM item_revisions WHERE id=$1",[revision])).rows).toEqual([{n:1}]);
    expect(model.extractionCalls).toBe(0); expect((await database.db.query('SELECT id FROM stories')).rows).toHaveLength(0);
  });
  it('groups draft reports and publishes a linked follow-up without modifying the previous story', async () => {
    const batch=await intake(['Acme выпустила Compiler 2.', 'Состоялся выпуск Compiler 2 от Acme.', 'Beta выпустила Database 3.']);
    await processIntake(batch); await publish();
    expect((await database.db.query('SELECT id FROM stories')).rows).toHaveLength(2);
    const canonical=await one("SELECT id FROM stories WHERE chosen_excerpt LIKE '%Compiler 2%'");
    expect((await database.db.query('SELECT id FROM story_mentions WHERE story_id=$1',[canonical])).rows).toHaveLength(2);
    expect(BotApi.prototype.send).toHaveBeenCalledTimes(2);
    const original=(await database.db.query('SELECT * FROM stories WHERE id=$1',[canonical])).rows[0];
    const extracted=model.extractionCalls;
    await processIntake(batch); await publish();
    expect(model.extractionCalls).toBe(extracted);
    expect(BotApi.prototype.send).toHaveBeenCalledTimes(2);
    await processIntake(await intake(['Compiler 2 теперь стоит 40 долларов в месяц.']));
    await publish(); await publish();
    expect(BotApi.prototype.send).toHaveBeenCalledTimes(3);
    expect(BotApi.prototype.edit).toHaveBeenCalled(); vi.mocked(BotApi.prototype.edit).mock.calls.forEach(call => expectFollowupMarker(call[2], '103'));
    expect((await database.db.query('SELECT * FROM stories WHERE id=$1',[canonical])).rows[0]).toEqual(original);
    expect((await database.db.query("SELECT metadata->>'previous_story_id' AS previous FROM story_mentions WHERE text LIKE '%40 долларов%' ")).rows)
      .toEqual([{previous:canonical}]);
    expect(vi.mocked(BotApi.prototype.send).mock.calls.at(-1)?.[1].text).toContain('Предыдущие публикации');
    expect((await database.db.query('SELECT id FROM publications')).rows).toHaveLength(3);
  });
  it.each(['same'])('creates a new linked post for every %s match, including duplicate coverage', async relation => {
    await processIntake(await intake(['Acme выпустила Compiler 2.'])); await publish();
    const canonical=await one("SELECT id FROM stories WHERE chosen_excerpt LIKE '%Compiler 2%'");
    const original=(await database.db.query('SELECT * FROM stories WHERE id=$1',[canonical])).rows[0];
    model.relation=relation;
    await processIntake(await intake(['Acme выпустила Compiler 2.'])); await publish();
    const next=(await database.db.query("SELECT id FROM stories WHERE id<>$1",[canonical])).rows[0]?.id;
    expect(next).toBeTruthy();
    expect((await database.db.query("SELECT story_id,metadata->>'previous_story_id' AS previous FROM story_mentions WHERE story_id=$1",[next])).rows)
      .toEqual([{story_id:next,previous:canonical}]);
    expect((await database.db.query('SELECT * FROM story_publication_threads WHERE story_id=$1',[next])).rows)
      .toContainEqual(expect.objectContaining({story_id:next,previous_story_id:canonical}));
    expect((await database.db.query('SELECT pending_snapshot_id FROM publications WHERE story_id=$1',[canonical])).rows)
      .toEqual([{pending_snapshot_id:null}]);
    expect(BotApi.prototype.send).toHaveBeenCalledTimes(2);
    expect(BotApi.prototype.edit).toHaveBeenCalled(); vi.mocked(BotApi.prototype.edit).mock.calls.forEach(call => expectFollowupMarker(call[2], '102'));
    expect((await database.db.query('SELECT * FROM stories WHERE id=$1',[canonical])).rows[0]).toEqual(original);
  });
  it('leaves later same candidates unrecorded rather than manufacturing related links', async () => {
    await processIntake(await intake(['Acme выпустила Compiler 2.'])); await publish();
    const first=await one("SELECT id FROM stories WHERE chosen_excerpt LIKE '%выпустила Compiler 2%'");
    await processIntake(await intake(['Compiler 2 теперь стоит 40 долларов в месяц.'])); await publish();
    const calls=model.groupingCalls;
    await processIntake(await intake(['Compiler 2 получила поддержку Linux.'])); await publish();
    const next=await one("SELECT story_id AS id FROM story_mentions WHERE text LIKE '%поддержку Linux%'");
    expect(model.groupingCalls-calls).toBe(1);
    expect((await database.db.query(`SELECT relation FROM story_relations
      WHERE lower_story_id=$1 OR upper_story_id=$1 ORDER BY relation`,[next])).rows)
      .toEqual([{relation:'same'}]);
    expect((await database.db.query('SELECT * FROM story_merges')).rows).toEqual([]);
    expect((await database.db.query('SELECT id FROM stories')).rows).toHaveLength(3);
    expect(BotApi.prototype.send).toHaveBeenCalledTimes(3);
    expect(next).not.toBe(first);
  });
  it('keeps PHP discovery and a consequent Alderon shutdown separate, without same-event ancestry or UPD', async () => {
    await processIntake(await intake(['OpenAI model discovered a PHP vulnerability.'])); await publish();
    const discovery=await one("SELECT id FROM stories WHERE chosen_excerpt LIKE 'OpenAI%'");
    const original=(await database.db.query('SELECT * FROM stories WHERE id=$1',[discovery])).rows[0];
    const calls=model.groupingCalls;
    await processIntake(await intake(['Alderon shut down its game because of the PHP vulnerability.'])); await publish();
    const shutdown=await one("SELECT id FROM stories WHERE chosen_excerpt LIKE 'Alderon%'");
    expect(discovery).not.toBe(shutdown); expect(model.groupingCalls-calls).toBe(1);
    expect((await database.db.query('SELECT * FROM story_merges')).rows).toEqual([]); expect((await database.db.query('SELECT * FROM story_publication_threads')).rows).toEqual([]);
    const { relatedStoryIds }=await import('./story-relations.js');
    expect(await relatedStoryIds(discovery)).toEqual([shutdown]); expect(await relatedStoryIds(shutdown)).toEqual([discovery]);
    expect((await database.db.query("SELECT provenance->'relatedEvidence' AS evidence FROM story_relations WHERE relation='related'")).rows)
      .toEqual([{ evidence:{ incomingQuote:'Alderon shut down its game because of the PHP vulnerability.',
        candidateQuote:'OpenAI model discovered a PHP vulnerability.',
        connection:'The shutdown is a consequence of the PHP vulnerability.' } }]);
    expect((await database.db.query('SELECT * FROM stories WHERE id=$1',[discovery])).rows[0]).toEqual(original);
    expect((await database.db.query('SELECT text FROM story_mentions WHERE story_id=$1',[shutdown])).rows)
      .toEqual([{text:'Alderon shut down its game because of the PHP vulnerability.'}]);
    const sent=(await database.db.query<{content:{details:string;updatedTo?:string}}>(`SELECT snap.content
      FROM publications p JOIN publication_snapshots snap ON snap.id=p.snapshot_id WHERE p.story_id=$1`,[shutdown])).rows[0]?.content;
    expect(sent?.details).toContain('Alderon'); expect(sent?.details).not.toContain('OpenAI model discovered');
    expect(vi.mocked(BotApi.prototype.edit).mock.calls.some(call=>call[2].plainText.startsWith('UPD:'))).toBe(false);
    expect(BotApi.prototype.send).toHaveBeenCalledTimes(2);
  });
  it('does not consolidate legacy related drafts into a broad-topic story', async () => {
    await processIntake(await intake(['OpenAI model discovered a PHP vulnerability.']));
    const discovery=await one("SELECT id FROM stories WHERE chosen_excerpt LIKE 'OpenAI%'");
    const legacy=await intake(['Alderon shut down its game because of the PHP vulnerability.']);
    const revision=await one('SELECT revision_id AS id FROM batch_items WHERE batch_id=$1',[legacy]);
    const text='Alderon shut down its game because of the PHP vulnerability.'; await (await import('./extraction-store.js')).applyExtraction(legacy,revision,text,[{start:0,end:text.length}]);
    const shutdown=await one('INSERT INTO stories(chosen_excerpt) VALUES($1) RETURNING id',[text]);
    await database.db.query('UPDATE story_mentions SET story_id=$2 WHERE revision_id=$1',[revision,shutdown]);
    await (await import('./consolidation.js')).consolidateStories(settings,legacy);
    expect((await database.db.query('SELECT * FROM story_merges')).rows).toEqual([]);
    expect((await database.db.query('SELECT story_id FROM story_mentions WHERE revision_id=$1',[revision])).rows)
      .toEqual([{story_id:shutdown}]);
    expect(await (await import('./story-relations.js')).relatedStoryIds(discovery)).toEqual([shutdown]);
  });
  it('adds a source-only recap to stories arriving later, without a separate post or confirmation calls', async () => {
    const recap=await intake(['Ссылки на релизы Compiler 2.']);
    const revision=await one('SELECT revision_id AS id FROM batch_items WHERE batch_id=$1',[recap]);
    const link=await one("INSERT INTO item_links(revision_id,url,anchor_text) VALUES($1,'https://example.org/recap','Compiler 2') RETURNING id",[revision]);
    await processIntake(recap);
    expect(model.linksCalls).toBe(0);
    await processIntake(await intake(['Acme выпустила Compiler 2.','Beta выпустила Database 3.']));
    const { associateSourceLinks }=await import('./source-links.js');
    await associateSourceLinks(settings); await associateSourceLinks(settings);
    expect(model.linksCalls).toBe(1);
    const oldStage=await one(`INSERT INTO stage_state(batch_id,revision_id,stage,status,next_retry_at)
      VALUES($1,$2,'source_links:item-links-v1:obsolete:m1','waiting',now()-interval '1 hour') RETURNING id`,[recap,revision]);
    await database.db.query("UPDATE processing_batches SET status='waiting',completed_at=NULL WHERE id=$1",[recap]);
    // The associations committed, but the follow-up acknowledgement was interrupted.
    const currentStage=await one(`UPDATE stage_state SET status='waiting',next_retry_at=now()-interval '1 hour',error_code='transient'
      WHERE revision_id=$1 AND stage=(SELECT processing_key FROM source_link_processing WHERE revision_id=$1) RETURNING id`,[revision]);
    await associateSourceLinks(settings);
    await (await import('./item-failures.js')).completeBatchItems(recap);
    expect((await database.db.query('SELECT status FROM stage_state WHERE id=$1',[oldStage])).rows).toEqual([{status:'skipped'}]);
    expect((await database.db.query('SELECT status,output,next_retry_at,error_code FROM stage_state WHERE id=$1',[currentStage])).rows)
      .toEqual([{status:'completed',output:true,next_retry_at:null,error_code:null}]);
    expect((await database.db.query('SELECT status FROM processing_batches WHERE id=$1',[recap])).rows).toEqual([{status:'completed'}]);
    expect((await database.db.query('SELECT id FROM story_mentions WHERE revision_id=$1',[revision])).rows).toHaveLength(0);
    const compiler=await one("SELECT id FROM stories WHERE chosen_excerpt LIKE '%Compiler 2%'");
    expect((await database.db.query('SELECT story_id,classification FROM story_link_sources WHERE link_id=$1',[link])).rows)
      .toEqual([{story_id:compiler,classification:'relevant'}]);
    expect((await database.db.query('SELECT id FROM stories')).rows).toHaveLength(2);
    await database.db.query('UPDATE stories SET interest_stale=false WHERE id=$1', [compiler]);
    await database.db.query('DELETE FROM operational_state WHERE key=$1', [`digest_refresh:${compiler}`]);
    await (await import('./source-links.js')).classifyItemLinks(revision, settings, {
      id: currentStage, attempt: 1, batchId: recap, revisionId: revision, storyId: null,
    });
    expect((await database.db.query('SELECT interest_stale FROM stories WHERE id=$1', [compiler])).rows)
      .toEqual([{ interest_stale: false }]);
    expect((await database.db.query('SELECT 1 FROM operational_state WHERE key=$1', [`digest_refresh:${compiler}`])).rows).toHaveLength(0);
    const text=(await database.db.query<{text:string}>('SELECT text FROM story_mentions WHERE story_id=$1',[compiler])).rows[0]?.text;
    if (!text) throw new Error('Missing compiler report');
    await database.db.query("UPDATE story_mentions SET text='Different product announcement.' WHERE story_id=$1",[compiler]);
    await associateSourceLinks(settings);
    expect((await database.db.query('SELECT story_id FROM story_link_sources WHERE link_id=$1',[link])).rows).toHaveLength(0);
    await database.db.query('UPDATE story_mentions SET text=$2 WHERE story_id=$1',[compiler,text]);
    await associateSourceLinks(settings); await associateSourceLinks(settings);
    expect(model.linksCalls).toBe(4);
    expect((await database.db.query('SELECT story_id FROM story_link_sources WHERE link_id=$1',[link])).rows).toEqual([{story_id:compiler}]);
  });
  it('does not expose an unrelated private story or let it block public grouping', async () => {
    await processIntake(await intake(['Acme выпустила Compiler 2.']));
    const privateStory=await one("SELECT id FROM stories WHERE chosen_excerpt LIKE '%Compiler 2%'");
    await database.db.query(`UPDATE sources SET access='restricted' WHERE id IN(
      SELECT i.source_id FROM source_items i JOIN item_revisions r ON r.item_id=i.id
      JOIN story_mentions m ON m.revision_id=r.id WHERE m.story_id=$1)`,[privateStory]);
    const { retainedStories }=await import('./matching.js');
    expect(await retainedStories(settings)).toEqual([]);
    await processIntake(await intake(['Beta выпустила Database 3.']));
    expect((await database.db.query("SELECT status FROM stories WHERE chosen_excerpt LIKE '%Database 3%'")).rows)
      .toEqual([{status:'completed'}]);
  });
  it('checks every source in a legacy incoming aggregate before sending it to Pi', async () => {
    const seed=await intake(['Acme выпустила Compiler 2.']); await processIntake(seed);
    await processIntake(await intake(['Beta выпустила Database 3.']));
    const compiler=await one("SELECT id FROM stories WHERE chosen_excerpt LIKE '%Compiler 2%'");
    const privateBatch=await intake(['Секретное дополнение про Compiler 2.']);
    const revision=await one('SELECT revision_id AS id FROM batch_items WHERE batch_id=$1',[privateBatch]);
    const text='Секретное дополнение про Compiler 2.';
    await (await import('./extraction-store.js')).applyExtraction(privateBatch,revision,text,[{start:0,end:text.length}]);
    await database.db.query('UPDATE story_mentions SET story_id=$2 WHERE revision_id=$1',[revision,compiler]);
    await database.db.query(`UPDATE sources SET access='restricted' WHERE id IN(SELECT i.source_id FROM source_items i
      JOIN item_revisions r ON r.item_id=i.id WHERE r.id=$1)`,[revision]);
    await database.db.query('DELETE FROM consolidation_intake WHERE revision_id IN(SELECT revision_id FROM batch_items WHERE batch_id=$1)',[seed]);
    const calls=model.groupingCalls;
    await (await import('./consolidation.js')).consolidateStories(settings,seed);
    expect(model.groupingCalls).toBe(calls);
    expect((await database.db.query("SELECT status,error_code FROM stage_state WHERE batch_id=$1 AND stage LIKE 'consolidate:%'",[seed])).rows)
      .toEqual([{status:'waiting',error_code:'invalid_request'}]);
  });
  it('reopens completed legacy draft intake and merges it before publishing', async () => {
    await processIntake(await intake(['Acme выпустила Compiler 2.']));
    const canonical=await one("SELECT id FROM stories WHERE chosen_excerpt LIKE '%Compiler 2%'");
    const legacy=await intake(['Ещё один источник сообщил о выпуске Compiler 2.']);
    const revision=await one('SELECT revision_id AS id FROM batch_items WHERE batch_id=$1',[legacy]);
    const text='Ещё один источник сообщил о выпуске Compiler 2.';
    await (await import('./extraction-store.js')).applyExtraction(legacy,revision,text,[{start:0,end:text.length}]);
    const duplicate=await one("INSERT INTO stories(chosen_excerpt) VALUES($1) RETURNING id",[text]);
    await database.db.query('UPDATE story_mentions SET story_id=$2 WHERE revision_id=$1',[revision,duplicate]);
    await database.db.query("UPDATE processing_batches SET status='completed',completed_at=now() WHERE id=$1",[legacy]);
    await database.db.query("UPDATE batch_items SET status='completed' WHERE batch_id=$1",[legacy]);
    const {readFile}=await import('node:fs/promises');
    await database.db.query(await readFile(new URL('../../migrations/193_simple_association.sql',import.meta.url),'utf8'));
    expect((await database.db.query('SELECT status,completed_at FROM processing_batches WHERE id=$1',[legacy])).rows)
      .toEqual([{status:'waiting',completed_at:null}]);
    await processIntake(legacy); await publish();
    expect((await database.db.query('SELECT story_id FROM story_mentions WHERE revision_id=$1',[revision])).rows).toEqual([{story_id:canonical}]);
    expect(BotApi.prototype.send).toHaveBeenCalledOnce();
  });
  it('keeps a historical published owner unchanged and leaves a lower-ranked same draft unrecorded', async () => {
    const first=await intake(['Acme выпустила Compiler 2.']); await processIntake(first); await publish();
    const original=await one('SELECT revision_id AS id FROM batch_items WHERE batch_id=$1',[first]);
    const item=await one('SELECT item_id AS id FROM item_revisions WHERE id=$1',[original]);
    const canonical=await one('SELECT story_id AS id FROM story_mentions WHERE revision_id=$1',[original]);
    const live=await intake(['Другой источник сообщил о Compiler 2.']);
    const liveRevision=await one('SELECT revision_id AS id FROM batch_items WHERE batch_id=$1',[live]);
    const otherText='Другой источник сообщил о Compiler 2.';
    await (await import('./extraction-store.js')).applyExtraction(live,liveRevision,otherText,[{start:0,end:otherText.length}]);
    const duplicate=await one('INSERT INTO stories(chosen_excerpt) VALUES($1) RETURNING id',[otherText]);
    await database.db.query('UPDATE story_mentions SET story_id=$2 WHERE revision_id=$1',[liveRevision,duplicate]);
    const update=await intake([]);
    const text='Compiler 2 теперь стоит 40 долларов в месяц.';
    const edited=await one(`INSERT INTO item_revisions(item_id,revision_number,content_hash,original_text,normalized_text)
      VALUES($1,2,$2,$3,$3) RETURNING id`,[item,randomUUID(),text]);
    await database.db.query('UPDATE source_items SET current_revision_id=$2 WHERE id=$1',[item,edited]);
    await database.db.query('INSERT INTO batch_items(batch_id,revision_id) VALUES($1,$2)',[update,edited]);
    await processIntake(update); await publish();
    const attached=(await database.db.query('SELECT story_id FROM story_mentions WHERE revision_id=$1',[edited])).rows[0]?.story_id;
    expect(attached).not.toBe(duplicate);
    expect(attached).not.toBe(canonical);
    expect((await database.db.query("SELECT metadata->>'previous_story_id' AS previous FROM story_mentions WHERE revision_id=$1",[edited])).rows).toEqual([{previous:canonical}]);
    expect((await database.db.query(`SELECT relation FROM story_relations
      WHERE lower_story_id=least($1::uuid,$2::uuid) AND upper_story_id=greatest($1::uuid,$2::uuid)`,[attached,duplicate])).rows)
      .toEqual([]);
    expect((await database.db.query("SELECT id FROM judgments WHERE stage='published_update'")).rows).toEqual([]);
    expect((await database.db.query('SELECT id FROM stories')).rows).toHaveLength(3);
    expect((await database.db.query('SELECT headline FROM stories WHERE id=$1',[canonical])).rows[0]?.headline).not.toBeNull();
    expect(BotApi.prototype.send).toHaveBeenCalledTimes(2); vi.mocked(BotApi.prototype.edit).mock.calls.forEach(call => expectFollowupMarker(call[2]));
    expect((await database.db.query('SELECT status FROM processing_batches WHERE id=$1',[update])).rows).toEqual([{status:'completed'}]);
  });
  it('parks one grouping failure while a healthy sibling is generated and published', async () => {
    await processIntake(await intake(['Acme выпустила Compiler 2.'])); await publish();
    const batch=await intake(['Сбой модели группировки.', 'Beta выпустила Database 3.']);
    await processIntake(batch); await publish();
    expect((await database.db.query("SELECT status FROM stage_state WHERE batch_id=$1 AND stage LIKE 'match:%' AND status='waiting'",[batch])).rows).toHaveLength(1);
    expect(BotApi.prototype.send).toHaveBeenCalledTimes(2);
    await processIntake(batch); await publish();
    expect(BotApi.prototype.send).toHaveBeenCalledTimes(2);
  });
});
