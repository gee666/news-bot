import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { once } from 'node:events';
import { mkdir, mkdtemp, writeFile, chmod, symlink, rm } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { browserSecurity } from '../src/http/security.ts';
import { helperEnvironment, readHelperEnvironment, relayConfig, startRelay, checkRelay } from './wsl-inference-relay.mjs';

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
async function config(targetPort) {
  return relayConfig({ INFERENCE_RELAY_BIND: '127.0.0.1', JEV_RELAY_PORT: String(await freePort()),
    EMBEDDING_RELAY_PORT: String(await freePort()), JEV_UPSTREAM_PORT: String(targetPort),
    EMBEDDING_UPSTREAM_PORT: String(targetPort), WSL_WEB_FORWARD_PORT: String(await freePort()),
    WSL_WEB_TARGET_PORT: String(targetPort) });
}
async function send(port, path, headers = {}, body = '') {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path, method: body ? 'POST' : 'GET', headers }, response => {
      let text = '';
      response.on('data', chunk => text += chunk.toString());
      response.on('end', () => resolve({ status: response.statusCode, body: text }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('optional UI configuration fixes loopback binding and uses WEB_PORT with safe overrides', () => {
  const interfaces = { docker0: [{ family: 'IPv4', address: '172.17.0.1' }] };
  assert.deepEqual(relayConfig({ WEB_PORT: '3007' }, interfaces).web,
    { name: 'web', bind: '127.0.0.1', port: 3030, upstreamPort: 3007 });
  assert.equal(relayConfig({ WEB_PORT: '3007', WSL_WEB_TARGET_PORT: '3008' }, interfaces).web.upstreamPort, 3008);
  assert.equal(relayConfig({ WSL_WEB_FORWARD_PORT: '0' }, interfaces).web, null);
  for (const env of [
    { WSL_WEB_FORWARD_PORT: '-1' }, { WSL_WEB_FORWARD_PORT: '443' },
    { WSL_WEB_FORWARD_PORT: '3000' }, { WSL_WEB_TARGET_PORT: '3030' },
    { WSL_WEB_TARGET_PORT: 'https://outside.example' }, { WEB_PORT: '70000' },
    { WSL_WEB_FORWARD_PORT: '18765' },
  ]) assert.throws(() => relayConfig(env, interfaces));
});

test('private environment parsing uses only web port keys and rejects unsafe file permissions/symlinks', async () => {
  const root = new URL('../tmp/', import.meta.url);
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(fileURLToPath(new URL('web-forward-test-', root)));
  const path = directory + '/private.env';
  try {
    await writeFile(path, 'WEB_PORT=3007\nWSL_WEB_FORWARD_PORT=3037\nTELEGRAM_BOT_TOKEN=synthetic\nJEV_RELAY_PORT=9999\n',
      { mode: 0o600 });
    assert.deepEqual(await readHelperEnvironment(path, {}), { WEB_PORT: '3007', WSL_WEB_FORWARD_PORT: '3037' });
    assert.deepEqual(helperEnvironment({ WEB_PORT: '3007', JEV_API_KEY: 'synthetic' },
      { WEB_PORT: '3008', WSL_WEB_TARGET_PORT: '3009', JEV_API_KEY: 'synthetic' }),
    { WEB_PORT: '3008', WSL_WEB_TARGET_PORT: '3009' });
    await symlink(path, directory + '/link.env');
    await assert.rejects(readHelperEnvironment(directory + '/link.env', {}));
    await chmod(path, 0o640);
    await assert.rejects(readHelperEnvironment(path, {}));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('UI streams preserve browser Host/Origin and CSRF headers without weakening cross-origin checks', async () => {
  const requests = [];
  const security = browserSecurity();
  const app = express();
  app.use(security.guard);
  app.use((req, res) => {
    let body = '';
    req.on('data', chunk => body += chunk.toString());
    req.on('end', () => {
      requests.push({ host: req.headers.host, origin: req.headers.origin, csrf: req.headers['x-csrf-token'], body });
      res.writeHead(200);
      res.write('first ');
      setTimeout(() => res.end('last'), 10);
    });
  });
  const application = createServer(app);
  const target = await listen(application);
  const configuration = await config(target);
  const relay = await startRelay(configuration);
  const host = 'localhost:' + configuration.web.port;
  try {
    assert.equal(relay.servers[2].address().address, '127.0.0.1');
    await checkRelay(configuration, 1000);
    const accepted = await send(configuration.web.port, '/api/settings', {
      host, origin: 'http://' + host, 'x-csrf-token': security.token,
      connection: 'host, origin', 'content-type': 'application/json',
    }, '{"synthetic":true}');
    assert.equal(accepted.status, 200);
    assert.equal(accepted.body, 'first last');
    assert.deepEqual(requests[0], { host, origin: 'http://' + host, csrf: security.token, body: '{"synthetic":true}' });
    assert.equal((await send(configuration.web.port, '/api/status', { host })).status, 200);
    assert.equal((await send(configuration.web.port, '/api/settings',
      { host, origin: 'https://outside.example', 'x-csrf-token': security.token }, '{}')).status, 403);
    assert.equal((await send(configuration.web.port, '/api/status', { host: 'outside.example' })).status, 403);
    assert.equal((await send(configuration.web.port, '/api/status',
      { host, 'sec-fetch-site': 'cross-site', connection: 'sec-fetch-site' })).status, 403);
    const before = requests.length;
    for (const path of ['http://outside.example/', 'https://outside.example/', '//outside.example/']) {
      assert.equal((await send(configuration.web.port, path)).status, 400);
    }
    assert.equal(requests.length, before);
    const unsafe = { ...configuration, web: { ...configuration.web, bind: '0.0.0.0' } };
    await assert.rejects(startRelay(unsafe));
    await new Promise(resolve => relay.servers[2].close(resolve));
    await assert.rejects(checkRelay(configuration, 500));
  } finally {
    await relay.close();
    await new Promise(resolve => application.close(resolve));
  }
});

test('an occupied UI port rolls back the new model listeners rather than reporting ready', async () => {
  const occupied = createServer();
  const port = await listen(occupied);
  const configuration = await config(await freePort());
  configuration.web.port = port;
  try {
    await assert.rejects(startRelay(configuration));
    const probe = createServer();
    probe.listen(configuration.routes[0].port, '127.0.0.1');
    await once(probe, 'listening');
    await new Promise(resolve => probe.close(resolve));
  } finally { await new Promise(resolve => occupied.close(resolve)); }
});
