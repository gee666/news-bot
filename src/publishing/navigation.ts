import type { PoolClient } from 'pg';
import { relatedStoryIds } from '../pipeline/story-relations.js';
import { publicationThreadEdges } from '../pipeline/generation-context.js';
import { publicationSnapshotSchema, type PublicationSnapshot, type PublicationSource } from '../types.js';
import { RELATED_PUBLICATION_LIMIT } from './sources.js';

export const delivered = `p.status='published' AND p.message_id IS NOT NULL AND p.published_at IS NOT NULL
  AND p.media_status IN ('none','complete')
  AND NOT EXISTS(SELECT 1 FROM publication_media_batches b WHERE b.publication_id=p.id AND b.status<>'sent')
  AND NOT EXISTS(SELECT 1 FROM operational_state removed WHERE removed.key='publication_removal:'||p.id::text)
  AND NOT EXISTS(SELECT 1 FROM publication_replacements r WHERE r.duplicate_publication_id=p.id)`;
const postAddress = "'https://t.me/c/'||substring(p.destination_id from 5)||'/'||p.message_id";
const validAddress = "p.destination_id ~ '^-100[0-9]+$' AND p.message_id ~ '^[1-9][0-9]*$'";
export const isNavigationSource = (source: PublicationSource): boolean => Boolean(
  source.previousPublication || source.relatedPublication || source.unverifiedPublication);

/** A legacy caption or a tracked attachment is not an internal text-post target. */
export async function textNavigationSources(client: Pick<PoolClient,'query'>, sources: PublicationSource[],
  destinationId: string): Promise<PublicationSource[]> {
  if (!sources.some(isNavigationSource)) return sources;
  const media = await client.query<{ url:string }>(`SELECT ${postAddress} AS url FROM publications p
    WHERE p.destination_id=$1 AND p.delivery_kind='album' AND ${validAddress}
    UNION SELECT 'https://t.me/c/'||substring(p.destination_id from 5)||'/'||i.message_id AS url
      FROM publication_media_items i JOIN publication_media_batches b ON b.id=i.batch_id
      JOIN publications p ON p.id=b.publication_id WHERE p.destination_id=$1 AND i.message_id IS NOT NULL
        AND i.message_id IS DISTINCT FROM p.message_id`,[destinationId]);
  const blocked = new Set(media.rows.map(row=>row.url));
  return sources.filter(source=>!isNavigationSource(source) || !blocked.has(source.url));
}

const verifiedSameEdges = `edges(a,b) AS (
  SELECT story_id,previous_story_id FROM publication_thread_edges
  UNION SELECT lower_story_id,upper_story_id FROM story_relations
    WHERE relation='same' AND provenance->>'quarantined' IS DISTINCT FROM 'true'
)`;

/** Same-event identity requires classification. Old blanket edges and frozen links are not proof. */
export async function sameStoryIds(client: Pick<PoolClient,'query'>, storyId: string): Promise<string[]> {
  const rows = await client.query<{ id: string }>(`WITH RECURSIVE ${publicationThreadEdges}, ${verifiedSameEdges},
    component(id) AS (SELECT $1::uuid UNION
      SELECT CASE WHEN e.a=c.id THEN e.b ELSE e.a END FROM component c JOIN edges e ON e.a=c.id OR e.b=c.id)
    SELECT id FROM component`, [storyId]);
  return rows.rows.map(row => row.id);
}

export async function relatedPublicationSources(client: Pick<PoolClient,'query'>, storyId: string,
  destinationId: string, botId?: string | null, options: { includeLegacyAlbums?: boolean } = {}): Promise<PublicationSource[]> {
  const ids = await relatedStoryIds(storyId,client.query.bind(client));
  if (!ids.length) return [];
  const rows = await client.query<{ url: string; headline: string }>(`WITH RECURSIVE
    ${publicationThreadEdges}, ${verifiedSameEdges}, components(root,id) AS (
      SELECT id,id FROM unnest($1::uuid[]) AS roots(id)
      UNION SELECT c.root,CASE WHEN e.a=c.id THEN e.b ELSE e.a END
        FROM components c JOIN edges e ON e.a=c.id OR e.b=c.id
    ), component_keys AS (
      SELECT root,min(id::text) AS component FROM components GROUP BY root
    ), latest AS (
      SELECT DISTINCT ON (c.component) ${postAddress} AS url,snap.content->>'headline' AS headline,p.published_at,p.id
      FROM publications p JOIN publication_snapshots snap ON snap.id=p.snapshot_id
      JOIN component_keys c ON c.root=p.story_id
      WHERE p.destination_id=$2 AND ($3::text IS NULL OR p.bot_id=$3) AND ($4::boolean OR p.delivery_kind<>'album') AND ${validAddress} AND ${delivered}
      ORDER BY c.component,p.published_at DESC,p.id DESC
    ) SELECT url,headline FROM latest ORDER BY published_at DESC,id DESC LIMIT $5`,
  [ids,destinationId,botId ?? null,options.includeLegacyAlbums ?? false,RELATED_PUBLICATION_LIMIT]);
  return rows.rows.map(row => ({ url:row.url,label:row.headline,primary:false,access:'public',
    classification:'relevant',relatedPublication:true }));
}

export async function latestUpdateTarget(client: Pick<PoolClient,'query'>, publicationId: string): Promise<string | null> {
  const old = (await client.query<{ story_id: string | null; destination_id: string; bot_id: string | null }>(
    'SELECT story_id,destination_id,bot_id FROM publications WHERE id=$1',[publicationId])).rows[0];
  if (!old?.story_id) return null;
  const same = await sameStoryIds(client,old.story_id);
  const target = (await client.query<{ url: string }>(`SELECT ${postAddress} AS url FROM publications old JOIN publications p
      ON p.destination_id=old.destination_id AND p.bot_id=old.bot_id AND p.id<>old.id
    WHERE old.id=$1 AND p.story_id=ANY($2::uuid[]) AND p.delivery_kind<>'album' AND ${validAddress} AND ${delivered}
      AND (p.published_at,p.id)>(coalesce(old.published_at,old.created_at),old.id)
    ORDER BY p.published_at DESC,p.id DESC LIMIT 1`,[publicationId,same])).rows[0];
  return target?.url ?? null;
}

/** Navigation edits may alter links and presentation, never event text, review, score or source facts. */
export function navigationOnlyChange(sent: PublicationSnapshot, desired: PublicationSnapshot): boolean {
  const body = (snapshot: PublicationSnapshot) => ({ ...snapshot,updatedTo:undefined,updatedToHeadline:undefined,navigationVersion:undefined,navigationOverflow:undefined,
    sources:snapshot.sources.filter(source => !isNavigationSource(source)) });
  return JSON.stringify(publicationSnapshotSchema.parse(body(sent))) === JSON.stringify(publicationSnapshotSchema.parse(body(desired)));
}

export async function desiredNavigation(client: Pick<PoolClient,'query'>,
  publication: { id: string; story_id: string | null; destination_id: string; bot_id: string | null },
  sent: PublicationSnapshot): Promise<PublicationSnapshot> {
  const related = publication.story_id ? await relatedPublicationSources(client,publication.story_id,
    publication.destination_id,publication.bot_id) : [];
  const sameIds = publication.story_id ? await sameStoryIds(client,publication.story_id) : [];
  const sameUrls = new Set((await client.query<{ url: string }>(`SELECT ${postAddress} AS url FROM publications p
    WHERE p.story_id=ANY($1::uuid[]) AND p.destination_id=$2 AND p.bot_id=$3 AND p.delivery_kind<>'album' AND ${validAddress}`,
  [sameIds,publication.destination_id,publication.bot_id])).rows.map(row => row.url));
  const relatedByUrl = new Map(related.map(source => [source.url,source]));
  const sources: PublicationSource[] = sent.sources.flatMap(source => {
    if (!isNavigationSource(source)) return [source];
    if (source.previousPublication && sameUrls.has(source.url)) return [source];
    if (relatedByUrl.has(source.url)) return [];
    // Retain historical links, but do not present unclassified links as same-event ancestry or sources.
    const retained = { ...source };
    delete retained.previousPublication; delete retained.relatedPublication;
    return [{ ...retained,unverifiedPublication:true as const }];
  });
  for (const source of related) if (!sources.some(existing => existing.url===source.url)) {
    const old = sent.sources.find(existing => existing.url===source.url);
    sources.push({ ...source,...(old && (old.previousPublication || old.unverifiedPublication || old.legacyPublication)
      ? { legacyPublication:true as const } : {}) });
  }
  const updatedTo = await latestUpdateTarget(client,publication.id);
  const result: PublicationSnapshot = { ...sent,sources,navigationVersion:2 };
  delete result.updatedTo; delete result.updatedToHeadline; delete result.navigationOverflow;
  if (updatedTo) {
    result.updatedTo=updatedTo;
    if (sent.presentationVersion === 1) {
      const target=(await client.query<{ headline:string }>(`SELECT snap.content->>'headline' AS headline
        FROM publications p JOIN publication_snapshots snap ON snap.id=p.snapshot_id
        WHERE p.destination_id=$1 AND ${postAddress}=$2 AND p.delivery_kind<>'album' AND ${delivered}`,
      [publication.destination_id,updatedTo])).rows[0];
      if (target?.headline) result.updatedToHeadline=target.headline;
    }
  }
  return result;
}
