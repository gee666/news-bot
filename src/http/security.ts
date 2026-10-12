import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from 'express';

export interface BrowserSecurity {
  token: string;
  guard: RequestHandler;
}

/** The UI has no user login. Only loopback hosts or an explicit operator allowlist are accepted. */
export function browserSecurity(allowedHosts: readonly string[] = []): BrowserSecurity {
  const token = randomBytes(32).toString('hex');
  const local = new Set(['localhost', '127.0.0.1', '[::1]']);
  const allowlist = new Set(allowedHosts.map(host => host.toLowerCase()));
  const guard: RequestHandler = (req, res, next) => {
    res.set({
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    });
    const host = req.headers.host;
    let url: URL;
    try {
      if (!host || /[\s,@/\\#?]/u.test(host)) throw new Error();
      url = new URL(`${req.protocol}://${host}`);
      if (url.host !== host.toLowerCase()) throw new Error();
    } catch { res.status(403).json({ error: 'Host is not allowed.' }); return; }
    if (!(allowlist.size ? allowlist.has(url.host) : local.has(url.hostname))) {
      res.status(403).json({ error: 'Host is not allowed.' }); return;
    }
    const origin = req.headers.origin;
    const crossSiteApi = req.path.startsWith('/api/') && req.headers['sec-fetch-site'] === 'cross-site';
    if ((origin !== undefined && origin !== url.origin) || crossSiteApi) {
      res.status(403).json({ error: 'Cross-origin requests are not allowed.' }); return;
    }
    if (!['GET', 'HEAD'].includes(req.method)) {
      const supplied = req.headers['x-csrf-token'];
      if (origin !== url.origin || typeof supplied !== 'string' || !/^[a-f0-9]{64}$/u.test(supplied) ||
          !timingSafeEqual(Buffer.from(supplied), Buffer.from(token))) {
        res.status(403).json({ error: 'Reload this page before making changes.' }); return;
      }
    }
    next();
  };
  return { token, guard };
}
