const redditHosts = new Set(['reddit.com', 'www.reddit.com', 'old.reddit.com', 'new.reddit.com', 'm.reddit.com']);
const ephemeralRedditParameters = new Set(['solution', 'js_challenge', 'jsc_token', 'jsc_orig_r',
  'share_id', 'share', 'ref', 'ref_source', 'rdt']);

/** Reddit challenge/session URLs are not portable citations. Keep the post/comment path and meaningful options. */
export function cleanSourceUrl(input: string): string {
  let url: URL;
  try { url = new URL(input); } catch { return input; }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
    || !redditHosts.has(url.hostname.toLowerCase()) || !/^\/(?:r\/[^/]+\/)?comments\/[a-z0-9]+(?:\/|$)/iu.test(url.pathname)) return input;
  let changed = false;
  for (const key of [...url.searchParams.keys()]) {
    if (ephemeralRedditParameters.has(key.toLowerCase()) || key.toLowerCase().startsWith('utm_')) {
      url.searchParams.delete(key); changed = true;
    }
  }
  return changed ? url.href : input;
}
