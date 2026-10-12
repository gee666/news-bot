import { writeFile, mkdir, realpath } from "node:fs/promises";
import { resolve, relative, dirname } from "node:path";
import { db, migrate } from "../db.js";
import { withUserClient } from "./client.js";
import { discoverChannels, resolveDestination } from "./discovery.js";
import { TelegramHistory, type HistoryReader } from "./history.js";
import { TelegramSetupError } from "./input.js";
import { listSources, refreshSources } from "./repository.js";
import type { CollectedItem, TelegramSource } from "./types.js";

export interface SmokeOptions {
  source: string | null;
  limit: number;
  channels: number;
  output: string | null;
}

export function smokeOptions(args: readonly string[]): SmokeOptions {
  const result: SmokeOptions = { source: null, limit: 3, channels: 3, output: null };
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i];
    const value = args[i + 1];
    if (!flag || !value || seen.has(flag)) throw new TelegramSetupError("Use smoke [--source ID] [--limit 1..10] [--channels 1..20] [--output tmp/file.json].");
    seen.add(flag);
    if (flag === "--source") result.source = value;
    else if (flag === "--output") result.output = value;
    else if (flag === "--limit" || flag === "--channels") {
      const number = Number(value);
      const max = flag === "--limit" ? 10 : 20;
      if (!Number.isInteger(number) || number < 1 || number > max) {
        throw new TelegramSetupError("Smoke limit or channel count is outside its permitted range.");
      }
      if (flag === "--limit") result.limit = number;
      else result.channels = number;
    } else throw new TelegramSetupError("Unknown smoke option.");
  }
  return result;
}

export async function smokeSamples(
  reader: HistoryReader, sources: readonly TelegramSource[], options: SmokeOptions, cutoff = new Date(),
): Promise<{ sourceId: string; channelId: string; name: string; access: string; items: CollectedItem[] }[]> {
  const active = sources.filter(source => source.active && source.enabled &&
    (!options.source || source.id === options.source || source.externalId === options.source));
  if (options.source && !active.length) throw new TelegramSetupError("Requested source is not active and enabled.");
  const samples = [];
  const since = new Date(cutoff.getTime() - 48 * 60 * 60 * 1000);
  for (const source of active.slice(0, options.channels)) {
    const items: CollectedItem[] = [];
    let scanned = 0;
    const scanLimit = options.limit * 5;
    for await (const entry of reader.recent(source, since, cutoff, scanLimit)) {
      scanned++;
      if (entry.item && entry.publishedAt >= since && entry.publishedAt <= cutoff &&
          (!entry.editedAt || entry.editedAt <= cutoff)) items.push(entry.item);
      if (items.length >= options.limit || scanned >= scanLimit) break;
    }
    samples.push({ sourceId: source.id, channelId: source.externalId, name: source.name, access: source.access, items });
  }
  return samples;
}

async function saveSamples(path: string, samples: string): Promise<void> {
  const root = resolve("tmp");
  const target = resolve(path);
  const within = relative(root, target);
  if (!within || within === ".." || within.startsWith("../") || within.startsWith("..\\")) {
    throw new TelegramSetupError("Smoke output must be inside the project tmp/ directory.");
  }
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const parent = await realpath(dirname(target));
  const actualRoot = await realpath(root);
  const parentWithin = relative(actualRoot, parent);
  if (parentWithin === ".." || parentWithin.startsWith("../") || parentWithin.startsWith("..\\\\")) {
    throw new TelegramSetupError("Smoke output directory must remain inside project tmp/.");
  }
  // Exclusive creation avoids overwriting files, following symlinks or weakening permissions.
  await writeFile(target, samples, { mode: 0o600, flag: "wx" });
}

export async function runTelegramCommand(command: "discover" | "smoke", args: readonly string[]): Promise<void> {
  if (command === "discover" && args.length) throw new TelegramSetupError("Usage: npm run cli -- discover");
  const options = command === "smoke" ? smokeOptions(args) : null;
  try {
    if (command === "discover") await migrate();
    await withUserClient(async client => {
      if (command === "discover") {
        const destination = await resolveDestination(client);
        const channels = await discoverChannels(client, destination.channelId);
        const sources = await refreshSources(channels, destination);
        console.log("Destination channel ID: " + destination.channelId);
        console.log(JSON.stringify(sources.map(source => ({
          id: source.id, channelId: source.externalId, name: source.name,
          access: source.access, enabled: source.enabled, active: source.active,
        })), null, 2));
      } else if (options) {
        const samples = await smokeSamples(new TelegramHistory(client), await listSources(), options);
        const serialized = JSON.stringify(samples, null, 2) + "\n";
        if (options.output) {
          await saveSamples(options.output, serialized);
          console.log("Read-only samples saved to " + options.output);
        } else process.stdout.write(serialized);
      }
    });
  } finally { await db.end(); }
}
