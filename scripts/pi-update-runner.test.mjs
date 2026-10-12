import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { commandPlan, isolatedEnvironment, runCommand } from './pi-update-runner.mjs';
import { piPackages, useLatestSpecs } from './pi-update-files.mjs';

const temporary = fileURLToPath(new URL('../tmp/', import.meta.url));
mkdirSync(temporary, { recursive: true });
function fixture(t) {
  const run = mkdtempSync(join(temporary, 'pi-update-runner-test-'));
  t.after(() => rmSync(run, { recursive: true, force: true }));
  const env = isolatedEnvironment(run);
  const controller = new AbortController();
  return { run, env, controller, options: { env, signal: controller.signal, timeoutMs: 5000 },
    command: code => ({ executable: process.execPath, cwd: run, args: ['-e', code] }) };
}

test('runner uses a clean home, npm config and environment, without forwarding child output', async t => {
  const { run, env, options, command } = fixture(t);
  for (const name of ['DATABASE_URL', 'TEST_DATABASE_URL', 'NODE_OPTIONS', 'PI_AUTH_PATH', 'NPM_TOKEN',
    'HTTP_PROXY', 'TELEGRAM_BOT_TOKEN', 'ALLOW_PRIVATE_INFERENCE']) assert.equal(env[name], undefined);
  assert.equal(env.PATH.split(':')[0], dirname(process.execPath));
  assert.equal(readFileSync(env.npm_config_userconfig, 'utf8'), '');
  assert.equal(readFileSync(env.npm_config_globalconfig, 'utf8'), '');
  const marker = join(run, 'env.json');
  await runCommand(command(`require('node:fs').writeFileSync(${JSON.stringify(marker)}, JSON.stringify(process.env));
    console.error('synthetic private output');`), options);
  assert.deepEqual(JSON.parse(readFileSync(marker, 'utf8')), env);
});

test('timeout kills the process group, including a worker that ignores SIGTERM', async t => {
  const { run, command, options } = fixture(t);
  const workerFile = join(run, 'worker.pid');
  const worker = `process.on('SIGTERM', () => {}); require('node:fs').writeFileSync(${JSON.stringify(workerFile)}, String(process.pid)); setInterval(() => {}, 1000)`;
  const parent = `const {spawn} = require('node:child_process');
    spawn(process.execPath, ['-e', ${JSON.stringify(worker)}], {stdio:'ignore'});
    setInterval(() => {}, 1000);`;
  let pid;
  await assert.rejects(runCommand(command(parent), { ...options, timeoutMs: 500,
    onStart: value => { pid = value; } }), error => {
    assert.equal(error.message, 'command-timeout');
    assert.equal(error.details.exitSignal, 'SIGTERM');
    return true;
  });
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  const workerPid = Number(readFileSync(workerFile, 'utf8'));
  // An orphan can remain a zombie until init reaps it, but it cannot run again.
  for (let attempt = 0; attempt < 50; attempt++) {
    if (!existsSync('/proc/' + workerPid + '/stat')) return;
    if (readFileSync('/proc/' + workerPid + '/stat', 'utf8').split(' ')[2] === 'Z') return;
    await delay(20);
  }
  assert.fail('worker survived process-group termination');
});

test('abort before and during a command prevents further work', async t => {
  const { command, options, controller } = fixture(t);
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(runCommand(command(''), { ...options, signal: aborted.signal }), /interrupted/u);
  let pid;
  await assert.rejects(runCommand(command('setInterval(() => {}, 1000)'), { ...options,
    onStart: value => { pid = value; controller.abort(); } }), /interrupted/u);
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});

test('missing commands and nonzero exits return only safe failure metadata', async t => {
  const { command, options, run } = fixture(t);
  await assert.rejects(runCommand({ executable: '/no-such-pi-updater-command', cwd: run, args: [] }, options), /command-start-failed/u);
  await assert.rejects(runCommand(command('console.error("synthetic private output"); process.exit(7)'), options), error => {
    assert.equal(error.message, 'command-failed');
    assert.equal(error.details.exitCode, 7);
    assert.doesNotMatch(JSON.stringify(error.details), /private/u);
    return true;
  });
});

test('real npm update and ci retain latest specs and resolve both packages through a local fixture registry',
  { timeout: 30000 }, async t => {
    const { run, env, options } = fixture(t);
    const stage = join(run, 'stage');
    mkdirSync(stage);
    const tarballs = new Map();
    const packages = new Map();
    let registry;
    for (const [index, name] of [...piPackages, 'unrelated'].entries()) {
      const versions = {};
      for (const version of ['1.0.0', '2.0.0']) {
        const directory = join(run, `archive-${index}-${version}`);
        mkdirSync(join(directory, 'package'), { recursive: true });
        writeFileSync(join(directory, 'package/package.json'), JSON.stringify({ name, version }));
        const tarball = join(directory, 'package.tgz');
        const packed = spawnSync('tar', ['-czf', tarball, '-C', directory, 'package'], { env, timeout: 5000 });
        assert.equal(packed.status, 0);
        const bytes = readFileSync(tarball);
        const path = `/tarballs/${index}-${version}.tgz`;
        tarballs.set(path, bytes);
        versions[version] = { name, version, dist: { path,
          integrity: 'sha512-' + createHash('sha512').update(bytes).digest('base64') } };
      }
      packages.set(name, { name, 'dist-tags': { latest: '2.0.0' }, versions });
    }
    const server = createServer((request, response) => {
      const path = new URL(request.url, registry).pathname;
      if (tarballs.has(path)) { response.end(tarballs.get(path)); return; }
      const metadata = packages.get(decodeURIComponent(path.slice(1)));
      if (!metadata) { response.writeHead(404).end(); return; }
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ ...metadata, versions: Object.fromEntries(Object.entries(metadata.versions)
        .map(([version, value]) => [version, { ...value, dist: {
          tarball: registry + value.dist.path, integrity: value.dist.integrity,
        } }])) }));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    registry = 'http://127.0.0.1:' + server.address().port;
    t.after(() => new Promise(resolve => server.close(resolve)));
    env.npm_config_registry = registry;
    const dependencies = { ...Object.fromEntries(piPackages.map(name => [name, '1.0.0'])), unrelated: '^1.0.0' };
    const manifest = { name: 'pi-update-fixture', private: true, dependencies };
    const lock = { name: manifest.name, lockfileVersion: 3, packages: { '': { dependencies },
      ...Object.fromEntries([...packages].map(([name, metadata]) => ['node_modules/' + name, {
        version: '1.0.0', resolved: registry + metadata.versions['1.0.0'].dist.path,
        integrity: metadata.versions['1.0.0'].dist.integrity,
      }])) } };
    writeFileSync(join(stage, 'package.json'), JSON.stringify(manifest));
    writeFileSync(join(stage, 'package-lock.json'), JSON.stringify(lock));
    useLatestSpecs(stage);
    const plan = commandPlan(stage, ['scripts/probe.test.mjs']);
    await runCommand(plan[0], options);
    assert.equal(existsSync(join(stage, 'node_modules')), false);
    const readJson = name => JSON.parse(readFileSync(join(stage, name), 'utf8'));
    const assertLatest = () => {
      const current = readJson('package.json');
      const currentLock = readJson('package-lock.json');
      for (const name of piPackages) {
        assert.equal(current.dependencies[name], 'latest');
        assert.equal(currentLock.packages[''].dependencies[name], 'latest');
        assert.equal(currentLock.packages['node_modules/' + name].version, '2.0.0');
      }
      assert.equal(current.dependencies.unrelated, '^1.0.0');
      assert.equal(currentLock.packages['node_modules/unrelated'].version, '1.0.0');
    };
    assertLatest();
    await runCommand(plan[1], options);
    assertLatest();
    for (const name of piPackages) assert.equal(readJson('node_modules/' + name + '/package.json').version, '2.0.0');
    const before = readFileSync(join(stage, 'package.json'));
    useLatestSpecs(stage);
    assert.deepEqual(readFileSync(join(stage, 'package.json')), before);
    await runCommand(plan[0], options);
    assertLatest();
  });
