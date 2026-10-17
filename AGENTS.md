<!-- bmad:context -->
<!-- Verified 2026-10-17 against fa155c8. Managed by bmad-project-context; edits inside this block are replaced on refresh. Keep anything you want preserved outside the markers. -->

## claude-seo-pi

Instructions for coding agents in this repository; user docs are in [README.md](README.md), the reasons behind these rules in [CONTRIBUTING.md](CONTRIBUTING.md). A port, not a fork, of the Claude Code plugin [claude-seo](https://github.com/AgriciDaniel/claude-seo): upstream is vendored at a pinned tag under `vendor/` and transformed at build time into the trees this package ships for the pi and omp agents. Node >=22 (ESM), TypeScript extensions, Python scripts shipped verbatim from upstream, one build-only devDependency (`yaml`).

## Policy

- Never edit the generated trees: `skills/`, `agents/`, `scripts/`, `extensions/`, `schema/`, `data/`, `requirements.txt`, `runtime-plugin.json`. `tools/sync.mjs` discards the edit on the next sync. Change `tools/sync.mjs`, `src/extensions/` or the upstream source instead.
- Never patch `scripts/*.py`, even for a two-line fix: it is byte-identical to upstream (`tests/tree.test.mjs`, `verify`), so a local fix is a divergence carried on every bump. Report it upstream; the open findings this port deliberately leaves unpatched are listed in CONTRIBUTING.md.
- Never commit a credential: `npm run secrets` gates CI, but by then the value is already in git history.
- Never add a runtime dependency: the package ships none, and `tools/` is not published.
- Never widen a subagent's `tools` allowlist to fix a symptom: pi-subagents treats it as strict, so omitting the key grants every builtin tool. The sync fails rather than emit that.
- Never create or push a `v*` tag without the maintainer's explicit say-so: it triggers `release.yml`, publishes to npm and cannot be undone. The tag must equal the `package.json` version, which the sync inherits from upstream.
- Never push to `main`; it takes merges from `development` only. Maintainers commit straight to `development`; contributors fork, branch from `development` and open the PR against it (CONTRIBUTING.md, "Sending a change"). Do not assume you are a maintainer: you may be in a fork or a topic branch.
- Commit subjects use conventional prefixes: `feat:`, `fix:`, `chore:`, `docs:`.
- Ask before bumping `vendor/lock.json`: it re-vendors the whole upstream tree.
- Ask before adding a whole-file entry to `DESELECTED` in `tools/upstream-tests.mjs`: it drops every test in the file, passing ones included (once 126 were skipped silently). Use `file.py::test_name`; a test caps whole-file entries at 10 and requires a stated reason.
- Ask before changing `package.json` `files[]`: it defines the published surface, and a file the README links but the tarball omits is a 404 no reader can diagnose.
- Ask before raising the README past 320 lines: developer material belongs in CONTRIBUTING.md, and a test enforces the budget.

## Where things are

- Hand-written: `tools/` (build, verify, upstream-suite harness, secret scan), `src/extensions/` (the two extensions; sync copies them into `extensions/`), `tests/` (`node:test`).
- Build input, never published: `vendor/`, pinned by `vendor/lock.json`, gitignored, recreated by `npm run vendor`.
- Every transform applied to upstream, each with its reason: `tools/sync.mjs`. Structural invariants: `tools/verify.mjs`. Behavioural ones: `tests/`.
- Why the rules exist, and the upstream findings this port does not patch: CONTRIBUTING.md.

## Running and verifying

- Fresh clone: `npm ci`, then `npm run vendor` once. It downloads the pinned tag, and `verify`, `test` and `check` fail without `vendor/claude-seo/`; after that they run offline.
- `npm run build` runs vendor, sync, verify, then `npm test`. `npm run check` runs verify, secrets and tests.
- After changing `tools/`, `src/extensions/` or `vendor/lock.json`, run `npm run build` and commit the regenerated trees in the same change: CI fails on any diff between the committed trees and the sync output.
- CI typechecks `src/extensions/*.ts` with `tsc`; `npm run check` does not, so a type error appears only after pushing. Extensions import the host package with `import type` only (`verify`).
- Upstream suite, run against the shipped scripts: `python3 -m venv .venv && .venv/bin/pip install pytest requests beautifulsoup4 lxml`, then `npm run test:upstream`.

## Conventions that differ from defaults

- Frontmatter is parsed as YAML through `tools/frontmatter.mjs`, never by hand: a hand parser shipped four agents with empty descriptions (`tests/frontmatter.test.mjs`).
- At most 16 agents set `advertise: true`: pi-subagents silently drops the rest (`verify` and the sync fail past 16).
- Each skill's `SKILL.md` sits one level deep in `skills/`: omp discovers nothing deeper (`verify`).
- The published tarball carries no build input or bytecode (`verify`, which asks `npm pack` rather than the manifest).
- README keeps `## Install`, `## Quick start`, `## Commands` and `## Troubleshooting` (`tests/tree.test.mjs`).

<!-- /bmad:context -->
