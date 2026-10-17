/**
 * What the sync transform must leave in the shipped tree.
 *
 * `npm run check` regenerates nothing, and CI's drift gate only says the commit
 * matches the sync output: an edit to sync.mjs that, say, renames the script-root
 * variable or drops a skill regenerates a consistent but broken tree and passes.
 * These assert the properties the host depends on, not the bytes.
 */
import { strict as assert } from "node:assert";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { frontmatterOf, parseFrontmatter } from "../tools/frontmatter.mjs";

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
