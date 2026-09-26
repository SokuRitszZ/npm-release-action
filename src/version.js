import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { assert, semver } from './config.js';
import { checked, json, writeJson } from './io.js';

// Give npm isolated manifest copies, never the checkout or its scripts/config.
// The returned manifests are also used for read-only artifact verification.
export async function versionManifests(pkg, lock, version) {
  assert(semver(version), 'Invalid release version');
  const stage = await fs.mkdtemp(path.join(os.tmpdir(), 'npm-release-version-'));
  try {
    await writeJson(path.join(stage, 'package.json'), pkg);
    if (lock) await writeJson(path.join(stage, 'package-lock.json'), lock);
    checked('npm', ['version', version, '--no-git-tag-version', '--ignore-scripts',
      '--allow-same-version', '--workspaces=false', '--offline'], stage);
    const updatedPkg = await json(path.join(stage, 'package.json'));
    const updatedLock = lock ? await json(path.join(stage, 'package-lock.json')) : undefined;
    assert(updatedPkg.version === version && (!lock || (updatedLock.version === version && updatedLock.packages?.['']?.version === version)), 'npm version did not synchronize manifests');
    return { pkg: updatedPkg, lock: updatedLock };
  } finally { await fs.rm(stage, { recursive: true, force: true }); }
}
