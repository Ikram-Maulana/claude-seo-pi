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

import { PATTERNS, scanText } from "../tools/scan-secrets.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scanner = join(repoRoot, "tools", "scan-secrets.mjs");

const MIXED = "Zk3pQ9vLm2Xw8TnB4yRc7HdJ5sGf1aEuV6bN0qWz";
const HEX = "9f8e7d6c5b4a39281706f5e4d3c2b1a0";

/** One real-shaped sample per PATTERNS label, in the context the label names. */
const fixtures = {
  "Google API key": `AI${"za"}${MIXED.slice(0, 35)}`,
  "Google OAuth client secret": `GOC${"SPX"}-${MIXED.slice(0, 28)}`,
  "AWS access key id": `AK${"IA"}Q3Z7K9M2P5X8R4TW`,
  "GitHub token": `gh${"p_"}${MIXED}${"AbCd"}`,
  "GitHub fine-grained PAT": `github${"_pat_"}${MIXED}${MIXED}Ab`,
  "Slack token": `xo${"xb"}-1234567890-${MIXED.slice(0, 12)}`,
  "Stripe secret": `sk${"_live_"}${MIXED.slice(0, 24)}`,
  "OpenAI key": `sk-${"proj"}-${MIXED}`,
  "Anthropic key": `sk-${"ant"}-${MIXED.repeat(3)}`,
  "Private key block": `-----BEGIN RSA PRIVATE ${"KEY"}-----`,
  "Firecrawl key": `fc${"-"}${HEX}`,
  "npm token": `npm${"_"}${MIXED}${"AbCd"}`,
  "JSON Web Token": `ey${"J"}hbGciOiJIUzI1NiJ9.ey${"J"}zdWIiOiIxMjM0NTY3ODkwIn0.${MIXED.slice(0, 20)}`,
  "assigned literal secret": `password = "${MIXED}"`,
  "unquoted env secret": `DATAFORSEO_PASSWORD=${MIXED}\n`,
  "unquoted YAML secret": `DATAFORSEO_PASSWORD: ${MIXED}\n`,
};

function labels(text) {
  return scanText(text).map((hit) => hit.label);
}

test("every scanner pattern has a sample that proves it still detects", () => {
  // A pattern without a sample can be broken by a regex edit and nobody would
  // know; a sample without a pattern is a label that was renamed or removed.
  assert.deepEqual(
    PATTERNS.map(([label]) => label).sort(),
    Object.keys(fixtures).sort(),
    "PATTERNS and the fixtures in this file must name the same labels"
  );
});

for (const [label, secret] of Object.entries(fixtures)) {
  test(`scanner detects a ${label}`, () => {
    const text = secret.endsWith("\n") ? secret : `value ${secret} end`;
    assert.ok(labels(text).includes(label), `${label} not detected`);
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

test("a placeholder word in the key name does not excuse a real value", () => {
  // The placeholder filter once ran on the whole match, key included, so a
  // real credential under `API_KEY_EXAMPLE`, `token_fake` or `EXAMPLE_SECRET`
  // passed.
  assert.deepEqual(labels(`API_KEY_EXAMPLE = "${MIXED}"`), ["assigned literal secret"]);
  assert.deepEqual(labels(`{"token_fake": "${MIXED}"}`), ["assigned literal secret"]);
  assert.deepEqual(labels(`EXAMPLE_SECRET=${MIXED}\n`), ["unquoted env secret"]);
  assert.deepEqual(labels(`DUMMY_PASSWORD: ${MIXED}\n`), ["unquoted YAML secret"]);
});

test("a bare key name with no prefix is still a key name", () => {
  // `[A-Z][A-Z0-9_]*API_KEY` needed at least one character before the suffix,
  // so the commonest .env line of all, `API_KEY=…`, was never matched.
  for (const name of ["API_KEY", "TOKEN", "SECRET", "PASSWORD"]) {
    assert.deepEqual(labels(`${name}=${MIXED}\n`), ["unquoted env secret"], `${name}= was missed`);
    assert.deepEqual(labels(`${name}: ${MIXED}\n`), ["unquoted YAML secret"], `${name}: was missed`);
  }
});

test("an unquoted YAML value is scanned like an env assignment", () => {
  assert.deepEqual(labels(`env:\n  MOZ_SECRET_KEY: ${MIXED}\n`), ["unquoted YAML secret"]);
  assert.deepEqual(labels(`- SERANKING_API_KEY: ${MIXED}  # prod\n`), ["unquoted YAML secret"]);
  // The same restrictions as the env form: SHOUTING_CASE, and a digit in the value.
  assert.deepEqual(labels("api_key: some_long_identifier_name_here\n"), []);
  assert.deepEqual(labels("DATAFORSEO_PASSWORD: ${{ secrets.DATAFORSEO_PASSWORD }}\n"), []);
  assert.deepEqual(labels("API_KEY: your_api_key_here_1234567\n"), []);
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
