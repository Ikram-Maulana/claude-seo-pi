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

/** The Windows App Execution Alias answers `python` with a Store prompt, not Python. */
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
      if (result.code === 0 && result.stdout.trim() && !STORE_STUB.test(`${result.stdout}\n${result.stderr}`)) {
        return candidate;
      }
    }
    const names = tried.map((c) => [c.exe, ...c.args].join(" ")).join(", ");
    console.error(`[seo-schema] validator unavailable: no working Python (tried ${names})`);
    return null;
  })();
  return probed;
}

/** Pull the written path out of the tool arguments across pi/omp tool shapes. */
function writtenPath(input: unknown): string | undefined {
  if (!input || typeof input !== "object") {
    return undefined;
  }
  const record = input as Record<string, unknown>;
  for (const key of ["path", "file_path", "filePath", "filename"]) {
    const value = record[key];
    if (typeof value === "string" && value) {
      return value;
    }
  }
  return undefined;
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
    const raw = writtenPath(event.input);
    if (!raw) {
      return undefined;
    }
    const file = absolutePath(raw, ctx?.cwd || process.cwd());
    if (!schemaBearing(file)) {
      return undefined;
    }

    let output: string;
    try {
      output = await findings(file);
    } catch (error) {
      console.error(`[seo-schema] validator failed: ${(error as Error).message}`);
      return undefined;
    }
    if (!output) {
      return undefined;
    }
    // pi drops structuredContent when content alone is replaced, so hand it
    // back; omp's event has none, and the key stays absent there.
    return {
      content: [...(event.content ?? []), { type: "text", text: `[seo-schema] ${output}` }],
      ...(event.structuredContent !== undefined && { structuredContent: event.structuredContent }),
    };
  });
}
