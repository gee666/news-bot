import { execFileSync } from 'node:child_process';
import { lstat, readFile } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import { createConnection, isIP } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { networkInterfaces } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseEnv } from 'node:util';

const webKeys = ['WSL_WEB_FORWARD_PORT', 'WSL_WEB_TARGET_PORT', 'WEB_PORT'];
const helperKeys = ['INFERENCE_RELAY_BIND', 'JEV_RELAY_PORT', 'JEV_UPSTREAM_PORT',
  'EMBEDDING_RELAY_PORT', 'EMBEDDING_UPSTREAM_PORT', 'INFERENCE_CONNECT_TIMEOUT_MS', ...webKeys];

export function helperEnvironment(file, env) {
  return Object.fromEntries(helperKeys.flatMap(key => {
    const value = env[key] ?? (webKeys.includes(key) ? file[key] : undefined);
    return value === undefined ? [] : [[key, value]];
  }));
}

export async function readHelperEnvironment(path = fileURLToPath(new URL('../.env', import.meta.url)), env = process.env) {
  let file = {};
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 ||
      (process.getuid && info.uid !== process.getuid())) throw new Error('Unsafe helper environment file');
    file = parseEnv(await readFile(path, 'utf8'));
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  return helperEnvironment(file, env);
}

function integer(value, fallback, minimum, maximum) {
  const number = value === undefined || value === '' ? fallback : Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw new Error('Invalid relay port or connection timeout');
  }
  return number;
}

function localInterfaces() {
  const interfaces = networkInterfaces();
  if (process.platform === 'linux') {
    try {
      // Node omits DOWN interfaces. Docker's default gateway can remain down while Compose bridges are up.
      const records = JSON.parse(execFileSync('ip', ['-j', '-4', 'address', 'show'], {
        encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'],
      }));
      if (Array.isArray(records)) for (const record of records) {
        if (typeof record?.ifname !== 'string' ||
          (record.ifname !== 'docker0' && !/^br-[a-f0-9]+$/u.test(record.ifname)) || !Array.isArray(record.addr_info)) continue;
        interfaces[record.ifname] = record.addr_info
          .filter(address => address?.family === 'inet' && typeof address.local === 'string' && isIP(address.local) === 4)
          .map(address => ({ family: 'IPv4', address: address.local }));
      }
    } catch { /* Active interfaces remain usable if iproute2 is unavailable. */ }
  }
  return interfaces;
}

export function relayConfig(env = process.env, interfaces = localInterfaces()) {
  const dockerAddresses = Object.entries(interfaces)
    .filter(([name]) => name === 'docker0' || /^br-[a-f0-9]+$/u.test(name))
    .sort(([left], [right]) => Number(right === 'docker0') - Number(left === 'docker0'))
    .flatMap(([, addresses]) => (addresses ?? []).filter(address => address.family === 'IPv4').map(address => address.address));
  const bind = env.INFERENCE_RELAY_BIND || dockerAddresses[0];
  if (!bind || isIP(bind) !== 4 || (bind !== '127.0.0.1' && !dockerAddresses.includes(bind))) {
    throw new Error('Relay must bind to a local Docker bridge address or loopback');
  }
  const routes = [
    { name: 'JEV', port: integer(env.JEV_RELAY_PORT, 18765, 1024, 65535),
      upstreamPort: integer(env.JEV_UPSTREAM_PORT, 8765, 1, 65535) },
    { name: 'embeddings', port: integer(env.EMBEDDING_RELAY_PORT, 21434, 1024, 65535),
      upstreamPort: integer(env.EMBEDDING_UPSTREAM_PORT, 11434, 1, 65535) },
  ];
  const webPort = integer(env.WSL_WEB_FORWARD_PORT, 3030, 0, 65535);
  if (webPort > 0 && webPort < 1024) throw new Error('Web forwarding requires an unprivileged port');
  const targetPort = integer(env.WSL_WEB_TARGET_PORT || env.WEB_PORT, 3000, 1, 65535);
  const web = webPort === 0 ? null : { name: 'web', bind: '127.0.0.1', port: webPort, upstreamPort: targetPort };
  const ports = [...routes.map(route => route.port), ...(web ? [web.port] : [])];
  if (new Set(ports).size !== ports.length) throw new Error('Relay listeners need different ports');
  if (web && web.port === web.upstreamPort) throw new Error('Web forwarding cannot target itself');
  return { bind, routes, web, connectTimeoutMs: integer(env.INFERENCE_CONNECT_TIMEOUT_MS, 10000, 100, 60000) };
}

function listeners(config) {
  return [...config.routes.map(route => ({ ...route, bind: config.bind, preserveHost: false })),
    ...(config.web ? [{ ...config.web, preserveHost: true }] : [])];
}

function forwardHeaders(headers) {
  const result = { ...headers };
  for (const name of String(headers.connection ?? '').split(',').map(value => value.trim().toLowerCase())) delete result[name];
  for (const name of ['connection', 'keep-alive', 'proxy-connection', 'proxy-authorization',
    'proxy-authenticate', 'te', 'trailer', 'transfer-encoding', 'upgrade']) delete result[name];
  return result;
}

export async function startRelay(config) {
  // Validate again when called as a module, not only through the command line.
  if (!Array.isArray(config.routes) || config.routes.length !== 2) throw new Error('Two relay routes are required');
  if (config.web && config.web.bind !== '127.0.0.1') throw new Error('Web forwarding must bind to loopback');
  const validated = relayConfig({ INFERENCE_RELAY_BIND: config.bind, JEV_RELAY_PORT: String(config.routes[0].port),
    EMBEDDING_RELAY_PORT: String(config.routes[1].port), JEV_UPSTREAM_PORT: String(config.routes[0].upstreamPort),
    EMBEDDING_UPSTREAM_PORT: String(config.routes[1].upstreamPort), INFERENCE_CONNECT_TIMEOUT_MS: String(config.connectTimeoutMs),
    WSL_WEB_FORWARD_PORT: config.web ? String(config.web.port) : '0',
    WSL_WEB_TARGET_PORT: config.web ? String(config.web.upstreamPort) : undefined });
  const servers = [];
  const connections = new Set();
  const close = async () => {
    for (const socket of connections) socket.destroy();
    await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
  };
  try {
    for (const route of listeners(validated)) {
      const server = createServer((incoming, outgoing) => {
        if (!incoming.url?.startsWith('/') || incoming.url.startsWith('//')) {
          outgoing.writeHead(400).end(); return;
        }
        const headers = forwardHeaders(incoming.headers);
        if (route.preserveHost) {
          // Keep the browser's origin intact so the application's existing Host/CSRF checks still apply.
          for (const name of ['host', 'origin', 'sec-fetch-site', 'x-csrf-token']) if (incoming.headers[name] !== undefined) headers[name] = incoming.headers[name];
        } else {
          // AutoJev requires a loopback Host. Upstreams are fixed services, never request URLs.
          headers.host = `127.0.0.1:${route.upstreamPort}`;
        }
        const upstream = request({ hostname: '127.0.0.1', port: route.upstreamPort,
          method: incoming.method, path: incoming.url, headers, agent: false }, response => {
          outgoing.writeHead(response.statusCode || 502, forwardHeaders(response.headers));
          response.pipe(outgoing);
          response.on('error', () => outgoing.destroy());
        });
        let timer;
        upstream.on('socket', socket => {
          timer = setTimeout(() => upstream.destroy(), validated.connectTimeoutMs);
          socket.once('connect', () => clearTimeout(timer));
        });
        upstream.on('close', () => clearTimeout(timer));
        upstream.on('error', () => {
          if (!outgoing.headersSent) outgoing.writeHead(502).end();
          else outgoing.destroy();
        });
        incoming.on('aborted', () => upstream.destroy());
        outgoing.on('close', () => upstream.destroy());
        incoming.pipe(upstream);
      });
      // The application owns the long inference deadline; do not cut off queued or cold requests.
      server.requestTimeout = 0;
      server.timeout = 0;
      server.headersTimeout = 10000;
      server.on('connection', socket => {
        connections.add(socket);
        socket.on('close', () => connections.delete(socket));
      });
      servers.push(server);
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(route.port, route.bind, () => { server.off('error', reject); resolve(); });
      });
    }
    return { close, servers };
  } catch (error) {
    await close();
    throw error;
  }
}

export async function checkRelay(config, deadlineMs = 10000, upstreams = false) {
  const deadline = Date.now() + deadlineMs;
  const routes = upstreams ? config.routes.map(route => ({ ...route, bind: '127.0.0.1', port: route.upstreamPort })) : listeners(config);
  for (const route of routes) {
    let ready = false;
    while (!ready && Date.now() < deadline) {
      ready = await new Promise(resolve => {
        const socket = createConnection({ host: route.bind, port: route.port });
        const finish = result => { socket.destroy(); resolve(result); };
        socket.once('connect', () => finish(true));
        socket.once('error', () => finish(false));
        socket.setTimeout(Math.max(1, Math.min(500, deadline - Date.now())), () => finish(false));
      });
      if (!ready) await delay(100);
    }
    if (!ready) throw new Error(upstreams ? 'Windows model services are not reachable' : 'Relay listeners are not ready');
  }
}

async function run() {
  if (process.argv.length > 3 || (process.argv[2] !== undefined && !['--check', '--check-upstreams'].includes(process.argv[2]))) {
    throw new Error('Usage: node scripts/wsl-inference-relay.mjs [--check|--check-upstreams]');
  }
  const config = relayConfig(await readHelperEnvironment());
  if (['--check', '--check-upstreams'].includes(process.argv[2])) {
    await checkRelay(config, 10000, process.argv[2] === '--check-upstreams');
    console.log(process.argv[2] === '--check-upstreams' ? 'Windows model services are reachable.' : 'Relay listeners are ready.');
    return;
  }
  const relay = await startRelay(config);
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    void relay.close();
  };
  for (const server of relay.servers) server.on('error', () => {
    console.error('Relay listener failed; request data was not logged.');
    process.exitCode = 1;
    stop();
  });
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  for (const route of listeners(config)) console.log(`${route.name} relay ready on ${route.bind}:${route.port}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { await run(); } catch {
    console.error(process.argv[2] === '--check-upstreams'
      ? 'Windows model services are unreachable. Start JEV and embeddings on Windows; no request data was logged.'
      : 'Relay startup failed. Check Docker bridge, ports and configuration. No request data was logged.');
    process.exitCode = 1;
  }
}
