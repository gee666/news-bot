import { db } from '../db.js';
import { requireInferenceApproval } from './generation-model.js';

/** These endpoints are the explicitly configured local inference services, not public providers. */
export function localInference(endpoint: string): boolean {
  const hostname = new URL(endpoint).hostname;
  return ['localhost', '127.0.0.1', '[::1]', 'host.docker.internal'].includes(hostname);
}
export async function approveRemoteInput(endpoint: string, operationId: string,
  owner: { revisionId?: string | null; storyId?: string | null; mentionId?: string }): Promise<void> {
  if (localInference(endpoint) || process.env.ALLOW_PRIVATE_INFERENCE === 'true') return;
  const sources = await db.query<{ access: string }>(`SELECT DISTINCT s.access FROM sources s JOIN source_items i ON i.source_id=s.id
    JOIN item_revisions r ON r.item_id=i.id LEFT JOIN story_mentions m ON m.revision_id=r.id
    WHERE r.id=$1 OR m.story_id=$2 OR m.id=$3`, [owner.revisionId ?? null, owner.storyId ?? null, owner.mentionId ?? null]);
  await requireInferenceApproval(sources.rows.map(source => source.access), operationId);
}
