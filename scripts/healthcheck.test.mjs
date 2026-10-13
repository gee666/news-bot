import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import test from 'node:test';

const compose = await readFile(new URL('../compose.yaml', import.meta.url), 'utf8');
const block = compose.match(/ {8}- >-\n([\s\S]*?)\n {6}interval:/u)?.[1];
if (!block) throw new Error('App healthcheck command is missing');
const command = block.split('\n').map(line => line.trim()).join(' ');

async function check(port, host = '') {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', command.replace('port:3000', 'port:' + port)], {
      env: { PATH: process.env.PATH, APP_ALLOWED_HOSTS: host }, timeout: 7000, stdio: 'ignore',
    });
    child.once('error', reject);
    child.once('close', (code, signal) => resolve(signal ? 1 : code));
  });
}
async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

test('Compose healthcheck reads the status API with an allowed Host', async () => {
  const requests = [];
  const server = createServer((req, res) => {
    requests.push({ path: req.url, host: req.headers.host });
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"batches":[]}');
  });
  const port = await listen(server);
  try {
    assert.equal(await check(port, 'allowed.example:3000'), 0);
    assert.deepEqual(requests, [{ path: '/api/health', host: 'allowed.example:3000' }]);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('Compose healthcheck fails when the API reports a database/query error or is unreachable', async () => {
  const server = createServer((_req, res) => res.writeHead(500).end('{"error":"Request failed"}'));
  const port = await listen(server);
  try { assert.equal(await check(port), 1); }
  finally { await new Promise(resolve => server.close(resolve)); }
  assert.equal(await check(port), 1);
});
