/**
 * Guards on the things that stand between a bad commit and an immutable npm
 * publish: the release workflow's gates and the checksum on the vendored
 * upstream. Both are plain files nothing else exercised, so deleting a gate or
 * the hash comparison left every other check green.
 */
import { strict as assert } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { parse } from "yaml";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workflow = (name) =>
  parse(readFileSync(join(repoRoot, ".github", "workflows", name), "utf-8"));

/** Every shell line a job runs, flattened. */
function runs(job) {
  return job.steps.map((step) => step.run ?? "").join("\n");
}

test("the publish job cannot start before verify and the upstream suite pass", () => {
  const { publish } = workflow("release.yml").jobs;
  const needs = [publish.needs].flat();
  assert.ok(needs.includes("verify"), "publish no longer waits for verify");
  assert.ok(needs.includes("upstream-suite"), "publish no longer waits for the upstream suite");
});

test("release verify job keeps every gate that precedes an irreversible publish", () => {
  const { verify } = workflow("release.yml").jobs;
  const script = runs(verify);
  assert.match(script, /GITHUB_REF#refs\/tags\/v/, "the tag-equals-version check is gone");
  assert.match(script, /exit 1/, "the tag check no longer fails the job");
  assert.match(script, /node tools\/verify\.mjs/, "structure verification is gone");
  assert.match(script, /node --test/, "the unit tests are gone");
  assert.match(script, /node tools\/scan-secrets\.mjs/, "the secret scan is gone");
});

test("the release publishes with provenance and only for v* tags", () => {
  const release = workflow("release.yml");
  assert.deepEqual(release.on.push.tags, ["v*"]);
  assert.match(runs(release.jobs.publish), /npm publish --provenance/);
  assert.equal(release.jobs.publish.permissions["id-token"], "write");
});

test("the tree-drift gates see untracked files in both workflows", () => {
  for (const name of ["ci.yml", "release.yml"]) {
    const w = workflow(name);
    const script = Object.values(w.jobs)
      .map((job) => runs(job))
      .join("\n");
    assert.match(
      script,
      /git status --porcelain/,
      `${name}: \`git diff\` alone ignores a newly generated file, so a file missing from git passes`
    );
  }
});

/** A one-file upstream archive, plus its hash. */
function fakeUpstream(workdir) {
  const root = join(workdir, "claude-seo-9.9.9");
  mkdirSync(join(root, "skills", "demo"), { recursive: true });
  writeFileSync(join(root, "skills", "demo", "SKILL.md"), "---\nname: demo\n---\n");
  const archive = join(workdir, "upstream.tar.gz");
  execFileSync("tar", ["-czf", archive, "-C", workdir, "claude-seo-9.9.9"]);
  return { archive, sha256: createHash("sha256").update(readFileSync(archive)).digest("hex") };
}

/** Run the real vendor script against a lock that points at a local archive. */
function vendorWith(sha256Override) {
  const work = mkdtempSync(join(tmpdir(), "vendor-gate-"));
  try {
    const { archive, sha256 } = fakeUpstream(work);
    const project = join(work, "project");
    mkdirSync(join(project, "tools"), { recursive: true });
    mkdirSync(join(project, "vendor"), { recursive: true });
    copyFileSync(join(repoRoot, "tools", "vendor.mjs"), join(project, "tools", "vendor.mjs"));
    writeFileSync(
      join(project, "vendor", "lock.json"),
      JSON.stringify({
        tag: "v9.9.9",
        url: pathToFileURL(archive).href,
        sha256: sha256Override ?? sha256,
      })
    );
    const result = spawnSync(process.execPath, [join(project, "tools", "vendor.mjs")], {
      cwd: project,
      encoding: "utf-8",
    });
    return { ...result, vendored: existsSync(join(project, "vendor", "claude-seo", "skills")) };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

test("vendor.mjs accepts an archive whose hash matches the lock", () => {
  const result = vendorWith();
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.vendored, "the archive was not extracted");
});

test("vendor.mjs refuses an archive whose hash does not match the lock", () => {
  const result = vendorWith("0".repeat(64));
  assert.notEqual(result.status, 0, "a tampered or moved archive must stop the build");
  assert.match(result.stderr, /checksum mismatch/);
  assert.equal(result.vendored, false, "nothing may be extracted from an unverified archive");
});

/**
 * Run the upstream-suite harness with a stand-in interpreter.
 *
 * The stand-in claims pytest is importable (the `-c` probe) and then exits with
 * the status under test for the real run, so this exercises the harness's own
 * exit handling without needing a Python environment.
 */
function harnessWith(pytestStatus) {
  const work = mkdtempSync(join(tmpdir(), "upstream-harness-"));
  try {
    const stub = join(work, "python");
    writeFileSync(stub, `#!/bin/sh\n[ "$1" = "-c" ] && exit 0\nexit ${pytestStatus}\n`);
    chmodSync(stub, 0o755);
    return spawnSync(process.execPath, [join(repoRoot, "tools", "upstream-tests.mjs")], {
      cwd: repoRoot,
      encoding: "utf-8",
      env: { ...process.env, CLAUDE_SEO_PYTHON: stub },
    });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

test(
  "the upstream-suite harness exits non-zero when pytest fails, so the release gate can stop",
  { skip: process.platform === "win32" ? "needs a POSIX shell stand-in" : false },
  () => {
    const failed = harnessWith(1);
    assert.notEqual(failed.status, 0, "a failing upstream suite must fail the job");
    assert.match(failed.stderr, /upstream suite failed/);

    const passed = harnessWith(0);
    assert.equal(passed.status, 0, passed.stderr);
  }
);
