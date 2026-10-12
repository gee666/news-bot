import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { z } from 'zod';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '../settings.js';
import { BotApi } from '../publishing/bot-api.js';
import { ModelRequestError, failureMetadata, RequestFault } from '../models/errors.js';

const model = vi.hoisted(() => ({ groupingCalls: 0, extractionCalls: 0, linksCalls: 0 }));
vi.mock('./collection.js', () => ({ collectBatch: async () => {} }));
vi.mock('./extraction-model.js', () => ({ extractEvents: async (text: string) => {
  model.extractionCalls++;
  return text.startsWith('Ссылки') ? [] : [{ parts: [{ start: 0, end: text.length }], context: [] }];
} }));
vi.mock('./generation-model.js', async original => ({ ...await original<typeof import('./generation-model.js')>(), recordGenerationFailure: vi.fn(),
  generationClient: async () => ({ generate: async (request: { prompt: string }) => {
    const { modelResult } = await import('./generation.test-helpers.js');
    const raw: unknown = JSON.parse(request.prompt);
    const links = z.object({ message: z.string(), links: z.array(z.object({ id:z.uuid() })),
      targets: z.array(z.object({ id:z.uuid(), reports:z.array(z.object({ text:z.string() })) })) }).safeParse(raw);
    if (links.success) {
      model.linksCalls++;
      return modelResult({ associations: links.data.targets.filter(target=>target.reports.some(report=>report.text.includes('Compiler 2')))
        .flatMap(target=>links.data.links.map(link=>({linkId:link.id,targetId:target.id,classification:'relevant'}))) });
    }
    model.groupingCalls++;
    const input = z.object({ incoming: z.object({ text: z.string() }),
      candidates: z.array(z.object({ id: z.uuid(), text: z.string() })) }).parse(raw);
    if (input.incoming.text.includes('Сбой')) throw new ModelRequestError(
      failureMetadata(new RequestFault('transient'), 'grouping', 'pi', 1, 0));
    return modelResult({ matches: input.candidates.filter(candidate => candidate.text.includes('Compiler 2') && input.incoming.text.includes('Compiler 2'))
      .map(candidate => ({ storyId: candidate.id, relation: input.incoming.text.includes('40 долларов') ? 'update' : 'same' })) });
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
    await database.db.query('UPDATE source_items SET current_revision_id=$2 WHERE id=$1',[item,revision]);
    await database.db.query('INSERT INTO batch_items(batch_id,revision_id) VALUES($1,$2)',[batch,revision]);
  }
  return batch;
}
async function processIntake(batch: string) { await (await import('./batches.js')).processBatch(false,true,batch); }
async function publish() { await (await import('../publishing/digest.js')).publishDigest(settings); }
describe.skipIf(!url)('grouping through Telegram delivery', () => {
  beforeAll(async () => {
    admin=new pg.Pool({connectionString:url}); await admin.query(`CREATE SCHEMA ${schema}`);
    const scoped=new URL(url ?? ''); scoped.searchParams.set('options',`-c search_path=${schema},public`);
    vi.stubEnv('DATABASE_URL',scoped.toString()); vi.stubEnv('EMBEDDING_DIMENSIONS','3'); vi.stubEnv('TELEGRAM_BOT_TOKEN','123:fixture'); vi.stubEnv('ALLOW_PRIVATE_INFERENCE','false');
    database=await import('../db.js'); await database.migrate();
    settings=await (await import('../settings.js')).saveSettings({publishingEnabled:true,embeddingDimensions:3});
  });
  beforeEach(async () => {
    vi.restoreAllMocks(); model.groupingCalls=0; model.extractionCalls=0; model.linksCalls=0;
    await database.db.query('TRUNCATE processing_batches,sources,stories,publications,model_cache,operational_state CASCADE');
    const { saveState }=await import('../publishing/store.js');
    await saveState('telegram_destination',{channelId:'-100123'});
    await saveState('bot_verified',{verified:true,destinationId:'-100123',botId:123});
    vi.spyOn(BotApi.prototype,'identity').mockResolvedValue({id:123,is_bot:true});
    vi.spyOn(BotApi.prototype,'send').mockImplementation(async () => randomUUID());
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
  it('groups duplicate reports, keeps distinct topics, and edits a meaningful update without another send', async () => {
    const batch=await intake(['Acme выпустила Compiler 2.', 'Состоялся выпуск Compiler 2 от Acme.', 'Beta выпустила Database 3.']);
    await processIntake(batch); await publish();
    expect((await database.db.query('SELECT id FROM stories')).rows).toHaveLength(2);
    const canonical=await one("SELECT id FROM stories WHERE chosen_excerpt LIKE '%Compiler 2%'");
    expect((await database.db.query('SELECT id FROM story_mentions WHERE story_id=$1',[canonical])).rows).toHaveLength(2);
    expect(BotApi.prototype.send).toHaveBeenCalledTimes(2);
    const extracted=model.extractionCalls;
    await processIntake(batch); await publish();
    expect(model.extractionCalls).toBe(extracted);
    expect(BotApi.prototype.send).toHaveBeenCalledTimes(2);
    await processIntake(await intake(['Compiler 2 теперь стоит 40 долларов в месяц.']));
    await publish(); await publish();
    expect(BotApi.prototype.send).toHaveBeenCalledTimes(2);
    expect(BotApi.prototype.edit).toHaveBeenCalledOnce();
    expect((await database.db.query('SELECT summary FROM stories WHERE id=$1',[canonical])).rows[0]?.summary).toContain('40 долларов');
    expect((await database.db.query('SELECT id FROM publications')).rows).toHaveLength(2);
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
    const text=(await database.db.query<{text:string}>('SELECT text FROM story_mentions WHERE story_id=$1',[compiler])).rows[0]?.text;
    if (!text) throw new Error('Missing compiler report');
    await database.db.query("UPDATE story_mentions SET text='Different product announcement.' WHERE story_id=$1",[compiler]);
    await associateSourceLinks(settings);
    expect((await database.db.query('SELECT story_id FROM story_link_sources WHERE link_id=$1',[link])).rows).toHaveLength(0);
    await database.db.query('UPDATE story_mentions SET text=$2 WHERE story_id=$1',[compiler,text]);
    await associateSourceLinks(settings); await associateSourceLinks(settings);
    expect(model.linksCalls).toBe(3);
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
  it('reopens completed legacy merge intake and preserves the original Telegram post', async () => {
    await processIntake(await intake(['Acme выпустила Compiler 2.'])); await publish();
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
  it('merges a historical published owner and a live duplicate when a source edit retires its last report', async () => {
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
    expect((await database.db.query('SELECT story_id FROM story_mentions WHERE revision_id=$1',[edited])).rows).toEqual([{story_id:canonical}]);
    expect((await database.db.query('SELECT canonical_story_id FROM story_merges WHERE merged_story_id=$1',[duplicate])).rows)
      .toEqual([{canonical_story_id:canonical}]);
    expect(BotApi.prototype.send).toHaveBeenCalledOnce(); expect(BotApi.prototype.edit).toHaveBeenCalledOnce();
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
