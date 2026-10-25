import { describe,expect,it } from 'vitest';
import { stripNavigationTail } from './navigation-tail.js';
import type { RenderedMessage } from './render.js';
const message=(text:string,plainText:string,links:RenderedMessage['links']=[]):RenderedMessage=>({ text,plainText,links,
  parse_mode:'HTML',link_preview_options:{ is_disabled:true },reply_markup:{ inline_keyboard:[] } });
const source={ label:'Другой сюжет',url:'https://t.me/c/123/20',primary:false,relatedPublication:true as const,
  access:'public' as const,classification:'relevant' as const };
describe('frozen multipart navigation suffix',()=>{
  it('finds a formatted heading split across messages without losing factual prefixes or source links',()=>{
    const fact='Факты <&> 😀'; const origin='https://author.example/report';
    const first=message(`<b>Тема</b>\n\n${'Факты &lt;&amp;&gt; 😀'}\n<a href="${origin}">Источник</a>\n\n<b>Связан</b>`,
      'Тема\n\n'+fact+'\nИсточник\n\nСвязан',[{ offset:('Тема\n\n'+fact+'\n').length,length:8,url:origin }]);
    const second=message(`<b>ные новости</b>\n<a href="${source.url}">Другой сюжет</a>`,'ные новости\nДругой сюжет',
      [{ offset:'ные новости\n'.length,length:'Другой сюжет'.length,url:source.url }]);
    const stripped=stripNavigationTail([first,second],[source]);
    expect(stripped[0]?.plainText).toBe('Тема\n\n'+fact+'\nИсточник');
    expect(stripped[0]?.text).toBe(`<b>Тема</b>\n\nФакты &lt;&amp;&gt; 😀\n<a href="${origin}">Источник</a>`);
    expect(stripped[0]?.links).toEqual(first.links); expect(stripped[1]?.plainText).toBe('');
    expect(stripped[1]?.links).toEqual([]);
  });
  it('removes old audit navigation and repeated related groups together, including a split legacy heading',()=>{
    const first=message('Факты\n\n<b>Другие пуб</b>','Факты\n\nДругие пуб');
    const secondPlain='ликации\nДругой сюжет\n\nСвязанные новости\nДругой сюжет\n\nСвязанные новости\nДругой сюжет';
    const second=message(`<b>ликации</b>\n<a href="${source.url}">Другой сюжет</a>\n\n<b>Связанные новости</b>\n<a href="${source.url}">Другой сюжет</a>\n\n<b>Связанные новости</b>\n<a href="${source.url}">Другой сюжет</a>`,secondPlain,
      [...secondPlain.matchAll(/Другой сюжет/gu)].map(match=>({ offset:match.index,length:match[0].length,url:source.url })));
    const stripped=stripNavigationTail([first,second],[{ ...source,relatedPublication:undefined,unverifiedPublication:true }]);
    expect(stripped.map(part=>part.plainText)).toEqual(['Факты','']);
    expect(stripped.flatMap(part=>part.links)).toEqual([]);
  });
  it('keeps factual text after or between matching navigation URLs instead of truncating it',()=>{
    for (const tail of ['\nДополнительный исходный факт','\nДополнительный факт\nДругой сюжет']) {
      const plain='Факты\n\nДругие публикации\nДругой сюжет'+tail;
      const html=`Факты\n\n<b>Другие публикации</b>\n<a href="${source.url}">Другой сюжет</a>`+tail;
      const value=message(html,plain,[{ offset:'Факты\n\nДругие публикации\n'.length,length:'Другой сюжет'.length,url:source.url }]);
      expect(stripNavigationTail([value],[source])).toEqual([value]);
    }
  });
  it('keeps a factual-source group even when an earlier heading looks like navigation',()=>{
    const plain='Факты\n\nДругие публикации\nДругой сюжет\n\nПервоисточники\nДокумент';
    const value=message(`Факты\n\n<b>Другие публикации</b>\n<a href="${source.url}">Другой сюжет</a>\n\n<b>Первоисточники</b>\n<a href="https://source.example/doc">Документ</a>`,plain,[
      { offset:'Факты\n\nДругие публикации\n'.length,length:'Другой сюжет'.length,url:source.url },
      { offset:plain.indexOf('Документ'),length:'Документ'.length,url:'https://source.example/doc' },
    ]);
    expect(stripNavigationTail([value],[source])).toEqual([value]);
  });
  it('removes diamond-prefixed navigation across a message boundary without removing factual list items',()=>{
    const first=message('Факты\n🔸 Исходный пункт\n\n<b>Другие публикации</b>\n🔸',
      'Факты\n🔸 Исходный пункт\n\nДругие публикации\n🔸');
    const second=message(` <a href="${source.url}">#20 · Другой сюжет</a>`,' #20 · Другой сюжет',
      [{offset:1,length:'#20 · Другой сюжет'.length,url:source.url}]);
    const stripped=stripNavigationTail([first,second],[source]);
    expect(stripped.map(part=>part.plainText)).toEqual(['Факты\n🔸 Исходный пункт','']);
    const factual=message(second.text+'\n🔸 Ещё один факт',second.plainText+'\n🔸 Ещё один факт',second.links);
    expect(stripNavigationTail([first,factual],[source])).toEqual([first,factual]);
  });
  it('does not treat a literal unformatted body paragraph as navigation',()=>{
    const value=message('Факты\n\nСвязанные новости\nЦитата','Факты\n\nСвязанные новости\nЦитата');
    expect(stripNavigationTail([value],[source])).toEqual([value]);
  });
});
