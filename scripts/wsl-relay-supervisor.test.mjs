import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFile, writeFile, stat, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}
async function freePort() {
  const server = createServer();
  const port = await listen(server);
  await new Promise(resolve => server.close(resolve));
  return port;
}
async function shell(command, env) {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', ['scripts/wsl-relay.sh', command], { cwd: root, env, timeout: 12000 });
    let text = '';
    child.stdout.on('data', chunk => text += chunk.toString());
    child.stderr.on('data', chunk => text += chunk.toString());
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve(text) : reject(new Error('Supervisor command failed: ' + text)));
  });
}
async function until(run) {
  for (let i = 0; i < 100; i++) {
    try { const result = await run(); if (result) return result; } catch { /* The restart removes PID state briefly. */ }
    await delay(100);
  }
  throw new Error('Supervisor transition did not complete');
}
async function pid(path) {
  const value = (await readFile(path, 'utf8')).trim();
  assert.match(value, /^[1-9][0-9]*$/u);
  return Number(value);
}

test('supervisor is idempotent, restarts a crashed relay, bounds logs and stops cleanly',
  { skip: process.platform !== 'linux', timeout: 30000 }, async () => {
    const upstream = createServer((_req, res) => res.end('ready'));
    const upstreamPort = await listen(upstream);
    const port = await freePort();
    const webPort = await freePort();
    const instance = 'test_' + process.pid;
    const state = root + 'tmp/wsl-relay-' + instance;
    const env = { ...process.env, WSL_RELAY_INSTANCE: instance, INFERENCE_RELAY_BIND: '127.0.0.1',
      JEV_RELAY_PORT: String(port), EMBEDDING_RELAY_PORT: String(await freePort()),
      JEV_UPSTREAM_PORT: String(upstreamPort), EMBEDDING_UPSTREAM_PORT: String(upstreamPort),
      WSL_WEB_FORWARD_PORT: String(webPort), WSL_WEB_TARGET_PORT: String(upstreamPort) };
    const healthy = async () => (await fetch('http://127.0.0.1:' + port + '/health',
      { signal: AbortSignal.timeout(500) })).text();
    try {
      await shell('start', env);
      await until(async () => (await healthy()) === 'ready');
      assert.equal(await (await fetch('http://127.0.0.1:' + webPort + '/health')).text(), 'ready');
      const supervisor = await pid(state + '/supervisor.pid');
      assert.match(await shell('start', env), /already running/u);
      assert.equal(await pid(state + '/supervisor.pid'), supervisor);
      const oldChild = await pid(state + '/child.pid');
      await writeFile(state + '/relay.log', 'x'.repeat(1048577), { mode: 0o600 });
      process.kill(oldChild, 'SIGKILL');
      const newChild = await until(async () => {
        const next = await pid(state + '/child.pid');
        return next !== oldChild && (await healthy()) === 'ready' ? next : false;
      });
      assert.notEqual(newChild, oldChild);
      assert.equal(await (await fetch('http://127.0.0.1:' + webPort + '/health')).text(), 'ready');
      const rotatedSize = (await stat(state + '/relay.log.1')).size;
      assert.ok(rotatedSize >= 1048577 && rotatedSize < 1050625);
      assert.ok((await stat(state + '/relay.log')).size < 1048576);
      assert.equal((await stat(state)).mode & 0o777, 0o700);
      assert.match(await shell('status', env), /Relay process running/u);
      await shell('stop', env);
      await assert.rejects(readFile(state + '/supervisor.pid'));
    } finally {
      await shell('stop', env);
      await new Promise(resolve => upstream.close(resolve));
      await rm(state, { recursive: true, force: true });
    }
  });
