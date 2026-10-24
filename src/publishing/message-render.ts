import type { PoolClient } from 'pg';
import { db } from '../db.js';
import { navigationOnlyChange, isNavigationSource } from './navigation.js';
import { stripNavigationTail } from './navigation-tail.js';
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
  const sent = first ? publicationSnapshotSchema.parse(first.snapshot_content) : publicationSnapshotSchema.parse(
    (await client.query<{ content: unknown }>(`SELECT snap.content FROM publications p
      JOIN publication_snapshots snap ON snap.id=p.snapshot_id WHERE p.id=$1`,[id])).rows[0]?.content ?? content);
  if (navigationOnlyChange(sent,snapshot)) {
    const base = first ? renderedMessageSchema.parse(first.content)
      : deliveryKind === 'album' ? renderCaption(sent,CAPTION_LIMIT,true) : render(sent,{ legacyBudget:true });
    const originals=[cleanLegacyHeadings(withoutUpdateMarker(base,sent.updatedTo)),...parts.slice(1).map(part=>renderedMessageSchema.parse(part.content))];
    const navigationSources=[...sent.sources,...parts.flatMap(part=>publicationSnapshotSchema.parse(part.snapshot_content).sources)].filter(isNavigationSource);
    let message=stripNavigationTail(originals,navigationSources)[0];
    if (!message) throw new PublicationRenderError('publication_snapshot_invalid');
    if (!snapshot.navigationOverflow) {
      const footer = renderFullText({ ...snapshot,headline:'Links',details:'',earlier:undefined,review:undefined,
        updatedTo:undefined,sources:snapshot.sources.filter(isNavigationSource) },true);
      if (parts.length > 1 && footer.length) throw new PublicationRenderError('publication_text_requires_new_edition');
      if (footer.length > 1) throw new PublicationRenderError('publication_message_too_long');
      const tail = footer[0];
      const offset=message.plainText.length;
      if (tail) message = { ...message,text:message.text+tail.text,plainText:message.plainText+tail.plainText,
        links:[...message.links,...tail.links.map(link => ({ ...link,offset:offset+link.offset }))] };
    }
    if (message.plainText.length > limit || message.links.length+(message.text.match(/<b>/gu)?.length ?? 0)>98)
      throw new PublicationRenderError('publication_message_too_long');
    if (snapshot.updatedTo && (!snapshot.navigationOverflow || message.plainText.length+`UPD: ${snapshot.updatedTo}\n\n`.length<=limit))
      return withUpdateMarker(message,snapshot.updatedTo,limit);
    return message;
  }
  const markerLength = snapshot.updatedTo ? `UPD: ${snapshot.updatedTo}\n\n`.length : 0;
  let message: RenderedMessage;
  if (first) {
    if (snapshotHash({ ...sent, updatedTo: undefined }) === snapshotHash({ ...snapshot, updatedTo: undefined })) {
      message = cleanLegacyHeadings(renderedMessageSchema.parse(first.content));
    } else {
      const desired = renderFullText({ ...snapshot,updatedTo:undefined });
      if (desired.length !== parts.length || parts.slice(1).some((part,index) =>
        JSON.stringify(renderedMessageSchema.parse(part.content)) !== JSON.stringify(desired[index+1]))) {
        throw new PublicationRenderError('publication_text_requires_new_edition');
      }
      const canonical = desired[0];
      if (!canonical) throw new PublicationRenderError('publication_snapshot_invalid');
      message = canonical;
    }
  } else {
    message = deliveryKind === 'album' ? renderCaption(snapshot,limit-markerLength) : render(snapshot,{ limit:limit-markerLength });
  }
  return snapshot.updatedTo ? withUpdateMarker(message,snapshot.updatedTo,limit) : message;
}

/** Remove only known legacy headings; all body text and link targets survive. */
export function cleanLegacyHeadings(message: RenderedMessage): RenderedMessage {
  const decode = (html: string) => html.replace(/<[^>]*>/gu,'').replaceAll('&quot;','"')
    .replaceAll('&gt;','>').replaceAll('&lt;','<').replaceAll('&amp;','&');
  const removals = [...message.text.matchAll(/(?<=\n\n)<b>(Новое|Ранее было опубликовано)<\/b>\n/gu)]
    .map(match => ({ htmlOffset:match.index,htmlLength:match[0].length,
      offset:decode(message.text.slice(0,match.index)).length,value:match[1]+'\n' }))
    .filter(item => message.plainText.slice(item.offset,item.offset+item.value.length)===item.value);
  if (!removals.length) return message;
  let text=message.text; let plainText=message.plainText;
  for (const item of [...removals].reverse()) {
    text=text.slice(0,item.htmlOffset)+text.slice(item.htmlOffset+item.htmlLength);
    plainText=plainText.slice(0,item.offset)+plainText.slice(item.offset+item.value.length);
  }
  return { ...message,text,plainText,
    links:message.links.map(link => ({ ...link,offset:link.offset-removals.filter(item => item.offset<link.offset)
      .reduce((sum,item) => sum+item.value.length,0) })) };

}


export async function renderPublication(publication: Publication): Promise<RenderedMessage> {
  return renderStoredPublication(db,publication.id,publication.content,publication.delivery_kind);
}

/** Save successful explicit first-part repairs without baking an UPD prefix into the base text. */
export async function freezeEditedCanonical(client: Pick<PoolClient,'query'>, publication: Publication, message: RenderedMessage): Promise<void> {
  const { updatedTo } = publicationSnapshotSchema.parse(publication.content);
  const canonical = withoutUpdateMarker(message,updatedTo);
  await client.query(`INSERT INTO publication_text_parts(publication_id,part_number,content,snapshot_id,status,message_id)
    VALUES($1,0,$2,$3,'sent',$4) ON CONFLICT(publication_id,part_number) DO UPDATE
      SET content=EXCLUDED.content,snapshot_id=EXCLUDED.snapshot_id`,
    [publication.id,JSON.stringify(canonical),publication.pending_snapshot_id ?? publication.snapshot_id,publication.message_id]);
}

function withoutUpdateMarker(message: RenderedMessage, updatedTo?: string): RenderedMessage {
  if (!updatedTo) return message;
  const prefix=`UPD: ${updatedTo}\n\n`;
  const htmlPrefix=`UPD: <a href="${escapeHtml(updatedTo)}">${escapeHtml(updatedTo)}</a>\n\n`;
  if (!message.plainText.startsWith(prefix) || !message.text.startsWith(htmlPrefix)
    || message.links[0]?.offset!==5 || message.links[0].url!==updatedTo) return message;
  return { ...message,text:message.text.slice(htmlPrefix.length),plainText:message.plainText.slice(prefix.length),
    links:message.links.slice(1).map(link => ({ ...link,offset:link.offset-prefix.length })) };
}
