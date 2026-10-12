import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z, ZodError } from 'zod';
import { transaction } from '../db.js';
import { settingsSchema,type AppSettings } from '../settings.js';
import { generationIsCurrent } from '../pipeline/generation-freshness.js';
import { publicationSnapshotSchema, type PublicationSnapshot } from '../types.js';
import type { RepairOptions } from './repair.js';
import { repairEditBlocked, trackedVerificationTest, verifiedBotSchema } from './repair-test.js';
import { expectedSourceUrls } from './preview-sources.js';
import { PublicationRenderError, render } from './render.js';
import { sourceGroup } from './sources.js';
import { eligible, rateLimited, snapshotFor, type StoryContent } from './store.js';
import { canonicalPublications } from './updates.js';

interface Metrics {
  characters: number; detailCharacters: number; sourceUrls: number; entities: number;
  snapshotSha256: string; detailsSha256: string; allSnapshotLinksRendered: boolean;
}
interface PostPreview {
  publicationId: string; storyId: string; messageId: string; eligible: boolean; ready: boolean;
  issues: string[]; metrics: Metrics | null; expectedSourceUrls: number | null; missingSourceUrls: number | null;
  previousDetailsSha256: string | null; wouldStageSnapshot: boolean | null;
  storedFormatVersion: number; publishedSnapshotMatchesDesired: boolean | null;
}
interface DuplicatePreview {
  publicationId: string; messageId: string; canonicalPublicationId: string; canonicalMessageId: string;
  replacementStatus: string | null; authorization: 'after_successful_canonical_edit';
}
interface TestPreview { publicationId: string | null; messageId: string | null; ready: boolean; issues: string[]; metrics: Metrics | null; storedFormatVersion: number | null }
interface StoryRow extends StoryContent {
  publication_id: string; message_id: string; bot_id: string | null; is_eligible: boolean;
  old_content: unknown; pending_content: unknown; pending_snapshot_id: string | null; snapshot_id: string; format_version: number;
}
export interface RepairPreview {
  destinationId: string; verifiedBotId: string; identityCheck: 'persisted_only'; publishingEnabled: boolean;
  profileVersion: number; modelVersion: number; canonicalPosts: number; eligiblePosts: number; readyPosts: number;
  allReady: boolean; cooldownActive: boolean; posts: PostPreview[]; verificationTest: TestPreview | null;
  proposedDuplicateDeletions: DuplicatePreview[]; unaccountedTrackedMessages: Array<{ publicationId: string; messageId: string }>;
}
function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function metrics(snapshot: PublicationSnapshot): Metrics {
  const message = render(snapshot);
  const expected = new Set(snapshot.sources.map(source => source.url));
  const rendered = new Set(message.links.map(link => link.url));
  return { characters: message.plainText.length,detailCharacters: snapshot.details.length,sourceUrls: expected.size,
    entities: 1 + message.links.length + new Set(snapshot.sources.map(sourceGroup)).size,
    snapshotSha256: hash(JSON.stringify(snapshot)),detailsSha256: hash(snapshot.details),
    allSnapshotLinksRendered: expected.size === rendered.size && [...expected].every(url => rendered.has(url)) };
}
async function previewStory(client: PoolClient, row: StoryRow, botId: string, cooldown: boolean, settings: AppSettings): Promise<PostPreview> {
  const old = publicationSnapshotSchema.safeParse(row.old_content);
  const preview: PostPreview = { publicationId: row.publication_id,storyId: row.id,messageId: row.message_id,
    eligible: row.is_eligible,ready: false,issues: [],metrics: null,expectedSourceUrls: null,missingSourceUrls: null,
    previousDetailsSha256: old.success ? hash(old.data.details) : null,wouldStageSnapshot: null,
    storedFormatVersion: row.format_version,publishedSnapshotMatchesDesired: null };
  if (!row.is_eligible) preview.issues.push('story_not_fresh_eligible');
  if (row.bot_id !== botId) preview.issues.push('bot_ownership_unverified');
  if (cooldown) preview.issues.push('telegram_cooldown');
  if (!row.is_eligible) return preview;
  try {
    if (!await generationIsCurrent(row.id,settings,client.query.bind(client))) preview.issues.push('current_generation_missing');
    const snapshot = await snapshotFor(client,row);
    preview.metrics = metrics(snapshot);
    if (snapshot.headline !== row.headline || snapshot.score !== row.interest_score
      || snapshot.details !== (row.researched ? row.summary : row.translated_excerpt)
      || snapshot.detailsKind !== (row.researched ? 'summary' : 'excerpt')) preview.issues.push('canonical_content_mismatch');
    preview.publishedSnapshotMatchesDesired = old.success && row.format_version === 1 && JSON.stringify(old.data) === JSON.stringify(snapshot);
    const expected = await expectedSourceUrls(client,row.id,row);
    const actual = new Set(snapshot.sources.map(source => source.url));
    preview.expectedSourceUrls = expected.size;
    preview.missingSourceUrls = [...expected].filter(url => !actual.has(url)).length;
    if (preview.missingSourceUrls) preview.issues.push('supporting_sources_missing');
    if (!preview.metrics.allSnapshotLinksRendered) preview.issues.push('rendered_sources_missing');
    const previous = publicationSnapshotSchema.safeParse(row.pending_snapshot_id ? row.pending_content : row.old_content);
    preview.wouldStageSnapshot = !(previous.success && JSON.stringify(previous.data) === JSON.stringify(snapshot)
      && (row.pending_snapshot_id !== null || row.format_version === 1));
    if (!preview.wouldStageSnapshot && await repairEditBlocked(client,row.publication_id,row.pending_snapshot_id ?? row.snapshot_id)) {
      preview.issues.push('edit_retry_blocked');
    }
  } catch (error) {
    if (!(error instanceof PublicationRenderError || error instanceof ZodError)) throw error;
    preview.issues.push(error instanceof PublicationRenderError ? error.code : 'publication_snapshot_invalid');
  }
  preview.ready = !preview.issues.length;
  return preview;
}

/** Consistent read-only plan. Does not prepare snapshots, bootstrap settings, call Telegram or call models. */
export async function previewPublicationRepair(options: RepairOptions = {}): Promise<RepairPreview> {
  return transaction(async client => {
    await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
    const settings = settingsSchema.parse((await client.query<{ value: unknown }>('SELECT value FROM app_settings WHERE id=1')).rows[0]?.value);
    const values = (await client.query<{ key: string; value: unknown }>(`SELECT key,value FROM operational_state
      WHERE key IN ('telegram_destination','bot_verified')`)).rows;
    const destinationId = z.object({ channelId: z.string().regex(/^-100\d+$/u) }).parse(values.find(row => row.key === 'telegram_destination')?.value).channelId;
    const verified = verifiedBotSchema.parse(values.find(row => row.key === 'bot_verified')?.value);
    if (verified.destinationId !== destinationId) throw new Error('Preview destination verification mismatch');
    const botId = String(verified.botId);
    const cooldown = await rateLimited(client);
    const rows = (await client.query<StoryRow>(`SELECT s.*,p.id AS publication_id,p.message_id,p.bot_id,p.format_version,
      p.snapshot_id,p.pending_snapshot_id,snap.content AS old_content,desired.content AS pending_content,(${eligible}) AS is_eligible
      FROM (${canonicalPublications}) chosen JOIN stories s ON s.id=chosen.canonical_story_id
      JOIN publications p ON p.id=chosen.id JOIN publication_snapshots snap ON snap.id=p.snapshot_id
      LEFT JOIN publication_snapshots desired ON desired.id=p.pending_snapshot_id`,
    [destinationId,settings.minimumPublicationScore,settings.profileVersion,settings.modelVersion])).rows;
    const posts: PostPreview[] = [];
    for (const row of rows) posts.push(await previewStory(client,row,botId,cooldown,settings));
    const duplicates: DuplicatePreview[] = [];
    for (const post of posts.filter(post => post.ready)) {
      const siblings = (await client.query<{ id: string; message_id: string; replacement_status: string | null }>(`SELECT d.id,d.message_id,r.status AS replacement_status
        FROM publications d LEFT JOIN story_publication_aliases pa ON pa.publication_id=d.id
        LEFT JOIN story_merges sm ON sm.merged_story_id=d.story_id
        LEFT JOIN publication_replacements r ON r.duplicate_publication_id=d.id
        WHERE coalesce(pa.canonical_story_id,sm.canonical_story_id,d.story_id)=$1 AND d.id<>$2
          AND d.destination_id=$3 AND d.bot_id=$4 AND d.status='published' AND d.message_id IS NOT NULL
          AND NOT EXISTS(SELECT 1 FROM operational_state removed WHERE removed.key='publication_removal:'||d.id::text)
          AND r.status IS DISTINCT FROM 'deleted' ORDER BY d.message_id,d.id`,
      [post.storyId,post.publicationId,destinationId,botId])).rows;
      for (const sibling of siblings) duplicates.push({ publicationId: sibling.id,messageId: sibling.message_id,
        canonicalPublicationId: post.publicationId,canonicalMessageId: post.messageId,replacementStatus: sibling.replacement_status,
        authorization: 'after_successful_canonical_edit' });
    }
    let test: TestPreview | null = null;
    if (options.includeVerificationTest) {
      test = { publicationId: null,messageId: null,ready: false,issues: [],metrics: null,storedFormatVersion: null };
      try {
        const publication = await trackedVerificationTest(client,destinationId,botId);
        test.publicationId = publication.id; test.messageId = publication.message_id; test.storedFormatVersion = publication.format_version;
        test.metrics = metrics(publicationSnapshotSchema.parse(publication.content));
        if (cooldown) test.issues.push('telegram_cooldown');
        if (await repairEditBlocked(client,publication.id,publication.snapshot_id)) test.issues.push('edit_retry_blocked');
        test.ready = !test.issues.length;
      } catch (error) {
        if (!(error instanceof ZodError || error instanceof PublicationRenderError || error instanceof Error && error.message.startsWith('verification_test_'))) throw error;
        test.issues.push(error instanceof ZodError ? 'verification_test_invalid' : error.message);
      }
    }
    const accounted = [...posts.map(post => post.publicationId),...duplicates.map(post => post.publicationId),...(test?.publicationId ? [test.publicationId] : [])];
    const unaccounted = (await client.query<{ publicationId: string; messageId: string }>(`SELECT p.id AS "publicationId",p.message_id AS "messageId"
      FROM publications p WHERE p.destination_id=$1 AND p.status='published' AND p.message_id IS NOT NULL
        AND NOT EXISTS(SELECT 1 FROM operational_state removed WHERE removed.key='publication_removal:'||p.id::text)
        AND NOT (p.id=ANY($2::uuid[])) AND NOT EXISTS(SELECT 1 FROM publication_replacements r WHERE r.duplicate_publication_id=p.id AND r.status='deleted')
      ORDER BY p.message_id,p.id`, [destinationId,accounted])).rows;
    return { destinationId,verifiedBotId: botId,identityCheck: 'persisted_only',publishingEnabled: settings.publishingEnabled,
      profileVersion: settings.profileVersion,modelVersion: settings.modelVersion,canonicalPosts: posts.length,
      eligiblePosts: posts.filter(post => post.eligible).length,readyPosts: posts.filter(post => post.ready).length,
      allReady: posts.every(post => post.ready) && (!test || test.ready) && !unaccounted.length
        && !duplicates.some(post => post.replacementStatus === 'failed'),
      cooldownActive: cooldown,posts,verificationTest: test,proposedDuplicateDeletions: duplicates,unaccountedTrackedMessages: unaccounted };
  });
}
