import { lstat, mkdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

export const CODEX_PROVIDER = "openai-codex";
export const CODEX_MODEL = "gpt-6-luna";

export interface PiRuntime {
  modelRuntime: ModelRuntime;
  authPath: string;
  agentDir: string;
}

/** The app never discovers or opens the development Pi auth location. */
export async function openPiRuntime(authPath: string): Promise<PiRuntime> {
  if (!isAbsolute(authPath)) throw new Error("PI_AUTH_PATH must be absolute");
  const developmentDirs = [resolve(homedir(), ".pi", "agent")];
  if (process.env.PI_CODING_AGENT_DIR) developmentDirs.push(resolve(process.env.PI_CODING_AGENT_DIR));
  const isDevelopment = (directory: string) =>
    developmentDirs.some((development) => directory === development || directory.startsWith(development + "/"));
  const agentDir = dirname(resolve(authPath));
  if (isDevelopment(agentDir)) {
    throw new Error("Use an application-owned Pi auth directory, not the development Pi directory");
  }
  await mkdir(agentDir, { recursive: true, mode: 0o700 });
  const actualDir = await realpath(agentDir);
  if (isDevelopment(actualDir)) {
    throw new Error("Pi auth directory must not link to development credentials");
  }
  await requirePrivate(agentDir, true);
  try { await requirePrivate(authPath, false); } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  try {
    const modelRuntime = await ModelRuntime.create({
      authPath, modelsPath: null, allowModelNetwork: false,
      // Restore only the built-in catalog; no global model config or catalog files.
      refreshOnCreate: false,
    });
    return { modelRuntime, authPath, agentDir };
  } catch {
    // Library errors can contain provider payloads. Never forward those to the UI.
    throw new Error("Could not initialize application Pi authentication");
  }
}

async function requirePrivate(path: string, directory: boolean): Promise<void> {
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())
    || (stat.mode & 0o077) !== 0) throw new Error("Pi credentials require a private directory and owner-only regular file");
}
