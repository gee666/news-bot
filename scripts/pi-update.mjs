import {
  appendFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync,
  realpathSync, renameSync, rmSync,
} from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  UpdateError, assertSnapshot, atomicJson, checkBaseline, checkCandidate, copySnapshot,
  plainDirectory, promote, recoverPromotion, requireSafe, snapshot, useLatestSpecs,
} from './pi-update-files.mjs';
import { commandPlan, isolatedEnvironment, runCommand } from './pi-update-runner.mjs';

const defaultRoot = fileURLToPath(new URL('../', import.meta.url));
const lockName = 'pi-update.lock';

export function parseArguments(args) {
  const options = { root: defaultRoot, check: false, recover: false,
    registry: 'https://registry.npmjs.org/', timeoutMs: 600000 };
  const seen = new Set();
  for (const arg of args) {
    const [key, ...parts] = arg.split('=');
    const value = parts.join('=');
    requireSafe(!seen.has(key), 'duplicate-option');
    seen.add(key);
    if (key === '--check' && !parts.length) options.check = true;
    else if (key === '--recover' && !parts.length) options.recover = true;
    else if (key === '--root' && value) options.root = resolve(value);
    else if (key === '--registry' && value) {
      let url;
      try { url = new URL(value); } catch { throw new UpdateError('invalid-registry'); }
      requireSafe(url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash,
        'invalid-registry');
      options.registry = url.href;
    } else if (key === '--timeout-seconds' && /^\d+$/u.test(value)) {
      const seconds = Number(value);
      requireSafe(Number.isInteger(seconds) && seconds >= 1 && seconds <= 3600, 'invalid-timeout');
      options.timeoutMs = seconds * 1000;
    } else throw new UpdateError('invalid-option');
  }
  requireSafe(!(options.check && options.recover), 'incompatible-options');
  return options;
}

function alive(pid, group = false) {
  requireSafe(Number.isSafeInteger(pid) && pid > 0, 'invalid-lock-owner');
  try { process.kill(group ? -pid : pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw new UpdateError('owner-check-failed'); }
}

function recover(root, lock, temporary) {
  plainDirectory(lock);
  const ownerPath = join(lock, 'owner.json');
  requireSafe(lstatSync(ownerPath).isFile() && !lstatSync(ownerPath).isSymbolicLink(), 'invalid-lock-owner');
  const owner = JSON.parse(readFileSync(ownerPath, 'utf8'));
  requireSafe(owner && !alive(owner.pid) && (!owner.childPid || !alive(owner.childPid, true)), 'lock-owner-alive');
  const recoveryLock = join(lock, 'recovery');
  mkdirSync(recoveryLock, { mode: 0o700 });
  try {
    const result = existsSync(join(lock, 'journal.json')) ? recoverPromotion(root, lock) : 'not-promoted';
    const run = mkdtempSync(join(temporary, 'pi-update-recovery-'));
    atomicJson(join(temporary, 'pi-update-status.json'), {
      outcome: 'recovered', phase: result, run: basename(run), updatedAt: new Date().toISOString(),
    });
    renameSync(lock, join(run, 'promotion'));
    return 'recovered';
  } finally { rmSync(recoveryLock, { recursive: true, force: true }); }
}

// execute is injected only by tests. The CLI always uses the real process runner.
export async function update(options, { execute = runCommand, signal = new AbortController().signal } = {}) {
  requireSafe(process.platform !== 'win32' && Number(process.versions.node.split('.')[0]) >= 24,
    'requires-posix-node-24');
  const root = realpathSync(options.root);
  plainDirectory(root);
  const temporary = join(root, 'tmp');
  mkdirSync(temporary, { recursive: true, mode: 0o700 });
  plainDirectory(temporary);
  const lock = join(temporary, lockName);
  if (options.recover) return recover(root, lock, temporary);
  try { mkdirSync(lock, { mode: 0o700 }); }
  catch (error) { if (error.code === 'EEXIST') throw new UpdateError('locked'); throw error; }
  let run;
  let phase = 'snapshot';
  let outcome = 'failed';
  let versions;
  const owner = { pid: process.pid, startedAt: new Date().toISOString() };
  const status = extra => {
    const updatedAt = new Date().toISOString();
    atomicJson(join(temporary, 'pi-update-status.json'), { outcome, phase, run: basename(run), updatedAt, versions, ...extra });
    // Only our fixed phase/error labels are logged. Never record child output or inherited environment.
    appendFileSync(join(run, 'events.log'), JSON.stringify({ updatedAt, outcome, phase, versions, ...extra }) + '\n', { mode: 0o600 });
  };
  try {
    atomicJson(join(lock, 'owner.json'), owner);
    run = mkdtempSync(join(temporary, 'pi-update-'));
    outcome = 'running';
    status();
    const source = snapshot(root);
    checkBaseline(source);
    const stage = join(run, 'stage');
    mkdirSync(stage, { mode: 0o700 });
    copySnapshot(source, stage);
    useLatestSpecs(stage);
    assertSnapshot(source, snapshot(root));
    const env = isolatedEnvironment(run, options.registry);
    const tests = [...source.keys()].filter(name => name.startsWith('scripts/') && name.endsWith('.test.mjs')).sort();
    const plan = commandPlan(stage, tests);
    let candidate;
    for (const command of plan) {
      phase = command.phase;
      status();
      await execute(command, { env, signal, timeoutMs: options.timeoutMs, onStart: childPid => {
        owner.childPid = childPid;
        atomicJson(join(lock, 'owner.json'), owner);
      } });
      delete owner.childPid;
      atomicJson(join(lock, 'owner.json'), owner);
      if (phase === 'resolve-latest') {
        candidate = snapshot(stage);
        versions = checkCandidate(source, candidate);
      }
      status({ result: 'passed' });
    }
    requireSafe(!signal.aborted, 'interrupted');
    phase = 'promotion-check';
    status();
    assertSnapshot(candidate, snapshot(stage));
    assertSnapshot(source, snapshot(root));
    const changed = ['package.json', 'package-lock.json'].some(name => source.get(name).hash !== candidate.get(name).hash);
    if (options.check) outcome = 'validated';
    else if (!changed) outcome = 'unchanged';
    else {
      phase = 'promote';
      status();
      promote(root, lock, source, candidate);
      outcome = 'updated';
    }
    status();
    return outcome;
  } catch (error) {
    outcome = 'failed';
    if (run) status({ error: error instanceof UpdateError ? error.message : 'filesystem-or-data-error',
      ...(error instanceof UpdateError ? error.details : {}), recoveryRequired: existsSync(join(lock, 'journal.json')) });
    throw error;
  } finally {
    // A prepared journal keeps the lock until explicit recovery. Do not overwrite concurrent edits.
    const journal = join(lock, 'journal.json');
    if (existsSync(journal)) {
      const state = JSON.parse(readFileSync(journal, 'utf8')).state;
      if (state === 'committed' && run) renameSync(lock, join(run, 'promotion'));
    } else rmSync(lock, { recursive: true, force: true });
    if (run) for (const name of ['stage', 'home', 'scratch', 'npm-cache', 'user.npmrc', 'global.npmrc']) {
      rmSync(join(run, name), { recursive: true, force: true });
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', interrupt);
  try {
    const outcome = await update(parseArguments(process.argv.slice(2)), { signal: controller.signal });
    console.log('[pi-update] ' + outcome + '; no deployment or restart performed');
  } catch (error) {
    const label = error instanceof UpdateError ? error.message : 'filesystem-or-data-error';
    console.error('[pi-update] ' + label + '; inspect tmp/pi-update-status.json');
    process.exitCode = label === 'locked' ? 75 : 1;
  } finally {
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', interrupt);
  }
}
