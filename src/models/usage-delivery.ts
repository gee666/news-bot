import { defaultSettings, type AppSettings } from '../settings.js';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, lstat, mkdir, open, readFile, readdir, rename, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { usageCallSchema } from '../usage/contracts.js';
import { recordUsage, type UsageCall, type UsageRecorder } from './usage.js';
import { manualUsage } from './usage-scope.js';

export type UsageStorageFailure = 'database_write' | 'failure_record' | 'outbox_write' | 'outbox_read';
export type UsageFailureReporter = (callId: string | null, failure: UsageStorageFailure) => void;
export interface UsageDeliveryOptions {
  directory?: string | undefined;
  settings?: Pick<AppSettings,'requestMaxAttempts' | 'retryBaseMs' | 'retryMaxMs'> | undefined;
  record?: UsageRecorder | undefined;
  report?: UsageFailureReporter | undefined;
}
const reportFailure: UsageFailureReporter = (callId, failure) => {
  // Never log database errors, paths, connection strings or provider payloads.
  console.error(`Model usage storage failed: ${failure}${callId ? `, call ${callId}` : ''}.`);
};
export function reportUsageStorageFailure(callId: string | null, failure: UsageStorageFailure,
  report: UsageFailureReporter = reportFailure): void {
  try { report(callId, failure); }
  catch { /* Reporting must not change inference outcomes or interrupt recovery. */ }
}
function reporter(options: UsageDeliveryOptions): UsageFailureReporter {
  return (callId, failure) => reportUsageStorageFailure(callId, failure, options.report);
}
export function usageOutboxDirectory(options: UsageDeliveryOptions = {}): string {
  return resolve(options.directory ?? process.env.MODEL_USAGE_OUTBOX_DIR ??
    join(dirname(resolve(process.env.PI_AUTH_PATH ?? 'tmp/models-private-auth/auth.json')), 'usage-outbox'));
}
async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
    throw new Error('Model usage outbox requires a private directory');
  }
  await access(path, constants.R_OK | constants.W_OK | constants.X_OK);
}
const deliverySchema = z.object({ attempts:z.number().int().positive(), next:z.iso.datetime() });
type DeliveryState = z.infer<typeof deliverySchema>;
function nextDelivery(attempts: number, options: UsageDeliveryOptions): DeliveryState {
  const settings = options.settings ?? defaultSettings;
  return { attempts, next:new Date(Date.now()+Math.min(settings.retryMaxMs,settings.retryBaseMs * 2 ** Math.min(attempts-1,10))).toISOString() };
}
async function spool(call: UsageCall, options: UsageDeliveryOptions, delivery = nextDelivery(1,options)): Promise<void> {
  z.uuid().parse(call.id);
  const path = usageOutboxDirectory(options);
  await privateDirectory(path);
  const temporary = join(path, `.${call.id}.${randomUUID()}.tmp`);
  try {
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify({ ...call,_delivery:delivery })); await file.sync(); }
    finally { await file.close(); }
    await rename(temporary, join(path, `${call.id}.json`));
    const folder = await open(path, 'r');
    try { await folder.sync(); } finally { await folder.close(); }
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

/** Storage recovery never runs inference and never replaces its result or provider failure. */
export async function deliverUsage(input: UsageCall, options: UsageDeliveryOptions = {}): Promise<void> {
  const call = manualUsage(input);
  const report = reporter(options);
  try { await (options.record ?? recordUsage)(call); }
  catch {
    report(call.id, 'database_write');
    try { await spool(call, options); }
    catch { report(call.id, 'outbox_write'); }
  }
}

export async function retryUsageWrites(options: UsageDeliveryOptions = {}): Promise<number> {
  const report = reporter(options);
  const path = usageOutboxDirectory(options);
  let files: string[];
  try {
    // A missing outbox means there have been no deferred writes.
    await privateDirectory(path);
    files = await readdir(path);
  } catch { report(null, 'outbox_read'); return 0; }
  let recorded = 0;
  for (const name of files.sort()) {
    if (!name.endsWith('.json') || !z.uuid().safeParse(name.slice(0, -5)).success) continue;
    let call: UsageCall;
    let delivery: DeliveryState;
    const file = join(path, name);
    try {
      const stat = await lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw new Error('Invalid outbox file');
      const value: unknown = JSON.parse(await readFile(file, 'utf8'));
      call = usageCallSchema.parse(value);
      delivery = z.object({ _delivery:deliverySchema.optional() }).parse(value)._delivery ?? { attempts:1,next:new Date(0).toISOString() };
      if (call.id + '.json' !== name || !z.iso.datetime().safeParse(call.timestamp).success || call.attempt < 1) {
        throw new Error('Invalid outbox record');
      }
    } catch {
      report(name.slice(0, -5), 'outbox_read');
      await rename(file,file+'.failed').catch(() => report(name.slice(0,-5),'outbox_write'));
      continue;
    }
    if (delivery.attempts >= (options.settings ?? defaultSettings).requestMaxAttempts) {
      await rename(file,file+'.failed').catch(() => report(call.id,'outbox_write'));
      continue;
    }
    if (Date.parse(delivery.next)>Date.now()) continue;
    // Save the attempt before dispatch so a crash cannot reset the storage retry budget.
    const next = nextDelivery(delivery.attempts+1,options);
    try { await spool(call,options,next); } catch { report(call.id,'outbox_write'); break; }
    try { await (options.record ?? recordUsage)(call); }
    // One failed connection is enough to defer the rest of the queue until the next recovery pass.
    catch {
      report(call.id, 'database_write');
      if (next.attempts >= (options.settings ?? defaultSettings).requestMaxAttempts) {
        await rename(file,file+'.failed').catch(() => report(call.id,'outbox_write'));
      }
      break;
    }
    try { await unlink(file); recorded++; }
    catch { report(call.id, 'outbox_write'); }
  }
  return recorded;
}

export async function initializeUsageOutbox(): Promise<void> {
  await privateDirectory(usageOutboxDirectory());
}
export interface UsageRecoveryStatus {
  replaying: boolean;
  lastReplayAt: string | null;
  lastReplayRecordedRecords: number;
  lastReplayFailed: boolean;
}
const recovery: UsageRecoveryStatus = { replaying: false, lastReplayAt: null,
  lastReplayRecordedRecords: 0, lastReplayFailed: false };
export function usageRecoveryStatus(): UsageRecoveryStatus { return { ...recovery }; }

export function usageRecoveryInterval(): number {
  return z.coerce.number().int().min(1000).max(3_600_000).parse(process.env.MODEL_USAGE_RETRY_MS ?? 30_000);
}
export function startUsageRecovery(intervalMs: number, options: UsageDeliveryOptions = {}): () => Promise<void> {
  let running: Promise<number> | undefined;
  const run = () => {
    if (running) return running;
    recovery.replaying = true;
    let failed = false;
    running = retryUsageWrites({ ...options, report: (id, failure) => {
      failed = true; reportUsageStorageFailure(id, failure, options.report);
    } }).catch(() => { failed = true; reportUsageStorageFailure(null, 'outbox_read'); return 0; })
      .then(recorded => {
        recovery.lastReplayAt = new Date().toISOString();
        recovery.lastReplayRecordedRecords = recorded;
        recovery.lastReplayFailed = failed;
        return recorded;
      }).finally(() => { recovery.replaying = false; running = undefined; });
    return running;
  };
  void run();
  const timer = setInterval(() => { void run(); }, intervalMs);
  timer.unref();
  return async () => { clearInterval(timer); await run(); };
}
