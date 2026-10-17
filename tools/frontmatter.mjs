/**
 * Frontmatter reading and rendering for the build.
 *
 * Reading delegates to the `yaml` package (a devDependency — `tools/` is not
 * published, so consumers still install nothing): `description: >` is a
 * block-scalar *header* whose value sits on the indented lines, and a
 * hand-rolled reader cuts a quoted `#` out of the value. Writing stays
 * hand-rolled so each key renders on one clean line instead of wrapping.
 */

import { parse as parseYaml } from "yaml";

/** A block-scalar header (`>`, `>-`, `|`, `|2`): carries no inline value. */
const BLOCK_SCALAR = /^[>|][-+]?\d*$/;

/** Split `---\nfm\n---\nbody` into its parts, tolerating a missing body. */
export function splitFrontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!match) {
    return { frontmatter: "", body: text };
  }
  return { frontmatter: match[1], body: text.slice(match[0].length) };
}

/**
 * Normalise one parsed value into the string form the build consumes.
 *
 * YAML gives back real types (arrays, booleans, numbers) while every consumer
 * downstream splits on commas and compares strings, so the conversion belongs
 * here. Trailing newlines are dropped: a block scalar's `clip` chomping keeps
 * one, which would round-trip into an escaped `\n` inside a quoted string.
 */
function toStringValue(value) {
  if (value === null || value === undefined) {
    return "";
  }
  if (Array.isArray(value)) {
    // pi-subagents takes either shape; normalise to the scalar so downstream
    // logic has one case.
    return value.map((item) => String(item)).join(", ");
  }
  return String(value).replace(/\n+$/, "");
}

/**
 * Parse frontmatter into `{ values, order, raw }`.
 *
 * `values` holds every key as a string, so it stays permissive: skills carry a
 * `metadata:` mapping the build only reads. `raw` keeps the parsed YAML types
 * for a caller that writes values back out and must not change them. `order`
 * preserves the source key order so the renderer keeps a file's existing
 * layout. Throws on malformed YAML: the build rewrites what it reads, so a
 * block the parser cannot read is one whose values would be guessed at.
 */
export function parseFrontmatter(raw) {
  const trimmed = raw.trim();
  if (trimmed === "") {
    return { values: {}, order: [], raw: {} };
  }

  let parsed;
  try {
    parsed = parseYaml(raw);
  } catch (error) {
    throw new Error(`frontmatter is not valid YAML: ${error.message}`);
  }

  if (parsed === null || parsed === undefined) {
    return { values: {}, order: [], raw: {} };
  }
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`frontmatter must be a mapping, got ${Array.isArray(parsed) ? "a list" : typeof parsed}`);
  }

  const values = {};
  const order = [];
  for (const [key, value] of Object.entries(parsed)) {
    order.push(key);
    values[key] = toStringValue(value);
  }
  return { values, order, raw: parsed };
}

/** True when `text`, written bare, reads back as exactly `value`. */
function readsBackAs(text, value) {
  try {
    return Object.is(parseYaml(text), value);
  } catch {
    return false;
  }
}

/**
 * Quote a value only when YAML would otherwise misread it.
 *
 * JSON's string syntax is a subset of YAML's double-quoted scalars, so
 * JSON.stringify is a safe quoter; plain values stay unquoted to keep the
 * generated files readable and diffable.
 *
 * With `exact`, the value is a parsed YAML scalar that must keep its type: a
 * boolean, number or null renders bare, and a string that would read back as
 * one of those (`"true"`, `"42"`, `"null"`) is quoted. Without it, the build's
 * own string flags (`advertise: true`) render bare, as pi-subagents expects.
 */
function yamlValue(value, exact = false) {
  if (exact && (value === null || typeof value === "boolean" || typeof value === "number")) {
    const bare = String(value);
    if (readsBackAs(bare, value)) {
      return bare;
    }
  }
  const text = String(value ?? "");
  const needsQuotes =
    (exact && !readsBackAs(text, text)) ||
    text === "" ||
    /:\s/.test(text) ||
    /\s#/.test(text) ||
    /^[\s>|&*!%@`"'\-?,[\]{}#]/.test(text) ||
    /[:#]\s*$/.test(text) ||
    /\s$/.test(text) ||
    text.includes("\n");
  return needsQuotes ? JSON.stringify(text) : text;
}

/** Render `[key, value]` or `[key, value, { exact: true }]` pairs, one per line. */
export function renderFrontmatter(pairs) {
  return ["---", ...pairs.map(([k, v, options]) => `${k}: ${yamlValue(v, options?.exact)}`), "---", ""].join("\n");
}

/** Raw frontmatter block of a file, or "" when the file has none. */
export function frontmatterOf(text) {
  const { frontmatter } = splitFrontmatter(text);
  return frontmatter;
}

/** The effective value of a key, resolving block scalars and list shapes. */
export function valueOf(frontmatter, key) {
  return parseFrontmatter(frontmatter).values[key] ?? "";
}

export function descriptionOf(frontmatter) {
  return valueOf(frontmatter, "description");
}

export { BLOCK_SCALAR };
