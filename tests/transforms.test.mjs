/**
 * What the sync transform must leave in the shipped tree.
 *
 * `npm run check` regenerates nothing, and CI's drift gate only says the commit
 * matches the sync output: an edit to sync.mjs that, say, renames the script-root
 * variable or drops a skill regenerates a consistent but broken tree and passes.
 * These assert the properties the host depends on, not the bytes.
 */
import { strict as assert } from "node:assert";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { frontmatterOf, parseFrontmatter } from "../tools/frontmatter.mjs";
import { convertAgent, portVersion } from "../tools/sync.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (...parts) => readFileSync(join(repoRoot, ...parts), "utf-8");

const skills = readdirSync(join(repoRoot, "skills"), { withFileTypes: true }).filter((e) => e.isDirectory());
const agentFiles = readdirSync(join(repoRoot, "agents")).filter((f) => f.endsWith(".md"));

/** Every shipped agent's frontmatter values, keyed by agent name. */
function agents() {
  return Object.fromEntries(
    agentFiles.map((file) => [file.replace(/\.md$/, ""), parseFrontmatter(frontmatterOf(read("agents", file))).values])
  );
}

test("the skill and agent counts the docs advertise match the shipped tree", () => {
  const claim = /(\d+)\s+(?:SEO\s+)?skills,\s+(\d+)\s+specialist agents/;
  for (const [name, text] of [["package.json", JSON.parse(read("package.json")).description], ["README.md", read("README.md")]]) {
    const match = claim.exec(text.replace(/\s+/g, " "));
    assert.ok(match, `${name} no longer states "N skills, M specialist agents"`);
    assert.equal(Number(match[1]), skills.length, `${name} claims ${match[1]} skills, the tree ships ${skills.length}`);
    assert.equal(Number(match[2]), agentFiles.length, `${name} claims ${match[2]} agents, the tree ships ${agentFiles.length}`);
  }
});

test("every skill the extension skills merge in is present", () => {
  // The seven integration skills come from upstream's extensions/ directory; a
  // sync that stopped copying them took the count from 33 to 26.
  const names = new Set(skills.map((s) => s.name));
  for (const required of ["seo", "seo-audit", "seo-dataforseo", "seo-firecrawl", "seo-matomo", "seo-image-gen", "seo-unlighthouse"]) {
    assert.ok(names.has(required), `skills/${required} is missing`);
  }
});

test("skills locate their scripts through a variable the extension exports", () => {
  const exported = new Set(["SEO_PLUGIN_ROOT"]);
  const extension = read("src", "extensions", "seo-setup.ts");
  for (const name of exported) {
    assert.ok(extension.includes(`process.env.${name}`), `the extension no longer sets ${name}`);
  }

  const used = new Set();
  for (const dir of ["skills", "agents"]) {
    const walk = (path) => {
      for (const entry of readdirSync(path, { withFileTypes: true })) {
        const full = join(path, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (/\.(md|txt)$/.test(entry.name)) {
          for (const m of readFileSync(full, "utf-8").matchAll(/\$\{?(SEO_[A-Z_]+)\}?/g)) {
            used.add(m[1]);
          }
        }
      }
    };
    walk(join(repoRoot, dir));
  }
  assert.ok(used.size > 0, "no skill references the script root any more");
  for (const name of used) {
    assert.ok(exported.has(name), `$${name} is used in skills/ or agents/ but no extension exports it`);
  }
});

test("every agent tool is a pi tool or an mcp:<server> reference", () => {
  const PI_TOOLS = new Set(["read", "bash", "write", "edit", "find", "grep", "ls"]);
  for (const [name, values] of Object.entries(agents())) {
    const tools = String(values.tools ?? "").split(",").map((t) => t.trim()).filter(Boolean);
    assert.ok(tools.length > 0, `${name}: an empty tools list grants every builtin tool`);
    for (const tool of tools) {
      assert.ok(PI_TOOLS.has(tool) || /^mcp:[a-z0-9-]+$/.test(tool), `${name}: '${tool}' is not a pi tool`);
    }
  }
  assert.match(String(agents()["seo-dataforseo"].tools), /mcp:dataforseo/, "seo-dataforseo lost its MCP server");
});

test("the audit core is advertised and the four skill-reached agents are not", () => {
  const advertised = (values) => String(values.advertise) === "true";
  const all = agents();
  for (const name of ["seo-technical", "seo-sitemap", "seo-sxo", "seo-visual"]) {
    assert.ok(advertised(all[name]), `${name} must be in the parent catalog: the audit orchestrator spawns it`);
  }
  for (const name of ["seo-drift", "seo-flow", "seo-image-gen", "seo-matomo"]) {
    assert.ok(!advertised(all[name]), `${name} is reached through its own skill and stays out of the catalog`);
  }
  assert.ok(Object.values(all).filter(advertised).length <= 16, "pi-subagents drops advertised agents past 16");
});

test("agents carry the managed flags as bare YAML booleans", () => {
  // pi-subagents reads `advertise` as a boolean; a quoted "true" is a string.
  for (const file of agentFiles) {
    const frontmatter = frontmatterOf(read("agents", file));
    for (const key of ["advertise", "inheritProjectContext", "inheritSkills"]) {
      assert.match(frontmatter, new RegExp(`^${key}: (?:true|false)$`, "m"), `${file}: ${key} is not a bare boolean`);
    }
  }
  assert.ok(
    agentFiles.some((file) => /^advertise: true$/m.test(read("agents", file))),
    "no agent is advertised at all"
  );
});

test("an agent's unmanaged keys keep their YAML type, and a non-scalar fails the sync", () => {
  const source = (extra) =>
    ["---", "name: scout", "description: A scout agent that reads pages.", "tools: Read", ...extra, "---", "body", ""].join("\n");

  const converted = parseFrontmatter(frontmatterOf(convertAgent(source(['color: "true"', "retries: 3", "note: plain"]), "scout.md")));
  assert.equal(converted.raw.color, "true", "a quoted string became a boolean");
  assert.equal(converted.raw.retries, 3);
  assert.equal(converted.raw.note, "plain");
  assert.equal(converted.raw.advertise, true, "the managed flag must stay a bare boolean");

  assert.throws(() => convertAgent(source(["hooks:", "  - a", "  - b"]), "scout.md"), /"hooks" is a list/);
  assert.throws(() => convertAgent(source(["meta:", "  k: v"]), "scout.md"), /"meta" is a mapping/);
});

test("an MCP wildcard keeps its server name exactly, underscores, dots and case included", () => {
  // `mcp:` selectors must name a configured server; the old pattern lowercased
  // the name and rejected `_` and `.`, so such a grant was silently dropped.
  const toolsOf = (tools) =>
    parseFrontmatter(
      frontmatterOf(
        convertAgent(["---", "name: scout", "description: A scout agent that reads pages.", `tools: ${tools}`, "---", ""].join("\n"), "scout.md")
      )
    ).values.tools;
  assert.equal(toolsOf("Read, mcp__google_analytics__*"), "read, mcp:google_analytics");
  assert.equal(toolsOf("Read, mcp__My.Server__*"), "read, mcp:My.Server");
  assert.equal(toolsOf("Read, mcp__dataforseo__serp_live"), "read", "a per-tool MCP grant has no pi equivalent");
});

test("skill-dir placeholders read as prose, not as a path to type", () => {
  // `${CLAUDE_SKILL_DIR}` in backticks became `this skill's directory` in
  // backticks, which reads as a literal path.
  const offenders = [];
  for (const { name } of skills) {
    if (read("skills", name, "SKILL.md").includes("`this skill's directory`")) {
      offenders.push(name);
    }
  }
  assert.deepEqual(offenders, []);
  assert.match(read("skills", "seo-image-gen", "SKILL.md"), /the directory containing this SKILL\.md/);
});

test("the package version is the upstream release plus a port revision", () => {
  assert.equal(portVersion("2.4.2", "2.4.2"), "2.4.2-pi.0", "a plain version starts the scheme");
  assert.equal(portVersion("2.4.2", "2.4.2-pi.3"), "2.4.2-pi.3", "the maintainer's revision is kept");
  assert.equal(portVersion("2.4.3", "2.4.2-pi.3"), "2.4.3-pi.0", "a new upstream resets the revision");
  assert.equal(portVersion("2.4.2", "2.4.2-beta.1"), "2.4.2-pi.0", "another prerelease shape is reset");
  assert.equal(portVersion("2.4.2", "2.4.2-pi.01"), "2.4.2-pi.0", "a leading zero is not valid semver");
  assert.equal(portVersion("2.4.2", undefined), "2.4.2-pi.0");
  for (const bad of ["2.5.0-rc.1", "2.4", "v2.4.2", "2.4.2 ", undefined, 242]) {
    assert.throws(() => portVersion(bad, "2.4.2-pi.0"), /usable release version/, `${JSON.stringify(bad)} was accepted`);
  }

  // And the shipped files agree on it.
  const pkg = JSON.parse(read("package.json"));
  assert.match(pkg.version, /^\d+\.\d+\.\d+-pi\.(?:0|[1-9]\d*)$/);
  assert.equal(JSON.parse(read("runtime-plugin.json")).version, pkg.version, "runtime.py would report another version");
  const lock = JSON.parse(read("package-lock.json"));
  assert.equal(lock.version, pkg.version, "the lockfile root version drifted from package.json");
  assert.equal(lock.packages[""].version, pkg.version);
});

test("the skill merge leaves the vendored tree as the archive shipped it", () => {
  // The merge once copied the core references into the vendored extension
  // copy, so the second sync read an upstream the archive does not contain.
  const banana = join(repoRoot, "vendor", "claude-seo", "extensions", "banana", "skills", "seo-image-gen");
  assert.ok(existsSync(join(banana, "SKILL.md")), "the vendored banana skill is gone");
  assert.ok(
    !existsSync(join(banana, "references")),
    "sync wrote references/ into vendor/ (run `npm run vendor` to restore the archive, then fix the merge)"
  );
  // The shipped skill still carries the core references the merge keeps.
  const core = readdirSync(join(repoRoot, "vendor", "claude-seo", "skills", "seo-image-gen", "references"));
  const shipped = new Set(readdirSync(join(repoRoot, "skills", "seo-image-gen", "references")));
  assert.deepEqual(core.filter((file) => !shipped.has(file)), [], "the merged skill lost core references");
});
