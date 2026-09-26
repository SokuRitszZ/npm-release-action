# Changelog

## Unreleased

- Delegate manifest version updates to native `npm version` on isolated copies; disable lifecycle scripts and Git tagging, and allow same-version retries.
- Simplify prerelease versions to `x.y.z-beta.<run_number>` (one increasing number). All retries keep the same version; differing existing bytes still fail closed.

## 1.0.0

- Release-branch betas and same-repository PR-merge stable versions.
- Configurable branch prefix, target branch, package directory, prerelease identifier, dist-tags, tag prefix, registry and package access.
- Separate plan/build/verify/npm/GitHub publication phases with dry-run by default.
- Artifact-only manifest stamping; optional application shrinkwrap and tracked-source archive.
- OIDC npm publication, integrity-checked retries and draft-first immutable GitHub assets.
- Zero runtime dependencies; Linux/macOS tests and complete least-privilege workflow example.
