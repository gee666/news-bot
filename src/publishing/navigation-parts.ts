import type { PoolClient } from 'pg';
import { publicationSnapshotSchema, type PublicationSnapshot } from '../types.js';
import { cleanLegacyHeadings, renderStoredPublication, withoutUpdateMarker } from './message-render.js';
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
  const old = await client.query<{ slot: string; content: unknown; snapshot_content:unknown; message_id: string | null; status: string }>(
    `SELECT n.slot,n.content,s.content AS snapshot_content,n.message_id,n.status FROM publication_navigation_parts n
      JOIN publication_snapshots s ON s.id=n.snapshot_id WHERE n.publication_id=$1 ORDER BY n.slot FOR UPDATE OF n`,[publicationId]);
  const oldFooters=old.rows.filter(part=>part.slot.startsWith('footer:'))
    .sort((left,right)=>Number(left.slot.slice(7))-Number(right.slot.slice(7)));
  const frozenFooters=oldFooters.filter(part=>part.message_id && JSON.stringify(part.content)!==JSON.stringify(emptyNavigation));
  const strippedFooters=stripNavigationTail(frozenFooters.map(part=>withoutUpdateMarker(renderedMessageSchema.parse(part.content),
    publicationSnapshotSchema.parse(part.snapshot_content).updatedTo)),
    frozenFooters.flatMap(part=>publicationSnapshotSchema.parse(part.snapshot_content).sources).filter(isNavigationSource));
  const cleanedFooters=new Map(frozenFooters.map((part,index)=>[part.slot,strippedFooters[index]]));
  for (const part of oldFooters) {
    if (!part.message_id) {
      const footer=footers.shift();
      if (footer) desired.set(part.slot,{ content:footer,messageId:null,textPart:null });
      else await client.query("DELETE FROM publication_navigation_parts WHERE publication_id=$1 AND slot=$2 AND status NOT IN ('running','unknown')",[publicationId,part.slot]);
      continue;
    }
    const original=renderedMessageSchema.parse(part.content);
    let cleaned=cleanLegacyHeadings(cleanedFooters.get(part.slot)??original);
    if (JSON.stringify(cleaned)===JSON.stringify(emptyNavigation)) cleaned={ ...cleaned,text:'',plainText:'',links:[] };
    const footer=footers[0];
    if (footer) {
      const combined=append(cleaned,footer);
      if (fits(combined)) { cleaned=combined; footers.shift(); }
    }
    // Retired overflow replies may contain frozen source/body prefixes. Never replace those with a placeholder.
    desired.set(part.slot,{ content:cleaned.plainText ? cleaned : emptyNavigation,messageId:part.message_id,textPart:null });
  }
  let index=0;
  for (const part of footers) {
    while (desired.has(`footer:${index}`)) index++;
    desired.set(`footer:${index++}`,{ content:part,messageId:null,textPart:null });
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
