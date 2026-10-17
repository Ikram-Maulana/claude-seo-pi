#!/usr/bin/env node
/**
 * Download and verify the pinned upstream claude-seo release into vendor/.
 *
 * The tarball checksum is verified against vendor/lock.json before extraction,
 * so a moved tag or a tampered archive fails hard instead of silently changing
 * the source of everything downstream.
 *
 * Run: node tools/vendor.mjs
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const vendorDir = join(repoRoot, "vendor");
const lockPath = join(vendorDir, "lock.json");
const targetDir = join(vendorDir, "claude-seo");

const lock = JSON.parse(readFileSync(lockPath, "utf-8"));
const { tag, url, sha256 } = lock;

if (!(tag && url && sha256)) {
  throw new Error(`vendor/lock.json must define tag, url and sha256 (got ${JSON.stringify(lock)})`);
}

mkdirSync(vendorDir, { recursive: true });

const archivePath = join(vendorDir, `.claude-seo-${tag}.tar.gz`);
console.log(`↓ downloading ${tag}`);
// -f: an HTTP error must stop here, not be hashed as if the error page were the
// archive and reported as a moved tag. The limits keep a stalled download from
// hanging the build.
execFileSync(
  "curl",
  ["-fsSL", "--retry", "3", "--connect-timeout", "20", "--max-time", "300", url, "-o", archivePath],
  { stdio: "inherit" }
);

const actual = createHash("sha256").update(readFileSync(archivePath)).digest("hex");
if (actual !== sha256) {
  rmSync(archivePath, { force: true });
  throw new Error(
    `checksum mismatch for ${tag}\n  expected ${sha256}\n  actual   ${actual}\n` +
      "The tag may have moved. Update vendor/lock.json deliberately after reviewing the diff."
  );
}
console.log(`✓ sha256 ${actual}`);

// GitHub tag archives nest everything under a single <repo>-<version> directory.
const entries = execFileSync("tar", ["-tzf", archivePath], { encoding: "utf-8" }).split("\n");
const stripRoot = (entries[0] ?? "").replace(/\/$/, "");
if (!stripRoot) {
  throw new Error("archive appears to be empty");
}

rmSync(targetDir, { recursive: true, force: true });
mkdirSync(targetDir, { recursive: true });
execFileSync("tar", ["-xzf", archivePath, "-C", targetDir, "--strip-components=1"], {
  stdio: "inherit",
});
rmSync(archivePath, { force: true });

if (!existsSync(join(targetDir, "skills"))) {
  throw new Error(`extracted ${stripRoot} but vendor/claude-seo/skills is missing`);
}

writeFileSync(
  join(vendorDir, "resolved.json"),
  `${JSON.stringify({ ...lock, resolvedAt: new Date().toISOString() }, null, 2)}\n`,
  "utf-8"
);

console.log(`✓ vendored ${tag} → vendor/claude-seo/`);
