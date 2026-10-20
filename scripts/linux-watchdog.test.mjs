import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
const old = '2000-01-01T00:00:00Z';
const healthy = `true healthy ${old}`;
const unhealthy = `true unhealthy ${old}`;

function run(command, args, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn('timeout', ['30', command, ...args], {cwd: root, env, timeout: 35000});
    let output = '';
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output += chunk; });
    child.once('error', reject);
    child.once('close', code => { resolve({code, output}); });
  });
}

async function fixture(t, states = {}, recover = false) {
  await mkdir(root + 'tmp', {recursive: true});
  const dir = await mkdtemp(root + 'tmp/linux-watchdog-test-');
  t.after(() => rm(dir, {recursive: true, force: true}));
  await writeFile(dir + '/calls', '');
  for (const service of ['db', 'crawl4ai', 'app']) {
    await writeFile(dir + '/' + service, (states[service] ?? healthy) + '\n');
  }
  await writeFile(dir + '/docker', `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$MOCK_DIR/calls"
if [[ "$1" == compose && "$2" == --project-name && "$3" == news-bot ]]; then
  service="\${!#}"
  if [[ "$4" == ps && "$5" == --all && "$6" == --quiet && $# == 7 ]]; then
    [[ "$(cat "$MOCK_DIR/$service")" == missing ]] || echo "$service"
  elif [[ "$4" == restart && "$5" == --no-deps && "$6" == --timeout && "$7" == 30 && $# == 8 ]]; then
    if [[ "$MOCK_RECOVER" == true ]]; then echo '${healthy}' > "$MOCK_DIR/$service"; fi
  else exit 90; fi
elif [[ "$1" == inspect && "$2" == --format && $# == 4 ]]; then
  cat "$MOCK_DIR/$4"
else exit 91; fi
`, {mode: 0o700});
  const env = {...process.env, ROOT: dir, DOCKER_BIN: dir + '/docker', MOCK_DIR: dir, MOCK_RECOVER: String(recover)};
  return {
    dir,
    async check() {
      const result = await run('bash', [root + 'scripts/linux-watchdog.sh'], env);
      const calls = await readFile(dir + '/calls', 'utf8');
      return {...result, calls, restarted: calls.split('\n').filter(line => line.includes(' restart ')).map(line => line.split(' ').at(-1))};
    },
  };
}

test('healthy containers are inspected without restart or upstream probes', {timeout: 40000}, async t => {
  const result = await (await fixture(t)).check();
  assert.equal(result.code, 0, result.output);
  assert.deepEqual(result.restarted, []);
  assert.equal(result.calls.trim().split('\n').length, 6);
  assert.doesNotMatch(result.calls, /up|curl|Spark|8765|11434/u);
});

test('unhealthy dependencies recover in DB/crawler/app order once dependencies are healthy', {timeout: 40000}, async t => {
  const result = await (await fixture(t, {db: unhealthy, crawl4ai: unhealthy, app: unhealthy}, true)).check();
  assert.equal(result.code, 0, result.output);
  assert.deepEqual(result.restarted, ['db', 'crawl4ai', 'app']);
});

for (const dependency of ['db', 'crawl4ai']) {
  test(`unhealthy app is gated while ${dependency} remains unhealthy`, {timeout: 40000}, async t => {
    const result = await (await fixture(t, {[dependency]: unhealthy, app: unhealthy})).check();
    assert.equal(result.code, 0, result.output);
    assert.deepEqual(result.restarted, [dependency]);
  });
}

test('unhealthy app alone recovers without restarting healthy dependencies', {timeout: 40000}, async t => {
  const result = await (await fixture(t, {app: unhealthy})).check();
  assert.equal(result.code, 0, result.output);
  assert.deepEqual(result.restarted, ['app']);
});

test('unhealthy dependency does not restart a healthy app', {timeout: 40000}, async t => {
  const result = await (await fixture(t, {db: unhealthy})).check();
  assert.equal(result.code, 0, result.output);
  assert.deepEqual(result.restarted, ['db']);
});

test('recently started unhealthy containers get five minutes of grace', {timeout: 40000}, async t => {
  const recent = `true unhealthy ${new Date().toISOString()}`;
  const result = await (await fixture(t, {db: recent, crawl4ai: recent, app: recent})).check();
  assert.equal(result.code, 0, result.output);
  assert.deepEqual(result.restarted, []);
});

test('stopped, missing and healthcheck-free containers are ignored', {timeout: 40000}, async t => {
  const result = await (await fixture(t, {db: `false unhealthy ${old}`, crawl4ai: 'missing', app: `true none ${old}`})).check();
  assert.equal(result.code, 0, result.output);
  assert.deepEqual(result.restarted, []);
});

test('missing dependency gates an unhealthy app', {timeout: 40000}, async t => {
  const result = await (await fixture(t, {db: 'missing', app: unhealthy})).check();
  assert.equal(result.code, 0, result.output);
  assert.deepEqual(result.restarted, []);
});

test('Docker inspection errors fail closed', {timeout: 40000}, async t => {
  const f = await fixture(t);
  await rm(f.dir + '/db');
  const result = await f.check();
  assert.notEqual(result.code, 0);
  assert.deepEqual(result.restarted, []);
});

test('shell syntax and unit templates verify without installation or activation', {timeout: 40000}, async t => {
  const f = await fixture(t);
  for (const script of ['scripts/linux-watchdog.sh', 'scripts/install-linux-startup.sh']) {
    const syntax = await run('bash', ['-n', script]);
    assert.equal(syntax.code, 0, syntax.output);
  }
  const units = ['news-bot.service', 'news-bot-watchdog.service', 'news-bot-watchdog.timer'];
  for (const unit of units) {
    const text = await readFile(root + 'deploy/systemd/' + unit, 'utf8');
    await writeFile(f.dir + '/' + unit, text.replace('/usr/local/libexec/news-bot-watchdog', root + 'scripts/linux-watchdog.sh'));
  }
  const verified = await run('systemd-analyze', ['verify', ...units.map(unit => f.dir + '/' + unit)], {...process.env, TMPDIR: f.dir});
  assert.equal(verified.code, 0, verified.output);
  const installer = await readFile(root + 'scripts/install-linux-startup.sh', 'utf8');
  assert.match(installer, /systemctl enable news-bot\.service news-bot-watchdog\.timer/u);
  assert.doesNotMatch(installer, /--now|^\s*(?:timeout \d+ )?systemctl (?:start|restart) /mu);
  const rejected = await run('bash', ['scripts/install-linux-startup.sh', '--activate']);
  assert.equal(rejected.code, 2);
});
