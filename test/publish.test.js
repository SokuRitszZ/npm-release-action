import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { publishNpm, publishGitHub, githubApi } from '../src/publish.js';

const bundle = { manifest: { name: 'example-package' }, plan: { version: '1.2.3', distTag: 'latest', repository: 'example/package', tag: 'v1.2.3', commit: 'a'.repeat(40), prerelease: false }, npm: '/tmp/package.tgz', npmIntegrity: 'sha512-identical', assets: [] };
const config = { registry: 'https://registry.npmjs.org/', access: 'public', dryRun: false };
const ok = value => ({ status: 0, stdout: JSON.stringify(value) });
const absent = { status: 1, stdout: JSON.stringify({ error: { code: 'E404' } }) };
test('npm dry-run never invokes non-dry publish or registry lookup', async () => {
  const calls = []; assert.equal(await publishNpm(bundle, { ...config, dryRun: true }, { run: args => { calls.push(args); return ok({}); } }), 'dry-run');
  assert.equal(calls.length, 1); assert.ok(calls[0].includes('--dry-run')); assert.ok(calls[0].includes('--ignore-scripts'));
});
test('identical npm retries skip upload and never move channels', async () => {
  const calls = []; assert.equal(await publishNpm(bundle, config, { run: args => { calls.push(args); return ok(bundle.npmIntegrity); } }), 'already-published');
  assert.deepEqual(calls.map(c => c[0]), ['view']);
});
test('different npm bytes and non-404 errors fail closed', async () => {
  for (const result of [ok('sha512-other'), { status: 1, stderr: JSON.stringify({ error: { code: 'E403' } }) }, { status: 1, stderr: 'network failed' }, ok(null)]) {
    await assert.rejects(publishNpm(bundle, config, { run: args => { assert.equal(args[0], 'view'); return result; } }));
  }
});
test('new npm publication checks integrity after upload', async () => {
  const replies = [absent, ok({}), absent, ok(bundle.npmIntegrity)]; const calls = [];
  assert.equal(await publishNpm(bundle, config, { run: args => { calls.push(args); return replies.shift(); }, wait: async () => {} }), 'published');
  assert.deepEqual(calls.map(c => c[0]), ['view', 'publish', 'view', 'view']);
  assert.ok(calls[1].includes('latest'));
});
test('npm successful command with different visible integrity fails', async () => {
  const replies = [absent, ok({}), ok('sha512-wrong')];
  await assert.rejects(publishNpm(bundle, config, { run: () => replies.shift() }), /integrity mismatch/);
});
const notFound = () => { const error = new Error('Not found'); error.status = 404; throw error; };
test('GitHub dry-run makes no requests', async () => {
  assert.equal(await publishGitHub(bundle, { dryRun: true }, { api: () => assert.fail('no requests expected') }), 'dry-run');
});
test('GitHub creates draft, verifies upload and finalizes last', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'release-upload-')); t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const file = path.join(temp, 'a.tgz'); await fs.writeFile(file, 'fixture');
  const assets = [{ name: 'a.tgz', file, digest: 'sha256-fixture' }]; const methods = [];
  await publishGitHub({ ...bundle, assets }, config, { api: async (method, endpoint, body, upload) => {
    methods.push(method);
    if (endpoint.includes('/git/ref/') || endpoint.includes('/releases/tags/')) return notFound();
    if (method === 'POST' && !upload) { assert.equal(body.draft, true); return { id: 1, tag_name: bundle.plan.tag, target_commitish: bundle.plan.commit, prerelease: false, draft: true }; }
    if (method === 'GET') return [];
    if (upload) return { digest: assets[0].digest };
    assert.equal(method, 'PATCH'); assert.equal(body.draft, false);
  } });
  assert.deepEqual(methods, ['GET', 'GET', 'GET', 'POST', 'GET', 'POST', 'PATCH']);
});
test('GitHub reuses a partial draft when by-tag lookup returns 404', async () => {
  const calls = [];
  await publishGitHub(bundle, config, { api: async (method, endpoint) => {
    calls.push(method);
    if (endpoint.includes('/git/ref/') || endpoint.includes('/releases/tags/')) return notFound();
    if (endpoint.includes('/releases?')) return [{ id: 7, tag_name: bundle.plan.tag, target_commitish: bundle.plan.commit, prerelease: false, draft: true }];
    if (method === 'GET') return [];
    assert.equal(method, 'PATCH');
  } });
  assert.ok(!calls.includes('POST')); assert.equal(calls.at(-1), 'PATCH');
});
test('GitHub rejects wrong tag commit, including annotated tags', async () => {
  await assert.rejects(publishGitHub(bundle, config, { api: async (_, endpoint) => endpoint.includes('/git/ref/') ? { object: { type: 'tag', sha: 'b'.repeat(40) } } : { object: { type: 'commit', sha: 'c'.repeat(40) } } }), /another commit/);
});
test('GitHub retry skips identical assets; differing assets stay draft', async () => {
  for (const digest of ['sha256-fixture', 'sha256-different', undefined]) {
    const calls = [];
    const promise = publishGitHub({ ...bundle, assets: [{ name: 'a.tgz', digest: 'sha256-fixture' }] }, config, { api: async (method, endpoint) => {
      calls.push(method);
      if (endpoint.includes('/git/ref/')) return { object: { type: 'commit', sha: bundle.plan.commit } };
      if (endpoint.includes('/releases/tags/')) return { id: 1, tag_name: bundle.plan.tag, prerelease: false, draft: true };
      if (method === 'GET') return [{ name: 'a.tgz', digest }];
      assert.equal(method, 'PATCH');
    } });
    if (digest === 'sha256-fixture') { await promise; assert.equal(calls.at(-1), 'PATCH'); }
    else { await assert.rejects(promise, /refusing overwrite/); assert.ok(!calls.includes('PATCH')); }
    assert.ok(!calls.includes('POST'));
  }
});
test('GitHub lookup errors other than 404 cannot create releases', async () => {
  await assert.rejects(publishGitHub(bundle, config, { api: async () => { const e = new Error('Forbidden'); e.status = 403; throw e; } }), /Forbidden/);
});
test('GitHub API errors never include response bodies or credentials', async () => {
  const api = githubApi('secret-token', async () => ({ ok: false, status: 403, text: async () => 'sensitive body' }));
  await assert.rejects(api('GET', '/repos/example/package'), error => error.message === 'GitHub request failed (HTTP 403)');
});
