/** Markdown table conversion flattens blocks inside cells; keep their text boundaries. */
export function separateTableBlocks(document: Document): void {
  for (const cell of document.querySelectorAll('td,th')) {
    for (const block of cell.querySelectorAll('div,p,ul,ol,blockquote,h1,h2,h3,h4,h5,h6')) {
      const inline = document.createElement('span');
      for (const attribute of block.attributes) inline.setAttribute(attribute.name, attribute.value);
      inline.append(document.createTextNode(' '), ...block.childNodes, document.createTextNode(' '));
      block.replaceWith(inline);
    }
  }
}

/** Animated marquees clone the same rendered rows. Do not let those copies dominate article selection. */
export function removeAnimatedCopies(document: Document): void {
  for (const container of document.querySelectorAll('[style]')) {
    const style = container.getAttribute('style') ?? '';
    if (!/(?:will-change\s*:\s*transform|animation\s*:|transition\s*:\s*transform)/iu.test(style)) continue;
    const children = [...container.children];
    if (children.length < 10) continue;
    const counts = new Map<string, number>();
    for (const child of children) {
      if ((child.textContent?.trim().length ?? 0) < 40) continue;
      counts.set(child.outerHTML, (counts.get(child.outerHTML) ?? 0) + 1);
    }
    const repeated = new Set([...counts].filter(([, count]) => count >= 3).map(([html]) => html));
    const kept = new Set<string>();
    for (const child of children) {
      const html = child.outerHTML;
      if (!repeated.has(html)) continue;
      if (kept.has(html)) child.remove();
      else kept.add(html);
    }
  }
}
