#!/usr/bin/env node
/**
 * Run the vendored upstream test suite against *this* tree.
 *
 * Every upstream test locates the code it checks with
 * `Path(__file__).resolve().parents[1]`, so running the suite from
 * `vendor/claude-seo/tests/` would import the vendored scripts and prove only
 * that upstream is self-consistent. Staging the tests one directory below the
 * repo root makes `parents[1]` resolve here, so the suite loads the shipped
 * `scripts/`. Fixtures are staged alongside, because the suite reads them
 * through `parents[1] / "tests" / "fixtures"`.
 *
 * The suite is upstream's, so a share of it asserts the Claude Code layout this
 * port replaces on purpose (`extensions/<name>/install.sh`, `hooks/`, `docs/`,
 * `${CLAUDE_PLUGIN_ROOT}`). Those are deselected by name in DESELECTED, with
 * the reason recorded, rather than by excluding whole files — the other tests
 * in those files still validate our code.
 *
 * Run: node tools/upstream-tests.mjs [--verbose]
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const source = join(repoRoot, "vendor", "claude-seo", "tests");

/**
 * Where the tests are staged: exactly one level below the repo root, so the
 * suite's `parents[1]` resolves to the root and it imports our scripts.
 */
const staging = join(repoRoot, "tests-upstream");

/**
 * Tests that assert the Claude Code layout this port deliberately replaces.
 *
 * Each entry records why, so a future reader can tell a real regression from an
 * intentional divergence. Everything not listed here runs, and a failure in it
 * is a genuine regression in the shipped code.
 *
 * The reasons cluster into five facts about the port, all documented in the
 * README: it ships no `extensions/<name>/install.sh`; it drives the schema
 * validator from an extension instead of `hooks/`; it rewrites
 * `${CLAUDE_PLUGIN_ROOT}` to `$SEO_PLUGIN_ROOT` and `mcp__x__*` to `mcp:x`; it
 * drops `maxTurns`; and it does not publish upstream's own repository files
 * (`docs/`, `CLAUDE.md`, `AGENTS.md`, `pyproject.toml`, `.claude-plugin/`).
 */
const DESELECTED = [
  // ── No Claude Code extension installers (they wrote ~/.claude.json) ──
  // The port ships no `extensions/<name>/install.sh` at all, so every test that
  // reads one is listed by name. Whole files are excluded only where *every* test
  // in them does so — a file that also contains passing tests still validates our
  // code, and excluding it wholesale once skipped 126 tests.
  "test_extension_installer_injection.py",
  "test_firecrawl_install_atomic_write.py",
  "test_windows_uninstaller.py",
  "test_matomo_report.py::test_installers_do_not_put_the_token_in_settings_json",
  "test_matomo_report.py::test_installers_pass_credentials_through_env_not_source_or_argv",
  "test_matomo_report.py::test_uninstall_removes_the_config_and_the_legacy_env_entry",
  "test_matomo_report.py::test_installers_warn_about_a_private_instance_address",
  "test_matomo_report.py::test_installer_writer_is_inert_against_an_injection_shaped_token",
  "test_matomo_report.py::test_installer_writer_survives_a_dropped_optional_argument",
  "test_banana_install_layout.py::test_standalone_extension_uses_managed_runtime_for_every_script",
  "test_banana_install_layout.py::test_standalone_installer_copies_scripts_beside_skill_file",
  "test_banana_install_layout.py::test_top_level_installer_keeps_extension_scripts_under_core_extension_tree",
  "test_runtime_installers.py::test_unix_installer_delegates_to_runtime_without_global_pip",
  "test_runtime_installers.py::test_windows_installer_delegates_to_runtime_without_path_mutation",
  "test_manual_install_layout.py::test_bash_installer_copies_google_update_data_beside_scripts",
  "test_manual_install_layout.py::test_powershell_installer_copies_google_update_data_beside_scripts",
  "test_manual_install_layout.py::test_cross_skill_paths_resolve_outside_the_repo_checkout",
  "test_parasite_risk_and_extensions.py::test_extension_has_install_skill_and_docs",
  "test_parasite_risk_and_extensions.py::test_extension_install_script_is_executable",
  "test_parasite_risk_and_extensions.py::test_extension_skillmd_has_required_frontmatter",
  "test_unlighthouse_run.py::test_installer_detects_plugin_install_paths",
  "test_dataforseo_tool_names.py::test_fixture_matches_the_installer_pin",
  // ── The schema hook lives in scripts/, driven by an extension ──
  // The suite looks for `hooks/validate-schema.py`; the port ships the same bytes
  // as `scripts/validate_schema_hook.py`, and `stage()` links the two so the 33
  // hook-behaviour tests run against the shipped file. Only the tests asserting
  // the *hook wiring* are listed here.
  "test_cross_platform_hooks.py",
  // Reads docs/TROUBLESHOOTING.md — an upstream repository file, not shipped.
  "test_schema_v2.py::test_faqpage_guidance_does_not_claim_unconfirmed_benefits",
  // ── `$SEO_PLUGIN_ROOT` replaces `${CLAUDE_PLUGIN_ROOT}` ──
  "test_hosted_plugin_layout.py::test_instruction_files_use_the_canonical_plugin_root_form",
  "test_hosted_plugin_layout.py::test_installers_reference_the_scripts_launcher",
  "test_audit_instructions.py::test_seo_audit_starts_with_render_page_auto",
  // ── `mcp:server` replaces `mcp__server__*`, and the per-extension directory
  //    layout is flattened into skills/ and agents/ for omp discovery ──
  "test_agent_mcp_permissions.py",
  // ── The body rewrite replaces "call WebFetch" with the packaged fetcher ──
  "test_sync_flow.py::test_agent_has_untrusted_webfetch_rule",
  // ── `maxTurns` is a Claude Code field with no pi-subagents equivalent ──
  "test_audit_agent_turn_budget.py::test_every_audit_agent_has_a_turn_budget_at_least_30",
  "test_audit_agent_turn_budget.py::test_named_reporters_agents_have_at_least_40_turns",
  "test_audit_agent_turn_budget.py::test_dataforseo_extension_mirror_also_has_the_early_write_instruction",
  "test_agent_untrusted_content.py::test_fifteen_agents_ingest_external_content",
  // ── Upstream repository files are not part of the published package ──
  // `.claude-plugin/`, `docs/`, `CLAUDE.md`, `AGENTS.md` and `pyproject.toml` do
  // not exist here, so the tests that read them are listed individually. The
  // files below also hold tests that pass against this tree (the portability
  // lint, the requirements floors), which is why none of them is listed whole.
  "test_manifest_consistency.py::test_plugin_json_skill_count_matches_disk",
  "test_manifest_consistency.py::test_plugin_json_description_fits_registry_limit",
  "test_manifest_consistency.py::test_plugin_json_subagent_count_matches_disk",
  "test_manifest_consistency.py::test_marketplace_json_skill_count_matches_plugin_json",
  "test_manifest_consistency.py::test_marketplace_json_subagent_count_matches_plugin_json",
  "test_manifest_consistency.py::test_canonical_phrasing_in_user_visible_docs",
  "test_manifest_consistency.py::test_version_triangulation",
  "test_manifest_consistency.py::test_pyproject_version_matches_plugin_json",
  "test_manifest_consistency.py::test_install_scripts_default_tag_matches_plugin_version",
  "test_manifest_consistency.py::test_orchestrator_sub_skills_list_matches_disk",
  "test_manifest_consistency.py::test_orchestrator_subagents_list_matches_disk",
  "test_manifest_consistency.py::test_skill_metadata_versions_match_plugin_json",
  "test_manifest_consistency.py::test_marketplace_metadata_and_author_parity",
  "test_manifest_consistency.py::test_canonical_math_adds_up",
  "test_manifest_consistency.py::test_script_count_claims_match_tracked_scripts",
  "test_manifest_consistency.py::test_claude_md_script_inventory_lists_every_tracked_script",
  "test_consistency_check.py::test_no_consistency_errors",
  "test_consistency_check.py::test_checker_scans_whole_tree",
  "test_contributors.py",
  "test_portability.py::test_agents_md_covers_all_target_platforms",
  "test_portability.py::test_agents_md_documents_portability_check",
  "test_portability.py::test_agents_md_tool_mapping_table_includes_codex_cline_aider",
  "test_pyproject_metadata.py::test_pyproject_has_authors_and_keywords",
  "test_pyproject_metadata.py::test_pyproject_has_minimal_ruff_config_only",
  "test_google_api_key_safety.py::test_mcp_docs_do_not_show_google_query_key_examples",
];

function stage() {
  if (!existsSync(source)) {
    console.error(
      "vendor/claude-seo/tests is missing — run `node tools/vendor.mjs` first."
    );
    process.exit(2);
  }
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  for (const entry of readdirSync(source)) {
    cpSync(join(source, entry), join(staging, entry), { recursive: true });
  }
  // The suite reads its fixtures through `parents[1] / "tests" / "fixtures"`,
  // which resolves to the repo's tests/ directory.
  mkdirSync(join(repoRoot, "tests", "fixtures"), { recursive: true });
  for (const entry of readdirSync(join(source, "fixtures"))) {
    cpSync(join(source, "fixtures", entry), join(repoRoot, "tests", "fixtures", entry));
  }

  // `test_schema_hook_*.py` invokes `ROOT/hooks/validate-schema.py`, which the
  // port ships as `scripts/validate_schema_hook.py`. A symlink lets those 33
  // tests exercise the shipped file instead of skipping them — which is how a
  // gutted validator went unnoticed. Where symlinks are unavailable (Windows
  // without Developer Mode), copying achieves the same thing.
  const hookDir = join(repoRoot, "hooks");
  const hookLink = join(hookDir, "validate-schema.py");
  const shipped = join(repoRoot, "scripts", "validate_schema_hook.py");
  mkdirSync(hookDir, { recursive: true });
  rmSync(hookLink, { force: true });
  try {
    symlinkSync(join("..", "scripts", "validate_schema_hook.py"), hookLink);
  } catch {
    try {
      cpSync(shipped, hookLink);
      console.warn(
        "[upstream-tests] symlinks unavailable — copied scripts/validate_schema_hook.py " +
          "into hooks/ instead; the schema tests still run against the shipped bytes"
      );
    } catch (error) {
      // Neither worked. Fail here with a clear reason rather than letting 33
      // tests fail later on a missing file, which reads as a code defect.
      console.error(
        `[upstream-tests] cannot expose the schema hook to the suite: ${error.message}\n` +
          `  expected to create ${hookLink} (symlink or copy of ${shipped})`
      );
      process.exit(2);
    }
  }
}

/** Resolve the Python interpreter to run pytest with. */
function python() {
  const candidates = [
    process.env.CLAUDE_SEO_PYTHON,
    join(repoRoot, ".venv", "bin", "python"),
    "python3",
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      execFileSync(candidate, ["-c", "import pytest"], { stdio: "ignore" });
      return candidate;
    } catch {
      // try the next one
    }
  }
  return null;
}

stage();

const interpreter = python();
if (!interpreter) {
  console.error(
    "No Python with pytest found. The upstream suite is optional; to run it:\n" +
      "  python3 -m venv .venv && .venv/bin/pip install pytest requests beautifulsoup4 lxml"
  );
  process.exit(2);
}

const args = [
  "-m",
  "pytest",
  "tests-upstream/",
  "-q",
  "--no-header",
  "-p",
  "no:cacheprovider",
  "--tb=line",
];
for (const entry of DESELECTED) {
  if (entry.includes("::")) {
    args.push("--deselect", join("tests-upstream", entry));
  } else {
    args.push("--ignore", join("tests-upstream", entry));
  }
}
if (process.argv.includes("--verbose")) {
  args.push("--tb=short", "-v");
}

/**
 * Count the test ids `--collect-only -q` printed.
 *
 * The summary line is not usable: with `--deselect` pytest prints
 * `984/985 tests collected (1 deselected)`, and a `(\d+) tests collected`
 * pattern reads the denominator, so every deselected test went uncounted.
 */
function countCollected(output) {
  return output.split("\n").filter((line) => /^\S+::\S/.test(line)).length;
}

/**
 * How many tests the DESELECTED list actually removes.
 *
 * Measured by asking pytest to collect twice — once unrestricted, once with the
 * list applied — rather than by counting entries, which is wrong two ways:
 * `--ignore` removes a file without pytest counting it as "deselected" (that
 * counter covers `--deselect` only), and one parametrised entry can remove
 * several tests.
 */
function deselectedTestCount() {
  const collect = (extra) => {
    try {
      const out = execFileSync(
        interpreter,
        [
          "-m", "pytest", "tests-upstream/",
          "--collect-only", "-q", "--no-header", "-p", "no:cacheprovider",
          ...extra,
        ],
        { cwd: repoRoot, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }
      );
      return countCollected(out);
    } catch (error) {
      return countCollected(`${error.stdout ?? ""}${error.stderr ?? ""}`);
    }
  };

  const all = collect([]);
  const kept = collect(
    DESELECTED.flatMap((entry) =>
      entry.includes("::")
        ? ["--deselect", join("tests-upstream", entry)]
        : ["--ignore", join("tests-upstream", entry)]
    )
  );
  return { removed: all - kept, total: all };
}

try {
  execFileSync(interpreter, args, { cwd: repoRoot, stdio: "inherit" });
  const { removed, total } = deselectedTestCount();
  console.log(
    `\n✓ upstream suite passed — ${total - removed}/${total} upstream tests ran; ` +
      `${removed} were not run, via ${DESELECTED.length} entries (each with a stated reason)`
  );
} catch (error) {
  console.error(
    "\n✗ the upstream suite failed against this tree. A failure here is usually a\n" +
      "  real regression in scripts/: the suite exercises the SSRF guard, the\n" +
      "  schema hook, the fetchers and the cost ledgers against the shipped code."
  );
  process.exit(error.status ?? 1);
}
