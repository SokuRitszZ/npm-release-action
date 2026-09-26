import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { assert } from './config.js';

export function run(command, args, cwd, { timeout = 120000 } = {}) {
  return spawnSync(command, args, { cwd, encoding: 'utf8', timeout, maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, COPYFILE_DISABLE: '1', npm_config_ignore_scripts: 'true', npm_config_audit: 'false', npm_config_fund: 'false' } });
}
export function checked(command, args, cwd, options) {
  const result = run(command, args, cwd, options);
  // Never dump raw npm/git errors: they can contain authenticated URLs or tokens.
  assert(result.status === 0, `${command} command failed (exit ${result.status ?? 'unknown'}); check configuration and connectivity`);
  return result.stdout;
}
export async function json(file) { return JSON.parse(await fs.readFile(file, 'utf8')); }
export async function writeJson(file, data) { await fs.writeFile(file, `${JSON.stringify(data, null, 2)}\n`); }
export function within(root, file) { const rel = path.relative(root, file); return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel)); }
export async function checkout(config, plan) {
  const workspace = await fs.realpath(config.workspace);
  const root = await fs.realpath(path.resolve(workspace, config.directory));
  assert(within(workspace, root), 'Package directory escapes workspace');
  const gitRoot = await fs.realpath(checked('git', ['rev-parse', '--show-toplevel'], root).trim());
  assert(gitRoot === workspace, 'Workspace must be the checkout root');
  assert(checked('git', ['rev-parse', 'HEAD'], root).trim() === plan.commit, 'Checkout does not match the planned commit');
  assert(checked('git', ['status', '--porcelain', '--untracked-files=normal'], workspace).trim() === '', 'Source must be clean; ignore generated build outputs');
  // If a release tag already exists locally, it must point to this exact source commit.
  const tag = run('git', ['rev-parse', '--verify', `refs/tags/${plan.tag}^{commit}`], root);
  assert(tag.status !== 0 || tag.stdout.trim() === plan.commit, 'Existing release tag points at another commit');
  return root;
}
