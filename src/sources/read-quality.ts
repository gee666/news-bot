import { z } from 'zod';

const readMetadata = z.object({ status:z.number().int().optional(),error:z.string().nullable().optional() }).passthrough();

/** Access screens and load errors are diagnostics, even with HTTP 200. */
export function readFailure(title: string | null, content: string, url: string, metadata?: unknown): 'restricted' | 'unavailable' | null {
  if (metadata !== undefined) {
    const parsed = readMetadata.safeParse(metadata);
    if (!parsed.success || parsed.data.error?.trim() || parsed.data.status !== undefined && (parsed.data.status<200 || parsed.data.status>=400)) return 'unavailable';
  }
  const heading = (title ?? '').trim();
  let path = '';
  try {
    const address = new URL(url);
    if (!['http:', 'https:'].includes(address.protocol)) return 'unavailable';
    path = address.pathname;
  } catch { return 'unavailable'; }
  if (/^\/(?:login|signin|sign-in|auth\/login)(?:\/|$)/iu.test(path)
    || /^(?:sign in(?: to [\w .-]+)?|log in|login|just a moment|attention required|access denied|security check|verify (?:you are human|your identity))(?:[.!…]*|\s*[|·].*)$/iu.test(heading)
    || /^(?:\s*#+\s*)?(?:verify (?:that )?you (?:are|re) (?:a )?human|checking your browser|performing security verification)/iu.test(content.trim())
    || (content.length < 1500 && /^(?:\s*#+\s*)?(?:sign in|log in|login)\b[^.!?\n]{0,80}\b(?:continue|view|access)\b/iu.test(content.trim()))
    || (content.length < 1500 && /enable javascript and cookies to continue/iu.test(content))) return 'restricted';
  const error = /^(?:this (?:page|site) (?:couldn.t|cannot|could not) (?:load|be reached)|page not found|not found|404(?:\b|\s)|application error|internal server error|service unavailable|something went wrong)/iu;
  if (error.test(heading) || error.test(content.replace(/^\s*#+\s*/u, '').trim())) return 'unavailable';
  return null;
}

/** Only content-derived titles, never link anchors or service errors. */
export function usefulSourceTitle(title: string | null, content: string, url: string): string | null {
  const candidate = title?.replace(/\s+/gu, ' ').trim();
  if (candidate && !readFailure(candidate, '', url)) return candidate.slice(0, 500);
  const heading = /^\s*#{1,3}\s+(.+)$/mu.exec(content)?.[1]?.replace(/\[([^\]]+)\]\([^)]*\)/gu, '$1').trim();
  if (heading && !readFailure(heading, '', url)) return heading.slice(0, 500);
  const paragraph = content.split(/\n\s*\n/u).find(line => line.trim() && !/^\s*[![]/u.test(line));
  const text = paragraph?.replace(/[#*_`]/gu, '').replace(/\s+/gu, ' ').trim();
  return text && !readFailure(text, '', url) ? text.slice(0, 180) : null;
}
