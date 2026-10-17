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

import { importsHostAtRuntime } from "../tools/verify.mjs";

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
  // pi and @oh-my-pi/* on omp, so it is erased deliberately. Same rule verify
  // applies to the built copies.
  const offenders = extensions.filter((file) => importsHostAtRuntime(readFileSync(join(srcExtDir, file), "utf-8")));
  assert.deepEqual(offenders, [], "use `import type` for the host package");
});

test("the host-import check sees every form a runtime import takes", () => {
  const runtime = {
    "single line": 'import { x } from "@earendil-works/pi-coding-agent";',
    "multi-line": 'import {\n  ExtensionAPI,\n  ToolResultEvent,\n} from "@earendil-works/pi-coding-agent";',
    "inline type specifier (Node keeps the empty import)": 'import { type ExtensionAPI } from "@oh-my-pi/pi-coding-agent";',
    "default import whose name starts with type": 'import  type_helpers from "@oh-my-pi/pi-coding-agent";',
    "side effect": 'import "@earendil-works/pi-coding-agent";',
    "dynamic": 'const host = await import("@earendil-works/pi-coding-agent");',
    "dynamic template": "const host = await import(`@oh-my-pi/pi-coding-agent`);",
    "require": 'const host = require("@earendil-works/pi-coding-agent");',
    "re-export": 'export { ExtensionAPI } from "@earendil-works/pi-coding-agent";',
    "star re-export": 'export * from "@oh-my-pi/pi-coding-agent";',
  };
  for (const [label, source] of Object.entries(runtime)) {
    assert.ok(importsHostAtRuntime(source), `${label} import was not detected`);
  }

  const erased = {
    "import type": 'import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";',
    "multi-line import type": 'import type {\n  ExtensionAPI,\n  ToolResultEvent,\n} from "@oh-my-pi/pi-coding-agent";',
    "export type": 'export type { ExtensionAPI } from "@earendil-works/pi-coding-agent";',
    "node builtin": 'import { execFile } from "node:child_process";',
    "in a comment": '// import { x } from "@earendil-works/pi-coding-agent";\n/* await import("@oh-my-pi/x") */',
  };
  for (const [label, source] of Object.entries(erased)) {
    assert.ok(!importsHostAtRuntime(source), `${label} was flagged, but it is erased or not the host`);
  }
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

test("the schema validator can never fail the tool call it observes", () => {
  // The handler appends findings to the result, but it is a lint, not a gate:
  // a broken Python environment must cost a lint, not an edit. So it never
  // sets isError and never throws. `slice(indexOf(...))` became `slice(-1)`
  // when the handler was absent, so removing the hook entirely once left a
  // check like this green — assert presence first.
  const source = stripComments(readFileSync(join(srcExtDir, "seo-schema-validator.ts"), "utf-8"));
  const start = source.indexOf('pi.on("tool_result"');
  assert.ok(start !== -1, "the tool_result handler is gone — the hook no longer runs");
  assert.ok(source.slice(start).length > 100, "the tool_result handler looks truncated");

  assert.doesNotMatch(source, /\bisError\s*:/, "the validator sets isError, which would fail the edit");
  assert.doesNotMatch(source, /\bthrow\b/, "the validator throws, which the host reports as a failed call");
  assert.match(source, /return\s*\{\s*content:/, "the handler no longer hands its findings to the model");
});
