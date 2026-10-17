/**
 * Tests for the frontmatter reader.
 *
 * Two bugs live here. The first: `description: >` is a *header*, not a value,
 * so a reader that stored the header and discarded the indented body shipped
 * four agents with `description: ">"` — and every guard in the repo matched the
 * header line with /^description:\s*\S/, which `>` satisfies, so the build
 * stayed green while the data was gone.
 *
 * The second: the hand-rolled reader had no notion of quoting, so a value like
 * `description: "Fixes the a # b case"` was cut at the `#`. The reader now
 * delegates to the `yaml` package, and the tests below pin both cases.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  BLOCK_SCALAR,
  descriptionOf,
  parseFrontmatter,
  renderFrontmatter,
  splitFrontmatter,
} from "../tools/frontmatter.mjs";

test("a folded block scalar becomes one space-joined line", () => {
  const { values } = parseFrontmatter(
    ["name: scout", "description: >", "  first line", "  second line"].join("\n")
  );
  assert.equal(values.description, "first line second line");
});

test("a folded block scalar with a chomping indicator is recognised", () => {
  for (const header of [">", ">-", ">+", "|", "|-", "|2"]) {
    const { values } = parseFrontmatter(
      ["description: " + header, "  body text"].join("\n")
    );
    assert.equal(values.description, "body text", `header ${header} lost its body`);
  }
});

test("a literal block scalar keeps its newlines", () => {
  const { values } = parseFrontmatter(
    ["description: |", "  line one", "  line two"].join("\n")
  );
  assert.equal(values.description, "line one\nline two");
});

test("a bare block header with no body resolves to empty, never to the header", () => {
  const { values } = parseFrontmatter("description: >\ntools: read");
  assert.equal(values.description, "");
  assert.notEqual(values.description, ">");
  assert.equal(values.tools, "read");
});

test("a block list is normalised to the comma-separated form", () => {
  const { values } = parseFrontmatter(
    ["tools:", "  - read", "  - bash", "  - find"].join("\n")
  );
  assert.equal(values.tools, "read, bash, find");
});

test("flat scalars keep working and stay in source order", () => {
  const { values, order } = parseFrontmatter(
    ["name: scout", "tools: read, grep", "advertise: true"].join("\n")
  );
  assert.equal(values.name, "scout");
  assert.equal(values.tools, "read, grep");
  assert.equal(values.advertise, "true");
  assert.deepEqual(order, ["name", "tools", "advertise"]);
});

test("a block scalar is not confused with a flat value containing >", () => {
  const { values } = parseFrontmatter("description: a > b is fine");
  assert.equal(values.description, "a > b is fine");
});

test("BLOCK_SCALAR matches headers and rejects real prose", () => {
  for (const header of [">", ">-", "|", "|-", ">+", "|2"]) {
    assert.ok(BLOCK_SCALAR.test(header), `${header} should match`);
  }
  for (const prose of ["Technical SEO specialist.", "a > b", ""]) {
    assert.ok(!BLOCK_SCALAR.test(prose), `${prose} should not match`);
  }
});

test("rendering quotes only what YAML would misread", () => {
  assert.equal(
    renderFrontmatter([["name", "scout"]]).split("\n")[1],
    "name: scout"
  );
  // A colon-space inside a plain scalar starts a nested mapping.
  assert.equal(
    renderFrontmatter([["description", "See: this"]]).split("\n")[1],
    'description: "See: this"'
  );
  // A trailing comment marker would truncate the value.
  assert.equal(
    renderFrontmatter([["description", "text # not a comment"]]).split("\n")[1],
    'description: "text # not a comment"'
  );
  assert.equal(renderFrontmatter([["empty", ""]]).split("\n")[1], 'empty: ""');
});

test("a rendered block description round-trips as a real value", () => {
  const source = ["name: seo-cluster", "description: >", "  one two", "  three"].join("\n");
  const { values } = parseFrontmatter(source);
  const rendered = renderFrontmatter([["description", values.description]]);
  const reread = parseFrontmatter(rendered.split("\n").slice(1, -2).join("\n"));
  assert.equal(reread.values.description, "one two three");
});

test("splitFrontmatter separates the body and tolerates its absence", () => {
  const withBody = splitFrontmatter("---\nname: x\n---\n# Heading\n");
  assert.equal(withBody.frontmatter, "name: x");
  assert.equal(withBody.body, "# Heading\n");

  const withoutBody = splitFrontmatter("---\nname: x\n---");
  assert.equal(withoutBody.frontmatter, "name: x");
  assert.equal(withoutBody.body, "");

  const none = splitFrontmatter("# Just a document\n");
  assert.equal(none.frontmatter, "");
  assert.equal(none.body, "# Just a document\n");
});

test("descriptionOf resolves the value, not the header", () => {
  assert.equal(descriptionOf("description: >\n  real text"), "real text");
  assert.equal(descriptionOf("description: flat text"), "flat text");
  assert.equal(descriptionOf("name: x"), "");
});

// Quoting and list shapes
// The hand-rolled reader stripped anything after ` #` without checking whether
// the `#` was inside quotes, so a quoted value containing " # " lost everything
// after it. These cases are why the reader delegates to `yaml`.

test("a quoted # is part of the value, not a comment", () => {
  assert.equal(
    parseFrontmatter('description: "Fixes the a # b case"').values.description,
    "Fixes the a # b case"
  );
  assert.equal(
    parseFrontmatter("description: 'Fixes the a # b case'").values.description,
    "Fixes the a # b case"
  );
});

test("a quoted colon is part of the value", () => {
  assert.equal(
    parseFrontmatter('description: "Note: this matters"').values.description,
    "Note: this matters"
  );
});

test("an unquoted # still starts a comment", () => {
  assert.equal(parseFrontmatter("tools: read, grep  # allowlist").values.tools, "read, grep");
});

test("a flow sequence becomes the comma-separated form", () => {
  // pi-subagents accepts a comma-separated scalar or a block list; the build
  // normalises every shape to the scalar so downstream logic has one case.
  assert.equal(parseFrontmatter("tools: [read, bash, find]").values.tools, "read, bash, find");
});

test("an empty flow sequence yields an empty string, not the literal []", () => {
  // A `tools: []` that stayed the literal "[]" would survive the sync as a
  // one-element allowlist naming a tool called "[]".
  assert.equal(parseFrontmatter("tools: []").values.tools, "");
});

test("quoted values keep their content intact", () => {
  const { values } = parseFrontmatter('description: "a: b # c"');
  assert.equal(values.description, "a: b # c");
});

test("non-string scalars are returned as their text form", () => {
  // Frontmatter values are consumed as strings throughout the build, so a
  // boolean or number must not arrive as a JS true/42.
  const { values } = parseFrontmatter("advertise: true\ncount: 42");
  assert.equal(values.advertise, "true");
  assert.equal(values.count, "42");
});

test("malformed YAML is reported rather than silently half-read", () => {
  // The hand-rolled reader returned whatever it had scanned; a stray quote
  // produced a truncated value with no signal at all.
  assert.throws(
    () => parseFrontmatter('description: "unterminated'),
    /quote|parse|yaml/i,
    "an unterminated quote must not parse to a truncated value"
  );
});

test("a tab-indented line is rejected", () => {
  assert.throws(() => parseFrontmatter("\tdescription: x"), /tab|parse|yaml/i);
});

test("parsing stays permissive and keeps the YAML types alongside the strings", () => {
  // Every SKILL.md carries a `metadata:` mapping that sync, verify and the tree
  // tests read; rejecting non-scalars here would fail all 33 skills.
  const { values, raw } = parseFrontmatter(
    ["name: seo", "advertise: true", 'color: "true"', "metadata:", "  version: 2.4.2"].join("\n")
  );
  assert.equal(values.advertise, "true");
  assert.equal(raw.advertise, true);
  assert.equal(raw.color, "true");
  assert.deepEqual(raw.metadata, { version: "2.4.2" });
  assert.deepEqual(parseFrontmatter("").raw, {});
});

test("an exact value is quoted when a bare one would change its type", () => {
  const line = (value) => renderFrontmatter([["key", value, { exact: true }]]).split("\n")[1];
  assert.equal(line("true"), 'key: "true"', "a string must not become a boolean");
  assert.equal(line("42"), 'key: "42"', "a string must not become a number");
  assert.equal(line("null"), 'key: "null"');
  assert.equal(line(true), "key: true");
  assert.equal(line(42), "key: 42");
  assert.equal(line(null), "key: null");
  assert.equal(line("plain words"), "key: plain words");
});

test("the build's own flags still render as bare booleans", () => {
  // pi-subagents reads `advertise: "true"` as a string, not as true.
  assert.equal(renderFrontmatter([["advertise", "true"]]).split("\n")[1], "advertise: true");
  assert.equal(renderFrontmatter([["inheritSkills", "false"]]).split("\n")[1], "inheritSkills: false");
});
