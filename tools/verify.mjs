#!/usr/bin/env node
/**
 * Structural verification of the generated tree.
 *
 * Stands in for a real pi/omp install in CI: it asserts the invariants that
 * make the package loadable on both runtimes, without needing either binary.
 *
 * Run: node tools/verify.mjs
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { BLOCK_SCALAR, descriptionOf, frontmatterOf, parseFrontmatter } from "./frontmatter.mjs";
import { GENERATED } from "./sync.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

/** Every file under `dir`, as paths relative to it, bytecode caches excluded. */
function filesUnder(dir) {
  const out = [];
  walk(dir, (file) => {
    const rel = relative(dir, file);
    if (!rel.split(sep).includes("__pycache__")) {
      out.push(rel);
    }
  });
  return out;
}

/**
 * Shipped files that must be upstream's bytes but are not.
 *
 * Covers everything the port copies from upstream's executable code: the
 * launcher and every `scripts/*.py` in both directions (a script upstream ships
 * and the package lacks is a divergence too), `scripts/validate_schema_hook.py`
 * against upstream's `hooks/validate-schema.py`, and each
 * `extensions/<name>/scripts/` tree. The drift gate already catches a hand edit
 * to these; this catches a transform in sync.mjs that touches them.
 */
export function upstreamDivergences(root = repoRoot) {
  const upstream = join(root, "vendor", "claude-seo");
  const problems = [];
  const compare = (shipped, original, label) => {
    if (!existsSync(original)) {
      problems.push(`${label} (not in upstream)`);
    } else if (!existsSync(shipped)) {
      problems.push(`${label} (upstream ships it; the package does not)`);
    } else if (!readFileSync(shipped).equals(readFileSync(original))) {
      problems.push(`${label} (differs from upstream — this port does not patch Python)`);
    }
  };

  const FROM_HOOKS = "validate_schema_hook.py";
  const isScript = (name) => name.endsWith(".py") || name === "claude-seo";
  const names = new Set([
    ...readdirSync(join(root, "scripts")).filter(isScript),
    ...readdirSync(join(upstream, "scripts")).filter(isScript),
  ]);
  names.delete(FROM_HOOKS);
  for (const name of [...names].sort()) {
    compare(join(root, "scripts", name), join(upstream, "scripts", name), `scripts/${name}`);
  }
  compare(join(root, "scripts", FROM_HOOKS), join(upstream, "hooks", "validate-schema.py"), `scripts/${FROM_HOOKS}`);

  for (const ext of readdirSync(join(upstream, "extensions"), { withFileTypes: true })) {
    const theirs = join(upstream, "extensions", ext.name, "scripts");
    const ours = join(root, "extensions", ext.name, "scripts");
    if (!ext.isDirectory() || !existsSync(theirs)) {
      continue;
    }
    const rels = new Set([...filesUnder(theirs), ...(existsSync(ours) ? filesUnder(ours) : [])]);
    for (const rel of [...rels].sort()) {
      compare(join(ours, rel), join(theirs, rel), `extensions/${ext.name}/scripts/${rel}`);
    }
  }
  return problems;
}

/**
 * Shortest description we accept for a skill or agent.
 *
 * A floor for catching a description a transform *emptied*, not a prose style
 * rule: the shortest real one upstream ships is 87 characters.
 */
const MIN_DESCRIPTION = 20;

/** How many agents the parent catalog can carry (pi-subagents MAX_ADVERTISED_AGENTS). */
const ADVERTISE_LIMIT = 16;

const failures = [];
const checks = [];

const ok = (label) => checks.push(label);
const fail = (label, detail) => failures.push(detail ? `${label}: ${detail}` : label);

/** Read a file and return its frontmatter block. */
function frontmatterAt(file) {
  return frontmatterOf(readFileSync(file, "utf-8"));
}

function walk(dir, cb) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, cb);
    } else {
      cb(full);
    }
  }
}

/**
 * A runtime reference to the host package, in any form a module can take one:
 * a static `import`/`export … from` (across lines), a side-effect import, or a
 * dynamic `import()` / `require()`. `import type` and `export type` are erased
 * and therefore fine. Matched against comment-stripped source.
 */
const HOST = String.raw`@(?:earendil-works|oh-my-pi)\/`;
export const HOST_IMPORT = new RegExp(
  [
    String.raw`(?:^|;)\s*(?:import|export)(?!\s+type\b)\s*[^;]*?\bfrom\s*["']${HOST}`,
    String.raw`(?:^|;)\s*import\s*["']${HOST}`,
    String.raw`\b(?:import|require)\s*\(\s*["'\`]${HOST}`,
  ].join("|"),
  "m"
);

/** Drop block and line comments; prose that *describes* an import is not one. */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

export function importsHostAtRuntime(source) {
  return HOST_IMPORT.test(stripComments(source));
}

/** Oldest action major we accept: anything older runs on a deprecated Node. */
export const MIN_ACTION_MAJOR = 6;

/**
 * Every `uses:` in a workflow that is not pinned as `@<40-hex> # vX.Y.Z` on a
 * major of at least MIN_ACTION_MAJOR. Local (`./`) and `docker://` references
 * are not versioned actions and are skipped.
 */
export function actionPinProblems(workflow) {
  const problems = [];
  for (const match of workflow.matchAll(/^\s*(?:-\s+)?uses:\s*["']?([^\s"'#]+)["']?[ \t]*(#.*)?$/gm)) {
    const [, ref, comment = ""] = match;
    if (ref.startsWith("./") || ref.startsWith("docker://")) {
      continue;
    }
    const pin = /^([\w.-]+\/[\w.-]+(?:\/[^@]+)?)@(.+)$/.exec(ref);
    if (!pin) {
      problems.push(`${ref} names no version`);
      continue;
    }
    const [, action, version] = pin;
    if (!/^[0-9a-f]{40}$/.test(version)) {
      problems.push(`${action}@${version} is a mutable ref, not a commit SHA`);
      continue;
    }
    const tag = /^#\s*v(\d+)\.\d+\.\d+\s*$/.exec(comment.trim());
    if (!tag) {
      problems.push(`${action}@${version.slice(0, 7)} has no \`# vX.Y.Z\` comment naming its release`);
      continue;
    }
    if (Number(tag[1]) < MIN_ACTION_MAJOR) {
      problems.push(`${action} is on v${tag[1]}, older than v${MIN_ACTION_MAJOR}`);
    }
  }
  return problems;
}

function main() {
  // 1. Package manifest
  const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf-8"));

  if (pkg.keywords?.includes("pi-package")) {
    ok("package.json declares the pi-package keyword");
  } else {
    fail("package.json is missing the pi-package keyword");
  }

  // pi requires host packages in peerDependencies with "*"; listing them in
  // dependencies produces duplicate module instances.
  for (const host of [
    "@earendil-works/pi-coding-agent",
    "@earendil-works/pi-ai",
    "@earendil-works/pi-agent-core",
    "@earendil-works/pi-tui",
  ]) {
    if (pkg.dependencies?.[host]) {
      fail(`host package ${host} is in dependencies`, "move it to peerDependencies");
    } else if (pkg.peerDependencies?.[host] === "*") {
      ok(`peerDependencies pins ${host} to "*"`);
    } else {
      fail(`peerDependencies is missing ${host} with "*"`);
    }
  }

  // pi-subagents is a *second* pi package, not a library: a dependency copy is
  // never registered as a package, so the agents stay undiscoverable while the copy
  // shadows the user's own install. It must be an optional peer instead.
  if (pkg.dependencies?.["pi-subagents"]) {
    fail(
      "pi-subagents is in dependencies",
      "pi does not register a dependency as a package — the agents would never load"
    );
  } else if (pkg.peerDependencies?.["pi-subagents"] && pkg.peerDependenciesMeta?.["pi-subagents"]?.optional) {
    ok("pi-subagents is an optional peerDependency (installed by the user)");
  } else {
    fail("pi-subagents should be an optional peerDependency");
  }

  // 2. Manifest globs resolve
  // `pkg.pi ?? {}` iterates nothing when the manifest is absent, so a package with
  // no registration at all would pass this section silently. Assert the three
  // resource kinds exist before checking their paths resolve.
  if (!pkg.pi) {
    fail("package.json has no `pi` manifest", "nothing would load on pi or omp");
  } else {
    for (const [kind, required] of [
      ["extensions", true],
      ["skills", true],
      ["subagents", true],
    ]) {
      const value = pkg.pi[kind];
      const list = Array.isArray(value) ? value : Object.values(value ?? {}).flat();
      if (list.length === 0) {
        fail(`pi.${kind} is missing or empty`, required ? "the package registers nothing of this kind" : "");
      }
    }
  }

  for (const [key, value] of Object.entries(pkg.pi ?? {})) {
    const list = Array.isArray(value) ? value : Object.values(value).flat();
    for (const entry of list) {
      const target = join(repoRoot, entry.replace(/^\.\//, ""));
      if (existsSync(target)) {
        ok(`pi.${key} → ${entry}`);
      } else {
        fail(`pi.${key} points at a missing path`, entry);
      }
    }
  }

  // 3. Skill layout
  // omp discovers exactly <skills>/<name>/SKILL.md and nothing deeper, so a
  // nested skill would be invisible to it without this check.
  const skillsDir = join(repoRoot, "skills");
  const skillNames = readdirSync(skillsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);

  for (const name of skillNames) {
    const skillFile = join(skillsDir, name, "SKILL.md");
    if (!existsSync(skillFile)) {
      fail(`skills/${name} has no SKILL.md`);
      continue;
    }
    // Check the *resolved* value: a `description: >` header whose body was lost
    // parses as "", and matching the header line instead reports a destroyed
    // description as present.
    const description = descriptionOf(frontmatterAt(skillFile));
    if (BLOCK_SCALAR.test(description)) {
      fail(`skills/${name}/SKILL.md description is a bare block-scalar header`, description);
    } else if (description.length < MIN_DESCRIPTION) {
      // omp's plugin provider requires a description and silently drops skills
      // that lack one.
      fail(
        `skills/${name}/SKILL.md has a missing or too-short description`,
        `${description.length} chars — omp will not load it`
      );
    }
  }

  const nested = [];
  walk(skillsDir, (file) => {
    const parts = relative(skillsDir, file).split("/");
    if (file.endsWith("SKILL.md") && parts.length > 2) {
      nested.push(relative(repoRoot, file));
    }
  });
  if (nested.length > 0) {
    fail("nested SKILL.md files are invisible to omp", nested.join(", "));
  } else {
    ok(`all ${skillNames.length} skills are one level deep`);
  }

  // 4. Agent definitions
  const agentsDir = join(repoRoot, "agents");
  const agentNames = readdirSync(agentsDir).filter((f) => f.endsWith(".md"));
  const advertisedAgents = [];
  for (const file of agentNames) {
    const fm = frontmatterAt(join(agentsDir, file));
    const values = parseFrontmatter(fm).values;

    if (!/^name:\s*\S/m.test(fm)) {
      fail(`agents/${file} has no name`);
    }
    const description = values.description ?? "";
    if (BLOCK_SCALAR.test(description)) {
      fail(`agents/${file} description is a bare block-scalar header`, description);
    } else if (description.length < MIN_DESCRIPTION) {
      fail(
        `agents/${file} has a missing or too-short description`,
        `${description.length} chars — it would be advertised empty`
      );
    }
    if (/^model:/m.test(fm)) {
      // Upstream's `model: sonnet` is not a pi model selector.
      fail(`agents/${file} still carries a model field`, "upstream's value does not resolve in pi");
    }
    if (/^maxTurns:/m.test(fm)) {
      fail(`agents/${file} still carries maxTurns`, "not a pi-subagents field");
    }

    // pi-subagents treats `tools` as a strict allowlist: omitting the key grants
    // *every* builtin tool, so an empty list silently widens a read-only agent.
    const tools = (values.tools ?? "").split(",").map((t) => t.trim()).filter(Boolean);
    if (tools.length === 0) {
      fail(
        `agents/${file} declares no tools allowlist`,
        "omitting tools grants every builtin tool, not none"
      );
    }
    if (values.advertise === "true") {
      advertisedAgents.push(values.name ?? file);
    }
  }
  if (agentNames.length > 0) {
    ok(`${agentNames.length} agent definitions carry name + description`);
  }

  // pi-subagents caps the parent catalog at MAX_ADVERTISED_AGENTS (16) and picks
  // entries in sorted order, so an overflow drops the last ones with no error.
  if (advertisedAgents.length > ADVERTISE_LIMIT) {
    fail(
      `${advertisedAgents.length} agents set advertise: true but pi-subagents advertises at most ${ADVERTISE_LIMIT}`,
      `silently dropped: ${advertisedAgents.sort().slice(ADVERTISE_LIMIT).join(", ")}`
    );
  } else {
    ok(`advertise is set on ${advertisedAgents.length}/${ADVERTISE_LIMIT} agents`);
  }

  // 5. No Claude Code placeholders the model would expand
  const placeholders = [];
  for (const dir of ["skills", "agents"]) {
    walk(join(repoRoot, dir), (file) => {
      if (readFileSync(file, "utf-8").includes("${CLAUDE_")) {
        placeholders.push(relative(repoRoot, file));
      }
    });
  }
  if (placeholders.length > 0) {
    fail("Claude Code placeholders survived", placeholders.join(", "));
  } else {
    ok("no ${CLAUDE_*} placeholders remain in skills or agents");
  }

  // Upstream's extension installers write to ~/.claude.json and
  // ~/.claude/settings.json, which neither pi nor omp reads. Any surviving
  // reference tells the model to run a script that is not shipped.
  const installerRefs = [];
  for (const dir of ["skills", "agents"]) {
    walk(join(repoRoot, dir), (file) => {
      if (/extensions\/[a-z-]+\/install\.(sh|ps1)/.test(readFileSync(file, "utf-8"))) {
        installerRefs.push(relative(repoRoot, file));
      }
    });
  }
  if (installerRefs.length > 0) {
    fail("references to Claude Code extension installers survived", installerRefs.join(", "));
  } else {
    ok("no dangling extension installer references");
  }

  // 5b. Upstream Python is shipped verbatim
  // `scripts/` is copied byte-for-byte and this port does not patch it: a local
  // edit is a divergence to carry on every upstream bump, and it destroys the
  // value of `diff -r scripts/ vendor/claude-seo/scripts/` as a review signal.
  // validate_schema_hook.py is upstream's hooks/validate-schema.py under a new name.
  if (!existsSync(join(repoRoot, "vendor", "claude-seo", "scripts"))) {
    fail("vendor/claude-seo/scripts is missing", "run `npm run vendor` first");
  } else {
    const diverged = upstreamDivergences();
    if (diverged.length > 0) {
      fail(
        `the shipped Python diverges from upstream: ${diverged.join(", ")}`,
        "this port ships upstream verbatim — report the fix upstream instead"
      );
    } else {
      ok("every shipped Python file, the launcher and the schema hook are byte-identical to upstream");
    }
  }

  // A patch mechanism would silently reintroduce that divergence.
  {
    const syncSource = readFileSync(join(repoRoot, "tools", "sync.mjs"), "utf-8");
    if (/PYTHON_PATCHES|patchPython/.test(syncSource)) {
      fail("sync.mjs has a Python patch mechanism", "the port is meant to ship upstream verbatim");
    } else {
      ok("sync.mjs does not patch upstream Python");
    }
  }

  // 5c. Workflows pin every action to a commit on a current major
  // A tag is mutable: whoever controls the action's repository can move `v7` to
  // new code, and release.yml would run it with an OIDC token that can publish.
  // So each `uses:` must name a full commit SHA, with the release it corresponds
  // to in a trailing `# vX.Y.Z` comment (the form Dependabot keeps up to date).
  //
  // The major is read from that comment, because a stale major is a slow-motion
  // failure: GitHub stops running actions built on a retired Node runtime, and in
  // release.yml that failure lands on `npm publish`, the one step that cannot be
  // retried once the tag is public.
  const workflowsDir = join(repoRoot, ".github", "workflows");
  const workflowFiles = readdirSync(workflowsDir).filter((f) => /\.ya?ml$/.test(f));
  {
    const problems = workflowFiles.flatMap((file) =>
      actionPinProblems(readFileSync(join(workflowsDir, file), "utf-8")).map((p) => `${file}: ${p}`)
    );
    if (problems.length > 0) {
      fail(
        `workflow actions are not pinned to a commit on a supported major: ${problems.join("; ")}`,
        `use \`owner/action@<40-hex sha> # vX.Y.Z\` with X >= ${MIN_ACTION_MAJOR}`
      );
    } else {
      ok(`workflow actions are SHA-pinned on supported majors (${workflowFiles.join(", ")})`);
    }
  }

  // The README is the documented replacement for those installers, so the
  // sections the skills now point at must actually exist.
  const readme = readFileSync(join(repoRoot, "README.md"), "utf-8");
  for (const section of [
    "## Install",
    "## Quick start",
    "## Commands",
    "## Optional integrations",
    "## Troubleshooting",
  ]) {
    if (readme.includes(section)) {
      ok(`README has "${section}"`);
    } else {
      fail(`README is missing the "${section}" section`, "skills redirect users there");
    }
  }

  // A document that links a file the package does not ship sends a reader to a 404
  // they cannot diagnose, so this covers every doc we publish, not just the README
  // — AGENTS.md links two of them and CLAUDE.md imports a third.
  {
    const published = new Set((pkg.files ?? []).map((entry) => entry.replace(/\/$/, "")));
    const broken = [];
    let checked = 0;
    for (const doc of ["README.md", "CONTRIBUTING.md", "AGENTS.md", "CLAUDE.md"]) {
      if (!published.has(doc)) {
        fail(`${doc} is not in package.json files[]`, "it would be absent from the tarball");
        continue;
      }
      const text = readFileSync(join(repoRoot, doc), "utf-8");
      // Markdown links and `@path` imports both resolve to a file at runtime.
      // A `#section` anchor still loads the file, so it counts; a path inside a
      // directory is published only when that top-level directory is.
      const targets = new Set([
        ...[...text.matchAll(/\]\(\.?\/?([A-Za-z0-9_.\/-]+\.md)(?:#[^)]*)?\)/g)].map((m) => m[1].split("/")[0]),
        ...[...text.matchAll(/^@([A-Za-z0-9_.-]+\.md)$/gm)].map((m) => m[1]),
      ]);
      for (const target of targets) {
        checked += 1;
        if (!published.has(target)) {
          broken.push(`${doc} → ${target}`);
        }
      }
    }
    if (broken.length > 0) {
      fail(
        `published docs reference files the package does not ship: ${broken.join(", ")}`,
        "add them to package.json files[], or the link 404s for anyone installing from npm"
      );
    } else {
      ok(`${checked} cross-document link(s) resolve to published files`);
    }
  }

  // CLAUDE.md is a bridge, not a second source of truth: Claude Code reads it
  // natively and AGENTS.md only via an `@` import, so anything past that import
  // makes two copies that drift. pi loads only the first match, so it would not
  // even read this one.
  {
    const claudePath = join(repoRoot, "CLAUDE.md");
    if (!existsSync(claudePath)) {
      fail("CLAUDE.md is missing", "Claude Code reads CLAUDE.md, not AGENTS.md");
    } else {
      const text = readFileSync(claudePath, "utf-8");
      const body = text
        .replace(/<!--[\s\S]*?-->/g, "") // strip the rationale comments
        .trim();
      if (!/^@AGENTS\.md\s*$/.test(body)) {
        fail(
          "CLAUDE.md has content beyond the @AGENTS.md import",
          "keep AGENTS.md the single source of truth; a copy here will drift"
        );
      } else {
        ok("CLAUDE.md is a one-line bridge to AGENTS.md");
      }
    }
  }

  // 6. Python runtime contract
  // runtime.py resolves its package root as the parent of scripts/ and reads
  // requirements.txt plus a version manifest from there.
  for (const [label, rel] of [
    ["launcher", "scripts/claude-seo"],
    ["runtime", "scripts/runtime.py"],
    ["requirements", "requirements.txt"],
    ["version manifest", "runtime-plugin.json"],
    ["data ledger", "data/google-updates.json"],
    ["schema templates", "schema/templates.json"],
    ["schema hook", "scripts/validate_schema_hook.py"],
  ]) {
    if (existsSync(join(repoRoot, rel))) {
      ok(`${label} present (${rel})`);
    } else {
      fail(`${label} missing`, rel);
    }
  }

  const launcher = join(repoRoot, "scripts", "claude-seo");
  if (existsSync(launcher) && !(statSync(launcher).mode & 0o111)) {
    fail("scripts/claude-seo is not executable", "skills invoke it directly");
  } else if (existsSync(launcher)) {
    ok("scripts/claude-seo is executable");
  }

  // package.json and runtime-plugin.json must state the same version, and
  // sync.mjs is what keeps them in step. The failure this catches is silent in
  // both directions: runtime.py reports the manifest's version while npm publishes
  // package.json's, so a release that bumped one would ship a runtime claiming a
  // version nobody tagged.
  //
  // The version itself is `<upstream>-pi.N`: the upstream release it ports plus a
  // port revision, so a port-only fix can ship without waiting for upstream.
  {
    const manifestPath = join(repoRoot, "runtime-plugin.json");
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
      if (manifest.version !== pkg.version) {
        fail(
          `runtime-plugin.json version ${manifest.version} does not match package.json ${pkg.version}`,
          "run `npm run sync` — runtime.py reads the manifest, npm publishes package.json"
        );
      } else {
        ok(`runtime-plugin.json agrees with package.json (${pkg.version})`);
      }
    }

    const upstreamPlugin = join(repoRoot, "vendor", "claude-seo", ".claude-plugin", "plugin.json");
    if (!existsSync(upstreamPlugin)) {
      fail("vendor/claude-seo/.claude-plugin/plugin.json is missing", "run `npm run vendor` first");
    } else {
      const upstreamVersion = JSON.parse(readFileSync(upstreamPlugin, "utf-8")).version;
      const escaped = String(upstreamVersion).replace(/\./g, "\\.");
      if (new RegExp(`^${escaped}-pi\\.(?:0|[1-9]\\d*)$`).test(pkg.version)) {
        ok(`package.json version ${pkg.version} is upstream ${upstreamVersion} plus a port revision`);
      } else {
        fail(
          `package.json version ${pkg.version} is not ${upstreamVersion}-pi.N`,
          "run `npm run sync`, which derives it from the vendored upstream"
        );
      }
    }
  }

  // runtime.py's _resolve_script looks for extension scripts at
  // <pkg>/extensions/<name>/scripts.
  const bananaScripts = join(repoRoot, "extensions", "banana", "scripts");
  if (existsSync(bananaScripts) && readdirSync(bananaScripts).length > 0) {
    ok("extension scripts staged for the runtime (banana)");
  } else {
    fail("extensions/banana/scripts is missing", "runtime.py --extension banana will fail");
  }

  // 7. Hand-written extensions
  // Read from src/extensions/ rather than listed here, so a new extension cannot
  // ship unchecked; each one must also be registered, or pi never loads it.
  const extDir = join(repoRoot, "extensions");
  const handWritten = readdirSync(join(repoRoot, "src", "extensions")).filter((f) => f.endsWith(".ts"));
  const registered = new Set((pkg.pi?.extensions ?? []).map((entry) => entry.replace(/^\.\/extensions\//, "")));
  const unregistered = handWritten.filter((file) => !registered.has(file));
  if (unregistered.length > 0) {
    fail(`src/extensions has files package.json pi.extensions does not load: ${unregistered.join(", ")}`);
  } else {
    ok(`all ${handWritten.length} hand-written extensions are registered in pi.extensions`);
  }
  for (const file of handWritten) {
    const full = join(extDir, file);
    if (!existsSync(full)) {
      fail(`extension ${file} is missing`);
      continue;
    }
    const source = readFileSync(full, "utf-8");
    // A *runtime* import of the host would have to resolve to @earendil-works/* on
    // pi and @oh-my-pi/* on omp; `import type` is erased and therefore safe, and
    // node: builtins are always fine.
    if (importsHostAtRuntime(source)) {
      fail(`extensions/${file} imports the host package at runtime`, "use `import type`");
    } else {
      ok(`extensions/${file} imports the host type-only`);
    }
  }

  // 8. Publish surface
  const files = pkg.files ?? [];
  if (files.some((f) => f.startsWith("vendor"))) {
    fail("package.json files[] would publish vendor/", "that is build input, not artifact");
  } else {
    ok("vendor/ is excluded from the published package");
  }

  // Every directory sync generates must be published: one that is committed but
  // not packed works from a git install and is missing from npm.
  const unpublished = GENERATED.filter((dir) => !files.includes(dir) && !files.includes(`${dir}/`));
  if (unpublished.length > 0) {
    fail(`sync generates directories package.json files[] omits: ${unpublished.join(", ")}`);
  } else {
    ok(`every generated directory is in files[] (${GENERATED.join(", ")})`);
  }

  // The build reads frontmatter with the `yaml` package, but tools/ is not
  // published, so it must stay a devDependency: otherwise every consumer installs
  // a parser the shipped code never imports.
  if (pkg.dependencies?.yaml) {
    fail("yaml is in dependencies", "it is a build input; tools/ is not published");
  } else if (pkg.devDependencies?.yaml) {
    ok("yaml is a devDependency of the build, not a runtime dependency");
  } else {
    fail("yaml is missing from devDependencies", "tools/frontmatter.mjs imports it");
  }

  // A published package whose install pulls the host's whole dependency tree is a
  // bug. `.npmrc` sets legacy-peer-deps so the "*" host peers stay off the
  // registry — without it, `npm ci` installs 266 packages.
  if (existsSync(join(repoRoot, ".npmrc"))) {
    const npmrc = readFileSync(join(repoRoot, ".npmrc"), "utf-8");
    if (/legacy-peer-deps\s*=\s*true/.test(npmrc)) {
      ok(".npmrc keeps peer resolution off the registry");
    } else {
      fail(".npmrc exists but does not set legacy-peer-deps", "npm ci would resolve every host peer");
    }
  } else {
    fail(
      ".npmrc is missing",
      "without legacy-peer-deps, npm resolves the \"*\" host peers and installs the whole pi tree"
    );
  }

  // scripts/ ships Python and the launcher imports it in place, so Python writes
  // __pycache__ next to the sources. Ask git rather than grepping .gitignore: the
  // rule may be `*.pyc`, `*.py[cod]` or `__pycache__/`.
  try {
    execFileSync("git", ["check-ignore", "-q", "scripts/__pycache__/probe.pyc"], {
      cwd: repoRoot,
      stdio: "ignore",
    });
    ok("git ignores the Python bytecode the launcher generates");
  } catch {
    fail(
      "scripts/**/__pycache__/*.pyc is not gitignored",
      "it would be committed and packed into the tarball"
    );
  }

  // .gitignore does not affect `npm pack`, which reads files[] and cannot see
  // ignore rules. Checked by asking npm, not by reading the manifest, because that
  // is the only way to know what actually ships.
  try {
    const packed = JSON.parse(
      execFileSync("npm", ["pack", "--dry-run", "--json"], {
        cwd: repoRoot,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      })
    );
    // npm 12 keys the JSON by package name instead of returning an array.
    const entry = Array.isArray(packed) ? packed[0] : Object.values(packed)[0];
    const paths = (entry?.files ?? []).map((f) => f.path);
    const bytecode = paths.filter((p) => p.includes("__pycache__") || p.endsWith(".pyc"));
    if (bytecode.length > 0) {
      fail(
        `the published tarball would carry ${bytecode.length} Python bytecode files`,
        `first: ${bytecode[0]} — add "!**/__pycache__" to package.json files[]`
      );
    } else if (paths.length === 0) {
      fail("npm pack reported no files", "the publish surface could not be inspected");
    } else {
      ok(`the published tarball carries no bytecode (${paths.length} files)`);
    }
  } catch (error) {
    fail("could not inspect the published tarball", String(error.message).slice(0, 80));
  }

  // Node's own floor. The build scripts use baseline features, so the floor is set
  // by the *test runner*: `node --test "<glob>"` needs Node 22, because Node 20
  // cannot expand a glob and Node 22+ dropped the directory argument.
  const MIN_NODE_MAJOR = 22;
  const nodeFloor = pkg.engines?.node;
  if (!nodeFloor) {
    fail("package.json does not declare engines.node", "consumers cannot tell what Node the build needs");
  } else {
    const declared = Number(/(\d+)/.exec(nodeFloor)?.[1]);
    if (!Number.isFinite(declared)) {
      fail(`engines.node is not a recognisable range`, nodeFloor);
    } else if (declared < MIN_NODE_MAJOR) {
      fail(
        `engines.node allows Node ${declared}`,
        `the test runner needs >= ${MIN_NODE_MAJOR}, and Node 20 is end-of-life (2026-04-30)`
      );
    } else {
      ok(`package.json declares engines.node ${nodeFloor}`);
    }
  }

  // 9. Repository wiring
  // The CI workflow only ran on `main` while the repository's branch was `master`,
  // so every push skipped it — a workflow that never fires reads as a passing gate.
  // The check compares against the branch this repository is actually on.
  //
  // Comment lines are stripped first: a comment between `push:` and `branches:` is
  // legal YAML, and matching the raw text reports a restricted trigger as open.
  const workflow = readFileSync(join(repoRoot, ".github", "workflows", "ci.yml"), "utf-8")
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");

  let currentBranch = "";
  try {
    currentBranch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf-8",
    }).trim();
  } catch {
    // No git (a source tarball).
    currentBranch = "";
  }

  const LONG_LIVED_BRANCHES = new Set(["main", "master", "development", "develop", "trunk"]);

  const pushBlock = /^on:\n(?:.*\n)*?\s{2}push:\n((?:\s{4,}.*\n?)*)/m.exec(workflow);
  const pushBranches = pushBlock && /branches:\s*\[([^\]]*)\]/.exec(pushBlock[1]);
  const branches = pushBranches
    ? pushBranches[1].split(",").map((b) => b.trim().replace(/["']/g, "")).filter(Boolean)
    : null;

  if (!pushBlock) {
    fail("ci.yml has no parseable `on.push` block", "the workflow may not run on push at all");
  } else if (branches === null) {
    ok("CI runs on every push (no branch filter)");
  } else if (
    currentBranch &&
    currentBranch !== "HEAD" &&
    !branches.includes(currentBranch) &&
    // A contributor's topic branch (`fix/...`) never matches a push filter by
    // design: its CI runs through `pull_request`. Only a long-lived branch
    // missing from the filter is the bug this check exists for.
    (LONG_LIVED_BRANCHES.has(currentBranch) || !/^  pull_request:/m.test(workflow))
  ) {
    fail(
      `CI push trigger does not include the current branch '${currentBranch}'`,
      `it names: ${branches.join(", ")} — pushes to this branch would never run CI`
    );
  } else {
    ok(`CI push trigger covers the current branch (${branches.join(", ")})`);
  }

  // The README quotes an agent count in two places; they disagreed once.
  const readmeText = readFileSync(join(repoRoot, "README.md"), "utf-8");
  const counts = [...readmeText.matchAll(/(\d+)\s+specialist agents/g)].map((m) => Number(m[1]));
  const wrong = counts.filter((n) => n !== agentNames.length);
  if (wrong.length > 0) {
    fail(
      `README claims ${[...new Set(wrong)].join(" and ")} specialist agents`,
      `agents/ holds ${agentNames.length}`
    );
  } else if (counts.length === 0) {
    fail("README never states how many specialist agents ship");
  } else {
    ok(`README's agent count (${counts[0]}) matches agents/`);
  }

  // Report
  if (failures.length > 0) {
    console.error(`\n✗ verify failed — ${failures.length} problem(s)\n`);
    for (const f of failures) {
      console.error(`  · ${f}`);
    }
    process.exit(1);
  }

  console.log(`✓ verify passed — ${checks.length} checks`);
  for (const c of checks) {
    console.log(`  · ${c}`);
  }
}

/**
 * True when this file is the entry point. import.meta.url is the realpath, so
 * argv[1] is resolved too: through a symlinked checkout the two differ and the
 * script would exit 0 having done nothing.
 */
function invokedDirectly() {
  if (!process.argv[1]) {
    return false;
  }
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  main();
}
