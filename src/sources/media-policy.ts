/** Obvious page furniture is never an article attachment, including in stored descriptors. */
export function decorativeImage(...values: Array<string | null | undefined>): boolean {
  return values.some(value => {
    if (!value) return false;
    let decoded = value;
    try { decoded = decodeURIComponent(value); } catch { /* Keep malformed text for matching. */ }
    const tokens = decoded.replace(/([a-z])([A-Z])/gu, '$1 $2');
    return /(?:^|[^\p{L}\p{N}])(?:avatars?|icons?|logos?|logomark|wordmark|favicon|emoji|tracking|pixel|headshot)(?:[^\p{L}\p{N}]|$)/iu.test(tokens)
      || /(?:author|profile|site|publisher|brand)[\s_-]+(?:photo|portrait|badge|branding|image)(?:[^\p{L}\p{N}]|$)/iu.test(tokens);
  });
}
