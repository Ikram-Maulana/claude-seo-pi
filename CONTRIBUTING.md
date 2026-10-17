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
`extensions/`, `schema/`, `data/`, `charts/` (when upstream ships it),
`requirements.txt` and `runtime-plugin.json`
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
| Schema hook | `hooks/hooks.json` (PostToolUse) | `pi.on("tool_result")` in an extension, findings appended to the tool result |
| Agents | native `agents/*.md` | same files, pi-subagents frontmatter |
| Extension skills | `extensions/<ext>/skills/` | flattened into `skills/` |
| Extension setup | `install.sh` → `~/.claude.json` | README section (`## Optional integrations`) |

Six points are worth calling out because they are not cosmetic:

**Agent frontmatter is rewritten.** Upstream's `model:`, `maxTurns` and
capitalised tool names are Claude Code fields. `model` and `maxTurns` are dropped
(pi-subagents removed turn budgets in 0.59.0, and neither `model: sonnet`, on 15
agents, nor `model: opus`, on `seo-cluster`, `seo-content`, `seo-drift`,
`seo-geo` and `seo-sxo`, is a selector in either runtime), so an agent carries
no model and no `thinking`, and upstream's choice of a stronger model for those
five is not carried over. The tools
become an explicit lowercase `tools` allowlist and `systemPromptMode` and the
`inherit*` flags are added. pi has
no built-in web fetch or search tool, so `WebFetch`/`WebSearch` are dropped.
omp does have `web_search`, but one agent file serves both hosts, and
pi-subagents checks every allowlisted name against pi's registry before the
first turn and fails the run on a missing one: granting it would break the
agent on pi. Of
the agents that referenced them, `seo-geo`, `seo-local` and `seo-maps` hold
`bash` and fetch through the packaged Python fetchers. `seo-flow` holds only
`read`, `find` and `grep`, so it works on the page the caller fetched and passed
in its task, and says so when none was passed. `seo-sxo` and `seo-cluster` have
`bash`, but no SERP script exists, so their SERP data comes from the task too:
the `seo` and `seo-audit` orchestrators tell the parent to pass the top-10
results from its web search or DataForSEO, if it has either (on plain pi it
has neither), and to spawn the agent anyway when it does not. The agents use a
web-search or DataForSEO tool only if one is in their tool list, measure
overlap only between keywords that came with results, and otherwise report
SERP analysis as a limitation rather than infer rankings. Their **prose** is
rewritten to match (`BODY_REWRITES`), so the body never points at a tool the
agent does not have; a test fails if an agent without `bash` is told to run
the launcher.

**Skill prose is rewritten the same way.** Skills are read by the parent model,
which on pi has no `WebFetch`, no `WebSearch` and no `~/.claude/settings.json`.
`WebSearch` becomes "web search" (omp's `web_search`, or a web-search MCP tool),
each `WebFetch` names the packaged fetcher or a web-fetch tool, and API-key
checks point at the environment instead of Claude Code's settings file
(`SKILL_REWRITES` in `tools/sync.mjs`). The build fails if any of these names
survives in `skills/` or `agents/`.

**The schema validator is an extension, not a hook.** Upstream's PostToolUse
hook becomes `extensions/seo-schema-validator.ts`: after a successful `edit` or
`write` of an `.html`, `.htm`, `.jsx`, `.tsx`, `.vue`, `.svelte`, `.php` or
`.ejs` file that contains JSON-LD, it runs `scripts/validate_schema_hook.py` on
a system Python (`CLAUDE_SEO_PYTHON`, then `python3`, then `python`; `py -3`
first on Windows) and appends its findings to the tool result, one
`[seo-schema] <absolute path>: …` block per file. One edit may validate several
files: omp's `paths` array and an apply_patch body's `Add File`, `Update File`
and `Move to` headers are all read. omp's patch-mode `edits[].rename` target is
not, so a renamed file goes unvalidated. It never fails the write; a missing Python logs one
`[seo-schema] validator unavailable` line to stderr per session. To turn it off,
exclude it on pi with `pi config`, or in settings with
`{"source": "npm:claude-seo-pi", "extensions": ["!extensions/seo-schema-validator.ts"]}`;
on omp, toggle it in `/extensions` or list `extension-module:seo-schema-validator`
under `disabledExtensions`. Its interpreter probe accepts a Microsoft Store
Python, which upstream's `run-python-hook.js` rejects because the real
`sys.executable` lives under `WindowsApps\`.

**DataForSEO responses are filtered.** Upstream's installer points the MCP
server at `extensions/dataforseo/field-config.json` through `FIELD_CONFIG_PATH`,
which keeps only SEO-relevant fields (upstream measures ~75% fewer tokens). The
sync ships that file at the same path in the package, and the README's MCP block
sets the variable.

**`seo-cockpit` is not ported.** Upstream's `plugins/seo-cockpit` is a Claude
Code mod (a function-hook plugin) that checks paid API calls against the
DataForSEO budget before they run and shows a live audit status line. Neither
host has that hook surface; the skills still run `dataforseo_costs.py check`
before paid calls, as upstream's skills do, but nothing enforces it.

**Agents inherit the session's model, and omp does not inherit its thinking
level.** With no `model`, both runtimes run an agent on the parent's model. omp
passes that model without the `:level` suffix, so the agent's thinking level
falls back to the global `defaultThinkingLevel`, which is `high` unless set. A
session on `…:max` therefore spawns `…:high` agents (seen in omp session logs as
`thinking_level_change … "configured": null`). The port does not pin a level: a
hard-coded one would override every user's choice on 20 agents. Set
`omp config set defaultThinkingLevel max` to follow the session.

**The `tools` allowlist is strict on pi, not on omp.** pi-subagents grants
exactly the listed tools. omp applies the list to its built-in tools only and
adds every connected MCP server's tools to each subagent (an omp session log
shows `seo-technical` holding `read, bash, write, grep` plus the whole MCP
catalogue). `mcp:dataforseo` is a pi-mcp-adapter selector that omp ignores,
harmlessly, since omp offers the server's tools anyway. An agent without `bash`
is therefore not sandboxed on omp; do not rely on the list as a security
boundary there.

**Four agents are held back from the parent catalog.** pi-subagents advertises at
most 16 agents in the parent system prompt (`MAX_ADVERTISED_AGENTS`) and picks
them in sorted order, so advertising all 20 would silently drop the four that
sort last — `seo-sitemap`, `seo-sxo`, `seo-technical`, `seo-visual`, all four
of which the audit orchestrator spawns unconditionally. The port
advertises the audit core instead and keeps `seo-drift`, `seo-flow`,
`seo-image-gen` and `seo-matomo` out: each is reached through its own skill,
which names it, so a catalog entry buys nothing. All 20 stay dispatchable by
name either way. If the count of `advertise: true` ever exceeds 16, the build
fails rather than dropping agents silently.

**Two skills merge rather than overwrite.** `seo-dataforseo` and `seo-image-gen`
exist both as a core skill and as an extension skill, and the two copies are not
identical. The extension `SKILL.md` is newer. For `seo-image-gen` its
references are not in the skill directory: upstream's banana installer copies
`extensions/banana/references/` next to it, and five of those nine files differ
from the older core copies. The sync takes the extension `SKILL.md`, then fills
`references/` in order of precedence: the extension's top-level `references/`,
the extension skill's own, and the core copy only for a file neither has. The
references then match the `SKILL.md` that ships, and instructions never point
at missing files.

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

### Releases

Every version is `<upstream>-pi.N`: the upstream release the tree ports, plus a
port revision. Upstream v2.4.2 ships as `2.4.2-pi.0`, and the next fix to the
port alone is `2.4.2-pi.1`, with no upstream release needed. The sync takes the
upstream part from the vendored `plugin.json` and keeps N while that stays the
same; a bump of `vendor/lock.json` to a new upstream resets it to `-pi.0`.
semver orders these the way `pi update` compares them:
2.4.0 < 2.4.2-pi.0 < 2.4.2-pi.1 < 2.4.3-pi.0.

To cut a port-only release, bump the revision and rebuild:

```bash
npm version prerelease --preid pi --no-git-tag-version && npm run build
```

Commit the result, including `package-lock.json` and `runtime-plugin.json`: the
lockfile carries the version too, and runtime.py reports the one in
`runtime-plugin.json`. `verify` checks `runtime-plugin.json` against
`package.json` and that the version has the `<upstream>-pi.N` shape; the unit
tests catch a stale lockfile.

Because every version is a prerelease, a semver range only ever matches
revisions of the upstream release it names: `^2.4.2-pi.0` takes `2.4.2-pi.1` but
never `2.4.3-pi.0`, and `^2.4.2` matches none of them. A plain install follows
the `latest` dist-tag, which `release.yml` sets explicitly (`npm publish --tag
latest`); npm refuses to publish a prerelease without one.

Releases are cut by maintainers: pushing a `v*` tag starts `release.yml`, whose
`publish` job then waits for approval in the `npm-release` environment before it
publishes to npm. The tag is `v` plus the `package.json` version, for example
`v2.4.2-pi.1`. The environment's required reviewer, its deployment policy
(tags matching `v*` only, so no branch run can deploy to it) and the `v*` tag
ruleset live in repository settings, not in the tree, so a fork that wants the
same gate has to recreate all three; if npm's trusted-publisher entry names an
environment, it must be `npm-release`.

### The vendored upstream suite

`npm run test:upstream` stages the 69 test files from `vendor/claude-seo/tests/`
at `tests-upstream/` — exactly one level below the repo root — so their
`Path(__file__).resolve().parents[1]` resolves here and they import the scripts
this package ships, not the vendored copy. That distinction is not cosmetic:
run in place, the suite validates upstream against itself and would pass with
every shipped script deleted.

It needs `pytest` plus the runtime's own packages (`requests`, `beautifulsoup4`,
`lxml`, `google-auth`, …), so it installs from the same `requirements.txt` CI
uses:

```bash
python3 -m venv .venv && .venv/bin/pip install pytest -r requirements.txt
npm run test:upstream        # 878 of 999 upstream tests on Python 3.14, 879 below it
```

The harness finds the interpreter via `CLAUDE_SEO_PYTHON`, then `.venv/bin/python`,
then `python3`. An explicit `CLAUDE_SEO_PYTHON` that cannot import pytest fails
the run (exit 2) instead of falling back to an interpreter nobody chose.

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

The four `@earendil-works/*` host peers are `"*"` and **optional**
(`peerDependenciesMeta`). npm 7+ and Bun install a required peer, so an omp or
Bun install pulled about 150 MB of the pi host it never loads. The extensions
import the host with `import type` only, so nothing needs the peers installed;
`verify` and `tests/tree.test.mjs` require the flag.

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

Four upstream findings are open and unfixed here, all verified against v2.4.2:

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
- **`test_hostile_inputs.py::test_deeply_nested_well_known_document_is_a_finding`
  fails on Python 3.14.** It feeds `agentic_check.audit_well_known` a 100000-deep
  `[[[…]]]` and expects a `fail` finding, assuming `json.loads` raises
  `RecursionError`. From 3.14 it parses the document, so the check correctly
  reports valid JSON and the test's premise is gone; the script is not broken.
  The harness deselects it on 3.14 and later only (`VERSION_DESELECTED` in
  `tools/upstream-tests.mjs`) and prints the reason; on older Pythons it runs
  and must pass. CI runs the upstream suite on 3.12 and the runtime job on 3.10,
  3.12 and 3.14.

If you need the `youtube_search.py` key leak fixed locally,
`redact_google_api_key` is already importable from `google_auth`; the change is
two lines. It is not applied here on purpose — see the paragraph above.

## Credits

Ported from [claude-seo](https://github.com/AgriciDaniel/claude-seo) v2.4.2 by
[AgriciDaniel](https://github.com/AgriciDaniel), MIT licensed. Upstream
contributors include Lutfiya Miller (seo-cluster), Florian Schmitz (seo-sxo),
Dan Colta (seo-drift) and Chris Muller (seo-hreflang).
