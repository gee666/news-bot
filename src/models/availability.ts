import { RequestFault, type FailureKind } from './errors.js';

/** One probe per endpoint/model after cooldown, serialized by the inference gate. */
export class ModelAvailability {
  private readonly failures = new Map<string, { count: number; until: number; kind: FailureKind }>();

  check(key: string, now = Date.now()): void {
    const saved = this.failures.get(key);
    if (saved && saved.until > now) {
      throw new RequestFault(saved.kind, { outcome: 'not_submitted', retryAt: saved.until });
    }
  }

  failed(key: string, kind: FailureKind, retryAt?: number, now = Date.now()): number {
    const count = (this.failures.get(key)?.count ?? 0) + 1;
    const delay = kind === 'timeout' ? 300_000 : Math.min(300_000, 5000 * 2 ** Math.min(count - 1, 6));
    const until = Math.max(now + delay, retryAt ?? 0);
    this.failures.set(key, { count, until, kind });
    return until;
  }

  succeeded(key: string): void { this.failures.delete(key); }
}

export const modelAvailability = new ModelAvailability();
