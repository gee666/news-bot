import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  chmodSync, closeSync, existsSync, fchmodSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync,
  renameSync, writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

export const piPackages = ['@earendil-works/pi-ai', '@earendil-works/pi-coding-agent'];
const manifests = ['package.json', 'package-lock.json'];
const files = [...manifests, 'tsconfig.json', 'tsconfig.test.json', 'tsconfig.web.json',
  'eslint.config.js', 'vite.config.ts', 'vitest.config.ts', 'compose.yaml'];
const directories = ['src', 'web', 'migrations', 'scripts'];
// This public tokenizer is a test input, not model weights or runtime state.
const tokenizerFile = 'model-data/autojev-qwen35-tokenizer.json.gz';
const tokenizerHash = '1679d69d8eb5c1f31610605b09294bd70a23cb851183a8204fac5ced82122d09';
const extensions = /\.(?:ts|tsx|js|mjs|sh|css|html|json|sql|md)$/u;
const excludedDirectories = new Set(['tmp', 'dist', 'node_modules', 'model-data', 'data', 'runtime']);
const privateFile = /(?:\.env(?:\.|$)|^(?:auth|credentials|secrets)(?:\.|$))/iu;

export class UpdateError extends Error {
  constructor(message, details = {}) { super(message); this.details = details; }
}
export function requireSafe(condition, message) {
  if (!condition) throw new UpdateError(message);
}

export function plainDirectory(path) {
  const stat = lstatSync(path);
  requireSafe(stat.isDirectory() && !stat.isSymbolicLink(), 'unsafe-directory');
}

function entry(root, name) {
  const path = join(root, name);
  const before = lstatSync(path, { bigint: true });
  requireSafe(before.isFile() && before.nlink === 1n, 'unsafe-source-file');
  const bytes = readFileSync(path);
  const after = lstatSync(path, { bigint: true });
  const identity = stat => [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.mode].map(String).join(':');
  requireSafe(identity(before) === identity(after), 'source-changed');
  return { bytes, mode: Number(before.mode) & 0o777, identity: identity(after), inode: `${after.dev}:${after.ino}`,
    hash: createHash('sha256').update(bytes).digest('hex') };
}

// Only build inputs and synthetic fixtures belong in these directories.
export function snapshot(root) {
  const result = new Map(files.map(name => [name, entry(root, name)]));
  function walk(name) {
    plainDirectory(join(root, name));
    for (const child of readdirSync(join(root, name)).sort()) {
      if (child.startsWith('.') || privateFile.test(child) || excludedDirectories.has(child)) continue;
      const relative = join(name, child);
      const stat = lstatSync(join(root, relative));
      requireSafe(!stat.isSymbolicLink(), 'source-symlink');
      if (stat.isDirectory()) walk(relative);
      else if (extensions.test(child)) result.set(relative, entry(root, relative));
      else requireSafe(stat.isFile(), 'unsafe-source-file');
    }
  }
  directories.forEach(walk);
  if (existsSync(join(root, 'model-data'))) plainDirectory(join(root, 'model-data'));
  if (existsSync(join(root, tokenizerFile))) {
    const tokenizer = entry(root, tokenizerFile);
    requireSafe(tokenizer.hash === tokenizerHash, 'unrecognized-public-tokenizer');
    result.set(tokenizerFile, tokenizer);
  }
  return result;
}

export function assertSnapshot(expected, actual, { contentOnly = false, omitManifests = false } = {}) {
  const select = map => [...map].filter(([name]) => !omitManifests || !manifests.includes(name))
    .map(([name, item]) => [name, item.hash, item.mode, ...(contentOnly ? [] : [item.identity])]).sort();
  requireSafe(isDeepStrictEqual(select(expected), select(actual)), 'source-changed');
}

export function copySnapshot(source, stage) {
  for (const name of [...directories, 'tmp']) mkdirSync(join(stage, name), { recursive: true, mode: 0o700 });
  for (const [name, item] of source) {
    mkdirSync(dirname(join(stage, name)), { recursive: true, mode: 0o700 });
    writeFileSync(join(stage, name), item.bytes, { flag: 'wx', mode: item.mode });
    chmodSync(join(stage, name), item.mode);
  }
}

function object(value) {
  requireSafe(value !== null && typeof value === 'object' && !Array.isArray(value), 'invalid-package-data');
  return value;
}
function json(bytes) {
  try { return object(JSON.parse(bytes.toString('utf8'))); }
  catch { throw new UpdateError('invalid-package-data'); }
}

export function checkBaseline(source) {
  const manifest = json(source.get('package.json').bytes);
  const dependencies = object(manifest.dependencies);
  for (const name of piPackages) requireSafe(typeof dependencies[name] === 'string', 'missing-pi-dependency');
  const scripts = object(manifest.scripts);
  for (const name of ['typecheck', 'lint', 'test', 'build']) {
    requireSafe(typeof scripts[name] === 'string' && scripts[name].length > 0, 'missing-validation-script');
  }
  for (const section of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    if (!manifest[section]) continue;
    for (const spec of Object.values(object(manifest[section]))) {
      requireSafe(typeof spec === 'string' && !/^(?:file:|link:|workspace:|git|https?:|\/|\.|~\/)/iu.test(spec),
        'non-registry-dependency');
    }
  }
  const lock = json(source.get('package-lock.json').bytes);
  requireSafe([2, 3].includes(lock.lockfileVersion), 'unsupported-lockfile');
  for (const item of Object.values(object(lock.packages))) {
    const dependency = object(item);
    requireSafe(!dependency.link, 'linked-dependency');
    if (!dependency.resolved) continue;
    let url;
    try { url = new URL(dependency.resolved); } catch { throw new UpdateError('non-registry-dependency'); }
    requireSafe(url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash,
      'non-registry-dependency');
  }
}

export function useLatestSpecs(stage) {
  const manifest = json(entry(stage, 'package.json').bytes);
  const dependencies = object(manifest.dependencies);
  if (piPackages.every(name => dependencies[name] === 'latest')) return;
  for (const name of piPackages) {
    requireSafe(typeof dependencies[name] === 'string', 'missing-pi-dependency');
    dependencies[name] = 'latest';
  }
  writeFileSync(join(stage, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
}

export function checkCandidate(source, candidate) {
  checkBaseline(candidate);
  const before = json(source.get('package.json').bytes);
  const after = json(candidate.get('package.json').bytes);
  const lock = object(json(candidate.get('package-lock.json').bytes).packages);
  const rootDependencies = object(object(lock['']).dependencies);
  const versions = {};
  for (const name of piPackages) {
    requireSafe(after.dependencies[name] === 'latest' && rootDependencies[name] === 'latest', 'pi-spec-not-latest');
    const version = object(lock['node_modules/' + name]).version;
    requireSafe(typeof version === 'string' && /^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/u.test(version),
      'pi-resolved-version-not-exact');
    versions[name] = version;
    after.dependencies[name] = before.dependencies[name];
  }
  requireSafe(isDeepStrictEqual(before, after), 'unexpected-manifest-change');
  assertSnapshot(source, candidate, { contentOnly: true, omitManifests: true });
  return versions;
}

export function durableWrite(path, bytes, mode = 0o600) {
  const fd = openSync(path, 'wx', mode);
  try { writeFileSync(fd, bytes); fchmodSync(fd, mode); fsyncSync(fd); }
  finally { closeSync(fd); }
}
export function syncDirectory(path) {
  const fd = openSync(path, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
export function atomicJson(path, value) {
  const temporary = path + '.' + randomUUID();
  durableWrite(temporary, JSON.stringify(value) + '\n');
  renameSync(temporary, path);
  syncDirectory(dirname(path));
}

// POSIX cannot atomically replace two separate files. Leave a durable recovery journal
// before either rename, and never roll back over an unrecognized edit.
export function promote(root, lockDirectory, source, candidate) {
  assertSnapshot(source, snapshot(root));
  for (const name of manifests) {
    durableWrite(join(lockDirectory, name + '.before'), source.get(name).bytes, source.get(name).mode);
    durableWrite(join(lockDirectory, name + '.after'), candidate.get(name).bytes, source.get(name).mode);
  }
  atomicJson(join(lockDirectory, 'journal.json'), { state: 'prepared', files: manifests,
    hashes: Object.fromEntries(manifests.map(name => [name, candidate.get(name).hash])) });
  const expected = new Map(source);
  for (const name of manifests) {
    const next = entry(lockDirectory, name + '.after');
    // Recheck the complete inventory immediately before each rename, including
    // inode/timestamps, so an editor's save of identical bytes also cancels the run.
    assertSnapshot(expected, snapshot(root));
    renameSync(join(lockDirectory, name + '.after'), join(root, name));
    syncDirectory(root);
    const installed = entry(root, name);
    requireSafe(installed.hash === next.hash && installed.inode === next.inode && installed.mode === next.mode,
      'source-changed');
    expected.set(name, installed);
  }
  assertSnapshot(expected, snapshot(root));
  atomicJson(join(lockDirectory, 'journal.json'), { state: 'committed', files: manifests });
}

export function recoverPromotion(root, lockDirectory) {
  plainDirectory(lockDirectory);
  const journal = json(entry(lockDirectory, 'journal.json').bytes);
  requireSafe(['prepared', 'committed', 'restored'].includes(journal.state)
    && isDeepStrictEqual(journal.files, manifests), 'invalid-recovery-journal');
  if (journal.state !== 'prepared') return journal.state;
  const current = new Map(manifests.map(name => [name, entry(root, name)]));
  for (const name of manifests) {
    const before = entry(lockDirectory, name + '.before');
    // A consumed .after means that rename completed; its hash was journaled below.
    const hashes = object(journal.hashes);
    requireSafe(typeof hashes[name] === 'string' && /^[a-f0-9]{64}$/u.test(hashes[name]), 'invalid-recovery-journal');
    requireSafe(current.get(name).hash === before.hash || current.get(name).hash === hashes[name], 'recovery-conflict');
  }
  for (const name of manifests) {
    requireSafe(entry(root, name).identity === current.get(name).identity, 'recovery-conflict');
    const before = entry(lockDirectory, name + '.before');
    const next = join(lockDirectory, name + '.restore-' + randomUUID());
    durableWrite(next, before.bytes, before.mode);
    renameSync(next, join(root, name));
    syncDirectory(root);
  }
  atomicJson(join(lockDirectory, 'journal.json'), { state: 'restored', files: manifests });
  return 'restored';
}

