import { envInteger } from '../pipeline/research-fetch.js';

export function mediaDeadlineMs(): number {
  return envInteger('MEDIA_PREPARATION_TIMEOUT_MS', 120_000, 2_147_483_647);
}

/** Settle even uncooperative adapters. Callers must also pass the signal to I/O
 * and check it before starting another operation or committing a cache entry. */
export function abortable<T>(signal: AbortSignal | undefined, work: () => Promise<T>): Promise<T> {
  if (!signal) return work();
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason); };
    signal.addEventListener('abort', abort, { once: true });
    const finish = () => signal.removeEventListener('abort', abort);
    try {
      work().then(value => {
        finish();
        if (signal.aborted) reject(signal.reason);
        else resolve(value);
      }, error => { finish(); reject(error); });
    } catch (error) { finish(); reject(error); }
  });
}

export class MediaDeadline {
  private readonly controller = new AbortController();
  private readonly timer: ReturnType<typeof setTimeout>;
  readonly signal = this.controller.signal;

  constructor(timeoutMs = mediaDeadlineMs()) {
    this.timer = setTimeout(() => this.controller.abort(new DOMException('Media preparation deadline expired', 'TimeoutError')), timeoutMs);
  }

  run<T>(work: () => Promise<T>): Promise<T> { return abortable(this.signal, work); }
  abort(): void { this.controller.abort(new DOMException('Media preparation cancelled', 'AbortError')); }
  dispose(): void { clearTimeout(this.timer); }
}
