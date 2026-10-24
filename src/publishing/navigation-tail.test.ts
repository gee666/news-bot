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
  it('does not treat a literal unformatted body paragraph as navigation',()=>{
    const value=message('Факты\n\nСвязанные новости\nЦитата','Факты\n\nСвязанные новости\nЦитата');
    expect(stripNavigationTail([value],[source])).toEqual([value]);
  });
});
