import { assert, clean, semver } from './config.js';

const counter = value => clean(value) && /^[1-9]\d*$/.test(value);
const sha = value => clean(value) && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value) && !/^0+$/.test(value);

export function planRelease(context, config) {
  const { eventName, event, repository, ref, commit: eventCommit, runNumber, runAttempt } = context;
  assert(clean(repository) && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) && event?.repository?.full_name === repository, 'Event repository mismatch');
  let branch, commit, prerelease;
  if (eventName === 'push') {
    assert(!event.deleted && ref?.startsWith('refs/heads/') && event.ref === ref && event.after === eventCommit, 'Invalid branch push');
    branch = ref.slice('refs/heads/'.length); commit = eventCommit; prerelease = true;
  } else if (eventName === 'pull_request') {
    const pr = event.pull_request;
    assert(event.action === 'closed' && pr?.merged === true && pr.base?.ref === config.mainBranch && pr.head?.repo?.full_name === repository && pr.base?.repo?.full_name === repository, 'Stable releases require a merged same-repository release PR');
    branch = pr.head.ref; commit = pr.merge_commit_sha; prerelease = false;
  } else throw new Error('Only branch push and merged pull_request events are supported');
  assert(clean(branch) && branch.startsWith(config.branchPrefix) && sha(commit), 'Invalid release branch or commit');
  const baseVersion = branch.slice(config.branchPrefix.length);
  assert(semver(baseVersion) && /^\d+\.\d+\.\d+$/.test(baseVersion), 'Release branch must end in x.y.z (no prerelease or leading zeros)');
  let version = baseVersion;
  if (prerelease) {
    assert(counter(runNumber) && counter(runAttempt), 'Invalid workflow run counters');
    version = `${baseVersion}-${config.prereleaseId}.${runNumber}.${runAttempt}`;
    if (config.requestedVersion) {
      const prefix = `${baseVersion}-${config.prereleaseId}.${runNumber}.`;
      const attempt = config.requestedVersion.startsWith(prefix) ? config.requestedVersion.slice(prefix.length) : '';
      assert(counter(attempt) && BigInt(attempt) <= BigInt(runAttempt), 'Version override must belong to this run and an existing attempt');
      version = config.requestedVersion;
    }
  } else assert(!config.requestedVersion || config.requestedVersion === baseVersion, 'Stable version override mismatch');
  return { repository, branch, commit, baseVersion, version, prerelease,
    tag: `${config.tagPrefix}${version}`, distTag: prerelease ? config.prereleaseTag : config.stableTag,
    artifactName: `npm-release-${version}-${commit}` };
}
