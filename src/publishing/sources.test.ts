import { describe,expect,it } from 'vitest';
import type { PublicationSnapshot,PublicationSource } from '../types.js';
import { render } from './render.js';
import { orderSources,sourceGroup,SOURCE_GROUPS,visibleSources } from './sources.js';

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

it('caps persisted related links at five unique URLs without capping previous or factual sources or mutating audit',()=>{
  const related=Array.from({length:26},(_,index)=>({...audit,unverifiedPublication:undefined,relatedPublication:true as const,
    label:`Related ${index}`,url:`https://t.me/c/123/${index+200}`}));
  const previous=Array.from({length:8},(_,index)=>({...audit,unverifiedPublication:undefined,previousPublication:true as const,
    url:`https://t.me/c/123/${index+300}`}));
  const sources=[...snapshot.sources.filter(source=>!source.relatedPublication),{...audit,...related[0],url:'https://t.me/c/123/200',label:'Duplicate',primary:false},...related,...previous];
  const before=structuredClone(sources);
  expect(visibleSources(sources).filter(source=>source.relatedPublication)).toHaveLength(5);
  expect(visibleSources(sources).filter(source=>source.previousPublication)).toHaveLength(9);
  expect(visibleSources(sources).some(source=>source.unverifiedPublication)).toBe(false);
  expect(sources).toEqual(before);
  expect(orderSources(sources)).toHaveLength(sources.length);
});

it.each(['text'] as const)('caps actual persisted sources in %s rendering without mutating the snapshot',()=>{
  const stored={...snapshot,sources:[...snapshot.sources,...Array.from({length:26},(_,index)=>({...audit,
    unverifiedPublication:undefined,relatedPublication:true as const,label:`Related ${index}`,url:`https://t.me/c/123/${index+200}`}))]};
  const before=structuredClone(stored);
  const parts=[render(stored)];
  const relatedUrls=new Set(stored.sources.filter(source=>source.relatedPublication).map(source=>source.url));
  expect(parts.flatMap(part=>part.links).filter(link=>relatedUrls.has(link.url)).length).toBeLessThanOrEqual(5);
  expect(stored).toEqual(before);
});
