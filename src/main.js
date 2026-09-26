import fs from 'node:fs/promises';
import { readConfig, assert } from './config.js';
import { planRelease } from './plan.js';
import { checkout, json, run } from './io.js';
import { buildBundle, verifyBundle } from './bundle.js';
import { githubApi, publishGitHub, publishNpm } from './publish.js';

async function output(name, value) {
  const text = String(value);
  assert(!/[\r\n]/.test(text), 'Multiline output rejected');
  if (process.env.GITHUB_OUTPUT) await fs.appendFile(process.env.GITHUB_OUTPUT, `${name}=${text}\n`);
}
async function main() {
  assert(process.platform !== 'win32', 'This action currently supports Linux and macOS runners only');
  const config = readConfig();
  assert(process.env.GITHUB_EVENT_PATH, 'GITHUB_EVENT_PATH is required');
  assert(!process.env.GITHUB_API_URL || process.env.GITHUB_API_URL === 'https://api.github.com', 'This version supports GitHub.com only');
  const plan = planRelease({ eventName: process.env.GITHUB_EVENT_NAME, event: await json(process.env.GITHUB_EVENT_PATH),
    repository: process.env.GITHUB_REPOSITORY, ref: process.env.GITHUB_REF, commit: process.env.GITHUB_SHA,
    runNumber: process.env.GITHUB_RUN_NUMBER, runAttempt: process.env.GITHUB_RUN_ATTEMPT }, config);
  await checkout(config, plan);
  let bundle, status = config.phase;
  if (config.phase === 'build') bundle = await buildBundle(config, plan);
  else if (config.phase !== 'plan') bundle = await verifyBundle(config, plan);
  if (config.phase === 'publish-npm') {
    if (!config.dryRun) {
      assert(process.env.GITHUB_ACTIONS === 'true', 'Live publication requires GitHub Actions');
      if (config.registry === 'https://registry.npmjs.org/') {
        assert(process.env.ACTIONS_ID_TOKEN_REQUEST_URL && process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN, 'npmjs publication requires id-token:write and Trusted Publishing');
        assert(!process.env.NODE_AUTH_TOKEN && !process.env.NPM_TOKEN, 'Remove token authentication when using npmjs Trusted Publishing');
      }
      const cli = run('npm', ['--version'], config.workspace);
      const parts = cli.stdout?.trim().split('.').map(Number);
      assert(cli.status === 0 && (parts[0] > 11 || (parts[0] === 11 && (parts[1] > 5 || (parts[1] === 5 && parts[2] >= 1)))), 'Publication requires npm >=11.5.1');
    }
    status = await publishNpm(bundle, config, { run: args => run('npm', args, config.workspace) });
  } else if (config.phase === 'publish-github') {
    assert(config.dryRun || process.env.GITHUB_ACTIONS === 'true', 'Live publication requires GitHub Actions');
    status = await publishGitHub(bundle, config, { api: config.dryRun ? null : githubApi(config.token) });
  }
  for (const [key, value] of Object.entries({ version: plan.version, tag: plan.tag, commit: plan.commit,
    prerelease: plan.prerelease, 'dist-tag': plan.distTag, 'artifact-name': plan.artifactName,
    'artifact-directory': config.artifactDirectory, 'npm-file': bundle?.npm || '', status })) await output(key, value);
  console.log(`Release ${plan.version}: ${status}${config.dryRun && config.phase.startsWith('publish') ? ' (nothing uploaded)' : ''}`);
}
main().catch(error => {
  const message = ['SyntaxError', 'TypeError'].includes(error.name) ? 'Invalid input or JSON; check configuration.' : error.message;
  console.error(`::error::${String(message).replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A')}`);
  process.exitCode = 1;
});
