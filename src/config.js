import path from 'node:path';
import os from 'node:os';

export function assert(ok, message) { if (!ok) throw new Error(message); }
export function clean(value) { return typeof value === 'string' && value.length > 0 && !/[\x00-\x20\x7f]/.test(value); }
export function semver(value) {
  if (!clean(value) || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(value)) return false;
  const pre = value.split('+')[0].split('-').slice(1).join('-');
  return !pre || pre.split('.').every(p => !/^\d+$/.test(p) || p === '0' || !p.startsWith('0'));
}
export function readConfig(env = process.env) {
  const input = (key, fallback = '') => env[`INPUT_${key.toUpperCase()}`] ?? fallback;
  const bool = (key, fallback) => { const v = input(key, String(fallback)); assert(v === 'true' || v === 'false', `Invalid boolean input: ${key}`); return v === 'true'; };
  const config = {
    phase: input('phase', 'plan'),
    workspace: path.resolve(env.GITHUB_WORKSPACE || process.cwd()),
    directory: input('working-directory', '.'),
    artifactDirectory: path.resolve(input('artifact-directory') || path.join(env.RUNNER_TEMP || os.tmpdir(), 'npm-release')),
    branchPrefix: input('release-branch-prefix', 'release/'), mainBranch: input('main-branch', 'main'),
    prereleaseId: input('prerelease-id', 'beta'), prereleaseTag: input('prerelease-tag', 'beta'),
    stableTag: input('stable-tag', 'latest'), tagPrefix: input('tag-prefix', 'v'),
    registry: input('registry-url', 'https://registry.npmjs.org/'), access: input('access', 'public'),
    shrinkwrap: bool('shrinkwrap', false), sourceArchive: bool('source-archive', false),
    dryRun: bool('dry-run', true), requestedVersion: input('version'), token: input('github-token'),
  };
  assert(['plan', 'build', 'verify', 'publish-npm', 'publish-github'].includes(config.phase), 'Unknown phase');
  for (const key of ['branchPrefix', 'mainBranch', 'tagPrefix']) assert(clean(config[key]) && /^[A-Za-z0-9_./-]+$/.test(config[key]) && !config[key].includes('..') && !config[key].startsWith('-'), `Invalid ${key}`);
  assert(config.branchPrefix.endsWith('/'), 'release-branch-prefix must end with /');
  assert(/^[A-Za-z][A-Za-z0-9-]*$/.test(config.prereleaseId) && clean(config.prereleaseId), 'Invalid prerelease-id');
  for (const key of ['prereleaseTag', 'stableTag']) assert(clean(config[key]) && /^[A-Za-z][A-Za-z0-9_-]*$/.test(config[key]), `Invalid ${key}`);
  assert(config.prereleaseTag !== config.stableTag, 'Prerelease and stable tags must differ');
  const registry = new URL(config.registry);
  assert(registry.protocol === 'https:' && !registry.username && !registry.password && !registry.search && !registry.hash, 'Registry must be an HTTPS URL without credentials/query/fragment');
  config.registry = registry.href.endsWith('/') ? registry.href : `${registry.href}/`;
  assert(['public', 'restricted'].includes(config.access), 'Invalid access');
  assert(!path.isAbsolute(config.directory) && !config.directory.split(/[\\/]/).includes('..') && !/[\x00-\x1f]/.test(config.directory), 'working-directory must stay inside the workspace');
  assert(!config.requestedVersion || semver(config.requestedVersion), 'Invalid version override');
  return config;
}

export function publicationConfig(config) {
  return Object.fromEntries(['directory', 'branchPrefix', 'mainBranch', 'prereleaseId', 'prereleaseTag', 'stableTag', 'tagPrefix', 'registry', 'access', 'shrinkwrap', 'sourceArchive'].map(k => [k, config[k]]));
}
