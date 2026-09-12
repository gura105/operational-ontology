# Repository workflow

This is a small, readable reference implementation of Operational Ontology. Keep the runtime and examples easy to read; prefer focused changes over new abstractions. README explains the concept; IMPLEMENTATION explains runtime contracts.

## Development

- `main` contains the published application; `next` collects work for the next release. Keep `main` as the default branch for readers.
- Start ordinary work from the latest `origin/next`, on a separate branch. Target `next` explicitly when creating a PR (`gh pr create --base next`).
- Keep commits focused. Update affected examples, tests, and both language versions of documentation with API changes.
- Run `pnpm typecheck`, `pnpm test`, and `pnpm demo` before merging changes. CI must pass.
- Merging an ordinary PR does not request a release. Do not bump the version, create a version tag, or publish a Release for each PR.
- Do not push directly to, delete, or force-push `main` or `next`. Do not bypass or weaken repository rules to complete a task.

## Release

1. When a release is requested, prepare its version in `package.json` through a PR to `next`. Summarize changes since the previous published version, including API migration, in the release PR description. Package version changes belong to release preparation, not ordinary feature PRs.
2. Open the release PR from this repository's `next` to `main`. Use a merge commit (`gh pr merge --merge`), preserving the shared branch history. Wait for CI.
3. After merging, run the `Release` workflow on `main`. Supply the version without `v`, the exact 40-character main commit, and the prepared release notes. Run with `dry_run=true` first, then `false` to publish. For example:

   ```sh
   gh workflow run release.yml --ref main -f version=0.5.0 -f commit=MAIN_COMMIT_SHA -F notes=@/path/to/release-notes.md -f dry_run=true
   ```

   The workflow verifies the version, commit, CI, and existing tag before creating an annotated tag and GitHub Release. A rerun may finish publication of the same commit; it never moves a tag or rewrites a published release.
4. Synchronize `main` back into `next` with a PR and a merge commit. Preserve both permanent branches. Use merge commits whenever synchronizing these branches; rebasing or squashing them would recreate commits already released.

Repository administration changes that leave the published application and its documentation unchanged may use `next → main` without a new version. Feature and API changes wait for a release.

## Enforced on GitHub

- `main` and `next` require a PR and successful `test` and `branch-policy` checks, and refuse deletion and force pushes.
- Only this repository's `next` may target `main`. `main → next` is reserved for synchronization.
- Version tags (`v*`) cannot be changed or deleted. Use the Release workflow to create new tags; this creation path is an instruction, not a GitHub permission restriction.
- The Release workflow is manual and its publishing environment accepts only `main`.

GitHub settings are managed through `gh`. Agent instructions live here; `CLAUDE.md` imports this file.
