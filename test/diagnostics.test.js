import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeDiagnostic, commandDiagnostics } from '../src/diagnostics.js';
import { publishNpm } from '../src/publish.js';

test('diagnostics redact secrets, URL credentials and queries, authorization and terminal controls', () => {
  const result = sanitizeDiagnostic('E403 known-secret https://user:pass@example.com/?token=hidden Bearer unknown-secret npm_abcdef token=another-secret "password":"private" \x1b[31mred', { INPUT_GITHUB_TOKEN: 'known-secret' });
  for (const secret of ['known-secret', 'unknown-secret', 'another-secret', 'private', 'hidden', 'user:pass', 'npm_abcdef', '\x1b']) assert.ok(!result.includes(secret), secret);
  assert.match(result, /E403/);
  assert.equal(sanitizeDiagnostic('x'.repeat(20000)).length, 12000);
});

test('every output line is prefixed to prevent workflow command injection', () => {
  const lines = [];
  commandDiagnostics('publish', { status: null, signal: 'SIGTERM', error: { code: 'ETIMEDOUT' }, stdout: '\n::error::untrusted\nnext', stderr: 'npm error code E403' }, line => lines.push(line));
  assert.ok(lines.every(line => line.startsWith('[npm-release] publish: ')));
  assert.ok(lines.some(line => line.includes('ETIMEDOUT')));
  assert.ok(lines.some(line => line.includes('E403')));
});

const absent = { status: 1, stdout: JSON.stringify({ error: { code: 'E404' } }) };
const bundle = { manifest: { name: 'example' }, plan: { version: '1.0.0', distTag: 'latest' }, npm: '/tmp/example.tgz', npmIntegrity: 'sha512-identical' };
const config = { registry: 'https://registry.npmjs.org/', access: 'public', dryRun: false };

test('successful upload followed by invisible version logs upload output and every lookup without republishing', async () => {
  const lines = [], calls = [], waits = [];
  await assert.rejects(publishNpm(bundle, config, { run: args => {
    calls.push(args[0]);
    return args[0] === 'publish' ? { status: 0, stdout: '+ example@1.0.0', stderr: 'npm notice publication pending' } : absent;
  }, wait: async ms => waits.push(ms), log: line => lines.push(line) }), /Publication not yet visible/);
  assert.equal(calls.filter(x => x === 'publish').length, 1);
  assert.equal(calls.filter(x => x === 'view').length, 6);
  assert.deepEqual(waits, [2000, 2000, 2000, 2000]);
  assert.ok(lines.some(line => line.includes('publication pending')));
  assert.ok(lines.some(line => line.includes('registry lookup #6')));
});

test('failed upload exposes npm error code but does not proceed to polling', async () => {
  const lines = [], calls = [];
  await assert.rejects(publishNpm(bundle, config, { run: args => {
    calls.push(args[0]);
    return args[0] === 'publish' ? { status: 1, stderr: 'npm error code E403\nnpm error token=secret-value' } : absent;
  }, log: line => lines.push(line) }), /npm publish failed/);
  assert.deepEqual(calls, ['view', 'publish']);
  assert.ok(lines.some(line => line.includes('E403')));
  assert.ok(!lines.join('\n').includes('secret-value'));
});
