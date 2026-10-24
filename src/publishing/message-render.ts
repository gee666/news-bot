import type { PoolClient } from 'pg';
import { db } from '../db.js';
import { publicationSnapshotSchema } from '../types.js';
import { snapshotHash } from './approval.js';
import { renderCaption, CAPTION_LIMIT } from './caption.js';
import { renderFullText, renderedMessageSchema, withUpdateMarker } from './full-text.js';
import { escapeHtml, PublicationRenderError, render, type RenderedMessage } from './render.js';
import type { Publication } from './store.js';

/** Edits may change the canonical part, never silently rewrite or discard continuations. */
export async function renderStoredPublication(client: Pick<PoolClient,'query'>, id: string, content: unknown,
  deliveryKind: 'text' | 'album' = 'text'): Promise<RenderedMessage> {
  const parsed = publicationSnapshotSchema.safeParse(content);
  if (!parsed.success) throw new PublicationRenderError('publication_snapshot_invalid');
  const snapshot = parsed.data;
  const parts = (await client.query<{ content: unknown; snapshot_content: unknown }>(`SELECT t.content,s.content AS snapshot_content
    FROM publication_text_parts t JOIN publication_snapshots s ON s.id=t.snapshot_id WHERE t.publication_id=$1 ORDER BY t.part_number`, [id])).rows;
  const first = parts[0];
  const limit = deliveryKind === 'album' ? CAPTION_LIMIT : 4096;
  const markerLength = snapshot.updatedTo ? `UPD: ${snapshot.updatedTo}\n\n`.length : 0;
  let message: RenderedMessage;
  if (first) {
    const base = publicationSnapshotSchema.parse(first.snapshot_content);
    if (snapshotHash({ ...base, updatedTo: undefined }) === snapshotHash({ ...snapshot, updatedTo: undefined })) {
      message = renderedMessageSchema.parse(first.content);
    } else {
      const desired = renderFullText({ ...snapshot,updatedTo:undefined });
      if (desired.length !== parts.length || parts.slice(1).some((part,index) =>
        snapshotHash(renderedMessageSchema.parse(part.content)) !== snapshotHash(desired[index+1]))) {
        throw new PublicationRenderError('publication_text_requires_new_edition');
      }
      const canonical = desired[0];
      if (!canonical) throw new PublicationRenderError('publication_snapshot_invalid');
      message = canonical;
    }
  } else {
    // Legacy captions keep their original renderer. Shorten only to fit the marker.
    message = deliveryKind === 'album' ? renderCaption(snapshot,limit-markerLength) : render(snapshot,{ limit:limit-markerLength });
  }
  return snapshot.updatedTo ? withUpdateMarker(message,snapshot.updatedTo,limit) : message;
}

export async function renderPublication(publication: Publication): Promise<RenderedMessage> {
  return renderStoredPublication(db,publication.id,publication.content,publication.delivery_kind);
}

/** Save successful explicit first-part repairs without baking an UPD prefix into the base text. */
export async function freezeEditedCanonical(client: Pick<PoolClient,'query'>, publication: Publication, message: RenderedMessage): Promise<void> {
  const { updatedTo } = publicationSnapshotSchema.parse(publication.content);
  const prefix = updatedTo ? `UPD: ${updatedTo}\n\n` : '';
  const canonical = updatedTo ? { ...message,
    text: message.text.slice(`UPD: <a href="${escapeHtml(updatedTo)}">${escapeHtml(updatedTo)}</a>\n\n`.length),
    plainText: message.plainText.slice(prefix.length),
    links: message.links.slice(1).map(link => ({ ...link,offset:link.offset-prefix.length })),
  } : message;
  await client.query(`UPDATE publication_text_parts SET content=$2,snapshot_id=$3 WHERE publication_id=$1 AND part_number=0`,
    [publication.id,JSON.stringify(canonical),publication.pending_snapshot_id ?? publication.snapshot_id]);
}
