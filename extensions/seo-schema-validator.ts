/**
 * SEO schema validator extension.
 *
 * Port of claude-seo's PostToolUse hook: after an edit or write of a file that
 * carries JSON-LD, run the bundled validator and append its findings to the
 * tool result, so the model reads them the way Claude Code feeds it the hook's
 * `additionalContext`. pi and omp both pass a `tool_result` content patch back
 * into the conversation.
 *
 * Deliberately non-blocking: a missing Python, a timeout or a crash never fails
 * the tool call. The handler sets no `isError` and throws nothing; at worst it
 * returns nothing and logs one diagnostic to stderr.
 */
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolResultEvent,
  ToolResultEventResult,
} from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "scripts");
const HOOK_SCRIPT = join(SCRIPTS_DIR, "validate_schema_hook.py");

/** The extensions the hook itself validates; it exits 0 on anything else. */
const CANDIDATE = /\.(?:html?|jsx|tsx|vue|svelte|php|ejs)$/i;
/** A file without either marker has no JSON-LD to validate. */
const SCHEMA_MARKER = /ld\+json|"@context"/;
/** The hook skips files above this size, so reading them to sniff is wasted. */
const MAX_BYTES = 10 * 1024 * 1024;
const TIMEOUT_MS = 10_000;

type Interpreter = { exe: string; args: string[] };
type RunResult = { code: number | null; stdout: string; stderr: string; killed: boolean; error?: Error };

/**
 * Interpreters in upstream's order (`hooks/run-python-hook.js`). `py -3` is
 * probed on Windows only, a deliberate narrowing: elsewhere `py` is not the
 * Python launcher.
 */
function candidates(): Interpreter[] {
  const list: Interpreter[] = [];
  const explicit = process.env.CLAUDE_SEO_PYTHON?.replace(/^["']|["']$/g, "");
  if (explicit) {
    list.push({ exe: explicit, args: [] });
  }
  if (process.platform === "win32") {
    list.push({ exe: "py", args: ["-3"] });
  }
  list.push({ exe: "python3", args: [] }, { exe: "python", args: [] });
  return list;
}

/**
 * The Windows App Execution Alias answers `python` with a Store prompt, not Python.
 *
 * Matched against stderr only. Upstream (`hooks/run-python-hook.js`) also tests
 * stdout, but a real Store Python reports its `sys.executable` under
 * `%LOCALAPPDATA%\Microsoft\WindowsApps\PythonSoftwareFoundation.Python.3.x_…`,
 * so that rejected every genuine Store install.
 */
const STORE_STUB = /Microsoft Store|WindowsApps|App execution alias|was not found/i;

function run(exe: string, args: string[]): Promise<RunResult> {
  return new Promise((done) => {
    const child = execFile(exe, args, { timeout: TIMEOUT_MS, encoding: "utf-8" }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === "number" ? error.code : null) : 0;
      done({ code, stdout: stdout ?? "", stderr: stderr ?? "", killed: Boolean(error?.killed), error: error ?? undefined });
    });
    // The hook reads stdin when its argv path is not a file; an open pipe would
    // hold it until the timeout.
    child.stdin?.end();
  });
}

let probed: Promise<Interpreter | null> | undefined;

/** Find a working interpreter once per session. */
function interpreter(): Promise<Interpreter | null> {
  probed ??= (async () => {
    const tried = candidates();
    for (const candidate of tried) {
      const result = await run(candidate.exe, [...candidate.args, "-c", "import sys; print(sys.executable)"]);
      if (result.code === 0 && result.stdout.trim() && !STORE_STUB.test(result.stderr)) {
        return candidate;
      }
    }
    const names = tried.map((c) => [c.exe, ...c.args].join(" ")).join(", ");
    console.error(`[seo-schema] validator unavailable: no working Python (tried ${names})`);
    return null;
  })();
  return probed;
}

/** apply_patch file headers; `Delete File` writes nothing, so it is not listed. */
const PATCH_HEADER = /^\*\*\* (Add File|Update File|Move to): (.+)$/;

/**
 * The paths an apply_patch body writes. `Move to` follows the `Update File` it
 * renames, and the content then lives at the move target, not the old path.
 */
function patchPaths(patch: string): string[] {
  const paths: string[] = [];
  for (const raw of patch.split("\n")) {
    const match = PATCH_HEADER.exec(raw.replace(/\r$/, ""));
    if (!match) {
      continue;
    }
    const [, kind, path] = match;
    const target = path.trim();
    if (!target) {
      continue;
    }
    if (kind === "Move to" && paths.length > 0) {
      paths[paths.length - 1] = target;
    } else if (kind !== "Move to") {
      paths.push(target);
    }
  }
  return paths;
}

/**
 * Every path a tool call wrote, across pi/omp tool shapes: the single path
 * keys, omp's `paths` array (a hashline edit of several files carries no
 * `path`), and the file headers of an apply_patch `input`.
 */
function writtenPaths(input: unknown): string[] {
  if (!input || typeof input !== "object") {
    return [];
  }
  const record = input as Record<string, unknown>;
  const paths: string[] = [];
  for (const key of ["path", "file_path", "filePath", "filename"]) {
    const value = record[key];
    if (typeof value === "string" && value) {
      paths.push(value);
    }
  }
  if (Array.isArray(record.paths)) {
    paths.push(...record.paths.filter((value): value is string => typeof value === "string" && value.length > 0));
  }
  for (const key of ["input", "_input"]) {
    const value = record[key];
    if (typeof value === "string" && value.includes("*** ")) {
      paths.push(...patchPaths(value));
    }
  }
  return paths;
}

/** Resolve a tool path the way the file tools do: `@` prefix, `~`, then cwd. */
function absolutePath(raw: string, cwd: string): string {
  let path = raw.startsWith("@") ? raw.slice(1) : raw;
  if (path === "~") {
    path = homedir();
  } else if (path.startsWith("~/") || path.startsWith("~\\")) {
    path = join(homedir(), path.slice(2));
  }
  return resolve(cwd, path);
}

/** True when the file exists and could hold JSON-LD, checked before spawning Python. */
function schemaBearing(file: string): boolean {
  if (!(CANDIDATE.test(file) && existsSync(file))) {
    return false;
  }
  try {
    const stat = statSync(file);
    return stat.isFile() && stat.size <= MAX_BYTES && SCHEMA_MARKER.test(readFileSync(file, "utf-8"));
  } catch {
    return false;
  }
}

/** Unwrap the hook JSON that carries warnings; anything else is already plain text. */
function report(raw: string): string {
  const text = raw.trim();
  try {
    const context = JSON.parse(text)?.hookSpecificOutput?.additionalContext;
    if (typeof context === "string") {
      return context.trim();
    }
  } catch {
    // not JSON
  }
  return text;
}

/** Run the hook on one file and return its findings, or "" when there are none. */
async function findings(file: string): Promise<string> {
  const python = await interpreter();
  if (!python) {
    return "";
  }
  const result = await run(python.exe, [...python.args, HOOK_SCRIPT, file]);
  if (result.killed) {
    return ""; // timed out: silence, not a diagnostic per edit
  }
  // Exit 2 puts critical errors on stderr; exit 0 puts warnings (or nothing) on stdout.
  if (result.code === 2) {
    return report(result.stderr);
  }
  if (result.code === 0) {
    return report(result.stdout);
  }
  const reason = result.stderr.trim().split("\n").pop() || result.error?.message || `exit ${result.code}`;
  console.error(`[seo-schema] validator crashed on ${file}: ${reason}`);
  return "";
}

export default function seoSchemaValidator(pi: ExtensionAPI) {
  if (!existsSync(HOOK_SCRIPT)) {
    return;
  }

  pi.on("tool_result", async (event: ToolResultEvent, ctx: ExtensionContext): Promise<ToolResultEventResult | undefined> => {
    if (!["edit", "write"].includes(event.toolName) || event.isError) {
      return undefined;
    }
    const cwd = ctx?.cwd || process.cwd();
    const files = [...new Set(writtenPaths(event.input).map((raw) => absolutePath(raw, cwd)))].filter(schemaBearing);
    if (files.length === 0) {
      return undefined;
    }

    // One block per file, each naming it: a multi-file edit can touch several
    // pages, and one file's crash must not drop the others' findings.
    const blocks: string[] = [];
    for (const file of files) {
      let output: string;
      try {
        output = await findings(file);
      } catch (error) {
        console.error(`[seo-schema] validator failed on ${file}: ${(error as Error).message}`);
        continue;
      }
      if (output) {
        blocks.push(`[seo-schema] ${file}: ${output}`);
      }
    }
    if (blocks.length === 0) {
      return undefined;
    }
    // pi drops structuredContent when content alone is replaced, so hand it
    // back; omp's event has none, and the key stays absent there.
    return {
      content: [...(event.content ?? []), ...blocks.map((text) => ({ type: "text" as const, text }))],
      ...(event.structuredContent !== undefined && { structuredContent: event.structuredContent }),
    };
  });
}
