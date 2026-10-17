/**
 * Guards on the things that stand between a bad commit and an immutable npm
 * publish: the release workflow's gates and the checksum on the vendored
 * upstream. Both are plain files nothing else exercised, so deleting a gate or
 * the hash comparison left every other check green.
 */
import { strict as assert } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { parse } from "yaml";

import { documentedCount, VERSION_DESELECTED, versionDeselected } from "../tools/upstream-tests.mjs";
import { actionPinProblems, MIN_ACTION_MAJOR } from "../tools/verify.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workflow = (name) =>
  parse(readFileSync(join(repoRoot, ".github", "workflows", name), "utf-8"));

/** Every shell line a job runs, flattened. */
function runs(job) {
  // A job that calls a reusable workflow has `uses` and no steps of its own.
  return (job.steps ?? []).map((step) => step.run ?? "").join("\n");
}

test("the publish job cannot start before verify and the upstream suite pass", () => {
  const { publish } = workflow("release.yml").jobs;
  const needs = [publish.needs].flat();
  assert.ok(needs.includes("verify"), "publish no longer waits for verify");
  assert.ok(needs.includes("upstream-suite"), "publish no longer waits for the upstream suite");
});

test("the release runs the whole CI workflow at the tagged commit before publishing", () => {
  // The typecheck, the Python runtime matrix and the tarball checks existed only
  // in ci.yml, so a tag on a commit CI never saw reached the approval step.
  const release = workflow("release.yml");
  const callers = Object.entries(release.jobs).filter(([, job]) => job.uses === "./.github/workflows/ci.yml");
  assert.equal(callers.length, 1, "release.yml no longer calls ci.yml");
  const [name, job] = callers[0];
  assert.ok([release.jobs.publish.needs].flat().includes(name), "publish does not wait for the CI run");
  assert.deepEqual(job.permissions, { contents: "read" }, "the CI call must not inherit a wider token");
  assert.ok("workflow_call" in workflow("ci.yml").on, "ci.yml can no longer be called by the release");
  // GitHub cancels a run whose caller and callee share a concurrency group.
  assert.notEqual(workflow("ci.yml").concurrency.group, release.concurrency.group);
});

test("CI keeps every gate, and none of them may fail softly", () => {
  const ci = workflow("ci.yml");
  const build = runs(ci.jobs.build);
  assert.match(build, /node tools\/verify\.mjs/, "structure verification is gone");
  assert.match(build, /node --test 'tests\/\*\.test\.mjs'/, "the unit tests are gone");
  assert.match(build, /node tools\/scan-secrets\.mjs/, "the secret scan is gone");
  assert.match(build, /npm pack --dry-run/, "the tarball check is gone");

  // The typecheck is the only thing that compiles the extensions; a file
  // missing from its list ships without ever being type-checked.
  const typecheck = stepRun(ci.jobs.build, "Typecheck the extensions");
  assert.match(typecheck, /tsc -p tsconfig\.json/);
  for (const file of readdirSync(join(repoRoot, "src", "extensions")).filter((f) => f.endsWith(".ts"))) {
    assert.ok(typecheck.includes(`src/extensions/${file}`), `${file} is not type-checked in CI`);
  }

  const lenient = [];
  for (const [name, job] of Object.entries(ci.jobs)) {
    if ("continue-on-error" in job) {
      lenient.push(name);
    }
    for (const step of job.steps ?? []) {
      if ("continue-on-error" in step) {
        lenient.push(`${name}: ${step.name ?? step.uses ?? step.run}`);
      }
    }
  }
  assert.deepEqual(lenient, [], "continue-on-error lets a failed CI gate pass, and the release reuses CI");
});

/** The shell a named step runs, failing the test when the step is gone. */
function stepRun(job, name) {
  const step = job.steps.find((s) => s.name === name);
  assert.ok(step, `the "${name}" step is gone`);
  return step.run ?? "";
}

test("release verify job keeps every gate that precedes an irreversible publish", () => {
  const { verify } = workflow("release.yml").jobs;
  const script = runs(verify);
  assert.match(script, /node tools\/verify\.mjs/, "structure verification is gone");
  assert.match(script, /node --test/, "the unit tests are gone");
  assert.match(script, /node tools\/scan-secrets\.mjs/, "the secret scan is gone");

  // Each check must fail its own step: one `exit 1` anywhere in the job used to
  // satisfy this, so a gate whose `exit 1` was deleted still passed.
  const tag = stepRun(verify, "Assert the tag matches package.json");
  assert.match(tag, /GITHUB_REF#refs\/tags\/v/, "the tag-equals-version check is gone");
  assert.match(tag, /exit 1/, "the tag check no longer fails the job");
  const drift = stepRun(verify, "Assert the committed tree matches the sync output");
  assert.match(drift, /git status --porcelain/);
  assert.match(drift, /exit 1/, "the tree-drift check no longer fails the job");
});

test("the release runs the upstream suite with the runtime's own requirements", () => {
  const job = workflow("release.yml").jobs["upstream-suite"];
  const script = runs(job);
  assert.match(script, /^node tools\/upstream-tests\.mjs$/m, "the release no longer runs the upstream suite");
  assert.match(script, /pip install[\s\S]*pytest -r requirements\.txt/, "the suite's dependencies drifted from requirements.txt");
});

test("no release gate can fail without failing the release", () => {
  const release = workflow("release.yml");
  const lenient = [];
  for (const [name, job] of Object.entries(release.jobs)) {
    if ("continue-on-error" in job) {
      lenient.push(name);
    }
    for (const step of job.steps ?? []) {
      if ("continue-on-error" in step) {
        lenient.push(`${name}: ${step.name ?? step.uses ?? step.run}`);
      }
    }
  }
  assert.deepEqual(lenient, [], "continue-on-error lets a failed gate through to npm publish");
});

test("the release publishes with provenance, as latest, and only for v* tags", () => {
  const release = workflow("release.yml");
  assert.deepEqual(release.on.push.tags, ["v*"]);
  const publish = runs(release.jobs.publish);
  assert.match(publish, /npm publish --provenance/);
  // Every version is a `-pi.N` prerelease; npm 11 refuses to publish one
  // without a dist-tag, and any other tag hides it from a plain install.
  assert.match(publish, /npm publish\b[^\n]*--tag latest/);
  assert.equal(release.jobs.publish.permissions["id-token"], "write");
});

test("checkouts keep no credentials and the workflows run one at a time", () => {
  for (const name of ["ci.yml", "release.yml"]) {
    for (const [jobName, job] of Object.entries(workflow(name).jobs)) {
      for (const step of (job.steps ?? []).filter((s) => String(s.uses ?? "").startsWith("actions/checkout@"))) {
        assert.equal(
          step.with?.["persist-credentials"],
          false,
          `${name} ${jobName}: checkout leaves the token in .git/config for every later step`
        );
      }
    }
  }
  const ci = workflow("ci.yml");
  assert.deepEqual(ci.permissions, { contents: "read" }, "CI's token is no longer read-only");
  assert.equal(ci.concurrency?.["cancel-in-progress"], true, "a superseded CI run keeps running");
  const release = workflow("release.yml");
  // Per tag: a shared group keeps one pending run and cancels the older one.
  assert.equal(release.concurrency?.group, "release-${{ github.ref }}");
  assert.equal(release.concurrency?.["cancel-in-progress"], false, "a second tag would cancel an approved release");
});

test("the schema-hook smoke test demands the critical exit, not any failure", () => {
  const step = workflow("ci.yml").jobs["python-runtime"].steps.find((s) => /broken\.html/.test(s.run ?? ""));
  assert.ok(step, "the broken-markup smoke test is gone");
  // `if python3 … broken.html; then fail` accepted a crash as a rejection.
  assert.match(step.run, /-ne 2/, "the step must require exit status 2");
});

test("Dependabot keeps the SHA-pinned actions current on development", () => {
  const config = parse(readFileSync(join(repoRoot, ".github", "dependabot.yml"), "utf-8"));
  const actions = config.updates.find((u) => u["package-ecosystem"] === "github-actions");
  assert.ok(actions, "nothing updates the pinned action SHAs");
  assert.equal(actions["target-branch"], "development");
  assert.equal(actions.schedule.interval, "weekly");
});

test("the action pin check accepts only a commit SHA with its release", () => {
  const sha = "3d3c42e5aac5ba805825da76410c181273ba90b1";
  assert.deepEqual(actionPinProblems(`      - uses: actions/checkout@${sha} # v7.0.1\n`), []);
  assert.deepEqual(actionPinProblems("      - uses: ./local-action\n"), [], "a local action has no version");

  const rejected = {
    "a bare major tag": "      - uses: actions/checkout@v7\n",
    "a branch": "      - uses: actions/checkout@main\n",
    "a SHA with no release comment": `      - uses: actions/checkout@${sha}\n`,
    "a SHA with a major-only comment": `      - uses: actions/checkout@${sha} # v7\n`,
    "a short SHA": "      - uses: actions/checkout@3d3c42e # v7.0.1\n",
    "no version at all": "      - uses: actions/checkout\n",
    [`a major below ${MIN_ACTION_MAJOR}`]: `      - uses: actions/checkout@${sha} # v${MIN_ACTION_MAJOR - 1}.9.0\n`,
  };
  for (const [label, line] of Object.entries(rejected)) {
    assert.equal(actionPinProblems(line).length, 1, `${label} was accepted`);
  }
});

test("the publish job waits on a protected environment, not just on a tag push", () => {
  const { publish } = workflow("release.yml").jobs;
  assert.equal(publish.environment, "npm-release", "publish no longer pauses for an approval");
});

test("the Python runtime job covers the declared floor and the newest Python", () => {
  const { python } = workflow("ci.yml").jobs["python-runtime"].strategy.matrix;
  assert.ok(python.includes("3.10"), "README promises Python 3.10+, but CI no longer tests it");
  assert.ok(python.some((v) => Number(v.split(".")[1]) >= 14), "CI no longer tests a current Python");
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
function harnessWith(pytestStatus, probeStatus = 0, { ci = false } = {}) {
  const work = mkdtempSync(join(tmpdir(), "upstream-harness-"));
  try {
    const stub = join(work, "python");
    writeFileSync(stub, `#!/bin/sh\n[ "$1" = "-c" ] && exit ${probeStatus}\nexit ${pytestStatus}\n`);
    chmodSync(stub, 0o755);
    // The stand-in collects nothing, so its count never matches CONTRIBUTING.md;
    // `CI` decides whether that mismatch fails the run.
    const env = { ...process.env, CLAUDE_SEO_PYTHON: stub };
    delete env.CI;
    if (ci) {
      env.CI = "true";
    }
    return spawnSync(process.execPath, [join(repoRoot, "tools", "upstream-tests.mjs")], {
      cwd: repoRoot,
      encoding: "utf-8",
      env,
    });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

const NEEDS_POSIX = { skip: process.platform === "win32" ? "needs a POSIX shell stand-in" : false };

test(
  "the upstream-suite harness exits non-zero when pytest fails, so the release gate can stop",
  NEEDS_POSIX,
  () => {
    const failed = harnessWith(1);
    assert.notEqual(failed.status, 0, "a failing upstream suite must fail the job");
    assert.match(failed.stderr, /upstream suite failed/);

    const passed = harnessWith(0);
    assert.equal(passed.status, 0, passed.stderr);
    // The stand-in prints no version, which must count as an older Python:
    // the version-conditional test then runs instead of being dropped.
    assert.doesNotMatch(passed.stdout, /deselected on Python/);
  }
);

test("a suite count that disagrees with CONTRIBUTING.md fails in CI and warns locally", NEEDS_POSIX, () => {
  // The documented count drifted once (813 vs 874) while a test that only
  // checked its shape stayed green; the harness now compares the measured one.
  const ci = harnessWith(0, 0, { ci: true });
  assert.equal(ci.status, 1, ci.stdout);
  assert.match(ci.stderr, /CONTRIBUTING\.md says \d+ of \d+ for this Python; the run measured 0 of 0/);

  const local = harnessWith(0);
  assert.equal(local.status, 0, local.stderr);
  assert.match(local.stderr, /a warning outside CI/);
});

test("documentedCount picks the figure for the Python that ran", () => {
  const line = "npm run test:upstream        # 878 of 999 upstream tests on Python 3.14, 879 below it";
  assert.deepEqual(documentedCount(line, [3, 14]), { ran: 878, total: 999 });
  assert.deepEqual(documentedCount(line, [4, 0]), { ran: 878, total: 999 });
  assert.deepEqual(documentedCount(line, [3, 12]), { ran: 879, total: 999 });
  assert.deepEqual(documentedCount(line, null), { ran: 879, total: 999 }, "an unknown version counts as older");
  assert.equal(documentedCount("no count here", [3, 12]), null);
});

test("versionDeselected applies an entry from its minimum Python up, and never to an unknown one", () => {
  // CI runs the suite on 3.12: an inverted comparison would silently drop a
  // hostile-input test there, and the stub-based harness test takes the `null`
  // path, so it would never notice.
  for (const { entry, minPython } of VERSION_DESELECTED) {
    const [major, minor] = minPython;
    const applies = (version) => versionDeselected(version).some((e) => e.entry === entry);
    assert.equal(applies([major, minor]), true, `${entry} must be deselected on ${major}.${minor}`);
    assert.equal(applies([major + 1, 0]), true, `${entry} must be deselected on ${major + 1}.0`);
    assert.equal(applies([major, minor - 1]), false, `${entry} must run on ${major}.${minor - 1}`);
    assert.equal(applies([major - 1, minor + 5]), false, `${entry} must run on ${major - 1}.${minor + 5}`);
    assert.equal(applies(null), false, `${entry} must run when the version is unknown`);
  }
});

test("an explicit CLAUDE_SEO_PYTHON without pytest fails instead of falling back", NEEDS_POSIX, () => {
  // Falling through to .venv or python3 would report a run on an interpreter
  // nobody chose as the result for the one that was asked for.
  const result = harnessWith(0, 1);
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /CLAUDE_SEO_PYTHON=.* cannot import pytest/);
  assert.doesNotMatch(result.stdout, /upstream suite passed/);
});
