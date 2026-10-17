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
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
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
 * would let a real syntax error in the extension skip every test here and exit
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
function fakeHost({ idle = true, cwd = process.cwd() } = {}) {
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
      cwd,
      // Both hosts expose isIdle(); the command uses it to decide between
      // starting a turn and queueing a follow-up.
      isIdle: () => idle,
      ui: {
        notify(message, type) {
          calls.notifies.push({ message, type });
        },
      },
    },
  };
}

/** The env vars the extension manages; `loadFresh` clears them, and `env` seeds a user's own. */
const ENV_KEYS = ["SEO_PLUGIN_ROOT", "CLAUDE_SEO_DATA_DIR"];

/**
 * Run the extension factory with the managed env cleared first.
 *
 * The extension sets these at module scope, so once any test has loaded it the
 * values persist; clearing them makes each assertion observe *this* run rather
 * than whatever ran before, which otherwise passes or fails by file order.
 */
function loadFresh(env = {}, hostOptions = {}) {
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
  Object.assign(process.env, env);
  const host = fakeHost(hostOptions);
  mod.default(host.pi);
  return host;
}

/** Run `fn` with env vars set, restoring their previous values afterwards. */
async function withEnv(env, fn) {
  const saved = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

/**
 * pi's own reader for a `/skill:` expansion (`parseSkillBlock` in
 * agent-session.js). pi renders a user message matching it as a skill
 * invocation, so the block the command builds must match it exactly.
 */
const SKILL_BLOCK = /^<skill name="([^"]+)" location="([^"]+)">\n([\s\S]*?)\n<\/skill>(?:\n\n([\s\S]+))?$/;
const SEO_SKILL = join(repoRoot, "skills", "seo", "SKILL.md");

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
  const { content, options } = calls.userMessages[0];

  // omp forces expandPromptTemplates off for an extension's message, so a
  // literal `/skill:seo …` reached the model as text there and the skill never
  // ran. The command sends the expanded block itself, on both hosts.
  assert.doesNotMatch(content, /^\/skill:/, "a /skill: string is not expanded on omp");
  assert.equal(options?.expandPromptTemplates, undefined, "nothing is left for the host to expand");

  const block = SKILL_BLOCK.exec(content);
  assert.ok(block, "the message does not match pi's skill-block format");
  assert.equal(block[1], "seo");
  assert.equal(block[2], SEO_SKILL);
  assert.ok(
    block[3].startsWith(`References are relative to ${dirname(SEO_SKILL)}.\n\n`),
    "the block must say where the skill's relative references resolve"
  );
  assert.doesNotMatch(block[3], /^name: seo$/m, "the skill frontmatter leaked into the block");
  const body = readFileSync(SEO_SKILL, "utf-8").replace(/^---\n[\s\S]*?\n---\n/, "").trim();
  assert.ok(block[3].endsWith(body), "the block does not carry the skill body");
  assert.equal(block[4], "audit https://example.com");
});

test("/seo starts a turn when idle and queues a follow-up while streaming", { skip }, async () => {
  const idle = loadFresh({}, { idle: true });
  await idle.calls.commands[0].options.handler("page https://example.com", idle.ctx);
  assert.equal(idle.calls.userMessages[0].options?.deliverAs, undefined, "an idle session takes a plain turn");

  // pi throws on a plain send while streaming; omp turns it into a steer.
  const busy = loadFresh({}, { idle: false });
  await busy.calls.commands[0].options.handler("page https://example.com", busy.ctx);
  assert.equal(busy.calls.userMessages.length, 1);
  assert.equal(busy.calls.userMessages[0].options?.deliverAs, "followUp");
});

test("/seo reports a missing skill file instead of sending an empty turn", { skip }, async () => {
  // A copy of the built extension with no skills/ beside it.
  const root = mkdtempSync(join(tmpdir(), "seo-noskill-"));
  try {
    mkdirSync(join(root, "extensions"));
    copyFileSync(ENTRY, join(root, "extensions", "seo-setup.ts"));
    const isolated = await import(pathToFileURL(join(root, "extensions", "seo-setup.ts")).href);
    const host = fakeHost();
    isolated.default(host.pi);
    await host.calls.commands[0].options.handler("audit https://example.com", host.ctx);
    assert.equal(host.calls.userMessages.length, 0, "no turn may start without the skill");
    assert.equal(host.calls.notifies.length, 1);
    assert.equal(host.calls.notifies[0].type, "error");
    assert.match(host.calls.notifies[0].message, /SKILL\.md/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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

test("a data dir the user already set is kept, not overwritten", { skip }, () => {
  const shared = join(tmpdir(), "shared-seo-runtime");
  loadFresh({ CLAUDE_SEO_DATA_DIR: shared, SEO_PLUGIN_ROOT: "/custom/root" });
  assert.equal(process.env.CLAUDE_SEO_DATA_DIR, shared);
  assert.equal(process.env.SEO_PLUGIN_ROOT, "/custom/root");
});

test(
  "an empty XDG_DATA_HOME counts as unset instead of becoming a relative data dir",
  { skip: skip || (process.platform === "linux" ? false : "XDG applies to Linux only") },
  () => {
    const saved = process.env.XDG_DATA_HOME;
    try {
      loadFresh({ XDG_DATA_HOME: "" });
      const dir = process.env.CLAUDE_SEO_DATA_DIR;
      assert.ok(isAbsolute(dir), `the data dir must be absolute, got '${dir}'`);
      assert.equal(dir, join(homedir(), ".local", "share", "claude-seo"));
    } finally {
      if (saved === undefined) {
        delete process.env.XDG_DATA_HOME;
      } else {
        process.env.XDG_DATA_HOME = saved;
      }
    }
  }
);

test(
  "a relative XDG_DATA_HOME is ignored instead of putting the venv inside the open project",
  { skip: skip || (process.platform === "linux" ? false : "XDG applies to Linux only") },
  async () => {
    await withEnv({ XDG_DATA_HOME: "relative/data" }, () => {
      loadFresh();
      assert.equal(process.env.CLAUDE_SEO_DATA_DIR, join(homedir(), ".local", "share", "claude-seo"));
    });
  }
);

test("a ~ in a user-set data dir is expanded and the path made absolute", { skip }, () => {
  // A quoted `~/…` in a settings env block reaches the process unexpanded.
  loadFresh({ CLAUDE_SEO_DATA_DIR: "~/seo-runtime" });
  assert.equal(process.env.CLAUDE_SEO_DATA_DIR, join(homedir(), "seo-runtime"));

  loadFresh({ CLAUDE_SEO_DATA_DIR: "relative/seo-runtime" });
  assert.equal(process.env.CLAUDE_SEO_DATA_DIR, resolve("relative/seo-runtime"));
});

test("session_start tells the user when the runtime is not provisioned", { skip }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "seo-data-"));
  try {
    const first = loadFresh({ CLAUDE_SEO_DATA_DIR: dir });
    const start = first.calls.events.find((e) => e.event === "session_start").handler;
    await start({}, first.ctx);
    assert.equal(first.calls.notifies.length, 1, "expected the not-provisioned notice");
    assert.match(first.calls.notifies[0].message, /\/seo setup/);

    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "runtime-state.json"), "{}");
    const second = loadFresh({ CLAUDE_SEO_DATA_DIR: dir });
    const again = second.calls.events.find((e) => e.event === "session_start").handler;
    await again({}, second.ctx);
    assert.equal(second.calls.notifies.length, 0, "a provisioned runtime needs no notice");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the launcher is executable after load", { skip }, () => {
  loadFresh();
  const launcher = join(repoRoot, "scripts", "claude-seo");
  assert.ok(existsSync(launcher));
  assert.ok(statSync(launcher).mode & 0o111, "skills invoke the launcher directly");
});

test(
  "loading the extension restores a launcher that lost its mode bit",
  { skip: skip || (process.platform === "win32" ? "no POSIX mode bits" : false) },
  () => {
    // A restrictive umask or a mode-less filesystem drops the bit; the
    // extension's chmod is what puts it back, so take it away first.
    const launcher = join(repoRoot, "scripts", "claude-seo");
    const original = statSync(launcher).mode & 0o777;
    try {
      chmodSync(launcher, 0o644);
      loadFresh();
      assert.ok(statSync(launcher).mode & 0o100, "the extension did not make the launcher executable again");
    } finally {
      chmodSync(launcher, original);
    }
  }
);

test("the usage notice lists every command the skills provide", { skip }, async () => {
  const { calls, ctx } = loadFresh();
  await calls.commands[0].options.handler("", ctx);
  const listed = new Set(
    /Commands: ([^\n]+)/.exec(calls.notifies[0].message)[1].split(",").map((c) => c.trim())
  );
  // Every skills/seo-<name> is reachable as `/seo <name>`; nine integrations
  // were once missing from the list.
  const commands = readdirSync(join(repoRoot, "skills"))
    .filter((name) => name.startsWith("seo-"))
    .map((name) => name.slice("seo-".length));
  assert.ok(commands.length > 20, "skills/ looks empty");
  const missing = [...commands, "setup", "doctor"].filter((command) => !listed.has(command));
  assert.deepEqual(missing, [], "the usage notice omits these commands");
});

const PYTHON_MISSING = spawnSync("python3", ["--version"]).error ? "python3 is not installed" : false;
const NO_POSIX_STUB = process.platform === "win32" ? "needs a POSIX shell stand-in" : false;
const VALIDATOR = pathToFileURL(join(repoRoot, "extensions", "seo-schema-validator.ts")).href;

let instance = 0;

/**
 * A fresh copy of the built validator and its `tool_result` handler.
 *
 * The module caches the interpreter it probed, so each import gets its own
 * module instance (a distinct URL) and therefore probes under the env the test
 * sets.
 */
async function freshValidator() {
  const { default: validator } = await import(`${VALIDATOR}?instance=${++instance}`);
  const host = fakeHost();
  validator(host.pi);
  return host.calls.events.find((e) => e.event === "tool_result").handler;
}

/** Call a handler while collecting what it logs to stderr. */
async function capture(fn) {
  const lines = [];
  const original = console.error;
  console.error = (line) => lines.push(String(line));
  try {
    return { result: await fn(), lines };
  } finally {
    console.error = original;
  }
}

/** A tool_result event as both hosts shape it for a successful write. */
function writeEvent(input, extra = {}) {
  return { toolName: "write", input, content: [{ type: "text", text: "Wrote file" }], isError: false, ...extra };
}

/** Run the built validator on a page and return what it handed back plus its log. */
async function validatorReport(html, { toolName = "write", key = "path", extra = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "seo-schema-"));
  const page = join(dir, "page.html");
  writeFileSync(page, html);
  try {
    const handler = await freshValidator();
    return await capture(() =>
      handler({ ...writeEvent({ [key]: page }, extra), toolName }, { cwd: dir, isIdle: () => true })
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * A stand-in interpreter that records every call. It answers the `-c` probe
 * like Python and exits with `status` (printing `stderr`) when run on the hook.
 */
function stubPython(dir, { status = 0, stdout = "", stderr = "", probe = 0, probeOut = "/stub/python", sleep = 0 } = {}) {
  const log = join(dir, "calls.log");
  const stub = join(dir, "python");
  writeFileSync(
    stub,
    [
      "#!/bin/sh",
      `echo "$@" >> '${log}'`,
      `if [ "$1" = "-c" ]; then [ ${probe} -eq 0 ] && printf '%s\\n' '${probeOut}'; exit ${probe}; fi`,
      // `exec`, so the timeout's kill reaches the sleeper itself: an orphaned
      // child would hold the pipes open and delay the callback past the kill.
      sleep ? `exec sleep ${sleep}` : "",
      `printf '%s' '${stdout}'`,
      `printf '%s' '${stderr}' >&2`,
      `exit ${status}`,
      "",
    ].join("\n")
  );
  chmodSync(stub, 0o755);
  return { stub, calls: () => (existsSync(log) ? readFileSync(log, "utf-8").trim().split("\n") : []) };
}

const JSON_LD = (body) => `<script type="application/ld+json">${body}</script>`;
const PLACEHOLDER_PAGE = JSON_LD('{"@context":"https://schema.org","@type":"Organization","name":"[Business Name]"}');

test(
  "the schema validator appends critical errors to the tool result the model reads",
  { skip: skip || PYTHON_MISSING },
  async () => {
    const { result, lines } = await validatorReport(PLACEHOLDER_PAGE);
    assert.ok(result, "a critical finding must reach the model, not only the log");
    assert.equal(result.content.length, 2, "the tool's own output must be kept, with one block appended");
    assert.deepEqual(result.content[0], { type: "text", text: "Wrote file" });
    assert.equal(result.content[1].type, "text");
    assert.match(result.content[1].text, /^\[seo-schema\] .*placeholder text: \[Business Name\]/s);
    assert.equal(result.isError, undefined, "a lint must never mark the write failed");
    assert.equal("structuredContent" in result, false, "omp's event has no structuredContent; none is invented");
    assert.deepEqual(lines, []);
  }
);

test(
  "the schema validator unwraps warnings from the hook JSON",
  { skip: skip || PYTHON_MISSING },
  async () => {
    const { result } = await validatorReport(JSON_LD('{"@type":"Organization","name":"Acme"}'));
    const text = result.content.at(-1).text;
    assert.match(text, /Missing @context/);
    assert.doesNotMatch(text, /hookSpecificOutput/, "the JSON envelope leaked into the result");
  }
);

test(
  "the schema validator keeps pi's structuredContent when it patches content",
  { skip: skip || PYTHON_MISSING },
  async () => {
    // pi drops structuredContent when a handler replaces content without it.
    const structured = { bytes: 42 };
    const { result } = await validatorReport(PLACEHOLDER_PAGE, { extra: { structuredContent: structured } });
    assert.deepEqual(result.structuredContent, structured);
  }
);

test(
  "the schema validator returns nothing for clean markup",
  { skip: skip || PYTHON_MISSING },
  async () => {
    const { result, lines } = await validatorReport(
      JSON_LD('{"@context":"https://schema.org","@type":"Article","headline":"ok","datePublished":"2026-01-01"}')
    );
    assert.equal(result, undefined);
    assert.deepEqual(lines, []);
  }
);

test(
  "the schema validator runs after an edit and reads every path key the hosts use",
  { skip: skip || PYTHON_MISSING },
  async () => {
    for (const key of ["path", "file_path", "filePath", "filename"]) {
      const { result } = await validatorReport(PLACEHOLDER_PAGE, { toolName: "edit", key });
      assert.match(result?.content.at(-1).text ?? "", /placeholder text/, `the '${key}' input key was not read`);
    }
  }
);

test(
  "the schema validator resolves relative, ~ and @ paths before validating",
  { skip: skip || PYTHON_MISSING },
  async () => {
    // os.homedir() follows $HOME, so `~` points into the fixture; the session
    // cwd is a sibling, so a relative path only resolves against ctx.cwd.
    const root = mkdtempSync(join(tmpdir(), "seo-schema-paths-"));
    try {
      mkdirSync(join(root, "home", "site"), { recursive: true });
      mkdirSync(join(root, "project"));
      writeFileSync(join(root, "home", "site", "page.html"), PLACEHOLDER_PAGE);
      await withEnv({ HOME: join(root, "home"), USERPROFILE: join(root, "home") }, async () => {
        for (const path of ["../home/site/page.html", "@../home/site/page.html", "~/site/page.html", "@~/site/page.html"]) {
          const handler = await freshValidator();
          const { result } = await capture(() => handler(writeEvent({ path }), { cwd: join(root, "project") }));
          assert.match(result?.content.at(-1).text ?? "", /placeholder text/, `'${path}' was not resolved`);
        }
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
);

/**
 * Write the given files into a fresh dir, run one edit event through a
 * validator backed by a stub Python, and return what the hook was run on.
 *
 * The stub crashes (exit 1) on a file whose name contains "crash", reports a
 * critical finding naming the file otherwise, so each block can be traced to
 * the file it belongs to.
 */
async function multiFileRun(files, input) {
  const dir = mkdtempSync(join(tmpdir(), "seo-schema-multi-"));
  try {
    for (const [name, body] of Object.entries(files)) {
      writeFileSync(join(dir, name), body);
    }
    const log = join(dir, "calls.log");
    const stub = join(dir, "python");
    writeFileSync(
      stub,
      [
        "#!/bin/sh",
        `if [ "$1" = "-c" ]; then echo /stub/python; exit 0; fi`,
        `echo "$2" >> '${log}'`,
        `case "$2" in *crash*) echo "Traceback: boom" >&2; exit 1;; esac`,
        `echo "critical in $(basename "$2")" >&2`,
        "exit 2",
        "",
      ].join("\n")
    );
    chmodSync(stub, 0o755);
    return await withEnv({ CLAUDE_SEO_PYTHON: stub }, async () => {
      const handler = await freshValidator();
      const { result, lines } = await capture(() =>
        handler({ ...writeEvent(input), toolName: "edit" }, { cwd: dir })
      );
      const validated = existsSync(log)
        ? readFileSync(log, "utf-8").trim().split("\n").map((line) => line.slice(dir.length + 1))
        : [];
      return { result, lines, validated, blocks: (result?.content ?? []).slice(1).map((c) => c.text) };
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("an omp hashline edit of one file is validated once", { skip: skip || NO_POSIX_STUB }, async () => {
  // omp sets `path` and `paths` together when a hashline edit names one file.
  const { validated, blocks } = await multiFileRun(
    { "a.html": PLACEHOLDER_PAGE },
    { input: "[a.html#1a2b]\n…", path: "a.html", paths: ["a.html"] }
  );
  assert.deepEqual(validated, ["a.html"], "the same file was validated more than once");
  assert.equal(blocks.length, 1);
});

test("an omp hashline edit of several files validates each schema-bearing one", { skip: skip || NO_POSIX_STUB }, async () => {
  // With more than one file omp sends `paths` alone, and no `path` key.
  const { validated } = await multiFileRun(
    { "a.html": PLACEHOLDER_PAGE, "b.css": "body { color: red }" },
    { input: "[a.html#1a2b]\n…\n[b.css#3c4d]\n…", paths: ["a.html", "b.css"] }
  );
  assert.deepEqual(validated, ["a.html"], "the paths array was not read, or a stylesheet was validated");
});

test("an apply_patch edit validates added files and move targets, not moved-away or deleted ones", { skip: skip || NO_POSIX_STUB }, async () => {
  const patch = [
    "*** Begin Patch",
    "*** Update File: x.html",
    "*** Move to: y.html",
    "@@",
    "-old",
    "+new",
    "*** Add File: z.html",
    "+<p>new</p>",
    "*** Add File: gone.html",
    "+<p>never written</p>",
    "*** Delete File: d.html",
    "*** End Patch",
    "",
  ].join("\n");
  const { validated, blocks } = await multiFileRun(
    // x.html and d.html still exist and carry JSON-LD, so skipping them is the
    // header logic, not the sniff; gone.html is missing and skipped.
    { "x.html": PLACEHOLDER_PAGE, "y.html": PLACEHOLDER_PAGE, "z.html": PLACEHOLDER_PAGE, "d.html": PLACEHOLDER_PAGE },
    { input: patch }
  );
  assert.deepEqual(validated, ["y.html", "z.html"]);
  assert.equal(blocks.length, 2);
});

test("findings from several files arrive one block per file, and a crash drops only its own", { skip: skip || NO_POSIX_STUB }, async () => {
  const { result, blocks, lines } = await multiFileRun(
    { "a.html": PLACEHOLDER_PAGE, "crash.html": PLACEHOLDER_PAGE, "b.html": PLACEHOLDER_PAGE },
    { paths: ["a.html", "crash.html", "b.html"] }
  );
  assert.deepEqual(result.content[0], { type: "text", text: "Wrote file" }, "the tool's own output must be kept");
  assert.equal(blocks.length, 2, "expected one block per file with findings");
  assert.match(blocks[0], /^\[seo-schema\] \S*a\.html: critical in a\.html/);
  assert.match(blocks[1], /^\[seo-schema\] \S*b\.html: critical in b\.html/);
  assert.equal(lines.length, 1, "the crash must log one diagnostic");
  assert.match(lines[0], /crashed on \S*crash\.html/);
});

test("the schema validator skips a failed write and a path that does not exist", { skip: skip || NO_POSIX_STUB }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "seo-schema-skip-"));
  try {
    const page = join(dir, "page.html");
    writeFileSync(page, PLACEHOLDER_PAGE);
    const { stub, calls } = stubPython(dir, { status: 2, stderr: "placeholder" });
    await withEnv({ CLAUDE_SEO_PYTHON: stub }, async () => {
      const handler = await freshValidator();
      const failed = await capture(() => handler(writeEvent({ path: page }, { isError: true }), { cwd: dir }));
      assert.equal(failed.result, undefined, "a failed write has nothing to validate");

      // The hook reads stdin when its argument is not a file; this must return
      // at once, not after the 10 s timeout.
      const started = Date.now();
      const missing = await capture(() => handler(writeEvent({ path: join(dir, "gone.html") }), { cwd: dir }));
      assert.equal(missing.result, undefined);
      assert.ok(Date.now() - started < 2000, "a missing file must not wait for the validator");
    });
    assert.deepEqual(calls(), [], "no Python may be spawned for either");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the schema validator spawns no Python for a file without JSON-LD", { skip: skip || NO_POSIX_STUB }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "seo-schema-sniff-"));
  try {
    writeFileSync(join(dir, "package.json"), '{"name":"x","@context":"https://schema.org"}');
    writeFileSync(join(dir, "App.tsx"), "export const App = () => <main>hello</main>;\n");
    const { stub, calls } = stubPython(dir);
    await withEnv({ CLAUDE_SEO_PYTHON: stub }, async () => {
      const handler = await freshValidator();
      for (const path of ["package.json", "App.tsx"]) {
        const { result } = await capture(() => handler(writeEvent({ path }), { cwd: dir }));
        assert.equal(result, undefined, `${path} has no schema to validate`);
      }
    });
    assert.deepEqual(calls(), [], "Python was spawned for a file that cannot carry JSON-LD");

    // The same stub does run once the sniff finds markup: the guard above is
    // the sniff, not a broken stub.
    writeFileSync(join(dir, "App.tsx"), `const ld = { "@context": "https://schema.org" };\n`);
    await withEnv({ CLAUDE_SEO_PYTHON: stub }, async () => {
      const handler = await freshValidator();
      await capture(() => handler(writeEvent({ path: "App.tsx" }), { cwd: dir }));
    });
    assert.ok(calls().some((line) => line.includes("validate_schema_hook.py")), "the hook never ran");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the schema validator ignores tools other than edit and write", { skip: skip || NO_POSIX_STUB }, async () => {
  // The handler runs after every tool call; a read of a page that carries
  // JSON-LD must not spawn Python or append findings to the read result.
  const dir = mkdtempSync(join(tmpdir(), "seo-schema-tools-"));
  try {
    const page = join(dir, "page.html");
    writeFileSync(page, PLACEHOLDER_PAGE);
    const { stub, calls } = stubPython(dir, { status: 2, stderr: "placeholder" });
    await withEnv({ CLAUDE_SEO_PYTHON: stub }, async () => {
      const handler = await freshValidator();
      for (const toolName of ["read", "bash", "grep"]) {
        const { result } = await capture(() => handler({ ...writeEvent({ path: page }), toolName }, { cwd: dir }));
        assert.equal(result, undefined, `${toolName} must not be validated`);
      }
    });
    assert.deepEqual(calls(), [], "Python was spawned for a tool that writes nothing");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a Store Python whose sys.executable is under WindowsApps is accepted", { skip: skip || NO_POSIX_STUB }, async () => {
  // A genuine Microsoft Store install reports its executable under
  // %LOCALAPPDATA%\Microsoft\WindowsApps\; only the alias stub's stderr marks a fake.
  const dir = mkdtempSync(join(tmpdir(), "seo-schema-store-"));
  try {
    const page = join(dir, "page.html");
    writeFileSync(page, PLACEHOLDER_PAGE);
    const { stub, calls } = stubPython(dir, {
      status: 2,
      stderr: "placeholder text: [Business Name]",
      probeOut: "C:\\Users\\u\\AppData\\Local\\Microsoft\\WindowsApps\\PythonSoftwareFoundation.Python.3.12_qbz5n2kfra8p0\\python.exe",
    });
    await withEnv({ CLAUDE_SEO_PYTHON: stub }, async () => {
      const handler = await freshValidator();
      const { result } = await capture(() => handler(writeEvent({ path: page }), { cwd: dir }));
      assert.match(result?.content.at(-1).text ?? "", /placeholder text/, "the Store Python was rejected as a stub");
    });
    assert.ok(calls().some((line) => line.includes("validate_schema_hook.py")), "the hook never ran");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a crashing validator leaves the tool result alone and logs one diagnostic", { skip: skip || NO_POSIX_STUB }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "seo-schema-crash-"));
  try {
    const page = join(dir, "page.html");
    writeFileSync(page, PLACEHOLDER_PAGE);
    const { stub } = stubPython(dir, { status: 1, stderr: "Traceback: boom" });
    await withEnv({ CLAUDE_SEO_PYTHON: stub }, async () => {
      const handler = await freshValidator();
      const { result, lines } = await capture(() => handler(writeEvent({ path: page }), { cwd: dir }));
      assert.equal(result, undefined, "a crash must not patch, let alone fail, the write");
      assert.equal(lines.length, 1);
      assert.match(lines[0], /^\[seo-schema\] validator crashed .*boom/);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test(
  "a validator that times out is killed and stays silent",
  { skip: skip || NO_POSIX_STUB, timeout: 30_000 },
  async () => {
    // The probe answers at once; the hook call outlives the 10 s timeout.
    const dir = mkdtempSync(join(tmpdir(), "seo-schema-timeout-"));
    try {
      const page = join(dir, "page.html");
      writeFileSync(page, PLACEHOLDER_PAGE);
      const { stub, calls } = stubPython(dir, { sleep: 20 });
      await withEnv({ CLAUDE_SEO_PYTHON: stub }, async () => {
        const handler = await freshValidator();
        const started = Date.now();
        const { result, lines } = await capture(() => handler(writeEvent({ path: page }), { cwd: dir }));
        assert.equal(result, undefined, "a timeout must not patch, let alone fail, the write");
        assert.deepEqual(lines.filter((line) => line.startsWith("[seo-schema]")), [], "a timeout must stay silent");
        assert.ok(Date.now() - started < 18_000, "the validator was not killed at its timeout");
      });
      assert.ok(calls().some((line) => line.includes("validate_schema_hook.py")), "the hook was never started");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
);

test("with no usable Python the validator stays out of the way", { skip: skip || NO_POSIX_STUB }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "seo-schema-nopy-"));
  try {
    const page = join(dir, "page.html");
    writeFileSync(page, PLACEHOLDER_PAGE);
    const { stub } = stubPython(dir, { probe: 1 });
    const emptyPath = join(dir, "bin");
    mkdirSync(emptyPath);
    await withEnv({ CLAUDE_SEO_PYTHON: stub, PATH: emptyPath }, async () => {
      const handler = await freshValidator();
      const first = await capture(() => handler(writeEvent({ path: page }), { cwd: dir }));
      assert.equal(first.result, undefined);
      assert.equal(first.lines.length, 1, "one diagnostic, so a missing Python is discoverable");
      assert.match(first.lines[0], /no working Python/);

      // The probe is cached: the next write neither probes again nor logs again.
      const second = await capture(() => handler(writeEvent({ path: page }), { cwd: dir }));
      assert.equal(second.result, undefined);
      assert.deepEqual(second.lines, []);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
