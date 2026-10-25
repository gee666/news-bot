import type { MediaDescriptor } from './download.js';

/** Only collapse a WordPress rendition when this source also supplies its original. */
export function distinctSourceMedia(descriptors: readonly MediaDescriptor[]): MediaDescriptor[] {
  const images = new Set(descriptors.flatMap(descriptor => {
    const url = descriptor.type === 'image' ? imageUrl(descriptor.url) : null;
    return url ? [url.href] : [];
  }));
  return descriptors.filter(descriptor => {
    if (descriptor.type !== 'image') return true;
    const url = imageUrl(descriptor.url);
    if (!url) return true;
    // WordPress generated sizes share the original's upload directory and extension.
    // Do not infer identity for arbitrary filenames, query transforms or other hosts.
    const rendition = /^(\/wp-content\/uploads\/\d{4}\/(?:0[1-9]|1[0-2])\/[^/]+)-[1-9]\d*x[1-9]\d*(\.(?:jpe?g|png|webp|avif))$/iu.exec(url.pathname);
    if (!rendition) return true;
    url.pathname = `${rendition[1]}${rendition[2]}`;
    return !images.has(url.href);
  });
}

function imageUrl(value: string | undefined): URL | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url : null;
  } catch { return null; }
}
