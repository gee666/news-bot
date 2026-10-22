export interface TelegramTimeouts { requestMs: number; uploadMs: number }

function timeout(name: string, fallback: number, maximum: number): number {
  const raw = process.env[name]?.trim();
  const value = raw === undefined ? fallback : /^\d+$/u.test(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(value) || value < 1_000 || value > maximum) {
    // Never echo environment values, which may contain accidentally pasted credentials.
    throw new Error(`${name.toLowerCase()}_invalid`);
  }
  return value;
}

/** Read and validate before recording an attempt; multipart uploads use uploadMs. */
export function telegramTimeouts(): TelegramTimeouts {
  return {
    requestMs: timeout('TELEGRAM_REQUEST_TIMEOUT_MS', 30_000, 300_000),
    uploadMs: timeout('TELEGRAM_UPLOAD_TIMEOUT_MS', 300_000, 900_000),
  };
}

function preconnectCause(error: unknown, depth = 0): boolean {
  if (!(error instanceof Error) || depth > 8 || error.cause !== undefined
    || error.name === 'AbortError' || error.name === 'TimeoutError') return false;
  const code = 'code' in error ? error.code : undefined;
  const syscall = 'syscall' in error ? error.syscall : undefined;
  if (error instanceof AggregateError) {
    // Node's multi-address connect can aggregate failures. Every address must have
    // failed before connection, not merely the first error or the aggregate code.
    if ((code !== undefined && code !== 'ECONNREFUSED' && code !== 'ENETUNREACH')
      || (syscall !== undefined && syscall !== 'connect')) return false;
    return Array.isArray(error.errors) && error.errors.length > 0 && error.errors.length <= 32
      && Array.from(error.errors).every((entry: unknown) => preconnectCause(entry, depth + 1));
  }
  if (code === 'UND_ERR_CONNECT_TIMEOUT') return error.name === 'ConnectTimeoutError' && syscall === undefined;
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return syscall === 'getaddrinfo';
  return (code === 'ECONNREFUSED' || code === 'ENETUNREACH') && syscall === 'connect';
}

/** Only recognize Node/undici fetch failures with evidence that no HTTP bytes were sent. */
export function isTelegramPreconnectFailure(error: unknown): boolean {
  return error instanceof TypeError && error.name === 'TypeError' && error.message === 'fetch failed'
    && preconnectCause(error.cause);
}
