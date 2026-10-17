# Contributing

This repository is a **port**, not a fork. Upstream `claude-seo` is vendored at a
pinned tag and transformed at build time; this repository adds only the pi/omp
adaptation layer.

That shapes what a contribution looks like. There are two kinds of change, and
they have different rules:

| You want to… | Do this |
|---|---|
| Fix or improve an SEO behaviour | Change it **upstream**, then bump the pin here |
| Fix something about how the port works on pi/omp | Change `tools/`, `src/extensions/`, or `tests/` here |
| Document something | Any file except the generated trees |

**Never edit the generated trees in place** — `skills/`, `agents/`, `scripts/`,
`extensions/`, `schema/`, `data/`, `requirements.txt` and `runtime-plugin.json`
are rebuilt from `vendor/` on every sync, so an edit there is discarded without
warning. They are committed (so a
git-source install needs no build step) and CI asserts they match the sync
output, which is what makes the discard visible rather than silent.

## What is different from upstream

The upstream Claude Code plugin is vendored at a pinned tag and transformed;
`vendor/` is build input and is never published.

| Concern | Claude Code | Here |
|---|---|---|
| Manifest | `.claude-plugin/plugin.json` | `package.json` → `pi` (omp accepts it too) |
| Script root | `${CLAUDE_PLUGIN_ROOT}` | `$SEO_PLUGIN_ROOT`, exported by the extension |
| Skill-local paths | `${CLAUDE_SKILL_DIR}` | relative to `SKILL.md` (both runtimes resolve this) |
| Schema hook | `hooks/hooks.json` (PostToolUse) | `pi.on("tool_result")` in an extension |
| Agents | native `agents/*.md` | same files, pi-subagents frontmatter |
| Extension skills | `extensions/<ext>/skills/` | flattened into `skills/` |
| Extension setup | `install.sh` → `~/.claude.json` | README section (`## Optional integrations`) |

Four transforms are worth calling out because they are not cosmetic:

**Agent frontmatter is rewritten.** Upstream's `model: sonnet`, `maxTurns` and
capitalised tool names are Claude Code fields. They become pi-subagents fields
(`thinking`, `systemPromptMode`, an explicit lowercase `tools` allowlist). pi has
no built-in web fetch or search tool, so `WebFetch`/`WebSearch` are dropped
rather than left in an allowlist where they would silently grant nothing. The
agents that referenced them — `seo-cluster`, `seo-flow`, `seo-geo`, `seo-local`,
`seo-maps`, `seo-sxo` — can still fetch, via the Python fetchers or an MCP
server; they just do not get a tool grant they cannot use. Their **prose** is
rewritten too: an instruction to "call WebFetch" now names the packaged
`fetch_page.py` fetcher or a web-fetch MCP tool, so the body never points at a
tool the agent does not have.

**Four agents are held back from the parent catalog.** pi-subagents advertises at
most 16 agents in the parent system prompt (`MAX_ADVERTISED_AGENTS`) and picks
them in sorted order, so advertising all 20 would silently drop the four that
sort last — `seo-sitemap`, `seo-sxo`, `seo-technical`, `seo-visual`, the first
and third of which the audit orchestrator spawns unconditionally. The port
advertises the audit core instead and keeps `seo-drift`, `seo-flow`,
`seo-image-gen` and `seo-matomo` out: each is reached through its own skill,
which names it, so a catalog entry buys nothing. All 20 stay dispatchable by
name either way. If the count of `advertise: true` ever exceeds 16, the build
fails rather than dropping agents silently.

**Two skills merge rather than overwrite.** `seo-dataforseo` and `seo-image-gen`
exist both as a core skill and as an extension skill, and the two copies are not
identical. The extension copy is newer but, for `seo-image-gen`, ships no
`references/` directory while its `SKILL.md` instructs the model to read seven
files from it. The sync takes the newer `SKILL.md` and unions the reference
trees, so instructions never point at missing files.

**The managed venv is pinned to a per-user directory.** Upstream's `_is_plugin()`
probe relies on `.claude-plugin/`, which this port strips, so without an override
the environment would be built inside `node_modules` and discarded on every
reinstall.

## Development

```bash
npm ci           # one devDependency: the YAML parser the build reads with
npm run build    # vendor → sync → verify → test  (network: downloads the pinned tag)
npm run verify   # structural checks only, no network
npm run secrets  # scan for credential-shaped strings
npm test         # unit + invariant tests, no network
npm run check    # verify + secrets + tests
```

The hand-written sources are `tools/`, `src/extensions/` and `tests/`.
`src/extensions/` is the editable copy of the two extensions; `sync` copies it
into `extensions/`, which is what ships.

### Sending a change

1. Fork the repository and branch from `development`, not `main`. Name the branch
   for the topic (`fix/schema-hook-crash`, `feat/new-agent-mapping`).
2. Change the hand-written sources, or `tools/sync.mjs` for a transform. Never the
   generated trees; see the top of this file.
3. Run `npm run build`, then commit **the regenerated trees together with the
   source change**. CI re-runs the sync and fails on any diff between it and what
   you committed, which is the usual reason a first PR is red.
4. Run `npm run check` before pushing. It does not typecheck `src/extensions/`;
   CI does, so a type error there appears only after you push.
5. Open the PR against `development`. `main` only receives merges from
   `development`.

Commit subjects use conventional prefixes (`feat:`, `fix:`, `chore:`, `docs:`).
CI needs no secrets, so it runs the same on a fork as on this repository.

A defect in upstream's own files (`scripts/*.py`, skill bodies) belongs in the
upstream repository, not in a PR here.

Releases are cut by maintainers: pushing a `v*` tag publishes to npm, and the tag
must equal the `package.json` version, which the sync inherits from upstream.

### The vendored upstream suite

`npm run test:upstream` stages the 66 test files from `vendor/claude-seo/tests/`
at `tests-upstream/` — exactly one level below the repo root — so their
`Path(__file__).resolve().parents[1]` resolves here and they import the scripts
this package ships, not the vendored copy. That distinction is not cosmetic:
run in place, the suite validates upstream against itself and would pass with
every shipped script deleted.

It needs `pytest`, `requests`, `beautifulsoup4` and `lxml`:

```bash
python3 -m venv .venv && .venv/bin/pip install pytest requests beautifulsoup4 lxml
npm run test:upstream        # 874 of 962 upstream tests
```

The harness finds the interpreter via `CLAUDE_SEO_PYTHON`, then `.venv/bin/python`,
then `python3`.

Some upstream tests assert the Claude Code layout this port replaces on purpose.
They are listed individually in `tools/upstream-tests.mjs` — `file.py::test_name`
rather than whole files — because excluding a file also drops the tests inside it
that pass against this tree; doing that once silently skipped 126 tests. A test
in `tests/tree.test.mjs` fails if an entry appears without a stated reason, and
another caps whole-file entries at 10 so the list cannot quietly widen again.

The schema-hook tests are *not* deselected: the port ships upstream's
`hooks/validate-schema.py` byte-for-byte as `scripts/validate_schema_hook.py`, so
the harness links the two and those 33 tests run against the real file.

### Tests use `node:test`

The runner built into Node, plus `node:assert`. This is not a compromise: the
runner has been stable since Node 20 and ships mocking, snapshots, watch mode and
`junit`/`lcov` reporters. Nothing here renders a component or needs a DOM, which
is the one capability it lacks — so a framework would add a dependency (Vitest
pulls 13, transitively far more) and a transform pipeline to a package whose
whole point is that a consumer installs it and nothing else.

The typecheck for the two extensions is the exception: it needs `typescript` and
the host's type declarations, and CI installs them into a throwaway directory
rather than into the repo.

**The Node floor is 22, and that is not arbitrary.** `node --test "<glob>"`
needs 22: Node 20 cannot expand a glob, and Node 22 removed the directory
argument, so no single invocation works on both. Node 20 also reached
end-of-life on 2026-04-30, and every integration the README names already
requires 22. CI therefore runs the matrix `[22, 24]` — the declared floor, and
the Active LTS — so a change that breaks either is caught rather than assumed.

### Dependencies

The package ships **no runtime dependencies** — pi installs it with peer
auto-install suppressed, and the bundled Python imports no npm package. The one
devDependency (`yaml`) is a *build* input: `tools/` is not published.

`.npmrc` sets `legacy-peer-deps` so `npm ci` does not resolve the `"*"` host
peers from the registry — without it npm installs 266 packages, including the
AWS SDK and protobufjs, to get one YAML parser. CI asserts both facts.

### Rules the build enforces

Each exists because it was broken silently at least once:

- **Frontmatter is parsed as YAML, not by hand.** `description: >` is a block
  scalar whose value is on the following indented lines; a reader that stored
  the `>` and dropped the body shipped four agents with an empty description.
  A hand-rolled reader also had no notion of quoting, so
  `description: "Fixes the a # b case"` was cut at the `#`. Reading now
  delegates to the `yaml` package; malformed frontmatter fails the build with a
  line and column instead of being half-read.
- **Writing stays hand-rolled.** `yaml.stringify` wraps long descriptions across
  lines and quotes `"true"`, which reads worse for both humans and the model.
  The renderer emits one clean line per key.
- **A lost `tools` list is not an empty grant.** pi-subagents treats `tools` as
  a strict allowlist, so omitting the key hands the agent *every* builtin tool.
  The sync fails rather than widen a read-only agent to `write` + `bash`.
- **The parent catalog holds 16 agents.** pi-subagents advertises at most 16 and
  picks them in sorted order, so the excess would be dropped with no error.

### Bumping upstream

Update `vendor/lock.json` (tag + sha256), then `npm run build` and review the
diff. If an upstream reword breaks a body rewrite in `tools/sync.mjs`, the sync
fails by name instead of leaving the agent pointing at a tool it does not have.

### Upstream Python ships verbatim

`scripts/` is copied byte-for-byte from the vendored tree and this port does not
patch it — `tests/tree.test.mjs` asserts the identity, and `tools/sync.mjs`
carries no patch mechanism. That is a deliberate constraint: a local edit is a
divergence to carry on every upstream bump, and it destroys the value of
`diff -r scripts/ vendor/claude-seo/scripts/` as a review signal. Anything
upstream gets wrong is reported upstream instead.

Three upstream findings are open and unfixed here, all verified against v2.4.0:

- **`youtube_search.py` echoes the Google API key in its error output.** A 400 —
  the ordinary invalid-key case — produces
  `<HttpError 400 when requesting …?key=AIza…>`, because `googleapiclient`
  builds the message from the request URI. It is the one Google consumer here
  that does not call `redact_google_api_key`, which already exists in
  `google_auth.py`; `runtime.py`'s own redactor handles home paths, not keys.
- **`verify_release.py` never compares `tree_sha256`.** It prints the value the
  docstring tells you to GPG-sign, but only checks per-file hashes — so an
  attacker who edits a script and patches its entry in `files` verifies clean.
- **`url_safety.validate_url()` raises on a malformed IPv6 URL** (`http://[::1`),
  violating its documented `-> bool` contract. Fail-closed, not an SSRF bypass,
  but it crashes 19 call sites with a traceback instead of returning `False`.

If you need the first one fixed locally, `redact_google_api_key` is already
importable from `google_auth`; the change is two lines. It is not applied here
on purpose — see the paragraph above.

## Credits

Ported from [claude-seo](https://github.com/AgriciDaniel/claude-seo) v2.4.0 by
[AgriciDaniel](https://github.com/AgriciDaniel), MIT licensed. Upstream
contributors include Lutfiya Miller (seo-cluster), Florian Schmitz (seo-sxo),
Dan Colta (seo-drift) and Chris Muller (seo-hreflang).
