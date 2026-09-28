/**
 * Behavioural tests for the /seo extension.
 *
 * The static checks in extensions.test.mjs catch invented API names; these
 * prove the extension works when a host drives it. `/seo <url>` used to call
 * `ctx.queueMessage`, which is undefined — the command registered fine and the
 * usage notice worked, while the one path users take did nothing at all.
 *
 * Node strips the TypeScript types on import (22.18+ unflagged), so the real
 * source file is loaded rather than a copy.
 */
import { strict as assert } from "node:assert";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The *built* extension, not the source.
 *
 * `extensions/` is what ships and what pi loads; it resolves SEO_PLUGIN_ROOT as
 * its own parent, which only holds for the built copy — loading
 * `src/extensions/seo-setup.ts` would look for `src/scripts`. The copy itself is
 * covered by extensions.test.mjs.
 */
const ENTRY = join(repoRoot, "extensions", "seo-setup.ts");

/**
 * Load the extension, or return undefined when this Node cannot strip types.
 *
 * Type stripping is unflagged from 22.18; older runtimes need the flag. CI pins
 * a current 22.x, so this is a guard against a developer on an older
 * interpreter, not an expected path.
 *
 * The match list is deliberately narrow: matching `Unexpected token` as well
 * would let a real syntax error in the extension skip all eight tests and exit
 * 0, reading as a green suite.
 */
const CANNOT_STRIP_TYPES = /Unknown file extension|ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX|--experimental-strip-types/i;

async function loadExtension() {
  try {
    return await import(pathToFileURL(ENTRY).href);
  } catch (error) {
    if (CANNOT_STRIP_TYPES.test(String(error))) {
      return undefined;
    }
    throw error;
  }
}

/** A stand-in for the host, recording everything the extension does. */
function fakeHost() {
  const calls = { commands: [], events: [], userMessages: [], notifies: [] };
  return {
    calls,
    pi: {
      registerCommand(name, options) {
        calls.commands.push({ name, options });
      },
      on(event, handler) {
        calls.events.push({ event, handler });
      },
      sendUserMessage(content, options) {
        calls.userMessages.push({ content, options });
      },
    },
    ctx: {
      ui: {
        notify(message, type) {
          calls.notifies.push({ message, type });
        },
      },
    },
  };
}

/** The env vars the extension sets, saved so a test can isolate its own run. */
const ENV_KEYS = ["SEO_PLUGIN_ROOT", "CLAUDE_SEO_DATA_DIR"];

/**
 * Run the extension factory with the managed env cleared first.
 *
 * The extension sets these at module scope, so once any test has loaded it the
 * values persist; clearing them makes each assertion observe *this* run rather
 * than whatever ran before, which otherwise passes or fails by file order.
 */
function loadFresh() {
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
  const host = fakeHost();
  mod.default(host.pi);
  return host;
}

const mod = await loadExtension();
const skip = mod === undefined ? "this Node cannot import TypeScript" : false;

test("the extension registers the /seo command", { skip }, () => {
  const { calls } = loadFresh();
  assert.deepEqual(
    calls.commands.map((c) => c.name),
    ["seo"]
  );
  assert.equal(typeof calls.commands[0].options.handler, "function");
});

test("/seo with no arguments prints usage and sends nothing", { skip }, async () => {
  const { calls, ctx } = loadFresh();
  await calls.commands[0].options.handler("", ctx);
  assert.equal(calls.notifies.length, 1, "expected a usage notice");
  assert.match(calls.notifies[0].message, /Usage: \/seo/);
  assert.equal(calls.userMessages.length, 0, "no turn should be started");
});

test("/seo <args> hands the arguments to the orchestrator skill", { skip }, async () => {
  const { calls, ctx } = loadFresh();
  await calls.commands[0].options.handler("audit https://example.com", ctx);
  assert.equal(calls.userMessages.length, 1, "the command must start a turn");
  assert.equal(calls.userMessages[0].content, "/skill:seo audit https://example.com");
  // Without expandPromptTemplates the literal `/skill:seo …` string is sent
  // to the model as text and the skill never runs.
  assert.equal(calls.userMessages[0].options?.expandPromptTemplates, true);
});

test("the extension exports SEO_PLUGIN_ROOT for the skills", { skip }, () => {
  loadFresh();
  assert.equal(process.env.SEO_PLUGIN_ROOT, repoRoot);
});

test("the managed runtime is pinned outside the package", { skip }, () => {
  loadFresh();
  const dir = process.env.CLAUDE_SEO_DATA_DIR;
  assert.ok(dir, "CLAUDE_SEO_DATA_DIR must be set");
  // A venv inside the installed package is discarded on every reinstall.
  assert.ok(
    !dir.startsWith(repoRoot),
    `the data dir must live outside the package, got ${dir}`
  );
});

test("the launcher is executable after load", { skip }, () => {
  loadFresh();
  const launcher = join(repoRoot, "scripts", "claude-seo");
  assert.ok(existsSync(launcher));
  assert.ok(statSync(launcher).mode & 0o111, "skills invoke the launcher directly");
});

test("the usage notice lists the commands the skills provide", { skip }, async () => {
  const { calls, ctx } = loadFresh();
  await calls.commands[0].options.handler("", ctx);
  const notice = calls.notifies[0].message;
  for (const command of ["audit", "page", "schema", "geo", "doctor", "setup"]) {
    assert.ok(notice.includes(command), `the usage notice omits '${command}'`);
  }
});

test("the schema validator never patches the tool result it observes", { skip }, () => {
  // It is a lint, not a gate: returning a value from the handler would let a
  // broken Python environment fail the edit that triggered it. The slice-based
  // check returned the last character when the handler was absent, so deleting
  // the handler entirely passed — assert presence first.
  const source = readFileSync(
    join(repoRoot, "src", "extensions", "seo-schema-validator.ts"),
    "utf-8"
  );
  const start = source.indexOf('pi.on("tool_result"');
  assert.ok(start !== -1, "the tool_result handler is gone — the hook no longer runs");

  const handler = source.slice(start);
  assert.ok(handler.length > 100, "the tool_result handler looks truncated");
  assert.ok(
    !/return\s+\{/.test(handler),
    "the handler returns a value, which would patch the tool result"
  );
});
