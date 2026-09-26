import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readConfig } from '../src/config.js';
import { checked, json, writeJson, run } from '../src/io.js';
import { buildBundle, verifyBundle } from '../src/bundle.js';
import { archiveEntries, archivedJson } from '../src/tar.js';
import { planRelease } from '../src/plan.js';

async function fixture(t, { subdirectory = '.', shrinkwrap = true, sourceArchive = true, stable = false } = {}) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'release-action-test-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const workspace = path.join(temp, 'repo'); const root = path.join(workspace, subdirectory); await fs.mkdir(root, { recursive: true });
  const pkg = { name: '@example/release-action-fixture', version: '0.0.0-dev', type: 'module', license: 'MIT', files: ['cli.js', 'long'], bin: { 'fixture-version': 'cli.js' }, scripts: { prepack: 'exit 91', postpack: 'exit 92' } };
  await writeJson(path.join(root, 'package.json'), pkg);
  await writeJson(path.join(root, 'package-lock.json'), { name: pkg.name, version: pkg.version, lockfileVersion: 3, requires: true, packages: { '': { name: pkg.name, version: pkg.version, license: pkg.license, bin: pkg.bin } } });
  await fs.writeFile(path.join(root, 'cli.js'), '#!/usr/bin/env node\nimport fs from "node:fs"; console.log(JSON.parse(fs.readFileSync(new URL("./package.json", import.meta.url))).version);\n', { mode: 0o755 });
  const long = path.join(root, 'long', 'a'.repeat(90)); await fs.mkdir(long, { recursive: true }); await fs.writeFile(path.join(long, 'b'.repeat(90) + '.txt'), 'long path\n');
  await fs.writeFile(path.join(workspace, '.gitignore'), 'node_modules/\n');
  checked('git', ['init', '-q'], workspace); checked('git', ['config', 'user.name', 'Fixture'], workspace); checked('git', ['config', 'user.email', 'fixture@example.invalid'], workspace);
  checked('git', ['add', '.'], workspace); checked('git', ['commit', '-qm', 'Fixture'], workspace);
  const commit = checked('git', ['rev-parse', 'HEAD'], workspace).trim();
  const config = readConfig({ GITHUB_WORKSPACE: workspace, 'INPUT_WORKING-DIRECTORY': subdirectory, 'INPUT_ARTIFACT-DIRECTORY': path.join(temp, 'artifacts'), INPUT_SHRINKWRAP: String(shrinkwrap), 'INPUT_SOURCE-ARCHIVE': String(sourceArchive) });
  const repository = 'example/package';
  const context = { eventName: stable ? 'pull_request' : 'push', repository, commit, ref: 'refs/heads/release/3.2.1', runNumber: '42', runAttempt: '1',
    event: stable ? { repository: { full_name: repository }, action: 'closed', pull_request: { merged: true, merge_commit_sha: commit, head: { ref: 'release/3.2.1', repo: { full_name: repository } }, base: { ref: 'main', repo: { full_name: repository } } } } : { repository: { full_name: repository }, ref: 'refs/heads/release/3.2.1', after: commit } };
  return { temp, workspace, root, config, context, plan: planRelease(context, config) };
}
for (const stable of [false, true]) test(`${stable ? 'stable' : 'beta'} bundle installs exact version; checkout is unchanged`, async t => {
  const f = await fixture(t, { stable });
  const before = await fs.readFile(path.join(f.root, 'package.json'));
  const bundle = await buildBundle(f.config, f.plan);
  assert.equal(bundle.manifest.name, '@example/release-action-fixture');
  assert.equal(bundle.manifest.assets.length, 2);
  const entries = archiveEntries(await fs.readFile(bundle.npm));
  assert.equal(archivedJson(entries, 'package/npm-shrinkwrap.json').version, f.plan.version);
  assert.ok(entries.some(e => e.name.length > 150));
  const install = path.join(f.temp, 'install'); await fs.mkdir(install); await writeJson(path.join(install, 'package.json'), { private: true });
  checked('npm', ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', bundle.npm], install);
  assert.equal(checked(process.execPath, [path.join(install, 'node_modules/@example/release-action-fixture/cli.js')], install).trim(), f.plan.version);
  assert.deepEqual(await fs.readFile(path.join(f.root, 'package.json')), before);
  assert.equal(checked('git', ['status', '--porcelain'], f.workspace).trim(), '');
  await verifyBundle(f.config, f.plan);
  await assert.rejects(buildBundle(f.config, f.plan), /must be empty/);
});
test('standalone subdirectory, no shrinkwrap and no source archive', async t => {
  const f = await fixture(t, { subdirectory: 'packages/cli', shrinkwrap: false, sourceArchive: false });
  const bundle = await buildBundle(f.config, f.plan);
  assert.equal(bundle.manifest.assets.length, 1);
  assert.ok(!archiveEntries(await fs.readFile(bundle.npm)).some(e => e.name.endsWith('npm-shrinkwrap.json')));
});
test('subdirectory source archive preserves repository-relative paths', async t => {
  const f = await fixture(t, { subdirectory: 'packages/cli', sourceArchive: true });
  const bundle = await buildBundle(f.config, f.plan);
  const entries = archiveEntries(await fs.readFile(path.join(f.config.artifactDirectory, bundle.manifest.source)), 'source');
  assert.equal(archivedJson(entries, 'source/packages/cli/package.json').version, f.plan.version);
  assert.ok(entries.some(e => e.name === 'source/.gitignore'));
});
test('artifact byte corruption and configuration changes fail verification', async t => {
  const f = await fixture(t); const bundle = await buildBundle(f.config, f.plan);
  await assert.rejects(verifyBundle({ ...f.config, stableTag: 'stable' }, f.plan), /configuration mismatch/);
  await fs.appendFile(bundle.npm, 'tampered');
  await assert.rejects(verifyBundle(f.config, f.plan), /checksum mismatch/);
});
test('manifest plan tampering fails before publication', async t => {
  const f = await fixture(t); await buildBundle(f.config, f.plan);
  const file = path.join(f.config.artifactDirectory, 'bundle.json'); const data = await json(file); data.plan.commit = 'f'.repeat(40); await writeJson(file, data);
  await assert.rejects(verifyBundle(f.config, f.plan), /plan mismatch/);
});
test('dirty checkout and wrong source commit are rejected', async t => {
  const f = await fixture(t);
  await assert.rejects(buildBundle(f.config, { ...f.plan, commit: 'f'.repeat(40) }), /planned commit/);
  await fs.writeFile(path.join(f.root, 'untracked.txt'), 'dirty');
  await assert.rejects(buildBundle(f.config, f.plan), /Source must be clean/);
});
test('private packages and lockfile mismatch fail closed', async t => {
  const f = await fixture(t);
  const pkgFile = path.join(f.root, 'package.json'); const pkg = await json(pkgFile); pkg.private = true; await writeJson(pkgFile, pkg);
  checked('git', ['add', '.'], f.workspace); checked('git', ['commit', '-qm', 'Private'], f.workspace);
  f.plan.commit = checked('git', ['rev-parse', 'HEAD'], f.workspace).trim();
  await assert.rejects(buildBundle(f.config, f.plan), /private:true/);
  delete pkg.private; pkg.version = '9.9.9'; await writeJson(pkgFile, pkg);
  checked('git', ['add', '.'], f.workspace); checked('git', ['commit', '-qm', 'Mismatch'], f.workspace);
  f.plan.commit = checked('git', ['rev-parse', 'HEAD'], f.workspace).trim();
  await assert.rejects(buildBundle(f.config, f.plan), /Lockfile root/);
});
test('real action entrypoint outputs a plan, builds and dry-runs without uploads', async t => {
  const f = await fixture(t, { shrinkwrap: false, sourceArchive: false });
  const eventPath = path.join(f.temp, 'event.json'); await writeJson(eventPath, f.context.event);
  const output = path.join(f.temp, 'outputs');
  const entry = fileURLToPath(new URL('../src/main.js', import.meta.url));
  const { spawnSync } = await import('node:child_process');
  const env = { ...process.env, GITHUB_ACTIONS: 'false', GITHUB_WORKSPACE: f.workspace, GITHUB_EVENT_PATH: eventPath, GITHUB_EVENT_NAME: 'push', GITHUB_REPOSITORY: f.plan.repository, GITHUB_REF: f.context.ref, GITHUB_SHA: f.plan.commit, GITHUB_RUN_NUMBER: '42', GITHUB_RUN_ATTEMPT: '1', GITHUB_OUTPUT: output,
    'INPUT_ARTIFACT-DIRECTORY': f.config.artifactDirectory, 'INPUT_DRY-RUN': 'true' };
  for (const phase of ['plan', 'build', 'verify', 'publish-npm', 'publish-github']) {
    const result = spawnSync(process.execPath, [entry], { cwd: f.workspace, env: { ...env, INPUT_PHASE: phase }, encoding: 'utf8', timeout: 120000 });
    assert.equal(result.status, 0, `${phase}: ${result.stderr}`);
    if (phase.startsWith('publish')) assert.match(result.stdout, /nothing uploaded/);
  }
  assert.match(await fs.readFile(output, 'utf8'), /version=3.2.1-beta.42.1/);
  const refused = spawnSync(process.execPath, [entry], { cwd: f.workspace, env: { ...env, INPUT_PHASE: 'publish-npm', 'INPUT_DRY-RUN': 'false' }, encoding: 'utf8' });
  assert.notEqual(refused.status, 0); assert.match(refused.stderr, /requires GitHub Actions/);
});
