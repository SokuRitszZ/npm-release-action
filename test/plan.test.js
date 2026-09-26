import test from 'node:test';
import assert from 'node:assert/strict';
import { readConfig, semver } from '../src/config.js';
import { planRelease } from '../src/plan.js';

const commit = 'a'.repeat(40), repository = 'example/package';
const defaults = readConfig({});
function push(overrides = {}) {
  return { eventName: 'push', repository, ref: 'refs/heads/release/2.3.4', commit,
    runNumber: '42', runAttempt: '1', event: { repository: { full_name: repository }, ref: 'refs/heads/release/2.3.4', after: commit }, ...overrides };
}
function merged() {
  return { ...push(), eventName: 'pull_request', event: { repository: { full_name: repository }, action: 'closed',
    pull_request: { merged: true, merge_commit_sha: commit, head: { ref: 'release/2.3.4', repo: { full_name: repository } }, base: { ref: 'main', repo: { full_name: repository } } } } };
}
test('push versions use one increasing run number and retries retain it', () => {
  const p = planRelease(push(), defaults);
  assert.equal(p.version, '2.3.4-beta.42'); assert.equal(p.distTag, 'beta'); assert.equal(p.commit, commit);
  assert.equal(planRelease(push({ runNumber: '43' }), defaults).version, '2.3.4-beta.43');
  assert.deepEqual(planRelease(push({ runAttempt: '2' }), defaults), p);
  assert.deepEqual(planRelease(push({ runAttempt: undefined }), defaults), p);
});
test('retry version overrides must exactly match the current run', () => {
  assert.equal(planRelease(push({ runAttempt: '2' }), { ...defaults, requestedVersion: '2.3.4-beta.42' }).version, '2.3.4-beta.42');
  for (const requestedVersion of ['2.3.4-beta.41', '2.3.4-beta.43', '2.3.4-beta.42.1', '2.3.4-beta.042', '2.3.4', '2.3.5-beta.42']) assert.throws(() => planRelease(push(), { ...defaults, requestedVersion }));
});
test('stable uses PR merge commit rather than head SHA', () => {
  const c = merged(); c.event.pull_request.head.sha = 'b'.repeat(40);
  const p = planRelease(c, defaults); assert.equal(p.version, '2.3.4'); assert.equal(p.commit, commit); assert.equal(p.distTag, 'latest'); assert.equal(p.prerelease, false);
  assert.throws(() => planRelease(c, { ...defaults, requestedVersion: '2.3.5' }));
});
test('reject unsupported events, fork PRs, unmerged PRs and different base', () => {
  for (const mutate of [c => { c.eventName = 'pull_request_target'; }, c => { c.event.action = 'opened'; }, c => { c.event.pull_request.merged = false; }, c => { c.event.pull_request.base.ref = 'dev'; }, c => { c.event.pull_request.head.repo.full_name = 'fork/package'; }, c => { c.event.repository.full_name = 'other/package'; }]) {
    const c = merged(); mutate(c); assert.throws(() => planRelease(c, defaults));
  }
});
test('reject deleted pushes, invalid commits and payload/ref mismatch', () => {
  for (const mutate of [c => { c.event.deleted = true; }, c => { c.commit = '0'.repeat(40); c.event.after = c.commit; }, c => { c.event.after = 'b'.repeat(40); }, c => { c.event.ref = 'refs/heads/main'; }]) { const c = push(); mutate(c); assert.throws(() => planRelease(c, defaults)); }
});
test('reject malformed branches and newline injection', () => {
  for (const branch of ['main', 'release/01.2.3', 'release/1.2', 'release/1.2.3-beta.1', 'release/1.2.3\n', 'release/1.2.3;echo']) {
    const c = push(); c.ref = c.event.ref = `refs/heads/${branch}`; assert.throws(() => planRelease(c, defaults));
  }
  for (const runNumber of ['0', '-1', '01', '1\n', 'NaN']) assert.throws(() => planRelease(push({ runNumber }), defaults));
});
test('branch prefixes, main branch, IDs, channels and tag prefixes are configurable', () => {
  const config = readConfig({ INPUT_RELEASE_BRANCH_PREFIX: 'ignored', 'INPUT_RELEASE-BRANCH-PREFIX': 'ship/', 'INPUT_MAIN-BRANCH': 'trunk', 'INPUT_PRERELEASE-ID': 'rc', 'INPUT_PRERELEASE-TAG': 'next', 'INPUT_STABLE-TAG': 'stable', 'INPUT_TAG-PREFIX': 'pkg-v' });
  const c = push(); c.ref = c.event.ref = 'refs/heads/ship/2.3.4';
  const p = planRelease(c, config); assert.equal(p.version, '2.3.4-rc.42'); assert.equal(p.tag, 'pkg-v2.3.4-rc.42'); assert.equal(p.distTag, 'next');
  const pr = merged(); pr.event.pull_request.head.ref = 'ship/2.3.4'; pr.event.pull_request.base.ref = 'trunk'; assert.equal(planRelease(pr, config).distTag, 'stable');
});
test('configuration rejects unsafe paths, credential URLs and malformed booleans', () => {
  for (const [key, value] of [['registry-url', 'http://example.com'], ['registry-url', 'https://user:password@example.com'], ['registry-url', 'https://example.com/?token=x'], ['working-directory', '../escape'], ['working-directory', '/tmp'], ['dry-run', 'yes'], ['prerelease-id', '01'], ['stable-tag', 'beta'], ['release-branch-prefix', 'release'], ['phase', 'shell'], ['tag-prefix', 'v\n']]) assert.throws(() => readConfig({ [`INPUT_${key.toUpperCase()}`]: value }));
  assert.equal(defaults.dryRun, true); assert.equal(defaults.sourceArchive, false); assert.equal(defaults.shrinkwrap, false);
});
test('semantic versions reject numeric leading zeros but accept build metadata', () => {
  for (const v of ['1.2.3', '1.2.3-rc.1', '1.2.3+build.1', '1.2.3-foo-bar.0']) assert.equal(semver(v), true);
  for (const v of ['01.2.3', '1.2.3-01', '1.2.3\n', 'v1.2.3']) assert.equal(semver(v), false);
});
