/**
 * SEO schema validator extension.
 *
 * Port of claude-seo's PostToolUse hook: after a file that could carry JSON-LD
 * is written or edited, run the bundled validator and surface any findings.
 *
 * Deliberately non-blocking: a missing Python environment, a timeout or a crash
 * all resolve to silence rather than a failed tool call.
 */
import type { ExtensionAPI, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "scripts");
const HOOK_SCRIPT = join(SCRIPTS_DIR, "validate_schema_hook.py");

/** File types that can plausibly contain schema markup. */
const CANDIDATE = /\.(?:html?|json|jsonld|php|jsx|tsx|svelte|vue|njk|ejs|hbs)$/i;
const TIMEOUT_MS = 10_000;

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

export default function seoSchemaValidator(pi: ExtensionAPI) {
  if (!existsSync(HOOK_SCRIPT)) {
    return;
  }

  pi.on("tool_result", async (event: ToolResultEvent) => {
    if (!["edit", "write"].includes(event.toolName)) {
      return;
    }
    const filePath = writtenPath(event.input);
    if (!(filePath && CANDIDATE.test(filePath))) {
      return;
    }

    execFile(
      "python3",
      [HOOK_SCRIPT, filePath],
      { timeout: TIMEOUT_MS, encoding: "utf-8" },
      (error, stdout) => {
        // Exit code 2 means "findings" upstream, which node reports as an
        // error — the report is still on stdout, so read it either way.
        const output = (stdout ?? "").trim();
        if (output) {
          // No ctx to notify through in a background lint. stderr keeps it out
          // of the model's context while staying visible in the session log.
          console.error(`[seo-schema] ${output}`);
        } else if (error && !("killed" in error)) {
          console.error(`[seo-schema] validator unavailable: ${error.message}`);
        }
      }
    );
  });
}
