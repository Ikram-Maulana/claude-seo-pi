/**
 * SEO runtime extension: wires the ported claude-seo skills into pi and omp.
 *
 * The host import is type-only, so it is erased at runtime and never resolved;
 * both runtimes expose the same extension surface (pi.on / pi.registerCommand).
 *
 * Exports SEO_PLUGIN_ROOT for the rewritten skills and agents, pins the managed
 * Python venv to a stable per-user directory, and registers the `/seo` command.
 *
 * `/seo` builds the skill block itself instead of sending `/skill:seo …`: omp's
 * `sendUserMessage` forces `expandPromptTemplates: false`, so the literal text
 * reached the model and the skill never ran there. The block uses pi's own
 * `/skill:` expansion format, so both hosts receive the same turn. The cost:
 * omp shows no skill chip for it, and on pi a user's override of the `seo`
 * skill is bypassed in favour of the copy this package ships.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { chmodSync, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPTS_DIR = join(PLUGIN_ROOT, "scripts");
const LAUNCHER = join(SCRIPTS_DIR, "claude-seo");

const SKILL_FILE = join(PLUGIN_ROOT, "skills", "seo", "SKILL.md");

const COMMANDS =
  "audit, page, technical, content, content-brief, schema, images, sitemap, geo, " +
  "plan, programmatic, competitor-pages, local, maps, hreflang, google, backlinks, " +
  "cluster, sxo, drift, ecommerce, flow, agentic, ahrefs, bing, dataforseo, " +
  "firecrawl, image-gen, matomo, profound, seranking, unlighthouse, setup, doctor";

/**
 * Where runtime.py builds the managed virtualenv.
 *
 * Without this, runtime.py's `_is_plugin()` returns false (we strip the
 * `.claude-plugin/` directory it probes) and it puts the venv *inside the
 * installed package*, which is replaced on every reinstall, silently throwing
 * away a multi-hundred-megabyte environment. Setting it explicitly takes the
 * highest-precedence branch in `_data_dir()` and mirrors upstream's own plugin
 * fallback, so the venv survives upgrades.
 */
function dataDir() {
  // `||`, not `??`: an empty variable counts as unset (the XDG spec says so),
  // and a relative one would put the venv inside whatever project is open.
  const absolute = (value: string | undefined) => (value && isAbsolute(value) ? value : undefined);
  if (process.platform === "win32") {
    return join(absolute(process.env.LOCALAPPDATA) ?? join(homedir(), "AppData", "Local"), "claude-seo");
  }
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "claude-seo");
  }
  return join(absolute(process.env.XDG_DATA_HOME) ?? join(homedir(), ".local", "share"), "claude-seo");
}

/**
 * The data directory in force: the user's own `CLAUDE_SEO_DATA_DIR` if they set
 * one (the README documents pointing it at a shared runtime), else the default.
 *
 * A user value is normalised the way runtime.py does it
 * (`Path(raw).expanduser().resolve()`): `~` is expanded, since a quoted `~/…`
 * in a settings `env` block reaches the process unexpanded, and the path is
 * resolved once, against the current directory. The session check here and
 * runtime.py then agree on the same directory.
 */
function activeDataDir() {
  const own = process.env.CLAUDE_SEO_DATA_DIR;
  if (!own) {
    return dataDir();
  }
  if (own === "~") {
    return homedir();
  }
  if (own.startsWith("~/") || own.startsWith("~\\")) {
    return join(homedir(), own.slice(2));
  }
  return resolve(own);
}

/**
 * The `seo` skill as pi's `/skill:` expansion would write it, matching the
 * format pi's `parseSkillBlock` reads back for display:
 * `<skill name location>`, a references line, the body without frontmatter.
 */
function skillMessage(args: string): string {
  const text = readFileSync(SKILL_FILE, "utf-8").replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const end = text.startsWith("---") ? text.indexOf("\n---", 3) : -1;
  const body = (end === -1 ? text : text.slice(end + 4)).trim();
  const block =
    `<skill name="seo" location="${SKILL_FILE}">\n` +
    `References are relative to ${dirname(SKILL_FILE)}.\n\n${body}\n</skill>`;
  return args ? `${block}\n\n${args}` : block;
}

/**
 * Surface a message without assuming a logger.
 *
 * There is no `pi.logger` in the extension API, only `ctx.ui.notify`, which
 * needs a context. Notices that fire before any context exists (module load)
 * go to stderr instead.
 */
function notify(ctx: ExtensionContext | undefined, message: string, level: "info" | "warning" | "error" = "info") {
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
    process.env.SEO_PLUGIN_ROOT ||= PLUGIN_ROOT;
    process.env.CLAUDE_SEO_DATA_DIR = activeDataDir();

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
    description: "SEO analysis: delegates to the seo skill. Usage: /seo [command] [url]",
    handler: async (args: string, ctx) => {
      if (!args.trim()) {
        ctx.ui.notify(
          `Usage: /seo [command] [url]\nCommands: ${COMMANDS}\n\n` +
            "Example: /seo audit https://example.com\n" +
            "First run: /seo setup provisions the Python environment.",
          "info"
        );
        return;
      }
      // Hand the arguments to the orchestrator skill as a user turn. The block is
      // built here rather than left to `/skill:seo` expansion, which omp never
      // performs for an extension's message (see the header).
      let message: string;
      try {
        message = skillMessage(args.trim());
      } catch (error) {
        notify(ctx, `[claude-seo-pi] cannot read ${SKILL_FILE}: ${(error as Error).message}`, "error");
        return;
      }
      // While a turn streams, pi refuses a plain send and omp turns it into a
      // steer that interrupts the running tool batch, so queue a follow-up then.
      // When idle, a plain send starts the turn on both.
      if (ctx.isIdle()) {
        pi.sendUserMessage(message);
      } else {
        pi.sendUserMessage(message, { deliverAs: "followUp" });
      }
    },
  });

  // Session notice
  pi.on("session_start", async (_event, ctx) => {
    if (!existsSync(SCRIPTS_DIR)) {
      notify(
        ctx,
        "[claude-seo-pi] scripts/ is missing: reinstall the package or run the sync script.",
        "warning"
      );
      return;
    }
    if (!existsSync(join(activeDataDir(), "runtime-state.json"))) {
      notify(ctx, "[claude-seo-pi] Python runtime not provisioned yet. Run `/seo setup` once to create it.");
    }
  });
}
