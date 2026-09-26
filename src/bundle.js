import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { assert, semver, publicationConfig } from './config.js';
import { checkout, checked, json, writeJson, within } from './io.js';
import { archiveEntries, archivedJson, extractArchive } from './tar.js';

const digest = (data, algorithm = 'sha256', encoding = 'hex') => createHash(algorithm).update(data).digest(encoding);
const equal = (actual, expected, message) => assert(isDeepStrictEqual(actual, expected), message);
const exists = file => fs.access(file).then(() => true, () => false);

export async function manifests(root, config, plan) {
  const pkgFile = path.join(root, 'package.json');
  assert((await fs.lstat(pkgFile)).isFile(), 'package.json must be a regular file');
  const pkg = await json(pkgFile);
  assert(typeof pkg.name === 'string' && pkg.name.length <= 214 && /^(?:@[a-z0-9_~][a-z0-9._~-]*\/)?[a-z0-9_~][a-z0-9._~-]*$/.test(pkg.name) && semver(pkg.version), 'Invalid package name or source version');
  assert(pkg.private !== true, 'Refusing to release a private:true npm package');
  assert(!pkg.workspaces, 'Workspace root packages are not supported; select a standalone package directory');
  for (const group of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    for (const spec of Object.values(pkg[group] || {})) assert(typeof spec === 'string' && !/^(file:|link:|workspace:)/.test(spec), 'Local/workspace dependencies are not publishable by this action');
  }
  if (pkg.publishConfig) {
    assert(!pkg.publishConfig.registry || new URL(pkg.publishConfig.registry).href.replace(/\/$/, '') === config.registry.replace(/\/$/, ''), 'publishConfig.registry conflicts with registry-url');
    assert(!pkg.publishConfig.tag || pkg.publishConfig.tag === plan.distTag, 'publishConfig.tag conflicts with release channel');
    assert(!pkg.publishConfig.access || pkg.publishConfig.access === config.access, 'publishConfig.access conflicts with access');
  }
  let lock;
  const lockFile = path.join(root, 'package-lock.json');
  if (await exists(lockFile)) {
    assert((await fs.lstat(lockFile)).isFile(), 'Lockfile must be a regular file');
    lock = await json(lockFile);
    assert([2, 3].includes(lock.lockfileVersion) && lock.name === pkg.name && lock.version === pkg.version && lock.packages?.['']?.version === pkg.version, 'Lockfile root/version mismatch (v2 or v3 required)');
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) equal(lock.packages[''][field] || {}, pkg[field] || {}, `Lockfile ${field} mismatch`);
    lock.version = plan.version; lock.packages[''].version = plan.version;
  }
  assert(!config.shrinkwrap || lock, 'shrinkwrap requires package-lock.json');
  assert(!await exists(path.join(root, 'npm-shrinkwrap.json')), 'Existing npm-shrinkwrap.json is unsupported; use package-lock.json and shrinkwrap:true');
  return { sourceVersion: pkg.version, pkg: { ...pkg, version: plan.version }, lock };
}
function runtimePackage(pkg, config) {
  if (config.shrinkwrap && Array.isArray(pkg.files)) return { ...pkg, files: [...new Set([...pkg.files, 'npm-shrinkwrap.json'])] };
  return pkg;
}
function names(pkg, plan, config) {
  const base = `${pkg.name.replace(/^@/, '').replace('/', '-')}-${plan.version}`;
  return { npm: `${base}.tgz`, source: config.sourceArchive ? `${base}-source.tar.gz` : null };
}
async function pack(root, destination) {
  const output = JSON.parse(checked('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', destination], root));
  assert(output.length === 1 && typeof output[0].filename === 'string' && /^[A-Za-z0-9_.~-]+\.tgz$/.test(output[0].filename), 'Unexpected npm pack result');
  return path.join(destination, output[0].filename);
}
export async function buildBundle(config, plan) {
  const root = await checkout(config, plan);
  const metadata = await manifests(root, config, plan);
  const output = config.artifactDirectory;
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'npm-release-build-'));
  try {
    await fs.mkdir(output, { recursive: true });
    assert((await fs.readdir(output)).length === 0, 'Artifact directory must be empty');
    assert(!within(await fs.realpath(config.workspace), await fs.realpath(output)), 'Build artifact directory must be outside checkout');
    const raw = path.join(temp, 'raw'); await fs.mkdir(raw);
    const initial = await pack(root, raw);
    await extractArchive(initial, temp, 'package');
    const stage = path.join(temp, 'package');
    const pkg = runtimePackage(metadata.pkg, config);
    await writeJson(path.join(stage, 'package.json'), pkg);
    if (metadata.lock && config.shrinkwrap) await writeJson(path.join(stage, 'npm-shrinkwrap.json'), metadata.lock);
    const packed = await pack(stage, output);
    const filenames = names(pkg, plan, config);
    assert(path.basename(packed) === filenames.npm, 'Unexpected release artifact name');
    if (config.sourceArchive) {
      const sourceTar = path.join(temp, 'tracked.tar.gz');
      checked('git', ['archive', '--format=tar.gz', '--prefix=source/', '-o', sourceTar, plan.commit], root);
      await extractArchive(sourceTar, temp, 'source');
      const sourceRoot = path.join(temp, 'source', config.directory);
      await writeJson(path.join(sourceRoot, 'package.json'), metadata.pkg);
      if (metadata.lock) await writeJson(path.join(sourceRoot, 'package-lock.json'), metadata.lock);
      checked('tar', ['-czf', path.join(output, filenames.source), '-C', temp, 'source'], root);
    }
    const assets = [];
    for (const filename of [filenames.npm, filenames.source].filter(Boolean)) {
      const bytes = await fs.readFile(path.join(output, filename));
      assets.push({ name: filename, sha256: digest(bytes), size: bytes.length });
    }
    const manifest = { schema: 1, plan, config: publicationConfig(config), name: pkg.name,
      sourceVersion: metadata.sourceVersion, npm: filenames.npm, source: filenames.source,
      npmIntegrity: `sha512-${digest(await fs.readFile(packed), 'sha512', 'base64')}`, assets };
    await writeJson(path.join(output, 'bundle.json'), manifest);
    await fs.writeFile(path.join(output, 'SHA256SUMS'), assets.map(a => `${a.sha256}  ${a.name}\n`).join(''));
    return await verifyBundle(config, plan);
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
}
export async function verifyBundle(config, plan) {
  const root = await checkout(config, plan);
  const { pkg, lock, sourceVersion } = await manifests(root, config, plan);
  const directory = config.artifactDirectory;
  const manifest = await json(path.join(directory, 'bundle.json'));
  assert(manifest.schema === 1, 'Unsupported artifact schema');
  equal(manifest.plan, plan, 'Artifact release plan mismatch');
  equal(manifest.config, publicationConfig(config), 'Artifact configuration mismatch');
  equal({ name: manifest.name, sourceVersion: manifest.sourceVersion }, { name: pkg.name, sourceVersion }, 'Artifact package identity mismatch');
  const filenames = names(pkg, plan, config);
  equal({ npm: manifest.npm, source: manifest.source }, filenames, 'Artifact filename mismatch');
  const expectedNames = [filenames.npm, filenames.source].filter(Boolean);
  assert(Array.isArray(manifest.assets), 'Invalid asset manifest');
  equal(manifest.assets.map(a => a.name), expectedNames, 'Artifact asset set mismatch');
  equal((await fs.readdir(directory)).sort(), [...expectedNames, 'bundle.json', 'SHA256SUMS'].sort(), 'Unexpected files in artifact directory');
  const assets = [];
  for (const asset of manifest.assets) {
    const file = path.join(directory, asset.name);
    assert((await fs.lstat(file)).isFile(), 'Artifact must be a regular file');
    const bytes = await fs.readFile(file);
    assert(digest(bytes) === asset.sha256 && bytes.length === asset.size, 'Artifact checksum mismatch');
    assets.push({ ...asset, file, digest: `sha256:${asset.sha256}` });
  }
  const sums = manifest.assets.map(a => `${a.sha256}  ${a.name}\n`).join('');
  assert(await fs.readFile(path.join(directory, 'SHA256SUMS'), 'utf8') === sums, 'Checksum file mismatch');
  const npm = path.join(directory, filenames.npm); const bytes = await fs.readFile(npm);
  assert(manifest.npmIntegrity === `sha512-${digest(bytes, 'sha512', 'base64')}`, 'npm integrity mismatch');
  const entries = archiveEntries(bytes);
  equal(archivedJson(entries, 'package/package.json'), runtimePackage(pkg, config), 'Packed package manifest mismatch');
  if (config.shrinkwrap) equal(archivedJson(entries, 'package/npm-shrinkwrap.json'), lock, 'Packed shrinkwrap mismatch');
  if (filenames.source) {
    const sourceEntries = archiveEntries(await fs.readFile(path.join(directory, filenames.source)), 'source');
    const prefix = path.posix.join('source', config.directory.replaceAll('\\', '/'));
    equal(archivedJson(sourceEntries, `${prefix}/package.json`), pkg, 'Source package manifest mismatch');
    if (lock) equal(archivedJson(sourceEntries, `${prefix}/package-lock.json`), lock, 'Source lockfile mismatch');
  }
  for (const name of ['bundle.json', 'SHA256SUMS']) {
    const file = path.join(directory, name); const data = await fs.readFile(file);
    assets.push({ name, file, digest: `sha256:${digest(data)}` });
  }
  return { manifest, plan, npm, npmIntegrity: manifest.npmIntegrity, assets };
}
