import { z } from 'zod';
import { db } from '../db.js';
import { EmbeddingClient } from '../models/embedding.js';
import { activateEmbeddingConfig, type ActiveEmbeddingConfig, type AppSettings } from '../settings.js';
import { hash, recordFailure, type StageContext } from './state.js';
import { approveRemoteInput } from './privacy.js';
import { EMBEDDING_INPUT_VERSION, prepareEmbedding, type ChunkRecord } from './embedding-preparation.js';

export class Vectors {
  private readonly client: EmbeddingClient;
  constructor(readonly config: ActiveEmbeddingConfig, private readonly settings: AppSettings) {
    if (config.context_tokens !== 2048) throw new Error('The embedding adapter requires 2048 context tokens');
    this.client = new EmbeddingClient({ baseUrl: config.endpoint, model: config.model, dimensions: config.dimensions,
      timeoutMs: settings.embeddingTimeoutMs, connectTimeoutMs: settings.connectionTimeoutMs,
      requestMaxAttempts: settings.requestMaxAttempts, recordFailure });
  }
  async save(owner: { mentionId: string } | { storyId: string }, text: string, context: StageContext): Promise<number[]> {
    const inputHash = hash([this.config.input_version, text]);
    const cached = await db.query<{ value: unknown }>(`SELECT value FROM model_cache WHERE kind='embedding'
      AND input_hash=$1 AND model_key=$2 AND prompt_version=$3 AND expires_at>now()`,
    [inputHash, this.config.config_key, this.config.input_version]);
    let vector: number[];
    if (cached.rows[0]) vector = z.array(z.number().finite()).length(this.config.dimensions).parse(cached.rows[0].value);
    else {
      await approveRemoteInput(this.config.endpoint, context.id, owner);
      const embed = async (input: string, attempt = context.attempt): Promise<number[]> => {
        const result = await this.client.embed([input], { operationId: context.id, attempt });
        return z.array(z.number().finite()).length(this.config.dimensions).parse(result.vectors[0]);
      };
      vector = this.config.input_version === EMBEDDING_INPUT_VERSION
        ? await prepareEmbedding(text, this.config.dimensions, context, {
          read: async chunk => {
            const result = await db.query<{ value: unknown }>(`SELECT value FROM model_cache WHERE kind='embedding'
              AND input_hash=$1 AND model_key=$2 AND prompt_version=$3 AND expires_at>now()`,
            [this.chunkHash(chunk), this.config.config_key, this.config.input_version]);
            return result.rows[0]?.value;
          },
          write: async (chunk, value) => this.cacheChunk(chunk, value),
          remove: async chunk => {
            await db.query(`DELETE FROM model_cache WHERE kind='embedding' AND input_hash=$1 AND model_key=$2
              AND prompt_version=$3`, [this.chunkHash(chunk), this.config.config_key, this.config.input_version]);
          },
        }, embed, { timeoutMs: this.settings.embeddingTimeoutMs, requestMaxAttempts: this.settings.requestMaxAttempts })
        : await embed(text);
      await db.query(`INSERT INTO model_cache(kind,input_hash,model_key,prompt_version,value,expires_at)
        VALUES('embedding',$1,$2,$3,$4,now()+$5*interval '1 day') ON CONFLICT(kind,input_hash,model_key,prompt_version)
        DO UPDATE SET value=EXCLUDED.value,expires_at=EXCLUDED.expires_at`,
      [inputHash, this.config.config_key, this.config.input_version, JSON.stringify(vector), this.settings.retentionDays]);
    }
    const column = 'mentionId' in owner ? 'mention_id' : 'story_id';
    const id = 'mentionId' in owner ? owner.mentionId : owner.storyId;
    await db.query(`INSERT INTO embeddings(config_id,${column},input_hash,embedding) VALUES($1,$2,$3,$4::vector)
      ON CONFLICT(config_id,${column}) DO UPDATE SET input_hash=EXCLUDED.input_hash,embedding=EXCLUDED.embedding,created_at=now()`,
    [this.config.id, id, inputHash, JSON.stringify(vector)]);
    return vector;
  }
  private chunkHash(text: string): string { return hash([this.config.input_version, 'chunk', text]); }
  private async cacheChunk(text: string, value: ChunkRecord): Promise<void> {
    await db.query(`INSERT INTO model_cache(kind,input_hash,model_key,prompt_version,value,expires_at)
      VALUES('embedding',$1,$2,$3,$4,CASE WHEN $6 THEN 'infinity'::timestamptz ELSE now()+$5*interval '1 day' END)
      ON CONFLICT(kind,input_hash,model_key,prompt_version)
      DO UPDATE SET value=EXCLUDED.value,expires_at=EXCLUDED.expires_at`,
    [this.chunkHash(text), this.config.config_key, this.config.input_version, JSON.stringify(value),
      this.settings.retentionDays, value.status === 'submitted' || value.status === 'failed']);
  }
  close(): Promise<void> { return this.client.close(); }
}

export async function reembedPending(settings: AppSettings, attempt = 1): Promise<void> {
  const configs = await db.query<ActiveEmbeddingConfig>("SELECT id,config_key,model,endpoint,dimensions,input_version,context_tokens FROM embedding_configs WHERE status='pending'");
  for (const config of configs.rows) {
    const vectors = new Vectors(config, settings);
    try {
      const stories = await db.query<{ id: string; text: string }>(`SELECT s.id,COALESCE(s.chosen_excerpt,
        (SELECT text FROM story_mentions WHERE story_id=s.id ORDER BY created_at LIMIT 1)) AS text
        FROM stories s WHERE s.status<>'rejected' AND EXISTS(SELECT 1 FROM story_mentions m
          JOIN item_revisions r ON r.id=m.revision_id JOIN source_items i ON i.id=r.item_id
          WHERE m.story_id=s.id AND i.retention_at>=now()-$1*interval '1 day') ORDER BY s.id`, [settings.retentionDays]);
      for (const story of stories.rows) await vectors.save({ storyId: story.id }, story.text,
        { id: story.id, attempt, batchId: null, revisionId: null, storyId: story.id });
      // Matching ranks all current mentions, not the selected display excerpt.
      const mentions = await db.query<{ id: string; story_id: string; text: string }>(`SELECT m.id,m.story_id,m.text
        FROM story_mentions m JOIN stories s ON s.id=m.story_id JOIN item_revisions r ON r.id=m.revision_id
        JOIN source_items i ON i.current_revision_id=r.id WHERE s.status<>'rejected'
          AND NOT EXISTS(SELECT 1 FROM story_merges sm WHERE sm.merged_story_id=s.id)
          AND i.retention_at>=now()-$1*interval '1 day' ORDER BY m.id`, [settings.retentionDays]);
      for (const mention of mentions.rows) await vectors.save({ mentionId: mention.id }, mention.text,
        { id: mention.story_id, attempt, batchId: null, revisionId: null, storyId: mention.story_id });
      await activateEmbeddingConfig(config.id);
    } finally { await vectors.close(); }
  }
}
