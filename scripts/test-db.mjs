import { readFile, lstat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseEnv } from 'node:util';
import { spawn } from 'node:child_process';
import pg from 'pg';

const root = fileURLToPath(new URL('../', import.meta.url));

export function databaseConfiguration(file, env) {
  const databaseName = env.DB_TEST_NAME || file.DB_TEST_NAME || 'newsbot_test';
  if (!/^[a-z][a-z0-9_]{0,62}$/u.test(databaseName) || databaseName === (file.POSTGRES_DB || 'newsbot')) {
    throw new Error('Use a separate test database name');
  }
  const explicit = env.TEST_DATABASE_URL || file.TEST_DATABASE_URL;
  if (explicit) {
    const url = new URL(explicit);
    if (!['postgresql:', 'postgres:'].includes(url.protocol) || !url.pathname.slice(1)) {
      throw new Error('Invalid test database URL');
    }
    if (decodeURIComponent(url.pathname.slice(1)) === (env.POSTGRES_DB || file.POSTGRES_DB || 'newsbot')) {
      throw new Error('Test database must be separate');
    }
    return { testUrl: url, adminUrl: null, databaseName };
  }
  const password = env.POSTGRES_PASSWORD || file.POSTGRES_PASSWORD;
  if (!password) throw new Error('Missing database password');
  const port = Number(env.DB_PORT || file.DB_PORT || 5432);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid database port');
  const adminUrl = new URL('postgresql://127.0.0.1');
  adminUrl.port = String(port);
  adminUrl.username = env.POSTGRES_USER || file.POSTGRES_USER || 'newsbot';
  adminUrl.password = password;
  adminUrl.pathname = '/' + (env.POSTGRES_DB || file.POSTGRES_DB || 'newsbot');
  if (databaseName === decodeURIComponent(adminUrl.pathname.slice(1))) throw new Error('Test database must be separate');
  const testUrl = new URL(adminUrl);
  testUrl.pathname = '/' + databaseName;
  return { testUrl, adminUrl, databaseName };
}

export function testEnvironment(url, env) {
  const allowed = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TERM', 'COLORTERM', 'NO_COLOR', 'FORCE_COLOR',
    'TMPDIR', 'SystemRoot', 'ComSpec', 'PATHEXT'];
  const result = Object.fromEntries(allowed.flatMap(key => env[key] === undefined ? [] : [[key, env[key]]]));
  return { ...result, DATABASE_URL: url.toString(), TEST_DATABASE_URL: url.toString() };
}

function redactOutput(stream, output, secrets) {
  let pending = '';
  const flush = line => output.write(secrets.reduce((value, secret) => secret ? value.replaceAll(secret, '[redacted]') : value, line));
  stream.setEncoding('utf8');
  stream.on('data', chunk => {
    pending += chunk;
    const end = pending.lastIndexOf('\n');
    if (end >= 0) { flush(pending.slice(0, end + 1)); pending = pending.slice(end + 1); }
  });
  stream.on('end', () => { if (pending) flush(pending); });
}

async function runTests(configuration, files) {
  const url = configuration.testUrl;
  const child = spawn(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', '--hookTimeout=60000', ...files], { cwd: root, env: testEnvironment(url, process.env), stdio: ['ignore', 'pipe', 'pipe'], timeout: 300000 });
  const secrets = [url.toString(), url.password, decodeURIComponent(url.password)];
  redactOutput(child.stdout, process.stdout, secrets);
  redactOutput(child.stderr, process.stderr, secrets);
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve(signal ? 1 : code ?? 1));
  });
}

export async function main(args = process.argv.slice(2)) {
  if (args.some(arg => !/^src\/[a-zA-Z0-9_./-]+\.test\.ts$/u.test(arg) || arg.includes('..'))
    && !(args.length === 1 && args[0] === '--db-only')) {
    throw new Error('Usage: node scripts/test-db.mjs [--db-only | src/<files>.test.ts ...]');
  }
  const files = args[0] === '--db-only' ? [
    'src/db.test.ts', 'src/settings.test.ts', 'src/schema.test.ts',
    'src/pipeline/pipeline.integration.test.ts', 'src/publishing/history.test.ts',
  ] : args;
  let file = {};
  try {
    const path = resolve(root, '.env');
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw new Error('Unsafe environment file');
    file = parseEnv(await readFile(path, 'utf8'));
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  const configuration = databaseConfiguration(file, process.env);
  if (configuration.adminUrl) {
    const admin = new pg.Pool({ connectionString: configuration.adminUrl.toString(), connectionTimeoutMillis: 10000 });
    try {
      const existing = await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [configuration.databaseName]);
      if (!existing.rows.length) await admin.query(`CREATE DATABASE "${configuration.databaseName}"`);
    } finally { await admin.end(); }
  }
  // Each integration suite migrates its own random schema. Never migrate application history here.
  return runTests(configuration, files);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { process.exitCode = await main(); }
  catch {
    console.error('Database tests could not start. Check private configuration, database access and npm dependencies. URLs/credentials were not displayed.');
    process.exitCode = 1;
  }
}
