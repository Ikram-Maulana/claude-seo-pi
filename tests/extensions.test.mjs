/**
 * Static checks on the hand-written extensions.
 *
 * `pi.logger` and `ctx.queueMessage` are not in the pi extension API; jiti
 * erases the types, so the mistake only showed up as a runtime TypeError in a
 * user's session. The typecheck in CI is the real guard — this file is the
 * cheap one, running with no dependencies.
 */
import { strict as assert } from "node:assert";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const srcExtDir = join(repoRoot, "src", "extensions");
const extensions = readdirSync(srcExtDir).filter((f) => f.endsWith(".ts"));

/**
 * Members that do not exist on the pi extension API.
 *
 * Both are `undefined` at runtime, and optional chaining hid the logging
 * failure while the command silently sent nothing.
 */
const NON_EXISTENT = [
  ["pi.logger", /\bpi\.logger\b/],
  ["ctx.queueMessage", /\bctx\.queueMessage\b/],
  ["ctx.sendMessage", /\bctx\.sendMessage\b/],
];

/**
 * Strip comments before matching.
 *
 * The fixes for this bug *describe* the members that were wrong, so a naive
 * grep flags the comment explaining why the call is gone.
 */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

test("the extensions do not call API members that do not exist", () => {
  const offenders = [];
  for (const file of extensions) {
    const source = stripComments(readFileSync(join(srcExtDir, file), "utf-8"));
    for (const [label, pattern] of NON_EXISTENT) {
      if (pattern.test(source)) {
        offenders.push(`${file}: ${label}`);
      }
    }
  }
  assert.deepEqual(offenders, [], "these calls are undefined at runtime");
});

test("the extensions import the host type-only", () => {
  // A runtime import of the host would have to resolve to @earendil-works/* on
  // pi and @oh-my-pi/* on omp, so it is erased deliberately.
  const offenders = [];
  for (const file of extensions) {
    const source = readFileSync(join(srcExtDir, file), "utf-8");
    if (/^\s*import\s+(?!type\b)[^\n]*from\s+["']@(?:earendil-works|oh-my-pi)\//m.test(source)) {
      offenders.push(file);
    }
  }
  assert.deepEqual(offenders, [], "use `import type` for the host package");
});

test("the generated extensions match their sources", () => {
  // extensions/ is generated from src/extensions/ by the sync. A mismatch means
  // someone edited the built copy, which the next sync would discard.
  const mismatched = [];
  for (const file of extensions) {
    const source = readFileSync(join(srcExtDir, file), "utf-8");
    let built;
    try {
      built = readFileSync(join(repoRoot, "extensions", file), "utf-8");
    } catch {
      mismatched.push(`${file} (missing from extensions/)`);
      continue;
    }
    if (built !== source) {
      mismatched.push(`${file} (extensions/ differs from src/extensions/)`);
    }
  }
  assert.deepEqual(mismatched, [], "run `npm run sync` to regenerate extensions/");
});

test("the schema validator stays non-blocking", () => {
  // The hook must never return a result that could fail the tool call it
  // observes: a broken Python environment should cost a lint, not an edit.
  // `slice(indexOf(...))` became `slice(-1)` when the handler was absent, so
  // removing the hook entirely left this green — assert presence first.
  const source = readFileSync(join(srcExtDir, "seo-schema-validator.ts"), "utf-8");
  const start = source.indexOf('pi.on("tool_result"');
  assert.ok(start !== -1, "the tool_result handler is gone — the hook no longer runs");

  const handler = source.slice(start);
  assert.ok(handler.length > 100, "the tool_result handler looks truncated");
  assert.ok(
    !/return\s+\{/.test(handler),
    "the tool_result handler returns a value, which would patch the tool result"
  );
});
