#!/usr/bin/env node
/**
 * Scan the tree for credential-shaped strings.
 *
 * Run in CI so a leaked key is caught in review rather than after publication.
 * This is a shape-based scan, not a real secret scanner: it matches the formats
 * of the credentials this project's integrations use plus the generic
 * `KEY = "..."` assignment. A scanner that only knows the generic shape misses
 * every prefixed token; one that only knows prefixes misses a pasted literal.
 *
 * It scans the *tracked and untracked* working tree, not just what is committed
 * (a secret is a problem the moment it is in the directory), and exits non-zero
 * on a hit so it can gate a build. Placeholders are recognised
 * (`xxx…`, `<your-key>`, `CHANGEME`) so upstream's own documentation does not
 * trip it.
 *
 * Run: node tools/scan-secrets.mjs [--all]
 */
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

/**
 * Credential shapes.
 *
 * Kept deliberately few and precise: a broad "looks like a long string" rule
 * produces noise, and a scan that cries wolf gets disabled.
 */
const PATTERNS = [
  ["Google API key", /AIza[0-9A-Za-z_-]{35}/g],
  ["Google OAuth client secret", /GOCSPX-[0-9A-Za-z_-]{28,}/g],
  ["AWS access key id", /AKIA[0-9A-Z]{16}/g],
  ["GitHub token", /gh[pousr]_[0-9A-Za-z]{36,}/g],
  ["GitHub fine-grained PAT", /github_pat_[0-9A-Za-z_]{82}/g],
  ["Slack token", /xox[baprs]-[0-9A-Za-z-]{10,}/g],
  ["Stripe secret", /sk_(live|test)_[0-9a-zA-Z]{24,}/g],
  ["OpenAI key", /sk-proj-[A-Za-z0-9_-]{40,}|sk-[A-Za-z0-9]{20}T3BlbkFJ[A-Za-z0-9]{20}/g],
  ["Anthropic key", /sk-ant-[A-Za-z0-9_-]{90,}/g],
  ["Private key block", /-----BEGIN [A-Z ]*PRIVATE KEY-----/g],
  ["Firecrawl key", /fc-[0-9a-f]{32}/g],
  ["JSON Web Token", /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g],
  [
    "assigned literal secret",
    /(?:api[_-]?key|apikey|client[_-]?secret|secret|password|token)\s*[:=]\s*["'][A-Za-z0-9_\-]{20,}["']/gi,
  ],
];

/**
 * Values that look like a secret but are documentation.
 *
 * Upstream ships `opr_live_xxxxxxxxxxxxxxxx` in a setup example; flagging that
 * would make the scan useless, so a match is discarded when it contains a run
 * of placeholder characters or a placeholder word.
 */
const PLACEHOLDER = /x{6,}|X{6,}|0{6,}|<[a-z_-]+>|\$\{|your[_-]?|example|placeholder|changeme|redacted|canary|dummy|fake|test[_-]?key|abc123|abcdef0123456789/i;

/** Files that cannot hold a credential we care about. */
const SKIP_PATH = /(^|\/)(node_modules|\.git|\.venv|vendor|tests-upstream|__pycache__)(\/|$)/;
const SKIP_EXT = /\.(png|jpe?g|gif|ico|webp|woff2?|ttf|eot|otf|zip|gz|tgz|bz2|pdf|pyc|so|dylib|dll|exe|mp4|webm)$/i;
const MAX_BYTES = 4 * 1024 * 1024;

/** List every file in the working tree, tracked or not. */
function listFiles() {
  const out = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: repoRoot, encoding: "utf-8", maxBuffer: 32 * 1024 * 1024 }
  );
  return out.split("\0").filter(Boolean);
}

/** Return the credential labels a file's text matches. */
function scanText(text) {
  const hits = [];
  for (const [label, pattern] of PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      if (PLACEHOLDER.test(match[0])) {
        continue;
      }
      hits.push({ label, sample: match[0].slice(0, 12) + "…" });
    }
  }
  return hits;
}

const files = listFiles();
const findings = [];
let scanned = 0;

for (const file of files) {
  if (SKIP_PATH.test(file) || SKIP_EXT.test(file)) {
    continue;
  }
  const full = join(repoRoot, file);
  let size;
  try {
    size = statSync(full).size;
  } catch {
    continue;
  }
  if (size === 0 || size > MAX_BYTES) {
    continue;
  }
  let buffer;
  try {
    buffer = readFileSync(full);
  } catch {
    continue;
  }
  if (buffer.includes(0)) {
    continue; // binary
  }
  scanned += 1;
  for (const hit of scanText(buffer.toString("utf-8"))) {
    findings.push(`${file}: ${hit.label} (${hit.sample})`);
  }
}

// The vendored tree is skipped above because it is upstream's own repository,
// but we ship its scripts, so scan it too unless --tracked-only was requested.
if (!process.argv.includes("--tracked-only")) {
  const vendored = execFileSync(
    "git",
    ["ls-files", "-z", "vendor/"],
    { cwd: repoRoot, encoding: "utf-8", maxBuffer: 32 * 1024 * 1024 }
  )
    .split("\0")
    .filter(Boolean);
  for (const file of vendored) {
    if (SKIP_EXT.test(file)) {
      continue;
    }
    let text;
    try {
      const buffer = readFileSync(join(repoRoot, file));
      if (buffer.includes(0) || buffer.length > MAX_BYTES) {
        continue;
      }
      text = buffer.toString("utf-8");
    } catch {
      continue;
    }
    scanned += 1;
    for (const hit of scanText(text)) {
      findings.push(`${file}: ${hit.label} (${hit.sample})`);
    }
  }
}

if (findings.length > 0) {
  console.error(`\n✗ ${findings.length} credential-shaped string(s) found:\n`);
  for (const finding of findings) {
    console.error(`  · ${finding}`);
  }
  console.error(
    "\nIf this is a real credential, rotate it — removing the file is not enough," +
      "\nbecause it is already in the git history and in any clone or fork." +
      "\nIf it is a placeholder, extend the PLACEHOLDER pattern in this script."
  );
  process.exit(1);
}

console.log(`✓ no credential-shaped strings in ${scanned} files`);
