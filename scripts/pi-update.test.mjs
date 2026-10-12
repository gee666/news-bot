import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArguments, update } from './pi-update.mjs';
import {
  assertSnapshot, atomicJson, checkCandidate, copySnapshot, piPackages, recoverPromotion, snapshot, UpdateError,
} from './pi-update-files.mjs';
import { commandPlan } from './pi-update-runner.mjs';

const temporary = fileURLToPath(new URL('../tmp/', import.meta.url));
mkdirSync(temporary, { recursive: true });
const put = (root, path, value) => {
  mkdirSync(join(root, path, '..'), { recursive: true });
  writeFileSync(join(root, path), typeof value === 'string' ? value : JSON.stringify(value) + '\n');
};
const get = (root, path) => readFileSync(join(root, path), 'utf8');
const manifest = version => ({ name: 'fixture', private: true, scripts: {
  typecheck: 'fixture', lint: 'fixture', test: 'fixture', build: 'fixture',
}, dependencies: Object.fromEntries(piPackages.map(name => [name, version])) });
const lockfile = (version, spec = version) => ({ lockfileVersion: 3, packages: {
  '': { dependencies: manifest(spec).dependencies },
  ...Object.fromEntries(piPackages.map(name => ['node_modules/' + name, { version }])),
} });

function fixture(t) {
  const root = mkdtempSync(join(temporary, 'pi-update-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  put(root, 'package.json', manifest('1.0.0'));
  put(root, 'package-lock.json', lockfile('1.0.0'));
  for (const name of ['tsconfig.json', 'tsconfig.test.json', 'tsconfig.web.json', 'eslint.config.js',
    'vite.config.ts', 'vitest.config.ts', 'compose.yaml']) put(root, name, '{}');
  for (const name of ['src', 'web', 'migrations', 'scripts']) mkdirSync(join(root, name));
  put(root, 'src/app.ts', 'export const value = 1;');
  put(root, 'scripts/probe.test.mjs', '// synthetic test');
  put(root, '.env', 'SYNTHETIC_SECRET=never-copy');
  put(root, '.npmrc', '//registry.npmjs.org/:_authToken=never-copy');
  put(root, 'model-data/private.json', 'runtime data');
  put(root, 'node_modules/active.txt', 'active dependencies');
  put(root, 'dist/active.txt', 'active build');
  return root;
}

function fakeRunner(root, { fail, visit = () => {} } = {}) {
  const phases = [];
  const execute = async (command, options) => {
    phases.push(command.phase);
    assert.notEqual(command.cwd, root);
    assert.ok(command.cwd.startsWith(join(root, 'tmp') + '/'));
    assert.equal(existsSync(join(command.cwd, '.env')), false);
    assert.equal(existsSync(join(command.cwd, '.npmrc')), false);
    assert.equal(existsSync(join(command.cwd, 'model-data')), false);
    assert.equal(existsSync(join(command.cwd, 'node_modules/active.txt')), false);
    assert.equal(existsSync(join(command.cwd, 'dist/active.txt')), false);
    assert.ok(options.env.HOME.startsWith(join(root, 'tmp') + '/'));
    assert.equal(options.env.DATABASE_URL, undefined);
    assert.equal(options.env.TEST_DATABASE_URL, undefined);
    assert.equal(options.env.NODE_OPTIONS, undefined);
    assert.equal(options.env.ALLOW_PRIVATE_INFERENCE, undefined);
    if (command.phase === 'resolve-latest') {
      assert.deepEqual(command.args, ['update', '--package-lock-only', '--ignore-scripts', ...piPackages]);
      assert.deepEqual(JSON.parse(get(command.cwd, 'package.json')), manifest('latest'));
      // The original lock must reach npm intact, rather than being discarded.
      assert.deepEqual(JSON.parse(get(command.cwd, 'package-lock.json')), lockfile('1.0.0'));
      put(command.cwd, 'package-lock.json', lockfile('2.0.0', 'latest'));
    }
    if (command.phase === 'install') {
      assert.deepEqual(JSON.parse(get(command.cwd, 'package.json')), manifest('latest'));
      assert.deepEqual(JSON.parse(get(command.cwd, 'package-lock.json')).packages[''].dependencies, manifest('latest').dependencies);
    }
    await visit(command, options);
    if (command.phase === fail) throw new UpdateError('command-failed');
  };
  return { execute, phases };
}
const optionsFor = root => parseArguments(['--root=' + root]);

function assertActiveUntouched(root) {
  assert.equal(get(root, 'node_modules/active.txt'), 'active dependencies');
  assert.equal(get(root, 'dist/active.txt'), 'active build');
  assert.equal(get(root, '.env'), 'SYNTHETIC_SECRET=never-copy');
}

test('both latest packages are validated in staging, then only manifest and lock are promoted', async t => {
  const root = fixture(t);
  const runner = fakeRunner(root);
  assert.equal(await update(optionsFor(root), runner), 'updated');
  assert.deepEqual(runner.phases, ['resolve-latest', 'install', 'typecheck', 'lint', 'test', 'build', 'script-tests']);
  assert.deepEqual(JSON.parse(get(root, 'package.json')), manifest('latest'));
  assert.deepEqual(JSON.parse(get(root, 'package-lock.json')), lockfile('2.0.0', 'latest'));
  assertActiveUntouched(root);
  const status = JSON.parse(get(root, 'tmp/pi-update-status.json'));
  assert.equal(status.outcome, 'updated');
  assert.deepEqual(status.versions, Object.fromEntries(piPackages.map(name => [name, '2.0.0'])));
  assert.equal(existsSync(join(root, 'tmp/pi-update.lock')), false);
  assert.equal(existsSync(join(root, 'tmp', status.run, 'stage')), false);
  assert.equal(get(root, 'tmp/' + status.run + '/promotion/package.json.before'), JSON.stringify(manifest('1.0.0')) + '\n');
  assert.doesNotMatch(get(root, 'tmp/' + status.run + '/events.log'), /never-copy/u);
});

test('every failed gate leaves original manifests, active dependencies and build intact', async t => {
  for (const fail of ['resolve-latest', 'install', 'typecheck', 'lint', 'test', 'build', 'script-tests']) {
    const root = fixture(t);
    const before = snapshot(root);
    const runner = fakeRunner(root, { fail });
    await assert.rejects(update(optionsFor(root), runner), /command-failed/u);
    assertSnapshot(before, snapshot(root));
    assertActiveUntouched(root);
    assert.equal(runner.phases.at(-1), fail);
    const status = JSON.parse(get(root, 'tmp/pi-update-status.json'));
    assert.equal(status.phase, fail);
    assert.equal(status.outcome, 'failed');
    assert.equal(existsSync(join(root, 'tmp/pi-update.lock')), false);
  }
});

test('check mode validates but never promotes, even if packages changed', async t => {
  const root = fixture(t);
  const before = snapshot(root);
  assert.equal(await update({ ...optionsFor(root), check: true }, fakeRunner(root)), 'validated');
  assertSnapshot(before, snapshot(root));
});

test('an already current lock still runs all gates and returns unchanged', async t => {
  const root = fixture(t);
  put(root, 'package.json', manifest('latest'));
  put(root, 'package-lock.json', lockfile('2.0.0', 'latest'));
  const phases = [];
  assert.equal(await update(optionsFor(root), { execute: async command => phases.push(command.phase) }), 'unchanged');
  assert.equal(phases.length, 7);
});

test('missing lockfile fails closed before any npm command', async t => {
  const root = fixture(t);
  rmSync(join(root, 'package-lock.json'));
  const runner = fakeRunner(root);
  await assert.rejects(update(optionsFor(root), runner));
  assert.deepEqual(runner.phases, []);
  assertActiveUntouched(root);
});

test('source edits, additions, deletions, and identical editor saves cancel promotion', async t => {
  for (const edit of [
    root => put(root, 'src/app.ts', 'export const value = 2;'),
    root => put(root, 'src/new.ts', 'export {};'),
    root => rmSync(join(root, 'src/app.ts')),
    root => { put(root, 'src/replacement.ts', get(root, 'src/app.ts')); renameSync(join(root, 'src/replacement.ts'), join(root, 'src/app.ts')); },
    root => put(root, 'package.json', { ...manifest('1.0.0'), concurrent: true }),
    root => put(root, 'package-lock.json', { ...lockfile('1.0.0'), concurrent: true }),
  ]) {
    const root = fixture(t);
    const runner = fakeRunner(root, { visit: command => { if (command.phase === 'script-tests') edit(root); } });
    await assert.rejects(update(optionsFor(root), runner), /source-changed/u);
    assertActiveUntouched(root);
    assert.notDeepEqual(JSON.parse(get(root, 'package.json')), manifest('latest'));
    assert.notDeepEqual(JSON.parse(get(root, 'package-lock.json')), lockfile('2.0.0', 'latest'));
  }
});

test('validation cannot mutate candidate manifests or staged source', async t => {
  for (const name of ['package.json', 'package-lock.json', 'src/app.ts']) {
    const root = fixture(t);
    const before = snapshot(root);
    const runner = fakeRunner(root, { visit: command => {
      if (command.phase === 'build') put(command.cwd, name, 'changed by validation');
    } });
    await assert.rejects(update(optionsFor(root), runner), /source-changed/u);
    assertSnapshot(before, snapshot(root));
  }
});

test('a second updater cannot start or overwrite the first updater status', async t => {
  const root = fixture(t);
  let entered;
  let release;
  const started = new Promise(resolve => { entered = resolve; });
  const waiting = new Promise(resolve => { release = resolve; });
  const runner = fakeRunner(root, { visit: async command => {
    if (command.phase === 'resolve-latest') { entered(); await waiting; }
  } });
  const first = update(optionsFor(root), runner);
  await started;
  const status = get(root, 'tmp/pi-update-status.json');
  await assert.rejects(update(optionsFor(root), fakeRunner(root)), /locked/u);
  assert.equal(get(root, 'tmp/pi-update-status.json'), status);
  release();
  assert.equal(await first, 'updated');
});

test('staging excludes nested private/runtime files and rejects source or tmp symlinks', async t => {
  const root = fixture(t);
  put(root, 'src/.env.local', 'private');
  put(root, 'src/auth.json', 'private');
  put(root, 'src/runtime/private.json', 'private');
  const source = snapshot(root);
  for (const name of ['src/.env.local', 'src/auth.json', 'src/runtime/private.json']) assert.equal(source.has(name), false);
  symlinkSync(join(root, '.env'), join(root, 'src/leak.ts'));
  assert.throws(() => snapshot(root), /source-symlink/u);
  rmSync(join(root, 'src/leak.ts'));
  symlinkSync(temporary, join(root, 'tmp'));
  await assert.rejects(update(optionsFor(root), fakeRunner(root)), /unsafe-directory/u);
});

test('candidate requires latest specs, exact resolved versions and unchanged unrelated settings', t => {
  const root = fixture(t);
  const source = snapshot(root);
  put(root, 'package.json', { ...manifest('latest'), scripts: { ...manifest('latest').scripts, start: 'malicious' } });
  put(root, 'package-lock.json', lockfile('2.0.0', 'latest'));
  assert.throws(() => checkCandidate(source, snapshot(root)), /unexpected-manifest-change/u);
  for (const name of piPackages) for (const spec of ['2.0.0', '^2.0.0']) {
    const pinned = manifest('latest'); pinned.dependencies[name] = spec;
    put(root, 'package.json', pinned);
    assert.throws(() => checkCandidate(source, snapshot(root)), /pi-spec-not-latest/u);
    put(root, 'package.json', manifest('latest'));
    const lock = lockfile('2.0.0', 'latest'); lock.packages[''].dependencies[name] = spec;
    put(root, 'package-lock.json', lock);
    assert.throws(() => checkCandidate(source, snapshot(root)), /pi-spec-not-latest/u);
    put(root, 'package-lock.json', lockfile('2.0.0', 'latest'));
  }
  for (const version of ['latest', '^2.0.0', null]) {
    put(root, 'package-lock.json', lockfile(version, 'latest'));
    assert.throws(() => checkCandidate(source, snapshot(root)), /pi-resolved-version-not-exact/u);
  }
});

test('local dependencies cannot escape staging', async t => {
  const root = fixture(t);
  put(root, 'package.json', { ...manifest('1.0.0'), devDependencies: { escape: 'file:../../private' } });
  const runner = fakeRunner(root);
  await assert.rejects(update(optionsFor(root), runner), /non-registry-dependency/u);
  assert.equal(runner.phases.length, 0);
});

test('recovering a partial promotion restores both originals, but refuses unrelated edits', t => {
  for (const conflict of [false, true]) {
    const root = fixture(t);
    const source = snapshot(root);
    const stage = join(root, 'tmp/stage');
    mkdirSync(stage, { recursive: true });
    copySnapshot(source, stage);
    put(stage, 'package.json', manifest('latest'));
    put(stage, 'package-lock.json', lockfile('2.0.0', 'latest'));
    const candidate = snapshot(stage);
    const lock = join(root, 'tmp/pi-update.lock');
    mkdirSync(lock);
    for (const name of ['package.json', 'package-lock.json']) put(lock, name + '.before', source.get(name).bytes.toString());
    atomicJson(join(lock, 'journal.json'), { state: 'prepared', files: ['package.json', 'package-lock.json'],
      hashes: Object.fromEntries(['package.json', 'package-lock.json'].map(name => [name, candidate.get(name).hash])) });
    put(root, 'package.json', manifest('latest'));
    if (conflict) {
      put(root, 'package-lock.json', { ...lockfile('1.0.0'), concurrent: true });
      const current = get(root, 'package.json');
      assert.throws(() => recoverPromotion(root, lock), /recovery-conflict/u);
      assert.equal(get(root, 'package.json'), current);
    } else {
      assert.equal(recoverPromotion(root, lock), 'restored');
      assertSnapshot(source, snapshot(root), { contentOnly: true });
      assert.equal(recoverPromotion(root, lock), 'restored');
    }
  }
});

test('recovery refuses a live lock owner', async t => {
  const root = fixture(t);
  const lock = join(root, 'tmp/pi-update.lock');
  mkdirSync(lock, { recursive: true });
  atomicJson(join(lock, 'owner.json'), { pid: process.pid });
  await assert.rejects(update({ ...optionsFor(root), recover: true }), /lock-owner-alive/u);
  assert.equal(existsSync(lock), true);
});

test('stale recovery releases an unpromoted or committed lock without changing manifests', async t => {
  const deadPid = spawnSync(process.execPath, ['-e', ''], { env: {}, timeout: 5000 }).pid;
  for (const state of ['not-promoted', 'committed']) {
    const root = fixture(t);
    const source = snapshot(root);
    const lock = join(root, 'tmp/pi-update.lock');
    mkdirSync(lock, { recursive: true });
    atomicJson(join(lock, 'owner.json'), { pid: deadPid });
    if (state === 'committed') atomicJson(join(lock, 'journal.json'), { state, files: ['package.json', 'package-lock.json'] });
    assert.equal(await update({ ...optionsFor(root), recover: true }), 'recovered');
    assertSnapshot(source, snapshot(root));
    assert.equal(existsSync(lock), false);
    const status = JSON.parse(get(root, 'tmp/pi-update-status.json'));
    assert.equal(status.phase, state);
    assert.equal(existsSync(join(root, 'tmp', status.run, 'promotion/owner.json')), true);
    assertActiveUntouched(root);
  }
});

test('options reject credentials, ambiguous flags and unreasonable timeouts', () => {
  for (const args of [['--registry=https://user:private@example.org/'], ['--registry=http://example.org/'],
    ['--registry=https://example.org/?token=private'], ['--check', '--recover'], ['--check', '--check'],
    ['--timeout-seconds=0'], ['--timeout-seconds=3601'], ['--root'], ['--unknown']]) {
    assert.throws(() => parseArguments(args), UpdateError);
  }
  assert.equal(parseArguments(['--timeout-seconds=30']).timeoutMs, 30000);
});

test('command plan has all gates, no deploy/start command and no install lifecycle hooks', () => {
  const plan = commandPlan('/stage', ['scripts/probe.test.mjs']);
  assert.equal(plan.length, 7);
  assert.deepEqual(plan.at(-1).args, ['--test', 'scripts/probe.test.mjs']);
  assert.ok(plan.filter(command => command.executable === 'npm').every(command => command.args.includes('--ignore-scripts')));
  assert.throws(() => commandPlan('/stage', []), /missing-script-tests/u);
});

test('a source edit between the two renames preserves a prepared journal and needs recovery', async t => {
  const root = fixture(t);
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from, to) => {
    rename(from, to);
    if (to === join(root, 'package.json')) put(root, 'src/app.ts', 'concurrent edit');
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  await assert.rejects(update(optionsFor(root), fakeRunner(root)), /source-changed/u);
  const lock = join(root, 'tmp/pi-update.lock');
  assert.equal(JSON.parse(get(lock, 'journal.json')).state, 'prepared');
  assert.equal(JSON.parse(get(root, 'tmp/pi-update-status.json')).recoveryRequired, true);
  assert.deepEqual(JSON.parse(get(root, 'package.json')), manifest('latest'));
  assert.deepEqual(JSON.parse(get(root, 'package-lock.json')), lockfile('1.0.0'));
  t.mock.restoreAll();
  syncBuiltinESMExports();
  assert.equal(recoverPromotion(root, lock), 'restored');
  assert.deepEqual(JSON.parse(get(root, 'package.json')), manifest('1.0.0'));
  assert.equal(get(root, 'src/app.ts'), 'concurrent edit');
  assertActiveUntouched(root);
});

test('only the hash-pinned public tokenizer is copied from model-data', t => {
  const root = fixture(t);
  const name = 'model-data/autojev-qwen35-tokenizer.json.gz';
  writeFileSync(join(root, name), readFileSync(new URL('../' + name, import.meta.url)));
  const source = snapshot(root);
  assert.equal(source.has(name), true);
  assert.equal(source.has('model-data/private.json'), false);
  const stage = join(root, 'tmp/stage');
  copySnapshot(source, stage);
  assert.equal(existsSync(join(stage, 'tmp')), true);
  assert.deepEqual(readFileSync(join(stage, name)), source.get(name).bytes);
  writeFileSync(join(root, name), 'unrecognized data');
  assert.throws(() => snapshot(root), /unrecognized-public-tokenizer/u);
});
