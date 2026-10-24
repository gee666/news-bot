import type { PoolClient } from 'pg';
import { publicationSnapshotSchema, type PublicationSnapshot } from '../types.js';
import { cleanLegacyHeadings, renderStoredPublication } from './message-render.js';
import { renderFullText, renderedMessageSchema } from './full-text.js';
import { isNavigationSource } from './navigation.js';
import { stripNavigationTail } from './navigation-tail.js';
import type { RenderedMessage } from './render.js';

const emptyNavigation:RenderedMessage={ text:'Дополнительные ссылки находятся в публикации.',
  plainText:'Дополнительные ссылки находятся в публикации.',links:[],parse_mode:'HTML',
  link_preview_options:{ is_disabled:true },reply_markup:{ inline_keyboard:[] } };
function append(base:RenderedMessage,footer:RenderedMessage):RenderedMessage {
  return { ...base,text:base.text+footer.text,plainText:base.plainText+footer.plainText,
    links:[...base.links,...footer.links.map(link=>({ ...link,offset:base.plainText.length+link.offset }))] };
}
function fits(message:RenderedMessage):boolean {
  return message.plainText.length<=4096 && message.links.length+(message.text.match(/<b>/gu)?.length??0)<=98;
}

/** Overflow is attached to the exact snapshot that authorizes it, never an uncommitted edit. */
export async function prepareNavigationParts(client: Pick<PoolClient,'query'>, publicationId: string,
  snapshotId: string, snapshot: PublicationSnapshot): Promise<void> {
  const desired = new Map<string,{ content: unknown; messageId: string | null; textPart: number | null }>();
  const owner = (await client.query<{ delivery_kind:'text'|'album' }>('SELECT delivery_kind FROM publications WHERE id=$1',[publicationId])).rows[0];
  const canonical = await renderStoredPublication(client,publicationId,snapshot,owner?.delivery_kind);
  let footers = snapshot.navigationOverflow ? renderFullText({ ...snapshot,headline:'Links',details:'',earlier:undefined,review:undefined,
    updatedTo:canonical.plainText.startsWith('UPD: ') ? undefined : snapshot.updatedTo,
    sources:snapshot.sources.filter(isNavigationSource) },true) : [];
  const continuations = await client.query<{ part_number: number; content: unknown; snapshot_content:unknown; message_id: string }>(
    `SELECT t.part_number,t.content,s.content AS snapshot_content,t.message_id FROM publication_text_parts t
      JOIN publication_snapshots s ON s.id=t.snapshot_id
      WHERE t.publication_id=$1 AND t.part_number>0 AND t.status='sent' ORDER BY t.part_number`,[publicationId]);
  const first=(await client.query<{ content:unknown; snapshot_content:unknown }>(`SELECT t.content,s.content AS snapshot_content
    FROM publication_text_parts t JOIN publication_snapshots s ON s.id=t.snapshot_id
    WHERE t.publication_id=$1 AND t.part_number=0`,[publicationId])).rows[0];
  const all=first ? [first,...continuations.rows] : continuations.rows;
  const stripped=stripNavigationTail(all.map(part=>renderedMessageSchema.parse(part.content)),
    all.flatMap(part=>publicationSnapshotSchema.parse(part.snapshot_content).sources).filter(isNavigationSource));
  for (const [index,part] of continuations.rows.entries()) {
    const original = renderedMessageSchema.parse(part.content);
    let cleaned = cleanLegacyHeadings(stripped[index+(first?1:0)] ?? original);
    // Keep navigation at the bottom of the final existing text part whenever it fits.
    if (index===continuations.rows.length-1 && footers.length===1 && footers[0]) {
      const combined=append(cleaned,footers[0]);
      if (fits(combined)) { cleaned=combined; footers=[]; }
    }
    if (!cleaned.plainText) cleaned=emptyNavigation;
    if (JSON.stringify(original)!==JSON.stringify(cleaned)) desired.set(`cleanup:${part.part_number}`,
      { content:cleaned,messageId:part.message_id,textPart:part.part_number });
  }
  for (const [index,part] of footers.entries()) desired.set(`footer:${index}`,{ content:part,messageId:null,textPart:null });
  const old = await client.query<{ slot: string; content: unknown; message_id: string | null; status: string }>(
    'SELECT slot,content,message_id,status FROM publication_navigation_parts WHERE publication_id=$1 FOR UPDATE',[publicationId]);
  for (const part of old.rows) {
    if (desired.has(part.slot) || !part.slot.startsWith('footer:')) continue;
    if (!part.message_id) {
      await client.query("DELETE FROM publication_navigation_parts WHERE publication_id=$1 AND slot=$2 AND status NOT IN ('running','unknown')",[publicationId,part.slot]);
    } else desired.set(part.slot,{ content:emptyNavigation,messageId:part.message_id,textPart:null });
  }
  for (const [slot,part] of desired) {
    await client.query(`INSERT INTO publication_navigation_parts(publication_id,slot,snapshot_id,content,message_id,text_part_number)
      VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(publication_id,slot) DO UPDATE SET snapshot_id=EXCLUDED.snapshot_id,
        content=EXCLUDED.content,status=CASE WHEN publication_navigation_parts.content=EXCLUDED.content
          AND publication_navigation_parts.status='sent' THEN 'sent' ELSE 'prepared' END,
        error_code=NULL,next_retry_at=NULL
      WHERE publication_navigation_parts.status NOT IN ('running','unknown')`,
    [publicationId,slot,snapshotId,JSON.stringify(part.content),part.messageId,part.textPart]);
  }
}
