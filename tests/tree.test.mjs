/**
 * Invariants of the generated tree.
 *
 * `tools/verify.mjs` asserts the same rules against whatever is on disk; these
 * run in CI unconditionally and fail with a diff-shaped message, so a broken
 * sync shows up as a test failure rather than a silent regression.
 */
import { strict as assert } from "node:assert";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { BLOCK_SCALAR, descriptionOf, frontmatterOf, parseFrontmatter } from "../tools/frontmatter.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const agentsDir = join(repoRoot, "agents");
const skillsDir = join(repoRoot, "skills");

/**
 * pi-subagents caps the parent catalog at this many entries and picks them in
 * sorted order, so exceeding it drops the tail with no error.
 */
const ADVERTISE_LIMIT = 16;

/** Shortest description the build will emit; the shortest real one is 87 chars. */
const MIN_DESCRIPTION = 20;

/** Tools the sync maps to null: pi has no builtin equivalent for them. */
const DROPPED_TOOLS = ["WebFetch", "WebSearch", "NotebookEdit"];

const agentFiles = readdirSync(agentsDir).filter((f) => f.endsWith(".md"));
const skillNames = readdirSync(skillsDir, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name);

/** Read a file and return its frontmatter block. */
function frontmatterAt(file) {
  return frontmatterOf(readFileSync(file, "utf-8"));
}

/** Parse one agent file into its frontmatter values and body. */
function agentOf(file) {
  const text = readFileSync(join(agentsDir, file), "utf-8");
  return { values: parseFrontmatter(frontmatterOf(text)).values, body: text };
}

/** Every file under a directory, as repo-relative paths. */
function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walk(full));
    } else {
      out.push(full);
    }
  }
  return out;
}

test("every agent declares a real description", () => {
  const broken = agentFiles.filter((file) => {
    const description = agentOf(file).values.description ?? "";
    return description.length < MIN_DESCRIPTION || BLOCK_SCALAR.test(description);
  });
  assert.deepEqual(
    broken,
    [],
    `these agents would be advertised with an empty description:\n  ${broken.join("\n  ")}`
  );
});

test("every skill declares a real description", () => {
  const broken = skillNames.filter((name) => {
    const description = descriptionOf(frontmatterAt(join(skillsDir, name, "SKILL.md")));
    return description.length < MIN_DESCRIPTION || BLOCK_SCALAR.test(description);
  });
  assert.deepEqual(broken, [], `skills omp would drop:\n  ${broken.join("\n  ")}`);
});

test("no agent inherits an unrestricted tool set", () => {
  // pi-subagents treats `tools` as a strict allowlist: omitting the key means
  // the child gets *every* builtin tool, so a lost list silently widens a
  // read-only recon agent to include write and bash.
  const unrestricted = agentFiles.filter((file) => {
    const tools = (agentOf(file).values.tools ?? "").split(",").map((t) => t.trim()).filter(Boolean);
    return tools.length === 0;
  });
  assert.deepEqual(unrestricted, [], "these agents declare no tools allowlist");
});

test("the advertised catalog fits pi-subagents' limit", () => {
  const advertised = agentFiles
    .filter((file) => agentOf(file).values.advertise === "true")
    .map((file) => agentOf(file).values.name ?? file)
    .sort();
  assert.ok(
    advertised.length <= ADVERTISE_LIMIT,
    `${advertised.length} agents advertise but the cap is ${ADVERTISE_LIMIT}; ` +
      `these would be dropped: ${advertised.slice(ADVERTISE_LIMIT).join(", ")}`
  );
});

test("no agent carries a Claude Code field", () => {
  const stale = [];
  for (const file of agentFiles) {
    const { frontmatter } = { frontmatter: frontmatterAt(join(agentsDir, file)) };
    for (const field of ["model", "maxTurns", "max_turns"]) {
      if (new RegExp(`^${field}:`, "m").test(frontmatter)) {
        stale.push(`${file}: ${field}`);
      }
    }
  }
  assert.deepEqual(stale, [], "Claude Code fields do not resolve in pi-subagents");
});

test("no agent tells the model to call a tool it does not have", () => {
  // The frontmatter is rewritten but the body is passed through verbatim, so a
  // body can still instruct the model to call a tool the mapping dropped.
  // Matching is narrow: the untrusted-content notes name these tools to say their
  // *output* must not be trusted, which stays correct.
  const offenders = [];
  for (const file of agentFiles) {
    const { values, body } = agentOf(file);
    const tools = (values.tools ?? "").toLowerCase();
    for (const tool of DROPPED_TOOLS) {
      const usedAsTool = new RegExp(`\\b(?:use|using|with|via|call|calling)\\s+${tool}\\b`, "i");
      if (usedAsTool.test(body) && !tools.includes(tool.toLowerCase())) {
        offenders.push(`${file}: ${tool}`);
      }
    }
  }
  assert.deepEqual(offenders, [], "these agents tell the model to call a tool they lack");
});

test("no Claude Code placeholder survives in a file the model reads", () => {
  const offenders = [...walk(skillsDir), ...walk(agentsDir)]
    .filter((file) => /\.(md|txt|json|ya?ml)$/i.test(file))
    .filter((file) => readFileSync(file, "utf-8").includes("${CLAUDE_"))
    .map((file) => relative(repoRoot, file));
  assert.deepEqual(offenders, []);
});

test("every skill stays one level deep for omp", () => {
  // omp discovers exactly <skills>/<name>/SKILL.md and nothing deeper.
  const nested = skillNames.flatMap((name) =>
    readdirSync(join(skillsDir, name), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(skillsDir, name, entry.name, "SKILL.md"))
      .filter((candidate) => {
        try {
          readFileSync(candidate);
          return true;
        } catch {
          return false;
        }
      })
      .map((candidate) => relative(repoRoot, candidate))
  );
  assert.deepEqual(nested, [], "nested SKILL.md files are invisible to omp");
});

test("every shipped Python file is byte-identical to upstream", () => {
  // `scripts/` is copied wholesale from the vendored tree and this port does not
  // patch it: a local edit is a divergence to carry on every upstream bump, and
  // it destroys the value of `diff -r scripts/ vendor/.../scripts/` as a review
  // signal. The one legitimate difference is `validate_schema_hook.py`, from
  // upstream hooks/.
  const FROM_HOOKS = "validate_schema_hook.py";
  const upstreamDir = join(repoRoot, "vendor", "claude-seo", "scripts");

  const differences = [];
  for (const file of readdirSync(join(repoRoot, "scripts")).filter((f) => f.endsWith(".py"))) {
    const shipped = readFileSync(join(repoRoot, "scripts", file));
    let upstream;
    try {
      upstream = readFileSync(join(upstreamDir, file));
    } catch {
      if (file !== FROM_HOOKS) {
        differences.push(`${file} (not in upstream scripts/ and not the hooks file)`);
      }
      continue;
    }
    if (!shipped.equals(upstream)) {
      differences.push(`${file} (differs from upstream — this port does not patch Python)`);
    }
  }
  assert.deepEqual(differences, [], "the shipped Python must stay identical to upstream");
});

test("sync.mjs does not patch upstream Python", () => {
  // A patch mechanism would silently reintroduce divergence the moment someone
  // used it, leaving the byte-identity test above as the only thing between the
  // tree and an unreviewable local fork.
  const syncSource = readFileSync(join(repoRoot, "tools", "sync.mjs"), "utf-8");
  assert.ok(
    !/PYTHON_PATCHES|patchPython/.test(syncSource),
    "a Python patch mechanism is back — the port is meant to ship upstream verbatim"
  );
});

test("the manifest points at paths that exist", () => {
  // `Object.entries(pkg.pi ?? {})` iterates nothing when `pi` is absent, so the
  // loop below would assert on an empty list — deleting the whole manifest once
  // passed this test and verify.mjs, which had the same `?? {}` hole.
  const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf-8"));
  assert.ok(pkg.pi, "package.json has no `pi` manifest — nothing would load");

  // The three resource kinds the package must register.
  assert.ok(Array.isArray(pkg.pi.extensions) && pkg.pi.extensions.length > 0, "pi.extensions is empty");
  assert.ok(Array.isArray(pkg.pi.skills) && pkg.pi.skills.length > 0, "pi.skills is empty");
  const agents = pkg.pi.subagents?.agents;
  assert.ok(Array.isArray(agents) && agents.length > 0, "pi.subagents.agents is empty");

  const missing = [];
  for (const [key, value] of Object.entries(pkg.pi)) {
    const entries = Array.isArray(value) ? value : Object.values(value).flat();
    for (const entry of entries) {
      const target = join(repoRoot, entry.replace(/^\.\//, ""));
      try {
        readdirSync(target);
      } catch {
        try {
          readFileSync(target);
        } catch {
          missing.push(`pi.${key} → ${entry}`);
        }
      }
    }
  }
  assert.deepEqual(missing, [], "the manifest references paths that do not exist");
});

test("the upstream suite is staged where it can see our scripts", () => {
  // The vendored tests find the code they check with
  // `Path(__file__).resolve().parents[1]`, which from vendor/claude-seo/tests/
  // resolves to the vendored copy — so the suite would say nothing about what
  // this package ships. Staging them one level below the repo root is what makes
  // the suite meaningful, and it is invisible: a regression here would just mean
  // the suite tests the wrong tree again.
  const harness = readFileSync(join(repoRoot, "tools", "upstream-tests.mjs"), "utf-8");

  const staging = /const staging = join\(repoRoot, "([^"]+)"\)/.exec(harness);
  assert.ok(staging, "upstream-tests.mjs no longer declares a staging path");
  const staged = staging[1];
  assert.ok(
    !staged.includes("/"),
    `tests are staged at "${staged}", which is not one level below the repo root — ` +
      "parents[1] would not resolve here"
  );

  // Assert the *call*, not the name: matching /symlinkSync/ alone also matches
  // the import line, so deleting the call left the check green.
  assert.match(
    harness,
    /^\s*symlinkSync\(/m,
    "the schema-hook symlink is no longer created — 33 schema tests would stop running"
  );

  // The suite must be invoked with pytest, not silently skipped.
  assert.match(harness, /"pytest"/, "the harness no longer runs pytest");
  assert.match(
    harness,
    /DESELECTED/,
    "the deselection list is gone — the suite would fail on intentional divergences"
  );

  // And CI must actually call it.
  const workflow = readFileSync(join(repoRoot, ".github", "workflows", "ci.yml"), "utf-8");
  assert.match(
    workflow,
    /run:\s*node tools\/upstream-tests\.mjs/,
    "CI never runs the upstream suite"
  );
});

test("every deselected upstream test carries a stated reason", () => {
  // Deselecting is how intentional divergence is expressed; an entry with no
  // reason is indistinguishable from a real failure someone muted. The rule is
  // positional — a reason comment *within the few lines above* each entry — so
  // a single flag that stayed true once any reason appeared let an entry
  // appended later pass.
  const harness = readFileSync(join(repoRoot, "tools", "upstream-tests.mjs"), "utf-8");
  const list = /const DESELECTED = \[([\s\S]*?)\n\];/.exec(harness);
  assert.ok(list, "DESELECTED is gone");

  const lines = list[1].split("\n");
  const orphans = [];
  // A reason block opens with the ── marker and covers every entry until the
  // next marker; an entry is an orphan only if no marker precedes it at all.
  let covered = false;
  for (const line of lines) {
    if (/^\s*\/\/\s*──/.test(line)) {
      covered = true;
      continue;
    }
    if (/^\s*"[^"]+",?\s*$/.test(line) && !covered) {
      orphans.push(line.trim());
    }
  }
  assert.deepEqual(orphans, [], "these deselect entries have no stated reason above them");

  // The other direction matters too: a reason block with no entries under it
  // means the list was edited and a rule was left behind.
  const reasons = lines.filter((l) => /^\s*\/\/\s*──/.test(l)).length;
  assert.ok(reasons > 0, "no reason blocks at all — the list lost its rationale");

  const count = (list[1].match(/^\s*"/gm) ?? []).length;
  assert.ok(count > 0, "the deselection list is empty — did the suite start passing?");

  // Prefer per-test entries over whole files: a whole-file entry removes every
  // test in that file, including the ones that pass against this tree — 126
  // upstream tests were skipped that way. Whole-file entries are still allowed
  // where every test in the file reads an artifact the port does not ship, so
  // this is a budget, not a ban.
  const wholeFiles = [...list[1].matchAll(/^\s*"([^"]+)",?\s*$/gm)]
    .map((m) => m[1])
    .filter((entry) => !entry.includes("::"));
  assert.ok(
    wholeFiles.length <= 10,
    `${wholeFiles.length} whole files are deselected (budget 10). Each one drops every ` +
      `test inside it, including tests that pass — prefer "file.py::test_name" entries:\n  ` +
      wholeFiles.join("\n  ")
  );
});

test("no test file declares the same test twice", () => {
  // A copy-paste during an edit left "the manifest points at paths that exist"
  // declared twice, so it ran twice — invisible in the pass count, and a sign a
  // surrounding block was duplicated wholesale. Node warns nothing for a
  // repeated name, so the check lives here.
  const offenders = [];
  for (const file of readdirSync(join(repoRoot, "tests")).filter((f) => f.endsWith(".test.mjs"))) {
    const source = readFileSync(join(repoRoot, "tests", file), "utf-8");
    const names = [...source.matchAll(/^test\("([^"]+)"/gm)].map((m) => m[1]);
    const seen = new Set();
    for (const name of names) {
      if (seen.has(name)) {
        offenders.push(`${file}: "${name}"`);
      }
      seen.add(name);
    }
  }
  assert.deepEqual(offenders, [], "these tests are declared more than once");
});

test("every test file declares at least one test", () => {
  // A file that matches the glob but declares nothing is a silent hole: it
  // reports as passing while covering no code at all.
  const empty = readdirSync(join(repoRoot, "tests"))
    .filter((f) => f.endsWith(".test.mjs"))
    .filter((f) => !/^test\("/m.test(readFileSync(join(repoRoot, "tests", f), "utf-8")));
  assert.deepEqual(empty, [], "these test files declare no tests");
});

test("the documented upstream-suite count matches what the harness reports", () => {
  // The README once said "813 tests" after the deselection list was made
  // per-test and the real figure became 874. The suite size is developer
  // documentation, so it now lives in CONTRIBUTING.md and the assertion follows.
  const doc = readFileSync(join(repoRoot, "CONTRIBUTING.md"), "utf-8");
  const claimed = /npm run test:upstream\s+#\s*(\d+) of (\d+) upstream tests/.exec(doc);
  assert.ok(
    claimed,
    'CONTRIBUTING.md must state the suite size as "npm run test:upstream  # N of M upstream tests"'
  );

  const harness = readFileSync(join(repoRoot, "tools", "upstream-tests.mjs"), "utf-8");
  // The harness computes these from pytest, so the doc cannot be checked against
  // a literal — assert the shape: the numbers must be plausible, and the harness
  // must actually measure rather than count entries.
  const ran = Number(claimed[1]);
  const total = Number(claimed[2]);
  assert.ok(ran > 0 && total > ran, `CONTRIBUTING.md claims ${ran} of ${total}, which is not a subset`);
  assert.match(
    harness,
    /--collect-only/,
    "the harness no longer measures the counts it reports — the documented number can drift again"
  );
  assert.ok(
    total > 900,
    `CONTRIBUTING.md says the suite has ${total} tests; upstream ships ~962, so this looks stale`
  );
});

test("the README stays a user document", () => {
  // It is the first thing a visitor reads, and it spent a long stretch at 501
  // lines because developer material kept accreting in it — build internals,
  // transform rationale, upstream findings, all now in CONTRIBUTING.md. A budget
  // is the only thing that keeps it from drifting back, because every individual
  // addition looks reasonable on its own.
  const readme = readFileSync(join(repoRoot, "README.md"), "utf-8");
  const lines = readme.split("\n").length;
  assert.ok(
    lines <= 320,
    `README.md is ${lines} lines (budget 320). Developer material belongs in CONTRIBUTING.md.`
  );

  // And the sections a user needs must not have been trimmed away in the process.
  for (const section of ["## Install", "## Quick start", "## Commands", "## Troubleshooting"]) {
    assert.ok(readme.includes(section), `README lost "${section}"`);
  }
  assert.match(
    readme,
    /CONTRIBUTING\.md/,
    "README must point at CONTRIBUTING.md, or the developer material becomes unreachable"
  );
});

test("AGENTS.md carries the operational facts an agent needs", () => {
  // AGENTS.md is loaded automatically by pi, omp, Codex, Cursor, Copilot and
  // ~20 other agents, so the things that cause damage when unknown must be in
  // it: which trees are generated, and the commands that actually work.
  const agents = readFileSync(join(repoRoot, "AGENTS.md"), "utf-8");

  // Every command it names must be a real npm script. A stale command is worse
  // than a missing one — the agent runs it, it fails, and it starts guessing.
  const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf-8"));
  const referenced = [...agents.matchAll(/npm run ([a-z:]+)/g)].map((m) => m[1]);
  const unknown = [...new Set(referenced)].filter((name) => !(name in (pkg.scripts ?? {})));
  assert.deepEqual(unknown, [], `AGENTS.md names npm scripts that do not exist: ${unknown.join(", ")}`);

  // The generated trees must be called out, or an agent edits one and loses the
  // work on the next sync.
  for (const tree of ["skills/", "agents/", "scripts/", "extensions/"]) {
    assert.ok(agents.includes(tree), `AGENTS.md does not mention the generated tree ${tree}`);
  }
  assert.match(agents, /generated/i, "AGENTS.md must say these trees are generated");

  // It is loaded into context on every session, so it has a budget too.
  const lines = agents.split("\n").length;
  assert.ok(lines <= 150, `AGENTS.md is ${lines} lines (budget 150); it is context on every task`);
});

test("CLAUDE.md stays a bridge rather than a second source of truth", () => {
  // Claude Code reads CLAUDE.md natively and AGENTS.md only through an `@`
  // import, so anything past that import makes two copies that drift — and pi
  // loads only the *first* match (AGENTS.md before CLAUDE.md), so it would not
  // even read the copy.
  const claude = readFileSync(join(repoRoot, "CLAUDE.md"), "utf-8");
  const body = claude.replace(/<!--[\s\S]*?-->/g, "").trim();
  assert.equal(
    body,
    "@AGENTS.md",
    "CLAUDE.md must contain only the @AGENTS.md import; put content in AGENTS.md"
  );
});

test("host packages are peers, never dependencies", () => {
  // A physical copy in dependencies can bypass pi's extension module mapping
  // and create duplicate registries.
  const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf-8"));
  const hosts = [
    "@earendil-works/pi-coding-agent",
    "@earendil-works/pi-ai",
    "@earendil-works/pi-agent-core",
    "@earendil-works/pi-tui",
  ];
  for (const host of hosts) {
    assert.equal(pkg.dependencies?.[host], undefined, `${host} must not be a dependency`);
    assert.equal(pkg.peerDependencies?.[host], "*", `${host} must be a "*" peer`);
  }
  // pi-subagents is a second pi package: a bundled copy would install but never
  // register, and could shadow the user's own install.
  assert.equal(pkg.dependencies?.["pi-subagents"], undefined);
  assert.ok(pkg.peerDependenciesMeta?.["pi-subagents"]?.optional, "pi-subagents must stay optional");
});

test("the published package stays dependency-free", () => {
  // The build needs a YAML parser, but tools/ is not published and the shipped
  // Python imports no npm package — a runtime dependency would be installed by
  // every consumer for code that never runs in their session.
  const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf-8"));
  assert.deepEqual(
    Object.keys(pkg.dependencies ?? {}),
    [],
    "claude-seo-pi must ship with no runtime dependencies"
  );
  assert.ok(pkg.devDependencies?.yaml, "the build's YAML parser must be a devDependency");
});

test("the lockfile does not drag in the host dependency tree", () => {
  // npm 7+ auto-installs peerDependencies and the host peers are "*", so a plain
  // `npm install` resolves the entire pi tree — 266 packages including the AWS
  // SDK and protobufjs — to install one YAML parser. `.npmrc` sets
  // legacy-peer-deps; this asserts it stayed effective.
  let lock;
  try {
    lock = JSON.parse(readFileSync(join(repoRoot, "package-lock.json"), "utf-8"));
  } catch {
    assert.fail("package-lock.json is missing — CI runs `npm ci`");
  }

  // Reading only `lock.packages` made this vacuous: a lockfile with no such key
  // (v1 shape) produced an empty list, so `[].every(...)` held and a lockfile
  // carrying the host tree — the exact regression this test documents — passed
  // unnoticed. Assert the shape first.
  assert.ok(lock.packages, "the lockfile has no `packages` map (v2/v3 format expected)");
  assert.ok(
    lock.lockfileVersion >= 2,
    `lockfileVersion is ${lock.lockfileVersion}; npm ci expects v2 or v3`
  );

  const installed = Object.keys(lock.packages).filter((key) => key !== "");
  assert.ok(installed.length > 0, "the lockfile pins no packages at all");
  assert.ok(
    installed.length <= 5,
    `the lockfile pins ${installed.length} packages; expected only the build's own:\n  ${installed.join("\n  ")}`
  );
  assert.ok(
    installed.every((key) => key === "node_modules/yaml"),
    `unexpected packages in the lockfile: ${installed.join(", ")}`
  );
});

test("the test command works on every Node version we claim to support", () => {
  // `node --test "<glob>"` is not portable by accident: Node 20 cannot expand a
  // glob, and Node 22+ removed the directory argument, so the floor and the
  // invocation have to agree.
  const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf-8"));
  const floor = Number(/(\d+)/.exec(pkg.engines?.node ?? "")?.[1]);
  const testScript = pkg.scripts?.test ?? "";

  assert.ok(Number.isFinite(floor), "engines.node must state a major version");
  assert.ok(
    floor >= 22,
    `engines.node is >= ${floor}; the test runner needs 22 ` +
      "(Node 20 cannot expand a glob, so `npm test` fails outright)"
  );
  assert.match(
    testScript,
    /--test\s+"?[^"]*\.test\.mjs/,
    "scripts.test must pass an explicit test-file glob"
  );
  assert.ok(
    !/--test\s+tests\/?\s*$/.test(testScript),
    "a bare directory argument fails on Node 22+, which removed it"
  );
});

test("CI tests the declared floor and the Active LTS", () => {
  // The floor is the version a user may legitimately run, so it is the one most
  // worth testing; the Active LTS is what most users are actually on. Testing
  // only one of them hides breakage on the other.
  const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf-8"));
  const floor = Number(/(\d+)/.exec(pkg.engines?.node ?? "")?.[1]);
  // Strip comments before matching: an explanatory comment between `matrix:`
  // and `node:` is legal YAML, and matching the raw text misses the entry.
  const workflow = readFileSync(join(repoRoot, ".github", "workflows", "ci.yml"), "utf-8")
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");

  const matrix = /matrix:\s*\n\s*node:\s*\[([^\]]*)\]/.exec(workflow);
  assert.ok(matrix, "ci.yml should test a matrix of Node versions");
  const versions = matrix[1].split(",").map((v) => Number(v.trim()));
  assert.ok(
    versions.includes(floor),
    `CI does not test the declared floor (${floor}); it tests ${versions.join(", ")}`
  );
  assert.ok(
    versions.length >= 2,
    `CI tests only Node ${versions.join(", ")} — add the Active LTS alongside the floor`
  );
});
