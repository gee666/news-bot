import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { piPackages, UpdateError, requireSafe } from './pi-update-files.mjs';

export function isolatedEnvironment(run, registry = 'https://registry.npmjs.org/') {
  const home = join(run, 'home');
  const scratch = join(run, 'scratch');
  for (const path of [home, scratch]) mkdirSync(path, { mode: 0o700 });
  const userconfig = join(run, 'user.npmrc');
  const globalconfig = join(run, 'global.npmrc');
  for (const path of [userconfig, globalconfig]) writeFileSync(path, '', { flag: 'wx', mode: 0o600 });
  // Do not inherit proxies, NODE_OPTIONS, npm tokens, Pi auth, or service credentials.
  return {
    PATH: [dirname(process.execPath), '/usr/local/bin', '/usr/bin', '/bin'].join(':'),
    HOME: home, XDG_CONFIG_HOME: join(home, 'config'), XDG_CACHE_HOME: join(home, 'cache'),
    XDG_DATA_HOME: join(home, 'data'), TMPDIR: scratch, TMP: scratch, TEMP: scratch,
    LANG: 'C.UTF-8', CI: 'true', NO_COLOR: '1',
    npm_config_userconfig: userconfig, npm_config_globalconfig: globalconfig,
    npm_config_cache: join(run, 'npm-cache'), npm_config_registry: registry,
    npm_config_ignore_scripts: 'true', npm_config_engine_strict: 'true',
    npm_config_audit: 'false', npm_config_fund: 'false', npm_config_update_notifier: 'false',
    npm_config_fetch_retries: '1', npm_config_fetch_timeout: '60000',
    npm_config_fetch_retry_mintimeout: '1000', npm_config_fetch_retry_maxtimeout: '5000',
  };
}

export function commandPlan(stage, scriptTests) {
  requireSafe(scriptTests.length > 0 && scriptTests.every(name => /^scripts\/[\w.-]+\.test\.mjs$/u.test(name)),
    'missing-script-tests');
  return [
    { phase: 'resolve-latest', executable: 'npm', args: ['update', '--package-lock-only', '--ignore-scripts', ...piPackages] },
    { phase: 'install', executable: 'npm', args: ['ci', '--ignore-scripts', '--include=dev'] },
    ...['typecheck', 'lint', 'test', 'build'].map(name => ({ phase: name, executable: 'npm',
      args: ['run', '--ignore-scripts', name] })),
    { phase: 'script-tests', executable: process.execPath, args: ['--test', ...scriptTests] },
  ].map(command => ({ ...command, cwd: stage }));
}

export async function runCommand(command, { env, signal, timeoutMs, onStart = () => {} }) {
  if (signal.aborted) throw new UpdateError('interrupted');
  const startedAt = Date.now();
  await new Promise((resolve, reject) => {
    const child = spawn(command.executable, command.args, {
      cwd: command.cwd, env, detached: true, stdio: 'ignore',
    });
    let failure;
    let escalation;
    const killGroup = signalName => {
      if (!child.pid) return;
      try { process.kill(-child.pid, signalName); }
      catch (error) { if (error.code !== 'ESRCH') failure = 'child-stop-failed'; }
    };
    const stop = reason => {
      failure = reason;
      killGroup('SIGTERM');
      escalation ??= setTimeout(() => killGroup('SIGKILL'), 2000);
    };
    const abort = () => stop('interrupted');
    const timeout = setTimeout(() => stop('command-timeout'), timeoutMs);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    if (child.pid) {
      try { onStart(child.pid); } catch { stop('child-state-write-failed'); }
    }
    child.once('error', () => { failure = 'command-start-failed'; });
    child.once('close', (code, exitSignal) => {
      clearTimeout(timeout);
      clearTimeout(escalation);
      signal.removeEventListener('abort', abort);
      // A successful command must not leave a detached server or worker behind.
      killGroup('SIGKILL');
      if (failure || code !== 0 || exitSignal) reject(new UpdateError(failure || 'command-failed',
        { exitCode: code, exitSignal, durationMs: Date.now() - startedAt }));
      else resolve();
    });
  });
}
