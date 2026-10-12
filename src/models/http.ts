import { Agent, fetch } from "undici";
import { classifyProviderError, RequestFault, retryTime } from "./errors.js";
import { providerDiagnostics } from './provider-diagnostics.js';
import type { Dispatch } from "./inference.js";

export interface HttpConfig {
  baseUrl: string;
  timeoutMs: number;
  connectTimeoutMs?: number;
}

export function endpoint(baseUrl: string, path: string): string {
  const url = new URL(baseUrl);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("Model endpoint must be an HTTP URL without credentials, query or fragment");
  }
  return baseUrl.replace(/\/$/, "") + path;
}

export class ModelHttp {
  private readonly dispatcher: Agent;
  constructor(private readonly config: HttpConfig) {
    this.dispatcher = new Agent({ connect: { timeout: config.connectTimeoutMs ?? 10_000 },
      headersTimeout: config.timeoutMs, bodyTimeout: config.timeoutMs });
  }

  /** Capability reads do not dispatch inference or contribute model-call usage. */
  async metadata(path: string, signal: AbortSignal): Promise<unknown> {
    const response = await fetch(endpoint(this.config.baseUrl, path), { method: 'GET',
      dispatcher: this.dispatcher, signal, redirect: 'error' });
    let value: unknown;
    try { value = await response.json(); } catch { throw new RequestFault('invalid_request', { outcome: 'not_submitted' }); }
    if (!response.ok) {
      const { message, code } = errorDetails(value);
      throw new RequestFault(classifyProviderError(message, response.status, code), { status: response.status, outcome: 'not_submitted' });
    }
    return value;
  }

  async post(path: string, body: unknown, headers: Record<string, string>, dispatch: Dispatch):
    Promise<{ value: unknown; headers: Headers; durationMs: number }> {
    const url = endpoint(this.config.baseUrl, path);
    const serialized = JSON.stringify(body);
    dispatch.signal.throwIfAborted();
    dispatch.submitted();
    const response = await fetch(url, {
      method: "POST", headers: { "Content-Type": "application/json", ...headers },
      body: serialized, dispatcher: this.dispatcher, signal: dispatch.signal,
      redirect: "error",
    });
    const responseHeaders = new Headers([...response.headers.entries()]);
    const requestId = responseHeaders.get("x-typesafe-request-id") ?? undefined;
    const retryAt = retryTime(responseHeaders);
    let value: unknown;
    try { value = await response.json(); } catch {
      throw new RequestFault(response.ok ? "invalid_output" : classifyProviderError("", response.status),
        { status: response.status, ...(requestId ? { requestId } : {}),
          ...(retryAt === undefined ? {} : { retryAt }),
          outcome: response.ok || response.status >= 500 ? "unknown" : "rejected" });
    }
    if (!response.ok) {
      const { message, code } = errorDetails(value);
      const kind = classifyProviderError(message, response.status, code);
      const { providerContextLimit, ...diagnostics } = providerDiagnostics(message, code);
      throw new RequestFault(kind, { status: response.status, ...diagnostics,
        ...(kind === 'context_limit' && providerContextLimit ? { providerContextLimit } : {}),
        ...(requestId ? { requestId } : {}), ...(retryAt === undefined ? {} : { retryAt }),
        outcome: kind === "timeout" || response.status >= 500 ? "unknown" : "rejected" });
    }
    dispatch.completed();
    return { value, headers: responseHeaders, durationMs: Date.now() - dispatch.startedAt };
  }

  close(): Promise<void> { return this.dispatcher.close(); }
}

function errorDetails(value: unknown): { message: string; code?: string } {
  if (typeof value !== 'object' || value === null) return { message: '' };
  const error: unknown = Reflect.get(value, 'error') ?? Reflect.get(value, 'detail');
  if (typeof error === 'string') return { message: error.slice(0, 4096) };
  if (typeof error !== 'object' || error === null) return { message: '' };
  const message: unknown = Reflect.get(error, 'message');
  const code: unknown = Reflect.get(error, 'code');
  const type: unknown = Reflect.get(error, 'type');
  return { message: typeof message === 'string' ? message.slice(0, 4096) : '',
    ...(typeof code === 'string' ? { code } : typeof type === 'string' ? { code: type } : {}) };
}

export function numericHeader(headers: Headers, name: string): number | undefined {
  const value = headers.get(name);
  if (value === null || value.trim() === "") return undefined;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}
