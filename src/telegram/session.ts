import { constants } from "node:fs";
import { chmod, lstat, mkdir, open } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { hiddenInput, TelegramSetupError } from "./input.js";

export interface ApiCredentials { apiId: number; apiHash: string }
export type SecretPrompt = (label: string) => Promise<string>;

function credentials(value: unknown): ApiCredentials {
  if (typeof value !== "object" || value === null ||
      !("apiId" in value) || !("apiHash" in value) ||
      typeof value.apiId !== "number" || !Number.isSafeInteger(value.apiId) ||
      value.apiId < 1 || typeof value.apiHash !== "string" ||
      !/^[a-f0-9]{32}$/iu.test(value.apiHash)) {
    throw new TelegramSetupError("Invalid Telegram API ID or API hash.");
  }
  return { apiId: value.apiId, apiHash: value.apiHash };
}

export class SessionFiles {
  readonly directory: string;

  constructor(directory = process.env.TELEGRAM_SESSION_DIR?.trim() || "tmp/telegram-session") {
    this.directory = resolve(directory);
    if (this.directory === resolve(".") || dirname(this.directory) === this.directory) {
      throw new TelegramSetupError("Use a dedicated directory for TELEGRAM_SESSION_DIR.");
    }
  }

  async prepare(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const stat = await lstat(this.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() ||
        (process.getuid && stat.uid !== process.getuid())) {
      throw new TelegramSetupError("Session directory must be owned by this user and not be a symlink.");
    }
    await chmod(this.directory, 0o700);
  }

  async read(name: "api.json" | "session.txt"): Promise<string | undefined> {
    try {
      const file = await open(resolve(this.directory, name), constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.nlink !== 1 || (process.getuid && stat.uid !== process.getuid())) {
          throw new TelegramSetupError("Session files must be regular files without hard links, owned by this user.");
        }
        await file.chmod(0o600);
        return await file.readFile("utf8");
      } finally { await file.close(); }
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
      throw error;
    }
  }

  async write(name: "api.json" | "session.txt", content: string): Promise<void> {
    const file = await open(resolve(this.directory, name),
      constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.nlink !== 1 || (process.getuid && stat.uid !== process.getuid())) {
        throw new TelegramSetupError("Session files must be regular files without hard links, owned by this user.");
      }
      await file.chmod(0o600);
      await file.truncate(0);
      await file.writeFile(content, "utf8");
      await file.sync();
    } finally { await file.close(); }
  }

  async apiCredentials(interactive: boolean, prompt: SecretPrompt = hiddenInput): Promise<ApiCredentials> {
    const id = process.env.TELEGRAM_API_ID?.trim() || undefined;
    const hash = process.env.TELEGRAM_API_HASH?.trim() || undefined;
    if (id && hash) return credentials({ apiId: Number(id), apiHash: hash });
    const saved = await this.read("api.json");
    let existing: ApiCredentials | undefined;
    if (saved) {
      try { existing = credentials(JSON.parse(saved)); }
      catch { throw new TelegramSetupError("Saved API credentials are invalid. Configure TELEGRAM_API_ID and TELEGRAM_API_HASH."); }
    }
    const apiId = id ?? existing?.apiId;
    const apiHash = hash ?? existing?.apiHash;
    if (!interactive && (apiId === undefined || apiHash === undefined)) {
      throw new TelegramSetupError("Run the login command first.");
    }
    const result = credentials({
      apiId: Number(apiId ?? await prompt("Telegram API ID from my.telegram.org")),
      apiHash: apiHash ?? (await prompt("Telegram API hash")).trim(),
    });
    if (!existing) await this.write("api.json", JSON.stringify(result));
    return result;
  }
}
