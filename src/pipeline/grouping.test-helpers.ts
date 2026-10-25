import { expect } from 'vitest';
import type { RenderedMessage } from '../publishing/render.js';

/** Check both the visible marker and its actual destination, not a raw URL label. */
export function expectFollowupMarker(message: RenderedMessage | undefined, targetId?: string): void {
  const visibleId = /^UPD:\n🔸 #(\d+) · Новости разработки\n\n/u.exec(message?.plainText ?? '')?.[1];
  expect(visibleId).toMatch(/^\d+$/u);
  if (targetId !== undefined) expect(visibleId).toBe(targetId);
  const url = `https://t.me/c/123/${visibleId}`;
  const html = `UPD:\n🔸 <a href="${url}">#${visibleId} · Новости разработки</a>\n\n`;
  expect(message?.text.slice(0, html.length)).toBe(html);
  expect(message?.links[0]?.url).toBe(url);
}
