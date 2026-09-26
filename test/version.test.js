import test from 'node:test';
import assert from 'node:assert/strict';
import { versionManifests } from '../src/version.js';

const pkg = { name: 'version-fixture', version: '1.2.3-beta.1',
  dependencies: { example: '2.0.0' },
  scripts: { preversion: 'exit 91', version: 'exit 92', postversion: 'exit 93' } };
const lock = { name: pkg.name, version: pkg.version, lockfileVersion: 3, requires: true,
  packages: { '': { name: pkg.name, version: pkg.version, dependencies: pkg.dependencies },
    'node_modules/example': { version: '2.0.0', resolved: 'https://registry.npmjs.org/example/-/example-2.0.0.tgz', integrity: 'sha512-fixture' } } };

for (const version of ['1.2.3-beta.42', '1.2.3', pkg.version]) {
  test(`npm version synchronizes copies to ${version}, including same-version retries, without hooks`, async () => {
    const before = structuredClone({ pkg, lock });
    const updated = await versionManifests(pkg, lock, version);
    assert.equal(updated.pkg.version, version);
    assert.equal(updated.lock.version, version);
    assert.equal(updated.lock.packages[''].version, version);
    assert.deepEqual(updated.pkg.dependencies, pkg.dependencies);
    assert.deepEqual(updated.pkg.scripts, pkg.scripts);
    assert.deepEqual(updated.lock.packages['node_modules/example'], lock.packages['node_modules/example']);
    assert.deepEqual({ pkg, lock }, before);
  });
}
test('npm version supports packages without lockfiles', async () => {
  const updated = await versionManifests(pkg, undefined, '2.0.0-beta.7');
  assert.equal(updated.pkg.version, '2.0.0-beta.7'); assert.equal(updated.lock, undefined);
});
test('invalid version cannot reach npm', async () => {
  await assert.rejects(versionManifests(pkg, lock, '--help'), /Invalid release version/);
});
