# Security

Please report vulnerabilities privately through this repository's GitHub Security Advisories. Do not put credentials in issues.

- Pin actions to reviewed full commit SHAs in security-sensitive workflows.
- Protect release branches, the main branch and workflow changes. Only trusted writers should be able to push release branches or merge release PRs.
- Use separate read-only build/test and privileged publication jobs. Never install project dependencies or execute package code in publication jobs.
- Never use `pull_request_target` with an untrusted checkout. This action only accepts branch `push` and merged, same-repository `pull_request` events.
- npmjs live publication requires GitHub OIDC; no automatic token fallback. Custom registries require the caller's explicit authentication setup.
- Artifact hashes detect corruption; they are not signatures or an independent trust boundary against malicious build jobs. Only download artifacts from the same trusted run, by the exact plan output name.
- A configured package, npm CLI, runner and workflow are trusted code. `npm pack` / `publish` hooks are disabled, but installing the resulting package may execute its runtime lifecycle scripts. Test it in a read-only job.
- `source-archive: true` includes the entire tracked repository, not only the selected package directory. Review tracked files before enabling it. npm contents follow the package's normal `files` / `.npmignore` rules; use a narrow `files` allowlist and inspect the tarball.
- Retry failed jobs with the same artifact. Published versions/assets are immutable and differing bytes are rejected. Protect tags against out-of-band changes.
- Publication to npm and GitHub is not atomic. An interrupted run may already have published npm; inspect state before retrying.

Supported release line: v1. The action is dependency-free and uses the GitHub runner's Node 24 runtime.
