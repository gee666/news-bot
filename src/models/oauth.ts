import { randomUUID } from "node:crypto";
import type { AuthInteraction, AuthPrompt } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { CODEX_PROVIDER } from "./pi-runtime.js";

export type LoginPhase = "starting" | "awaiting_redirect" | "exchanging" | "complete" | "failed" | "cancelled";
export interface OAuthStatus {
  provider: "openai-codex";
  connected: boolean;
  login: {
    id: string;
    phase: LoginPhase;
    authorizationUrl?: string;
    expiresAt: string;
    message?: string;
  } | null;
}
interface LoginAttempt {
  id: string;
  phase: LoginPhase;
  expiresAt: string;
  url?: string;
  message?: string;
  controller: AbortController;
  timer: ReturnType<typeof setTimeout>;
  input?: (url: string) => void;
  ready: () => void;
  done: Promise<void>;
}
type OAuthRuntime = Pick<ModelRuntime, "login" | "listCredentials">;

/** UI callbacks only. Pi owns PKCE, state validation, token exchange, persistence and refresh. */
export class PiOAuth {
  private current: LoginAttempt | undefined;
  constructor(private readonly runtime: OAuthRuntime, private readonly loginTimeoutMs = 900_000) {}

  async status(): Promise<OAuthStatus> {
    let connected: boolean;
    try {
      const credentials = await this.runtime.listCredentials();
      connected = credentials.some((info) => info.providerId === CODEX_PROVIDER && info.type === "oauth");
    } catch { throw new Error("Could not read application Pi login status"); }
    const attempt = this.current;
    return {
      provider: CODEX_PROVIDER,
      connected,
      login: attempt ? { id: attempt.id, phase: attempt.phase, expiresAt: attempt.expiresAt,
        ...(attempt.url ? { authorizationUrl: attempt.url } : {}),
        ...(attempt.message ? { message: attempt.message } : {}) } : null,
    };
  }

  async start(): Promise<OAuthStatus> {
    if (this.current && isActive(this.current.phase)) return this.status();
    let ready: () => void = () => {};
    const started = new Promise<void>((resolve) => { ready = resolve; });
    const controller = new AbortController();
    const attempt: LoginAttempt = {
      id: randomUUID(), phase: "starting",
      expiresAt: new Date(Date.now() + this.loginTimeoutMs).toISOString(),
      controller, ready, done: Promise.resolve(),
      timer: setTimeout(() => controller.abort(), this.loginTimeoutMs),
    };
    this.current = attempt;
    const interaction: AuthInteraction = {
      signal: controller.signal,
      notify: (event) => {
        if (event.type === "auth_url") {
          attempt.url = event.url;
          attempt.phase = "awaiting_redirect";
          ready();
        }
        // Do not forward provider progress/info, which may contain sensitive payloads.
      },
      prompt: (prompt) => this.prompt(attempt, prompt),
    };
    attempt.done = this.runtime.login(CODEX_PROVIDER, "oauth", interaction)
      .then(() => { attempt.phase = "complete"; delete attempt.url; })
      .catch(() => {
        attempt.phase = controller.signal.aborted ? "cancelled" : "failed";
        attempt.message = controller.signal.aborted ? "Login cancelled or expired."
          : "Login failed. Start again and paste the complete redirect URL.";
        delete attempt.url;
      }).finally(() => {
        clearTimeout(attempt.timer);
        delete attempt.input;
        ready();
      });
    await started;
    return this.status();
  }

  /** Only complete URLs are accepted, so Pi's optional-state manual path cannot bypass checks. */
  async finish(id: string, redirectUrl: string): Promise<OAuthStatus> {
    const attempt = this.current;
    if (!attempt || attempt.id !== id || attempt.phase !== "awaiting_redirect" || !attempt.input) {
      throw new Error("No active Pi login is awaiting this redirect");
    }
    let url: URL;
    try { url = new URL(redirectUrl); } catch { throw new Error("Paste the complete Pi redirect URL"); }
    if (url.origin !== "http://localhost:1455" || url.pathname !== "/auth/callback"
      || !url.searchParams.get("code") || !url.searchParams.get("state") || url.username || url.password) {
      throw new Error("Paste the complete Pi redirect URL with code and state");
    }
    const submit = attempt.input;
    delete attempt.input;
    attempt.phase = "exchanging";
    submit(redirectUrl);
    // Token exchange continues in Pi. The UI polls status without holding this request open.
    return this.status();
  }

  async cancel(id?: string): Promise<void> {
    const attempt = this.current;
    if (attempt && (!id || id === attempt.id) && isActive(attempt.phase)) {
      attempt.controller.abort();
      await attempt.done;
    }
  }

  private prompt(attempt: LoginAttempt, prompt: AuthPrompt): Promise<string> {
    if (prompt.type === "select") return Promise.resolve("browser");
    if (prompt.type !== "manual_code") return Promise.reject(new Error("Unsupported login prompt"));
    const signal = prompt.signal ? AbortSignal.any([prompt.signal, attempt.controller.signal])
      : attempt.controller.signal;
    return new Promise((resolve, reject) => {
      const abort = () => {
        delete attempt.input;
        reject(new Error("Login cancelled"));
      };
      if (signal.aborted) { abort(); return; }
      signal.addEventListener("abort", abort, { once: true });
      attempt.input = (url) => {
        signal.removeEventListener("abort", abort);
        resolve(url);
      };
    });
  }
}

function isActive(phase: LoginPhase): boolean {
  return phase === "starting" || phase === "awaiting_redirect" || phase === "exchanging";
}
