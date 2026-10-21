import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { Agent, fetch } from 'undici';

export class ResearchFetchError extends Error {
  constructor(readonly code: 'blocked_url' | 'fetch_failed' | 'too_large' | 'unsupported_content') {
    super(code);
    this.name = 'ResearchFetchError';
  }
}

const blockedV4 = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.168.0.0', 16], ['192.88.99.0', 24], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 3],
] satisfies [string, number][]) blockedV4.addSubnet(address, prefix, 'ipv4');
const globalV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');
const blockedV6 = new BlockList();
for (const [address, prefix] of [
  ['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20],
] satisfies [string, number][]) blockedV6.addSubnet(address, prefix, 'ipv6');

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !blockedV4.check(address, 'ipv4');
  return family === 6 && globalV6.check(address, 'ipv6') && !blockedV6.check(address, 'ipv6');
}

export function publicUrl(input: string): URL {
  let url: URL;
  try { url = new URL(input); } catch { throw new ResearchFetchError('blocked_url'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
    || (url.port && url.port !== '80' && url.port !== '443') || url.href.length > 4096) {
    throw new ResearchFetchError('blocked_url');
  }
  const host = url.hostname.replace(/^\[|\]$/gu, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')
    || host.endsWith('.internal') || host.endsWith('.home.arpa')
    || (isIP(host) && !isPublicAddress(host))) throw new ResearchFetchError('blocked_url');
  url.hash = '';
  return url;
}

export interface FetchLimits { timeoutMs: number; maxBytes: number; maxRedirects: number; allowXml?: boolean }
export interface FetchedBinary { url: string; status: number; contentType: string; data: Buffer }
export interface FetchedResponse { url: string; status: number; contentType: string; text: string }
export type AddressResolver = (host: string) => Promise<{ address: string; family: number }[]>;

const resolveAddresses: AddressResolver = host => lookup(host, { all: true, verbatim: true });

export async function resolvePublicAddress(host: string, resolve: AddressResolver = resolveAddresses):
Promise<{ address: string; family: 4 | 6 }> {
  const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await resolve(host);
  // Reject mixed public/private DNS rather than letting address selection decide safety.
  if (!addresses.length || addresses.some(entry => !isPublicAddress(entry.address))) {
    throw new ResearchFetchError('blocked_url');
  }
  const first = addresses[0];
  if (!first || (first.family !== 4 && first.family !== 6)) throw new ResearchFetchError('blocked_url');
  return { address: first.address, family: first.family };
}

export function envInteger(name: string, fallback: number, maximum: number): number {
  const value = process.env[name] === undefined ? fallback : Number(process.env[name]);
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`Invalid ${name}`);
  }
  return value;
}

export function fetchLimits(): FetchLimits {
  return {
    timeoutMs: envInteger('RESEARCH_FETCH_TIMEOUT_MS', 15_000, 120_000),
    maxBytes: envInteger('RESEARCH_FETCH_MAX_BYTES', 1_000_000, 5_000_000),
    maxRedirects: 3,
  };
}

async function beforeDeadline<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new ResearchFetchError('fetch_failed'));
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/** Resolve once per hop and pin the validated address while preserving Host and TLS SNI. */
async function fetchContent(input: string, limits: FetchLimits,
  headers: Record<string, string>, media: boolean): Promise<FetchedBinary> {
  const signal = AbortSignal.timeout(limits.timeoutMs);
  let url = publicUrl(input);
  try {
    for (let hop = 0; hop <= limits.maxRedirects; hop++) {
      const host = url.hostname.replace(/^\[|\]$/gu, '');
      const pinned = await beforeDeadline(resolvePublicAddress(host), signal);
      const dispatcher = new Agent({ connect: { timeout: Math.min(10_000, limits.timeoutMs),
        lookup: (_hostname, options, callback) => {
          if (options.all) callback(null, [pinned]);
          else callback(null, pinned.address, pinned.family);
        } }, headersTimeout: limits.timeoutMs, bodyTimeout: limits.timeoutMs });
      try {
        const response = await fetch(url, { dispatcher, redirect: 'manual', signal,
          headers: { 'User-Agent': 'personal-news-bot/1.0', Accept: 'text/html,text/plain,application/json', ...headers } });
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          await response.body?.cancel();
          const location = response.headers.get('location');
          if (!location || hop === limits.maxRedirects || Object.keys(headers).length) {
            throw new ResearchFetchError('blocked_url');
          }
          url = publicUrl(new URL(location, url).href);
          continue;
        }
        const contentType = (response.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
        const allowed = media ? /^(image\/(jpeg|png|webp|gif)|video\/(mp4|webm|quicktime))$/u.test(contentType) : ['text/html', 'application/xhtml+xml', 'text/plain', 'application/json'].includes(contentType)
          || (limits.allowXml && ['application/rss+xml', 'application/atom+xml', 'application/xml', 'text/xml'].includes(contentType));
        if (!allowed) {
          await response.body?.cancel();
          throw new ResearchFetchError('unsupported_content');
        }
        const declaredLength = Number(response.headers.get('content-length') ?? 0);
        if (declaredLength > limits.maxBytes) {
          await response.body?.cancel();
          throw new ResearchFetchError('too_large');
        }
        const chunks: Uint8Array[] = [];
        let bytes = 0;
        if (response.body) {
          const reader = response.body.getReader();
          try {
            for (;;) {
              const next = await reader.read();
              if (next.done) break;
              bytes += next.value.byteLength;
              if (bytes > limits.maxBytes) throw new ResearchFetchError('too_large');
              chunks.push(next.value);
            }
          } finally { await reader.cancel(); reader.releaseLock(); }
        }
        return { url: url.href, status: response.status, contentType,
          data: Buffer.concat(chunks) };
      } finally { await dispatcher.destroy(); }
    }
    throw new ResearchFetchError('blocked_url');
  } catch (error) {
    if (error instanceof ResearchFetchError) throw error;
    throw new ResearchFetchError('fetch_failed');
  }
}

export async function fetchPublic(input: string, limits: FetchLimits = fetchLimits(),
  headers: Record<string, string> = {}): Promise<FetchedResponse> {
  const { data, ...response } = await fetchContent(input, limits, headers, false);
  return { ...response, text: data.toString('utf8') };
}

/** Binary media uses the same pinned DNS, redirect and streaming size checks as research. */
export function fetchPublicMedia(input: string, maxBytes: number): Promise<FetchedBinary> {
  return fetchContent(input, { timeoutMs: 60_000, maxBytes, maxRedirects: 3 }, {}, true);
}
