# AGENTS.md

Instructions for coding agents working **in this repository**. This is not user
documentation — see [README.md](README.md) for that. For *why* the rules below
exist, see [CONTRIBUTING.md](CONTRIBUTING.md); this file is the short version.

## What this repository is

A **port**, not a fork. The upstream Claude Code plugin
[claude-seo](https://github.com/AgriciDaniel/claude-seo) is vendored at a pinned
tag under `vendor/` and transformed at build time into the trees this package
ships. This repository adds only the pi/omp adaptation layer.

Two consequences drive nearly every rule below:

- Most files are **generated**. An edit to one is discarded on the next sync.
- Most content is **upstream's**. A fix here that upstream also needs becomes a
  divergence this repository carries forever.

## Commands

```bash
npm ci                  # one devDependency: the YAML parser the build reads with
npm run build           # vendor → sync → verify (network: downloads the pinned tag)
npm run verify          # structural checks only, no network
npm run secrets         # scan for credential-shaped strings
npm test                # unit + invariant tests, no network
npm run check           # verify + secrets + tests
```

The vendored upstream suite needs a Python environment:

```bash
python3 -m venv .venv && .venv/bin/pip install pytest requests beautifulsoup4 lxml
npm run test:upstream   # 874 of 962 upstream tests, run against the shipped scripts
```

## Never

- **Never edit `skills/`, `agents/`, `scripts/`, `extensions/`, `schema/` or
  `data/`.** They are generated from `vendor/` by `tools/sync.mjs` and wiped on
  every sync. Change `tools/sync.mjs`, or the upstream source.
- **Never patch `scripts/*.py`.** Those files are byte-identical to upstream and
  `tests/tree.test.mjs` asserts it. An upstream defect is reported upstream, not
  fixed here — even when the fix is two lines.
- **Never commit a credential.** `npm run secrets` gates this in CI, but by the
  time it fails the value is already in the git history and in every clone.
- **Never add a runtime dependency.** The package ships with none; the single
  devDependency is build-only and `tools/` is not published.
- **Never widen a subagent's `tools` allowlist to fix a symptom.** pi-subagents
  treats it as strict, so omitting the key grants *every* builtin tool rather
  than none. The sync fails rather than emit that.

## Ask first

- **Bumping `vendor/lock.json`** — it re-vendors the entire upstream tree.
- **Adding a whole-file entry to `DESELECTED`** in `tools/upstream-tests.mjs` —
  it drops every test in that file, including the ones that pass. Prefer
  `file.py::test_name`. Doing this once silently skipped 126 tests.
- **Changing `package.json` `files[]`** — it defines the published surface, and a
  file the README links but the tarball omits is a 404 no reader can diagnose.
- **Raising the README past 320 lines** — developer material belongs in
  CONTRIBUTING.md; a test enforces the budget.

## Invariants the build enforces

Each exists because it was broken silently at least once.

| Invariant | Enforced by |
|---|---|
| Frontmatter is parsed as YAML, not by hand | `tools/frontmatter.mjs` + `tests/frontmatter.test.mjs` |
| Every agent carries a `tools` allowlist | sync throws if the mapped list would be empty |
| `advertise: true` on at most 16 agents | verify + sync (pi-subagents caps the catalog) |
| Every skill's `SKILL.md` sits one level deep | verify (omp discovers nothing deeper) |
| Shipped Python is byte-identical to upstream | verify + `tests/tree.test.mjs` |
| The published tarball carries no build input or bytecode | verify (asks `npm pack`, not the manifest) |
| README keeps its user sections and its size budget | `tests/tree.test.mjs` |

## Layout

| Path | Kind | Notes |
|---|---|---|
| `tools/` | hand-written | build, verify, upstream harness, secret scan |
| `src/extensions/` | hand-written | the two extensions; sync copies them into `extensions/` |
| `tests/` | hand-written | `node:test` |
| `vendor/` | build input | pinned upstream; never published |
| `skills/` `agents/` `scripts/` `extensions/` `schema/` `data/` | **generated** | rebuilt by `npm run sync` |

## Where the detail lives

- [CONTRIBUTING.md](CONTRIBUTING.md) — the transforms, the reasoning, the open
  upstream findings this port deliberately does not patch.
- `tools/verify.mjs` — the executable list of structural invariants.
- `tests/` — the executable list of behavioural ones.
- `tools/sync.mjs` — every transform applied to upstream, each with its reason.
