import { z } from 'zod';
import { db, transaction } from '../db.js';
import { primaryCursorSchema, primarySourceInput, primarySourcePatch, validatePrimarySource, type PrimarySource } from './config.js';
import { primarySourceViewSchema, sourceIdentitySchema, safeSourceUrl, type PrimarySourceView } from './view.js';
import { PRIMARY_SOURCE_SEEDS } from './seeds.js';
import { recoverSkippedPublication } from './unknown-publication.js';

const rowSchema = z.object({ id: z.uuid(), connector_type: z.enum(['feed', 'website']),
  name: z.string(), original_url: z.string(), enabled: z.boolean(),
  collection_config_version: z.number().int().min(1).default(1), metadata: z.object({
    publisher: z.string(), articlePathPrefixes: z.array(z.string()), maxArticles: z.number(),
    articleLinkPolicy: primarySourceInput.shape.articleLinkPolicy,
    backlogLimit: primarySourceInput.shape.backlogLimit,
    retryDelayMinutes: primarySourceInput.shape.retryDelayMinutes,
    feedDateRole: primarySourceInput.shape.feedDateRole,
    unknownPublication: z.enum(['skip', 'collect_once']),
  }), collection_cursor: primaryCursorSchema });
export function parsePrimarySource(input: unknown): PrimarySource {
  const row = rowSchema.parse(input);
  const url = safeSourceUrl(row.original_url);
  if (!url) throw new Error('primary_source_invalid_config');
  return { id: row.id, ...primarySourceInput.parse({ kind: row.connector_type, name: row.name,
    url, enabled: row.enabled, ...row.metadata }), cursor: row.collection_cursor, configVersion: row.collection_config_version };
}
const columns = 'id,connector_type,name,original_url,enabled,metadata,collection_cursor,collection_config_version';
function sourceView(input: unknown, identityLocked: boolean): PrimarySourceView {
  try {
    const source = { ...parsePrimarySource(input) };
    delete source.configVersion;
    return primarySourceViewSchema.parse({ ...source, configState: 'valid', identityLocked });
  }
  catch { /* Invalid configuration exposes only safe identity fields. */ }
  const row = sourceIdentitySchema.parse(input);
  return { id: row.id, kind: row.connector_type, name: row.name, url: safeSourceUrl(row.original_url),
    enabled: row.enabled, identityLocked, configState: 'invalid', errorCode: 'primary_source_invalid_config' };
}
export async function listPrimarySources(): Promise<PrimarySourceView[]> {
  const result = await db.query(`SELECT ${columns},
    (EXISTS(SELECT 1 FROM source_items i WHERE i.source_id=sources.id)
      OR metadata @> '{"publisherIdentityLocked":true}'::jsonb) AS identity_locked
    FROM sources WHERE connector_type IN ('feed','website') ORDER BY name,id`);
  return result.rows.map((row: unknown) =>
    sourceView(row, z.object({ identity_locked: z.boolean().default(false) }).parse(row).identity_locked));
}
export async function addPrimarySource(input: unknown): Promise<PrimarySourceView> {
  const source = await validatePrimarySource(input);
  const { kind, name, url, enabled, ...metadata } = source;
  const result = await db.query(`INSERT INTO sources(connector_type,external_id,name,original_url,enabled,access,metadata)
    VALUES($1,$2,$3,$2,$4,'public',$5::jsonb) RETURNING ${columns}`,
  [kind, url, name, enabled, JSON.stringify(metadata)]);
  return sourceView(result.rows[0], false);
}
export async function editPrimarySource(id: string, input: unknown): Promise<PrimarySourceView> {
  z.uuid().parse(id);
  const patch = primarySourcePatch.parse(input);
  return transaction(async client => {
    const saved = await client.query(`SELECT ${columns} FROM sources
      WHERE id=$1 AND connector_type IN ('feed','website') FOR UPDATE`, [id]);
    const row: unknown = saved.rows[0];
    if (!row) throw new Error('primary_source_not_found');
    // The next statement sees items committed by FK holders while we waited for the row lock.
    const history = await client.query<{ has_items: boolean }>(
      `SELECT (EXISTS(SELECT 1 FROM source_items WHERE source_id=$1)
        OR metadata @> '{"publisherIdentityLocked":true}'::jsonb) AS has_items FROM sources WHERE id=$1`, [id]);
    const locked = history.rows[0]?.has_items === true;
    const previous = sourceView(row, locked);
    if (previous.configState === 'invalid') {
      if (patch.enabled !== false || Object.keys(patch).length !== 1) throw new Error('primary_source_invalid_config');
      const disabled = await client.query(`UPDATE sources SET enabled=false,updated_at=now(),
        collection_config_version=collection_config_version+1
        WHERE id=$1 RETURNING ${columns}`, [id]);
      return sourceView(disabled.rows[0], locked);
    }
    const config = primarySourceInput.parse({ kind: previous.kind, name: previous.name, url: previous.url,
      publisher: previous.publisher, articlePathPrefixes: previous.articlePathPrefixes, maxArticles: previous.maxArticles,
      articleLinkPolicy: previous.articleLinkPolicy, backlogLimit: previous.backlogLimit,
      retryDelayMinutes: previous.retryDelayMinutes, feedDateRole: previous.feedDateRole,
      unknownPublication: previous.unknownPublication, enabled: previous.enabled });
    const source = await validatePrimarySource({ ...config, ...patch });
    const { kind, name, url, enabled, ...metadata } = source;
    const reset = url !== previous.url || kind !== previous.kind;
    if (reset && locked) throw new Error('primary_source_identity_locked');
    const recovered = !reset && previous.unknownPublication === 'skip' && source.unknownPublication === 'collect_once'
      ? await recoverSkippedPublication(client, id, previous.cursor) : null;
    const result = await client.query(`UPDATE sources SET connector_type=$2,external_id=$3,name=$4,original_url=$3,
      enabled=$5,metadata=$6::jsonb,collection_cursor=CASE WHEN $7 THEN '{}'::jsonb
        ELSE COALESCE($8::jsonb,collection_cursor) END,
      collection_config_version=collection_config_version+1,
      updated_at=now() WHERE id=$1 AND connector_type IN ('feed','website') RETURNING ${columns}`,
    [id, kind, url, name, enabled, JSON.stringify(locked ? { ...metadata, publisherIdentityLocked: true } : metadata),
      reset, recovered ? JSON.stringify(recovered) : null]);
    return sourceView(result.rows[0], locked);
  });
}
export async function seedPrimarySources(): Promise<PrimarySourceView[]> {
  for (const input of PRIMARY_SOURCE_SEEDS) {
    const source = await validatePrimarySource(input);
    const { kind, name, url, enabled, ...metadata } = source;
    await db.query(`INSERT INTO sources(connector_type,external_id,name,original_url,enabled,access,metadata)
      VALUES($1,$2,$3,$2,$4,'public',$5::jsonb) ON CONFLICT(connector_type,external_id) DO NOTHING`,
    [kind, url, name, enabled, JSON.stringify(metadata)]);
  }
  return listPrimarySources();
}
export async function preparePrimarySources(batchId: string): Promise<PrimarySource[]> {
  await db.query(`INSERT INTO batch_sources(batch_id,source_id,cursor_before)
    SELECT $1,id,collection_cursor FROM sources WHERE connector_type IN ('feed','website') AND enabled AND active
    ON CONFLICT(batch_id,source_id) DO NOTHING`, [batchId]);
  const result = await db.query(`SELECT s.id,s.connector_type,s.name,s.original_url,s.enabled,s.metadata,s.collection_config_version,
    COALESCE(bs.cursor_after,bs.cursor_before) AS collection_cursor
    FROM batch_sources bs JOIN sources s ON s.id=bs.source_id WHERE bs.batch_id=$1
    AND bs.status <> 'completed' AND s.connector_type IN ('feed','website') ORDER BY s.id`, [batchId]);
  const sources: PrimarySource[] = [];
  for (const row of result.rows) {
    // The UUID comes from the database; publisher configuration is independently untrusted.
    const { id } = z.object({ id: z.uuid() }).parse(row);
    try { sources.push(parsePrimarySource(row)); }
    catch {
      await db.query(`UPDATE batch_sources SET status='failed',error_code='primary_source_invalid_config'
        WHERE batch_id=$1 AND source_id=$2 AND status <> 'completed'`, [batchId, id]);
    }
  }
  return sources;
}
