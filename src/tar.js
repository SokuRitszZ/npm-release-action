import fs from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { assert } from './config.js';

const LIMIT = 256 * 1024 * 1024;
const text = bytes => bytes.toString('utf8').replace(/\0.*$/s, '');
function octal(bytes) { const value = text(bytes).trim(); assert(/^[0-7]*$/.test(value), 'Unsupported tar numeric header'); return value ? parseInt(value, 8) : 0; }
function paxFields(bytes) {
  const fields = {};
  for (let offset = 0; offset < bytes.length;) {
    const space = bytes.indexOf(32, offset);
    assert(space > offset, 'Invalid PAX header');
    const lengthText = bytes.subarray(offset, space).toString();
    assert(/^[1-9]\d*$/.test(lengthText), 'Invalid PAX length');
    const length = Number(lengthText);
    assert(length > space - offset + 2 && offset + length <= bytes.length && bytes[offset + length - 1] === 10, 'Invalid PAX record');
    const record = bytes.subarray(space + 1, offset + length - 1).toString('utf8');
    const eq = record.indexOf('='); assert(eq > 0, 'Invalid PAX field');
    fields[record.slice(0, eq)] = record.slice(eq + 1); offset += length;
  }
  return fields;
}
// Deliberately accept regular files/directories only; never extract links or devices.
export function archiveEntries(compressed, prefix = 'package') {
  assert(compressed.length <= LIMIT, 'Archive exceeds 256 MiB limit');
  const data = gunzipSync(compressed, { maxOutputLength: LIMIT });
  const entries = []; const seen = new Set(); let pax = {};
  for (let offset = 0; offset + 512 <= data.length;) {
    const header = data.subarray(offset, offset + 512);
    if (header.every(b => b === 0)) {
      assert(data.subarray(offset).every(b => b === 0), 'Unexpected data after tar terminator');
      return entries;
    }
    const expected = octal(header.subarray(148, 156));
    const actual = header.reduce((sum, b, i) => sum + (i >= 148 && i < 156 ? 32 : b), 0);
    assert(expected === actual, 'Invalid tar header checksum');
    const size = octal(header.subarray(124, 136));
    assert(size <= LIMIT && offset + 512 + size <= data.length, 'Truncated tar member');
    const body = data.subarray(offset + 512, offset + 512 + size);
    const type = header[156]; offset += 512 + Math.ceil(size / 512) * 512;
    if (type === 120) { pax = paxFields(body); continue; }
    // git archive adds a global comment containing the source commit.
    if (type === 103) { const global = paxFields(body); assert(Object.keys(global).every(k => k === 'comment'), 'Unsupported global PAX fields'); continue; }
    assert(type === 0 || type === 48 || type === 53, 'Archive links and special files are not supported');
    const pre = text(header.subarray(345, 500));
    let name = pax.path ?? `${pre ? `${pre}/` : ''}${text(header.subarray(0, 100))}`;
    assert(pax.size === undefined || String(size) === pax.size, 'Unsupported PAX size override'); pax = {};
    if (type === 53 && name.endsWith('/')) name = name.slice(0, -1);
    assert(name === prefix || name.startsWith(`${prefix}/`), 'Archive member has unexpected root');
    assert(!/[\\\x00-\x1f\x7f]/.test(name) && name.split('/').every(p => p && p !== '.' && p !== '..'), 'Unsafe archive member path');
    assert(!seen.has(name), 'Duplicate archive member'); seen.add(name);
    assert(type === 53 || name !== prefix, 'Archive root must be a directory');
    entries.push({ name, directory: type === 53, mode: octal(header.subarray(100, 108)) & 0o777, data: body });
  }
  throw new Error('Missing tar terminator');
}
export async function extractArchive(file, destination, prefix) {
  const entries = archiveEntries(await fs.readFile(file), prefix);
  for (const entry of entries) {
    const filePath = path.join(destination, entry.name);
    if (entry.directory) await fs.mkdir(filePath, { recursive: true });
    else {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, entry.data, { flag: 'wx', mode: entry.mode });
    }
  }
  return entries;
}
export function archivedJson(entries, name) {
  const entry = entries.find(e => e.name === name && !e.directory);
  assert(entry, `Required archive manifest missing: ${name}`);
  return JSON.parse(entry.data.toString('utf8'));
}
