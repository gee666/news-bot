import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import { relayConfig, startRelay } from './wsl-inference-relay.mjs';

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
async function config(upstreamPort) {
  return relayConfig({ INFERENCE_RELAY_BIND: '127.0.0.1', JEV_RELAY_PORT: String(await freePort()),
    EMBEDDING_RELAY_PORT: String(await freePort()), JEV_UPSTREAM_PORT: String(upstreamPort),
    EMBEDDING_UPSTREAM_PORT: String(upstreamPort), INFERENCE_CONNECT_TIMEOUT_MS: '1000', WSL_WEB_FORWARD_PORT: '0' });
}

test('relay configuration permits Docker interfaces but rejects LAN and wildcard binding', () => {
  const interfaces = { docker0: [{ family: 'IPv4', address: '172.17.0.1' }],
    eth0: [{ family: 'IPv4', address: '172.16.0.5' }] };
  assert.equal(relayConfig({}, interfaces).bind, '172.17.0.1');
  for (const bind of ['0.0.0.0', '192.168.0.1', '172.16.0.5', '::']) {
    assert.throws(() => relayConfig({ INFERENCE_RELAY_BIND: bind }, interfaces));
  }
  assert.throws(() => relayConfig({}, {}));
  assert.throws(() => relayConfig({ INFERENCE_RELAY_BIND: '127.0.0.1', JEV_RELAY_PORT: '0' }, {}));
  assert.throws(() => relayConfig({ INFERENCE_RELAY_BIND: '127.0.0.1',
    JEV_RELAY_PORT: '12345', EMBEDDING_RELAY_PORT: '12345' }, {}));
});

test('relay streams HTTP, rewrites Host and strips connection/proxy headers', async () => {
  const seen = [];
  const upstream = createServer((req, res) => {
    let body = '';
    req.on('data', chunk => body += chunk.toString());
    req.on('end', () => {
      seen.push({ headers: req.headers, body });
      res.setHeader('content-type', 'text/plain');
      res.write('first ');
      setTimeout(() => res.end('last'), 20);
    });
  });
  const upstreamPort = await listen(upstream);
  const configuration = await config(upstreamPort);
  const relay = await startRelay(configuration);
  try {
    const result = await new Promise((resolve, reject) => {
      const req = request({ hostname: '127.0.0.1', port: configuration.routes[0].port, path: '/v1/systemone',
        method: 'POST', headers: { authorization: 'Bearer synthetic-key', 'proxy-authorization': 'synthetic-proxy',
          connection: 'x-private-hop', 'x-private-hop': 'synthetic', 'content-type': 'application/json' },
      }, response => {
        let body = '';
        response.on('data', chunk => body += chunk.toString());
        response.on('end', () => resolve({ status: response.statusCode, body }));
      });
      req.on('error', reject);
      req.end('{"synthetic":true}');
    });
    assert.equal(result.status, 200);
    assert.equal(result.body, 'first last');
    assert.equal(seen[0].headers.host, '127.0.0.1:' + upstreamPort);
    assert.equal(seen[0].headers.authorization, 'Bearer synthetic-key');
    assert.equal(seen[0].headers['proxy-authorization'], undefined);
    assert.equal(seen[0].headers['x-private-hop'], undefined);
    assert.equal(seen[0].body, '{"synthetic":true}');
    assert.equal(relay.servers[0].requestTimeout, 0);
    assert.equal(relay.servers[0].timeout, 0);
  } finally {
    await relay.close();
    await new Promise(resolve => upstream.close(resolve));
  }
});

test('relay rejects absolute request targets and returns safe 502 for unavailable upstream', async () => {
  const configuration = await config(await freePort());
  const relay = await startRelay(configuration);
  try {
    const status = await new Promise((resolve, reject) => {
      const req = request({ hostname: '127.0.0.1', port: configuration.routes[0].port,
        path: 'http://outside.example/private' }, response => { response.resume(); resolve(response.statusCode); });
      req.on('error', reject);
      req.end();
    });
    assert.equal(status, 400);
    const response = await fetch('http://127.0.0.1:' + configuration.routes[0].port + '/health');
    assert.equal(response.status, 502);
    assert.equal(await response.text(), '');
  } finally { await relay.close(); }
});

test('failed second listener releases the first listener', async () => {
  const occupied = createServer();
  const occupiedPort = await listen(occupied);
  const configuration = await config(await freePort());
  configuration.routes[1].port = occupiedPort;
  await assert.rejects(startRelay(configuration));
  const probe = createServer();
  try {
    probe.listen(configuration.routes[0].port, '127.0.0.1');
    await once(probe, 'listening');
  } finally {
    await new Promise(resolve => probe.close(resolve));
    await new Promise(resolve => occupied.close(resolve));
  }
});
