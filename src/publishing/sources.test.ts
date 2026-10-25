import { describe,expect,it } from 'vitest';
import type { PublicationSnapshot,PublicationSource } from '../types.js';
import { render } from './render.js';
import { renderCaption } from './caption.js';
import { renderFullText } from './full-text.js';
import { orderSources,sourceGroup,SOURCE_GROUPS } from './sources.js';

const audit:PublicationSource={ label:'Непроверенная историческая ссылка',url:'https://t.me/c/123/10',primary:false,
  unverifiedPublication:true,access:'public',classification:'relevant' };
const snapshot:PublicationSnapshot={ headline:'Новость',details:'Исходные факты',score:8,detailsKind:'summary',sources:[
  { label:'Источник',url:'https://source.example/report',primary:true,access:'public',classification:'relevant' },
  { ...audit,url:'https://t.me/c/123/9',label:'Та же история',unverifiedPublication:undefined,previousPublication:true },
  audit,
  { ...audit,url:'https://t.me/c/123/20',label:'Подтверждённая связь',unverifiedPublication:undefined,relatedPublication:true },
] };

describe('visible navigation and audit-only historical links',()=>{
  it('keeps audit links in ordered storage without promoting them to a visible source group',()=>{
    expect(orderSources(snapshot.sources)).toContainEqual(audit);
    expect(sourceGroup(audit)).toBe('unverified');
    expect(sourceGroup({ ...audit,primary:true,kind:'primary',relatedPublication:true })).toBe('unverified');
    expect(SOURCE_GROUPS.some(group=>group.kind==='unverified')).toBe(false);
  });
  it('does not spend visible entity budget on retained audit links',()=>{
    const sources=Array.from({length:150},(_,index)=>({ ...audit,url:`https://t.me/c/123/${index+100}` }));
    const stored={ ...snapshot,sources:[...snapshot.sources,...sources] };
    expect(()=>render(stored)).not.toThrow();
    expect(render(stored).links).toHaveLength(3);
    expect(stored.sources).toHaveLength(154);
  });
  it.each([
    ['text',()=>[render(snapshot)]],
    ['caption',()=>[renderCaption(snapshot)]],
    ['full text',()=>renderFullText(snapshot)],
    ['overflow footer',()=>renderFullText(snapshot,true)],
  ] as const)('does not render audit-only links in %s',(_name,renderParts)=>{
    const parts=renderParts(); const plain=parts.map(part=>part.plainText).join('');
    expect(plain).not.toContain('Связанные новости');
    expect(plain).not.toContain(audit.label);
    expect(parts.flatMap(part=>part.links).map(link=>link.url)).not.toContain(audit.url);
    expect(snapshot.sources).toContainEqual(audit);
    expect(plain.match(/Другие публикации/gu)).toHaveLength(1);
    expect(plain).toContain('Предыдущие публикации');
  });
});
