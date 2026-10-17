/**
 * The secret scanner is the only enforcement of "never commit a credential",
 * and it is a script nothing else exercises: a refactor that turned it into a
 * no-op left `npm run check` green. These tests fail when it stops detecting.
 *
 * Fixture credentials are assembled at runtime so this file does not itself
 * contain a credential-shaped literal for the scanner to flag.
 */
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { scanText } from "../tools/scan-secrets.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scanner = join(repoRoot, "tools", "scan-secrets.mjs");

const MIXED = "Zk3pQ9vLm2Xw8TnB4yRc7HdJ5sGf1aEuV6bN0qWz";
const fixtures = {
  "Google API key": `AI${"za"}${MIXED.slice(0, 35)}`,
  "AWS access key id": `AK${"IA"}Q3Z7K9M2P5X8R4TW`,
  "GitHub token": `gh${"p_"}${MIXED}${"AbCd"}`,
  "npm token": `npm${"_"}${MIXED}${"AbCd"}`,
  "Private key block": `-----BEGIN RSA PRIVATE ${"KEY"}-----`,
};

function labels(text) {
  return scanText(text).map((hit) => hit.label);
}

for (const [label, secret] of Object.entries(fixtures)) {
  test(`scanner detects a ${label}`, () => {
    assert.ok(labels(`value ${secret} end`).includes(label), `${label} not detected`);
  });
}

test("scanner detects an assigned literal under a quoted key", () => {
  assert.deepEqual(labels(`{"password": "${MIXED}"}`), ["assigned literal secret"]);
  assert.deepEqual(labels(`password = "${MIXED}"`), ["assigned literal secret"]);
});

test("scanner detects prefixed and suffixed key names", () => {
  assert.deepEqual(labels(`MOZ_SECRET_KEY = "${MIXED}"`), ["assigned literal secret"]);
});

test("scanner detects an unquoted .env assignment", () => {
  assert.deepEqual(labels(`DATAFORSEO_PASSWORD=${MIXED}\n`), ["unquoted env secret"]);
  assert.deepEqual(labels(`export MOZ_SECRET_KEY=${MIXED}\n`), ["unquoted env secret"]);
});

test("scanner leaves placeholders and ordinary code alone", () => {
  assert.deepEqual(labels("OPR_API_KEY=opr_live_xxxxxxxxxxxxxxxx"), []);
  assert.deepEqual(labels('api_key = "your-api-key-goes-here-123"'), []);
  assert.deepEqual(labels("token = some_long_identifier_name_here"), []);
  assert.deepEqual(labels("API_KEY=$DATAFORSEO_API_KEY_FROM_SHELL_1"), []);
});

/** Run the real script inside a throwaway git repository. */
function scanInTempRepo(files) {
  const root = mkdtempSync(join(tmpdir(), "scan-secrets-"));
  try {
    mkdirSync(join(root, "tools"));
    copyFileSync(scanner, join(root, "tools", "scan-secrets.mjs"));
    for (const [path, body] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), body);
    }
    spawnSync("git", ["init", "-q"], { cwd: root });
    return spawnSync(process.execPath, [join(root, "tools", "scan-secrets.mjs")], {
      cwd: root,
      encoding: "utf-8",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("the script exits non-zero on a credential and zero on a clean tree", () => {
  const dirty = scanInTempRepo({ "a.txt": fixtures["Google API key"] });
  assert.equal(dirty.status, 1, dirty.stderr);
  assert.match(dirty.stderr, /a\.txt: Google API key/);

  const clean = scanInTempRepo({ "a.txt": "nothing to see" });
  assert.equal(clean.status, 0, clean.stderr);
});

test("the script scans a nested vendor directory but skips the build-input one", () => {
  const nested = scanInTempRepo({ "scripts/vendor/x.py": fixtures["AWS access key id"] });
  assert.equal(nested.status, 1, "a shipped nested vendor/ must still be scanned");

  const buildInput = scanInTempRepo({ "vendor/x.py": fixtures["AWS access key id"] });
  assert.equal(buildInput.status, 0, "the top-level build input is upstream's own repo");
});
