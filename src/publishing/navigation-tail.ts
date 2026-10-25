import type { PublicationSource } from '../types.js';
import { SOURCE_GROUPS } from './sources.js';
import type { RenderedMessage } from './render.js';

const decode=(text:string)=>text.replaceAll('&quot;','"').replaceAll('&gt;','>').replaceAll('&lt;','<').replaceAll('&amp;','&');
const tokens=(html:string)=>html.matchAll(/<[^>]*>|&(?:amp|lt|gt|quot);|[^<&]+|[<&]/gu);

/** Slice decoded UTF-16 while closing open formatting. Never slice raw HTML at a text offset. */
function prefix(message:RenderedMessage,end:number):RenderedMessage {
  if (end>=message.plainText.length) return message;
  let text=''; let length=0; const stack:string[]=[];
  for (const match of tokens(message.text)) {
    if (length>=end) break;
    const token=match[0];
    if (token.startsWith('<')) {
      text+=token;
      const opening=/^<(b|a)(?:\s|>)/u.exec(token);
      if (opening?.[1]) stack.push(opening[1]);
      else if (/^<\/(?:b|a)>$/u.test(token)) stack.pop();
      continue;
    }
    const decoded=decode(token); const take=Math.min(decoded.length,end-length);
    text+=take===decoded.length ? token : token.slice(0,take); length+=take;
  }
  text+=stack.reverse().map(tag=>`</${tag}>`).join('');
  return { ...message,text,plainText:message.plainText.slice(0,end),links:message.links.filter(link=>link.offset<end)
    .map(link=>({ ...link,length:Math.min(link.length,end-link.offset) })) };
}

/** Locate the formatted navigation suffix across part boundaries, including split headings/labels. */
export function stripNavigationTail(messages:RenderedMessage[],sources:PublicationSource[]):RenderedMessage[] {
  if (!sources.length) return messages;
  const urls=new Set(sources.map(source=>source.url));
  let offset=0; const bold:Array<{start:number;end:number}>=[];
  const links=messages.flatMap(message=>{
    let local=0; let depth=0;
    for (const match of tokens(message.text)) {
      const token=match[0];
      if (token==='<b>') depth++;
      else if (token==='</b>') depth--;
      else if (!token.startsWith('<')) {
        const length=decode(token).length;
        if (depth>0) bold.push({ start:offset+local,end:offset+local+length });
        local+=length;
      }
    }
    const result=message.links.map(link=>({ ...link,offset:offset+link.offset })); offset+=message.plainText.length;
    return result;
  });
  const plain=messages.map(message=>message.plainText).join(''); let boundary=plain.length;
  // Recognize both historical related headings; the current title does not make audit links visible.
  const headings=[...new Set([...SOURCE_GROUPS.filter(group=>['previous','related'].includes(group.kind)).map(group=>group.heading),
    'Связанные новости'])];
  const sections:Array<{ start:number; end:number }>=[];
  for (const heading of headings) {
    const needle=`\n\n${heading}\n`;
    for (let start=plain.indexOf(needle); start>=0; start=plain.indexOf(needle,start+needle.length)) {
      let covered=start+2;
      for (const range of bold) if (range.start<=covered && range.end>covered) covered=range.end;
      if (covered>=start+2+heading.length) sections.push({ start,end:start+2+heading.length });
    }
  }
  sections.sort((left,right)=>left.start-right.start);
  for (const section of sections) {
    const following=links.filter(link=>link.offset>=section.start);
    if (!following.length || following.some(link=>!urls.has(link.url))) continue;
    const suffixSections=sections.filter(item=>item.start>=section.start);
    if (suffixSections.some((item,index)=>!following.some(link=>link.offset>item.end
      && link.offset<(suffixSections[index+1]?.start??plain.length)))) continue;
    const ranges=[...suffixSections,...following.map(link=>({ start:link.offset,end:link.offset+link.length }))]
      .sort((left,right)=>left.start-right.start);
    let end=section.start; let safe=true;
    for (const range of ranges) {
      if (range.start>end && plain.slice(end,range.start).trim()) { safe=false; break; }
      end=Math.max(end,range.end);
    }
    // A matching URL is not enough: unlinked factual text after/between links must survive.
    if (safe && !plain.slice(end).trim()) { boundary=section.start; break; }
  }
  offset=0;
  return messages.map(message=>{
    const length=Math.max(0,Math.min(message.plainText.length,boundary-offset)); offset+=message.plainText.length;
    return prefix(message,length);
  });
}
