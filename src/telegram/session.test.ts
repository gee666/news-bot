import { chmod, mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionFiles } from "./session.js";

let directory: string;
beforeEach(async () => {
  await mkdir(resolve("tmp"), { recursive: true });
  directory = await mkdtemp(resolve("tmp/telegram-unit-"));
  vi.stubEnv("TELEGRAM_API_ID", undefined);
  vi.stubEnv("TELEGRAM_API_HASH", undefined);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

describe("protected session persistence with synthetic credentials", () => {
  it("protects the directory and files, including existing permissive paths", async () => {
    await chmod(directory, 0o755);
    const files = new SessionFiles(directory);
    await files.prepare();
    await files.write("session.txt", "synthetic-session-only");
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    expect((await stat(resolve(directory, "session.txt"))).mode & 0o777).toBe(0o600);
    expect(await files.read("session.txt")).toBe("synthetic-session-only");
  });

  it("prompts for credentials once and uses the protected saved credentials later", async () => {
    const files = new SessionFiles(directory);
    await files.prepare();
    const prompt = vi.fn().mockResolvedValueOnce("1234").mockResolvedValueOnce("a".repeat(32));
    const credentials = await files.apiCredentials(true, prompt);
    expect(credentials).toEqual({ apiId: 1234, apiHash: "a".repeat(32) });
    expect((await stat(resolve(directory, "api.json"))).mode & 0o777).toBe(0o600);
    expect(await files.apiCredentials(false)).toEqual(credentials);
    expect(prompt).toHaveBeenCalledTimes(2);
  });

  it("treats blank Compose credentials as missing and prompts only for missing values", async () => {
    const files = new SessionFiles(directory);
    vi.stubEnv("TELEGRAM_API_ID", "");
    vi.stubEnv("TELEGRAM_API_HASH", "");
    const prompt = vi.fn().mockResolvedValueOnce("1234").mockResolvedValueOnce("a".repeat(32));
    expect(await files.apiCredentials(true, prompt)).toEqual({ apiId: 1234, apiHash: "a".repeat(32) });
    expect(prompt).toHaveBeenCalledTimes(2);
    await rm(resolve(directory, "api.json"));
    vi.stubEnv("TELEGRAM_API_ID", "1234");
    prompt.mockReset().mockResolvedValueOnce("b".repeat(32));
    expect(await files.apiCredentials(true, prompt)).toEqual({ apiId: 1234, apiHash: "b".repeat(32) });
    expect(prompt).toHaveBeenCalledExactlyOnceWith("Telegram API hash");
  });

  it("rejects project-root and filesystem-root session locations", () => {
    expect(() => new SessionFiles(".")).toThrow("dedicated");
    expect(() => new SessionFiles("/")).toThrow("dedicated");
  });

  it("validates environment credentials without echoing invalid values", async () => {
    vi.stubEnv("TELEGRAM_API_ID", "1234");
    vi.stubEnv("TELEGRAM_API_HASH", "private-invalid-value");
    await expect(new SessionFiles(directory).apiCredentials(false)).rejects.toThrow("Invalid Telegram API");
  });

  it("does not follow a session-file symlink", async () => {
    const target = resolve(directory, "fixture.txt");
    await writeFile(target, "synthetic");
    await symlink(target, resolve(directory, "session.txt"));
    await expect(new SessionFiles(directory).read("session.txt")).rejects.toThrow();
    await expect(new SessionFiles(directory).write("session.txt", "replacement")).rejects.toThrow();
  });

  it("rejects a symlinked session directory and missing non-interactive credentials", async () => {
    const link = resolve(directory, "link");
    await symlink(directory, link);
    await expect(new SessionFiles(link).prepare()).rejects.toThrow("symlink");
    await expect(new SessionFiles(directory).apiCredentials(false)).rejects.toThrow("login");
  });
});
