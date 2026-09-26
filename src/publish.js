import fs from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { assert } from './config.js';

const parse = value => { try { return JSON.parse(value); } catch { return null; } };
export async function publishNpm(bundle, config, { run, wait = sleep }) {
  async function lookup() {
    const result = await run(['view', `${bundle.manifest.name}@${bundle.plan.version}`, 'dist.integrity', '--json', '--prefer-online', '--registry', config.registry]);
    const data = parse(result.stdout);
    if (result.status === 0 && typeof data === 'string' && data.startsWith('sha512-')) return data;
    if (result.status !== 0 && (data?.error?.code === 'E404' || parse(result.stderr)?.error?.code === 'E404')) return null;
    throw new Error('Registry lookup failed; only E404 is treated as an unpublished version');
  }
  if (config.dryRun) {
    const result = await run(['publish', bundle.npm, '--dry-run', '--ignore-scripts', '--access', config.access, '--tag', bundle.plan.distTag, '--registry', config.registry]);
    assert(result.status === 0, 'npm publish dry-run failed'); return 'dry-run';
  }
  const previous = await lookup();
  if (previous) {
    assert(previous === bundle.npmIntegrity, 'Published version has different bytes; refusing overwrite');
    return 'already-published'; // Do not move a dist-tag backwards during a retry.
  }
  const result = await run(['publish', bundle.npm, '--ignore-scripts', '--access', config.access, '--tag', bundle.plan.distTag, '--registry', config.registry]);
  assert(result.status === 0, 'npm publish failed; inspect registry state before retrying');
  for (let i = 0; i < 5; i++) {
    const integrity = await lookup();
    if (integrity === bundle.npmIntegrity) return 'published';
    assert(!integrity, 'Published integrity mismatch');
    if (i < 4) await wait(2000);
  }
  throw new Error('Publication not yet visible; inspect registry before retrying');
}

export function githubApi(token, fetcher = fetch) {
  assert(token, 'github-token is required for GitHub publication');
  return async (method, endpoint, body, upload = false) => {
    const url = `${upload ? 'https://uploads.github.com' : 'https://api.github.com'}${endpoint}`;
    const response = await fetcher(url, { method, redirect: 'error', signal: AbortSignal.timeout(120000), headers: {
      authorization: `Bearer ${token}`, accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28', 'user-agent': 'release-branch-npm-publisher',
      ...(body ? { 'content-type': upload ? 'application/octet-stream' : 'application/json' } : {}),
    }, ...(body ? { body: upload ? body : JSON.stringify(body) } : {}) });
    if (!response.ok) { const error = new Error(`GitHub request failed (HTTP ${response.status})`); error.status = response.status; throw error; }
    return response.status === 204 ? null : response.json();
  };
}
export async function publishGitHub(bundle, config, { api }) {
  if (config.dryRun) return 'dry-run';
  const { plan, assets } = bundle;
  const base = `/repos/${plan.repository}`;
  let tagRef;
  try { tagRef = await api('GET', `${base}/git/ref/tags/${encodeURIComponent(plan.tag)}`); }
  catch (error) { if (error.status !== 404) throw error; }
  if (tagRef) {
    let object = tagRef.object;
    for (let depth = 0; object.type === 'tag' && depth < 5; depth++) object = (await api('GET', `${base}/git/tags/${object.sha}`)).object;
    assert(object.type === 'commit' && object.sha === plan.commit, 'Remote tag points at another commit');
  }
  let release;
  try { release = await api('GET', `${base}/releases/tags/${encodeURIComponent(plan.tag)}`); }
  catch (error) {
    if (error.status !== 404) throw error;
    // Drafts are not reliably returned by the by-tag endpoint. Find a partial
    // release explicitly before creating another draft during a failed-job retry.
    for (let page = 1; !release; page++) {
      const rows = await api('GET', `${base}/releases?per_page=100&page=${page}`);
      const matches = rows.filter(r => r.tag_name === plan.tag);
      assert(matches.length <= 1, 'Multiple releases have the same tag; resolve manually');
      release = matches[0];
      if (rows.length < 100) break;
      assert(page < 100, 'Excessive release history');
    }
    if (!release) release = await api('POST', `${base}/releases`, { tag_name: plan.tag, target_commitish: plan.commit,
      name: plan.tag, draft: true, prerelease: plan.prerelease, generate_release_notes: true });
  }
  assert(release.tag_name === plan.tag && release.prerelease === plan.prerelease, 'Existing release metadata mismatch');
  assert(tagRef || (release.draft && release.target_commitish === plan.commit), 'Unverified existing release target');
  const existing = [];
  for (let page = 1; ; page++) {
    const rows = await api('GET', `${base}/releases/${release.id}/assets?per_page=100&page=${page}`);
    existing.push(...rows); if (rows.length < 100) break;
    assert(page < 100, 'Excessive release assets');
  }
  for (const asset of assets) {
    const previous = existing.find(a => a.name === asset.name);
    if (previous) {
      assert(previous.digest === asset.digest, 'Existing release asset digest missing or different; refusing overwrite');
      continue;
    }
    const uploaded = await api('POST', `${base}/releases/${release.id}/assets?name=${encodeURIComponent(asset.name)}`, await fs.readFile(asset.file), true);
    assert(uploaded.digest === asset.digest, 'Uploaded release asset digest mismatch');
  }
  if (release.draft) await api('PATCH', `${base}/releases/${release.id}`, { draft: false, prerelease: plan.prerelease, make_latest: plan.prerelease ? 'false' : 'true' });
  return 'published';
}
