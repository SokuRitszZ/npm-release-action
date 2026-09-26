# Release Branch npm Publisher

[![CI](https://github.com/SokuRitszZ/npm-release-action/actions/workflows/ci.yml/badge.svg)](https://github.com/SokuRitszZ/npm-release-action/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

A dependency-free GitHub Action that turns release branches into npm betas and merged release PRs into stable packages. Build once, test the exact tarball, and publish those same bytes with npm Trusted Publishing.

- Push `release/1.2.3` → `1.2.3-beta.<run_number>`, npm `beta`.
- Push again → a new beta (`beta.42`, `beta.43`, …). Retries retain the same version. The counter is workflow-wide, not reset for each release branch; failed runs can leave gaps.
- Merge a **same-repository** `release/1.2.3` PR into `main` → `1.2.3`, npm `latest`, from the merge commit.
- Direct pushes to `main`, fork PRs, unmerged PRs, manual-dispatch and tag events are rejected.
- Versions are stamped **only into artifacts**, not committed back to your source branch. Manifest updates use native `npm version` on isolated copies, with Git commits/tags, lifecycle hooks and network access disabled; same-version retries are allowed.
- Publishing is **dry-run by default**. No npm package is installed to use this action.

## Quick start

Copy [examples/release.yml](examples/release.yml) to `.github/workflows/release.yml` in your package repository. It includes a Linux/macOS × Node 22/24 test matrix, exact-artifact installation, and separate least-privilege publishing jobs. Customize the test/build steps for your project.

For example, the build phase is:

```yaml
- uses: SokuRitszZ/npm-release-action@v1
  id: bundle
  with:
    phase: build
    version: ${{ needs.plan.outputs.version }}
    # Optional for applications/CLIs, normally leave false for libraries:
    shrinkwrap: 'true'
    source-archive: 'false'
```

Use a reviewed full commit SHA instead of `@v1` for stronger supply-chain pinning. The `v1` tag tracks compatible releases; `v1.0.0` identifies this initial release.

### Enable real publication

1. Ensure you own the npm package. A first bootstrap publication may be needed before npm lets you configure its Trusted Publisher; this action does not bypass package ownership or first-time authentication.
2. In the package's npm settings, add a GitHub Actions Trusted Publisher for **your consuming repository**, its **top-level calling workflow filename** (e.g. `release.yml`), and the matching environment (the example uses `npm-publish`). Do **not** point it at this action repository. Check current [npm Trusted Publishing documentation](https://docs.npmjs.com/trusted-publishers/).
3. Create the `npm-publish` GitHub environment; allow deployment from both `release/*` and `main`. Configure approval/branch protection as appropriate.
4. Use Node 24 and npm >=11.5.1 in the npm publication job. The example pins npm 11.12.1. Grant `id-token: write` only to that job; do not configure `NODE_AUTH_TOKEN`, `NPM_TOKEN` or token-based npmrc authentication for npmjs OIDC.
5. Set repository variable `NPM_PUBLISH_ENABLED=true`. To also publish GitHub Releases, set `RELEASE_ASSETS_ENABLED=true`.
6. Push a release branch. Inspect the beta, then merge its PR to publish stable. No version commit or manually created package tag is needed.

A green workflow with publication disabled is **not** a registry release. Private-repository provenance and npm account policies may impose additional restrictions; verify your npm configuration rather than falling back silently to tokens.

## Inputs

All `with:` values are strings; quote booleans. Use the same package/versioning/publication configuration in every phase; the bundle records it and mismatches fail verification.

| Input | Default | Meaning |
| --- | --- | --- |
| `phase` | `plan` | `plan`, `build`, `verify`, `publish-npm`, `publish-github` |
| `working-directory` | `.` | Standalone npm package path, relative to checkout root |
| `artifact-directory` | `$RUNNER_TEMP/npm-release` | Bundle location; build requires an empty directory outside checkout |
| `release-branch-prefix` | `release/` | Prefix followed by an exact `x.y.z`; must end in `/` |
| `main-branch` | `main` | PR target branch required for stable publication |
| `prerelease-id` | `beta` | Version identifier, e.g. `rc` produces `1.2.3-rc.42` |
| `prerelease-tag` | `beta` | npm prerelease distribution tag, e.g. `next` |
| `stable-tag` | `latest` | npm stable distribution tag |
| `tag-prefix` | `v` | GitHub release tag prefix, e.g. `cli-v` |
| `registry-url` | `https://registry.npmjs.org/` | HTTPS registry, no credentials/query/fragment |
| `access` | `public` | `public` or `restricted` |
| `shrinkwrap` | `false` | Generate application shrinkwrap from the package's lockfile |
| `source-archive` | `false` | Archive **all tracked repository files**, not just package directory |
| `version` | derived | Pass `plan`'s version to subsequent jobs, especially for failed-job retries |
| `dry-run` | `true` | Set `false` explicitly in publishing phases to upload |
| `github-token` | `${{ github.token }}` | `contents:write` token, used only by `publish-github` |

Changing branch names/prefixes also requires updating your caller's `on:` filters and job guard. Custom registries require your own authentication setup; built-in OIDC enforcement applies to npmjs. `publishConfig` in package.json must not conflict with the selected registry/channel/access.

### Outputs

`version`, `tag`, `commit`, `prerelease`, `dist-tag`, `artifact-name`, `artifact-directory`, `npm-file` (absolute tarball path, empty in `plan`), `status`.

## Phases and permissions

| Phase | Behavior | Permissions |
| --- | --- | --- |
| `plan` | Validate event, release branch, merge provenance and clean exact checkout; derive version | `contents: read` |
| `build` | Pack, safely stage and stamp manifests, optionally archive source, hash and verify | `contents: read` |
| `verify` | Revalidate plan/configuration, hashes and packed manifests; no upload | `contents: read` |
| `publish-npm` | Verify exact artifact, dry-run or publish; integrity-checked retry | `contents: read`, plus `id-token: write` for live npmjs |
| `publish-github` | Verify bundle; create/reuse draft, upload immutable assets, publish last | `contents: write` for live publication |

Always check out the **plan's commit** in downstream jobs with `persist-credentials: false`; fetch tags (`fetch-depth: 0`) for conflict checks. For the initial plan, use the PR `merge_commit_sha` when the event is a merged PR, otherwise `github.sha`.

Build/test steps belong in unprivileged jobs. Build your compiled output before `phase: build`; this action intentionally never executes `prepack`, `prepare` or other pack/publish hooks. Generated files must be gitignored so the source checkout stays clean. If your compiled code embeds a version, pass `plan.version` as a build environment variable and configure your build to use it: artifact stamping changes manifests, not already-compiled code.

Upload the full bundle under `artifact-name`. Download that exact same-run artifact to `artifact-directory` in each publishing job. Do **not** rebuild in publication jobs, run package code there, or give test jobs write/OIDC permissions. Add package-specific CLI/API smoke assertions to the example's artifact-install step.

The npm bundle preserves your package's normal npm contents and runtime scripts, changes its version, and optionally adds `npm-shrinkwrap.json`. Use a narrow `files` allowlist and inspect the resulting package. Source archives contain tracked source, **not** generated build output; selected package manifests have the release version.

## Retry and ordering behavior

- Both failed-job and full-run retries retain the same version for the **same run**. Prefer retrying failed jobs with the original artifact and `plan.version`; rebuilding a source archive can change its bytes and fail immutable-asset checks. Start a new run via a new push if a new beta version is needed.
- Existing npm versions are skipped only if SHA-512 integrity matches. Only explicit registry `E404` means absent; auth/network failures stop publication.
- Existing GitHub assets must have the same SHA-256 digest. They are never clobbered. Partial uploads remain drafts.
- Retrying an already-published npm version does not move its dist-tag backwards.
- Parallel runs can finish out of order: `beta`/`latest` points to the last new upload, not necessarily the last push or highest version. Publish stable versions sequentially.
- Avoid a shared branch concurrency group if every push must produce a beta: GitHub can replace a pending run even with `cancel-in-progress: false`. The example groups by run ID.
- npm and GitHub Release publication are not atomic. Inspect both after interruption.

## Support boundaries

- GitHub.com; Linux and macOS runners. JavaScript action runtime: Node 24 (requires a sufficiently recent Actions runner). The npm CLI comes from the caller's PATH.
- One standalone npm package per invocation. A subdirectory works if it has its own manifests. Workspace-root packages, `file:`/`link:`/`workspace:` runtime dependencies and multi-package version coordination are not supported.
- Optional package-lock.json must be lockfile v2/v3 with matching root version/dependencies. `shrinkwrap: true` requires it. Existing source `npm-shrinkwrap.json` is rejected; generate it from package-lock instead.
- Archives are limited to 256 MiB compressed/uncompressed and regular files/directories. Links, special files, duplicate entries and traversal paths are rejected.
- npm `private:true` packages are rejected. This action itself is `private:true` because it is distributed through GitHub, not npm.

## Development

```sh
npm ci --ignore-scripts
npm run check
npm test
```

Tests use temporary Git repositories, real pack/install and dry-run publication, and mocked network APIs. No test publishes a package. The repository's `release/*` CI smoke jobs invoke the actual Action on a tiny fixture, on Linux and macOS, with publication forced to dry-run.

See [SECURITY.md](SECURITY.md) and [CHANGELOG.md](CHANGELOG.md). MIT licensed.
