import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { archiveEntries } from '../src/tar.js';
function tar(name, type = '0') {
  const header = Buffer.alloc(512); header.write(name); header.write('0000644\0', 100); header.write('00000000000\0', 124); header.fill(32, 148, 156); header.write(type, 156);
  header.write(header.reduce((s, b) => s + b, 0).toString(8).padStart(6, '0') + '\0 ', 148);
  return gzipSync(Buffer.concat([header, Buffer.alloc(1024)]));
}
test('regular package files are accepted', () => assert.equal(archiveEntries(tar('package/index.js'))[0].name, 'package/index.js'));
test('archive traversal, alternate roots, links, devices and control characters are rejected', () => {
  for (const name of ['package/../escape', '/package/file', 'other/file', 'package/a\\b', 'package/a\nb', 'package//file']) assert.throws(() => archiveEntries(tar(name)));
  for (const type of ['1', '2', '3', '4', '6']) assert.throws(() => archiveEntries(tar('package/link', type)));
});
test('invalid gzip fails closed', () => assert.throws(() => archiveEntries(Buffer.from('not gzip'))));
