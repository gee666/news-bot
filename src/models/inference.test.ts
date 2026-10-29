import { describe, expect, it } from "vitest";
import { failureMetadata, ModelRequestError, RequestFault, retryTime, classifyProviderError, faultFromError, providerRetryTime } from "./errors.js";
import { infer, InferenceLimiter, type FailureRecorder } from "./inference.js";

describe("inference reliability", () => {
  it("shares one gate and excludes local waiting from dispatch duration", async () => {
    const record: FailureRecorder = async () => {};
    let active = 0;
    let maximum = 0;
    const execute = () => infer("jev", 1000, { operationId: "test" }, record, async () => {
      active++;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      return true;
    });
    await Promise.all([execute(), execute(), execute()]);
    expect(maximum).toBe(1);
  });

  it("removes cancelled waiting requests without releasing someone else's slot", async () => {
    const gate = new InferenceLimiter();
    const release = await gate.acquire();
    const controller = new AbortController();
    const waiting = gate.acquire(controller.signal);
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ kind: "cancelled" });
    let acquired = false;
    const next = gate.acquire().then((finish) => { acquired = true; finish(); });
    await Promise.resolve();
    expect(acquired).toBe(false);
    release();
    release();
    await next;
    const finish = await gate.acquire();
    finish();
  });

  it("persists timeout metadata before throwing, with delayed unknown-outcome retry", async () => {
    const recorded: string[] = [];
    await expect(infer("embedding", 10, { operationId: "stage-9" }, async (failure) => {
      recorded.push(failure.kind);
      expect(failure.outcome).toBe("unknown");
      expect(Date.parse(failure.nextRetryAt ?? "") - Date.parse(failure.failedAt)).toBeGreaterThanOrEqual(300_000);
    }, async ({ signal }) => new Promise((_, reject) => {
      signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }))).rejects.toBeInstanceOf(ModelRequestError);
    expect(recorded).toEqual(["timeout"]);
  });

  it("does not time out while locally waiting", async () => {
    let unblock: () => void = () => {};
    const held = new Promise<void>((resolve) => { unblock = resolve; });
    const first = infer("jev", 1000, { operationId: "held" }, async () => {}, async () => held);
    await Promise.resolve();
    const second = infer("embedding", 10, { operationId: "queued" }, async () => {}, async () => 7);
    await new Promise((resolve) => setTimeout(resolve, 30));
    unblock();
    await first;
    expect(await second).toBe(7);
  });

  it("respects provider retry time and stops repeated transport failures", () => {
    const now = Date.now();
    expect(retryTime(new Headers({ "Retry-After": "120" }), now)).toBe(now + 120_000);
    expect(providerRetryTime("You have hit your ChatGPT usage limit. Try again in ~120 min.", now))
      .toBe(now + 121 * 60_000);
    expect(retryTime(new Headers({ "x-ratelimit-reset-requests": "2m3s" }), now)).toBe(now + 123_000);
    const fault = new RequestFault("throttled", { status: 429, retryAt: now + 3_600_000 });
    expect(failureMetadata(fault, "stage", "pi", 1, 10, now).nextRetryAt)
      .toBe(new Date(now + 3_600_000).toISOString());
    expect(failureMetadata(new RequestFault("transient"), "stage", "jev", 5, 10).retryable).toBe(false);
    expect(failureMetadata(new RequestFault("authentication"), "stage", "pi", 1, 10).nextRetryAt).toBeNull();
  });

  it.each(["transient", "timeout"] as const)("uses configured attempts for %s failures", (kind) => {
    const now = Date.now();
    const fault = new RequestFault(kind);
    const fifth = failureMetadata(fault, "stage", "jev", 5, 10, now, 10);
    expect(fifth.retryable).toBe(true);
    expect(fifth.nextRetryAt).not.toBeNull();
    if (kind === "timeout") {
      expect(fifth.outcome).toBe("unknown");
      expect(Date.parse(fifth.nextRetryAt ?? "")).toBeGreaterThanOrEqual(now + 300_000);
    }
    expect(failureMetadata(fault, "stage", "jev", 9, 10, now, 10).retryable).toBe(true);
    expect(failureMetadata(fault, "stage", "jev", 10, 10, now, 10))
      .toMatchObject({ retryable: false, nextRetryAt: null });
    expect(failureMetadata(fault, "stage", "jev", 5, 10, now))
      .toMatchObject({ retryable: false, nextRetryAt: null });
  });

  it("caps throttling even with a configured single attempt", () => {
    expect(failureMetadata(new RequestFault("throttled"), "stage", "pi", 50, 10, Date.now(), 1))
      .toMatchObject({ retryable: false, nextRetryAt:null });
  });

  it("classifies corrective failures and never stores provider payloads", () => {
    expect(classifyProviderError("context_length_exceeded", 400)).toBe("context_limit");
    expect(classifyProviderError("model not supported", 400)).toBe("model_unavailable");
    expect(classifyProviderError("invalid_grant secret-token", 400)).toBe("authentication");
    expect(classifyProviderError("usage_limit_reached")).toBe("throttled");
    const cause = Object.assign(new Error("connect timed out"), { code: "UND_ERR_CONNECT_TIMEOUT" });
    expect(faultFromError(new Error("fetch failed", { cause }))).toMatchObject({
      kind: "transient", detail: { outcome: "not_submitted" },
    });
    expect(JSON.stringify(failureMetadata(new RequestFault("authentication"), "test", "pi", 1, 0)))
      .not.toContain("secret-token");
  });
});
