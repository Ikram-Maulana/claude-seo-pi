/**
 * SEO runtime extension — wires the ported claude-seo skills into pi and omp.
 *
 * The host import is type-only, so it is erased at runtime and never resolved;
 * both runtimes expose the same extension surface (pi.on / pi.registerCommand).
 *
 * Exports SEO_PLUGIN_ROOT for the rewritten skills and agents, pins the managed
 * Python venv to a stable per-user directory, and registers the `/seo` command.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { chmodSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPTS_DIR = join(PLUGIN_ROOT, "scripts");
const LAUNCHER = join(SCRIPTS_DIR, "claude-seo");

const COMMANDS =
  "audit, page, technical, content, content-brief, schema, images, sitemap, geo, " +
  "plan, programmatic, competitor-pages, local, maps, hreflang, google, backlinks, " +
  "cluster, sxo, drift, ecommerce, flow, agentic, setup, doctor";

/**
 * Where runtime.py builds the managed virtualenv.
 *
 * Without this, runtime.py's `_is_plugin()` returns false (we strip the
 * `.claude-plugin/` directory it probes) and it puts the venv *inside the
 * installed package*, which is replaced on every reinstall — silently throwing
 * away a multi-hundred-megabyte environment. Setting it explicitly takes the
 * highest-precedence branch in `_data_dir()` and mirrors upstream's own plugin
 * fallback, so the venv survives upgrades.
 */
function dataDir() {
  if (process.platform === "win32") {
    return join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "claude-seo");
  }
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "claude-seo");
  }
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "claude-seo");
}

/**
 * Surface a message without assuming a logger.
 *
 * There is no `pi.logger` in the extension API — only `ctx.ui.notify`, which
 * needs a context. Notices that fire before any context exists (module load)
 * go to stderr instead.
 */
function notify(ctx: ExtensionContext | undefined, message: string, level: "info" | "warning" = "info") {
  if (ctx?.ui?.notify) {
    ctx.ui.notify(message, level);
  } else {
    console.error(message);
  }
}

export default function seoSetup(pi: ExtensionAPI) {
  // Environment
  // Set at module scope, not only in session_start: some invocations load
  // extensions without starting a session, and a skill running before the first
  // session_start would expand $SEO_PLUGIN_ROOT to nothing.
  if (existsSync(SCRIPTS_DIR)) {
    process.env.SEO_PLUGIN_ROOT = PLUGIN_ROOT;
    process.env.CLAUDE_SEO_DATA_DIR = dataDir();

    // npm preserves the launcher's mode bit, but a restrictive umask or a
    // filesystem without modes would break it, and the failure is opaque from
    // inside a skill.
    if (existsSync(LAUNCHER)) {
      try {
        chmodSync(LAUNCHER, 0o755);
      } catch {
        // Read-only install (for example a globally linked package).
      }
    }
  }

  // `/seo` command
  pi.registerCommand("seo", {
    description: "SEO analysis — delegates to the seo skill. Usage: /seo [command] [url]",
    handler: async (args: string, ctx) => {
      if (!args) {
        ctx.ui.notify(
          `Usage: /seo [command] [url]\nCommands: ${COMMANDS}\n\n` +
            "Example: /seo audit https://example.com\n" +
            "First run: /seo setup provisions the Python environment.",
          "info"
        );
        return;
      }
      // Hand the arguments to the orchestrator skill as a user turn.
      // `expandPromptTemplates` turns the `/skill:seo …` text into the skill
      // invocation; without it the literal string would be sent.
      pi.sendUserMessage(`/skill:seo ${args}`, { expandPromptTemplates: true });
    },
  });

  // Session notice
  pi.on("session_start", async (_event, ctx) => {
    if (!existsSync(SCRIPTS_DIR)) {
      notify(
        ctx,
        "[claude-seo-pi] scripts/ is missing — reinstall the package or run the sync script.",
        "warning"
      );
      return;
    }
    if (!existsSync(join(dataDir(), "runtime-state.json"))) {
      notify(ctx, "[claude-seo-pi] Python runtime not provisioned yet. Run `/seo setup` once to create it.");
    }
  });
}
