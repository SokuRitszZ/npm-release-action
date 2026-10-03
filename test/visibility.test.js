import test from 'node:test';
import assert from 'node:assert/strict';
import { publishNpm } from '../src/publish.js';
const absent = { status: 1, stdout: '{"error":{"code":"E404"}}' };
const bundle = { manifest: { name: 'example' }, plan: { version: '1.0.0', distTag: 'latest' }, npm: '/tmp/example.tgz', npmIntegrity: 'sha512-identical' };
const config = { registry: 'https://registry.npmjs.org/', access: 'public', dryRun: false };

test('registry processing for more than a minute succeeds without uploading twice', async () => {
  let clock = 0, uploads = 0;
  const result = await publishNpm(bundle, config, {
    now: () => clock, wait: async ms => { clock += ms; }, log: () => {},
    run: args => {
      if (args[0] === 'publish') { uploads++; return { status: 0 }; }
      return clock >= 75000 ? { status: 0, stdout: JSON.stringify(bundle.npmIntegrity) } : absent;
    },
  });
  assert.equal(result, 'published'); assert.equal(uploads, 1); assert.equal(clock, 75000);
});

test('slow registry calls count against budget and receive bounded subprocess timeouts', async () => {
  let clock = 0, uploads = 0;
  const timeouts = [];
  await assert.rejects(publishNpm(bundle, config, {
    now: () => clock, wait: async ms => { clock += ms; }, log: () => {},
    run: (args, options) => {
      if (args[0] === 'publish') { uploads++; return { status: 0 }; }
      if (uploads) { timeouts.push(options.timeout); clock += options.timeout; }
      return absent;
    },
  }), /after 300s/);
  assert.equal(clock, 300000); assert.equal(uploads, 1);
  assert.ok(timeouts.every(ms => ms > 0 && ms <= 30000));
});

test('non-404 and integrity mismatch after upload fail immediately rather than waiting five minutes', async () => {
  for (const response of [{ status: 1, stdout: '{"error":{"code":"E403"}}' }, { status: 0, stdout: '"sha512-wrong"' }]) {
    let uploads = 0;
    await assert.rejects(publishNpm(bundle, config, {
      log: () => {}, wait: async () => assert.fail('must not retry'),
      run: args => {
        if (args[0] === 'publish') { uploads++; return { status: 0 }; }
        return uploads ? response : absent;
      },
    }), /Registry lookup failed|integrity mismatch/);
    assert.equal(uploads, 1);
  }
});
