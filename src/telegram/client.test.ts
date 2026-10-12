import type { UserAuthParams } from "telegram/client/auth.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Logger } from "telegram/extensions/Logger.js";

const mocks = vi.hoisted(() => ({
  start: vi.fn<(params: UserAuthParams) => Promise<void>>(),
  connect: vi.fn<() => Promise<void>>(),
  destroy: vi.fn<() => Promise<void>>(),
  authorized: vi.fn<() => Promise<boolean>>(),
  getMe: vi.fn<() => Promise<{ bot: boolean }>>(),
  prepare: vi.fn<() => Promise<void>>(),
  read: vi.fn<() => Promise<string | undefined>>(),
  write: vi.fn<(name: string, value: string) => Promise<void>>(),
  options: vi.fn<(options: unknown) => void>(),
}));
vi.mock("telegram", () => ({
  TelegramClient: class {
    start = mocks.start;
    connect = mocks.connect;
    destroy = mocks.destroy;
    checkAuthorization = mocks.authorized;
    getMe = mocks.getMe;
    constructor(_session: unknown, _id: unknown, _hash: unknown, options: unknown) { mocks.options(options); }
  },
}));
vi.mock("telegram/sessions/index.js", () => ({
  StringSession: class { save() { return "synthetic-session"; } },
}));
vi.mock("./session.js", () => ({
  SessionFiles: class {
    prepare = mocks.prepare;
    read = mocks.read;
    write = mocks.write;
    async apiCredentials() { return { apiId: 1234, apiHash: "a".repeat(32) }; }
  },
}));

import { login, withUserClient } from "./client.js";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.read.mockResolvedValue("synthetic-session");
  mocks.authorized.mockResolvedValue(true);
  mocks.getMe.mockResolvedValue({ bot: false });
  mocks.start.mockResolvedValue();
  mocks.destroy.mockResolvedValue();
  vi.stubEnv("TELEGRAM_PHONE", undefined);
});

afterEach(() => { vi.unstubAllEnvs(); });

describe("user-account login", () => {
  it("uses hidden prompts, never displays password hints, and saves only the authorized session", async () => {
    const prompt = vi.fn<(label: string) => Promise<string>>()
      .mockResolvedValueOnce("+15555555555").mockResolvedValueOnce("12345").mockResolvedValueOnce("synthetic-password");
    mocks.start.mockImplementation(async params => {
      if (typeof params.phoneNumber !== "function") throw new Error("Phone prompt missing");
      expect(await params.phoneNumber()).toBe("+15555555555");
      expect(await params.phoneCode()).toBe("12345");
      expect(await params.password?.("private password hint")).toBe("synthetic-password");
    });
    await login(prompt);
    expect(prompt.mock.calls.flat().join(" ")).not.toContain("private password hint");
    expect(mocks.write).toHaveBeenCalledExactlyOnceWith("session.txt", "synthetic-session");
    expect(mocks.destroy).toHaveBeenCalledOnce();
    const options = mocks.options.mock.calls[0]?.[0];
    if (typeof options !== "object" || options === null || !("baseLogger" in options) || !(options.baseLogger instanceof Logger)) {
      throw new Error("Expected library logging configuration");
    }
    expect(options.baseLogger.logLevel).toBe("none");
  });

  it("destroys the client and does not save a session after auth failure", async () => {
    mocks.start.mockImplementation(async params => {
      await params.onError(new Error("arbitrary secret in upstream error"));
    });
    await expect(login(vi.fn().mockResolvedValue(""))).rejects.toThrow("Telegram login failed");
    expect(mocks.write).not.toHaveBeenCalled();
    expect(mocks.destroy).toHaveBeenCalledOnce();
  });

  it("refuses automatic account registration", async () => {
    mocks.start.mockImplementation(async params => { await params.firstAndLastNames?.(); });
    await expect(login(vi.fn().mockResolvedValue(""))).rejects.toThrow("registration is disabled");
    expect(mocks.write).not.toHaveBeenCalled();
  });

  it("rejects a bot account and always closes it", async () => {
    mocks.getMe.mockResolvedValue({ bot: true });
    await expect(login(vi.fn().mockResolvedValue(""))).rejects.toThrow("user account");
    expect(mocks.write).not.toHaveBeenCalled();
    expect(mocks.destroy).toHaveBeenCalledOnce();
  });
});

describe("non-interactive session reuse", () => {
  it("never starts auth and closes the client on callback failure", async () => {
    await expect(withUserClient(async () => { throw new Error("Synthetic callback failure"); })).rejects.toThrow("callback");
    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.connect).toHaveBeenCalledOnce();
    expect(mocks.destroy).toHaveBeenCalledOnce();
  });

  it("refuses an unauthorized persisted session without requesting a code", async () => {
    mocks.authorized.mockResolvedValue(false);
    const run = vi.fn<() => Promise<void>>();
    await expect(withUserClient(run)).rejects.toThrow("not authorized");
    expect(run).not.toHaveBeenCalled();
    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.destroy).toHaveBeenCalledOnce();
  });
});
