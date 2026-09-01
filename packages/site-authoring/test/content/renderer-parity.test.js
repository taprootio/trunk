// taproot-allow-source-read: this file is a cross-service parity contract. It
// exists to fail when the canonical renderer or the component registry changes
// vocabulary without this package following, because the failure mode upstream
// is silent — the renderer drops what it does not recognise, and a CLI that
// still accepted the old vocabulary would publish pages that render wrong.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { COMPONENT_TYPES } from "../../src/content/components.js";
import { FREE_FORM_SECTION_REGISTRY } from "../../src/content/free-form-sections.js";
import { NODE_RULES } from "../../src/content/validate-document.js";
import { MARK_TYPES, NODE_TYPES } from "../../src/content/vocabulary.js";
import { MONOREPO_ONLY, MONOREPO_ROOT } from "../monorepo.js";

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const IMPLEMENTATION_MARKER = "export const TIPTAP_SITE_DEFAULT";

function read(...segments) {
  // taproot-allow-source-read: cross-service parity contract (see above).
  return readFileSync(path.join(...segments), "utf8");
}

/** The copy carries its own header; everything after the marker must match. */
function implementationBody(source) {
  const start = source.indexOf(IMPLEMENTATION_MARKER);
  assert.notEqual(start, -1, "the renderer source is missing its implementation marker");
  return source.slice(start);
}

/** The `case "x":` labels of one function in the copied renderer. */
function switchLabels(source, functionName) {
  const start = source.indexOf(`function ${functionName}(`);
  assert.notEqual(start, -1, `the copied renderer has no ${functionName}`);
  const end = source.indexOf("\nfunction ", start + 1);
  const body = source.slice(start, end === -1 ? undefined : end);
  return [...body.matchAll(/case "([A-Za-z]+)":/gu)].map((match) => match[1]);
}

const copy = read(PACKAGE_ROOT, "src", "content", "tiptap-prosemirror.ts");

// Every comparison against a canonical source is monorepo-only: the public
// Trunk tree carries this package alone (TR00635). Inside the monorepo none of
// them skip, because a silently skipped parity test is the drift they exist to
// catch.
test("the copied renderer stays byte-identical to the canonical shared source", { skip: MONOREPO_ONLY }, () => {
  const canonical = read(MONOREPO_ROOT, "shared", "tiptap-prosemirror.ts");
  assert.equal(implementationBody(copy), implementationBody(canonical));
});

test("the runtime section registry stays byte-identical to the canonical shared source", { skip: MONOREPO_ONLY }, () => {
  const canonical = read(MONOREPO_ROOT, "shared", "free-form-section-registry.json");
  const runtime = read(PACKAGE_ROOT, "src", "content", "free-form-section-registry.json");
  assert.equal(runtime, canonical);
});

// Two shared inputs the behavior suites need — the seeded default theme and
// the representative section composition — are carried as test fixtures so the
// public tree can run those suites. Like the copies above, each is pinned
// byte-for-byte to its canonical source here.
test("the default-theme test fixture stays byte-identical to the canonical shared artifact", { skip: MONOREPO_ONLY }, () => {
  const canonical = read(MONOREPO_ROOT, "shared", "default-site-theme.json");
  const fixture = read(PACKAGE_ROOT, "test", "fixtures", "default-site-theme.json");
  assert.equal(fixture, canonical);
});

test("the section-composition test fixture stays byte-identical to the canonical shared fixture", { skip: MONOREPO_ONLY }, () => {
  const canonical = read(MONOREPO_ROOT, "shared", "free-form-section-composition.fixture.json");
  const fixture = read(PACKAGE_ROOT, "test", "fixtures", "free-form-section-composition.fixture.json");
  assert.equal(fixture, canonical);
});

test("the accepted node vocabulary is exactly what the renderer switches on", () => {
  // Every label bar the `default` arm, which renders an unknown node's
  // children and is the silent drop this package refuses. Table descendants
  // are a closed internal grammar normalized by the table case rather than
  // independent renderNode cases, so prove those registry keys are consumed
  // by normalizeTable before including their canonical values.
  const normalizationStart = copy.indexOf("function normalizeTable(");
  const normalizationEnd = copy.indexOf("\nfunction renderSection(", normalizationStart);
  assert.notEqual(normalizationStart, -1, "the copied renderer has no normalizeTable");
  assert.notEqual(normalizationEnd, -1, "the copied renderer has no renderSection after normalizeTable");
  const normalizationBody = copy.slice(normalizationStart, normalizationEnd);
  const nestedTableNodes = Object.entries(FREE_FORM_SECTION_REGISTRY.table.nodeTypes)
    .filter(([key]) => key !== "table")
    .map(([key, type]) => {
      assert.match(normalizationBody, new RegExp(`\\.nodeTypes\\.${key}\\b`, "u"));
      return type;
    });

  assert.deepEqual([...switchLabels(copy, "renderNode"), ...nestedTableNodes].sort(), [...NODE_TYPES].sort());
});

test("the accepted mark vocabulary is exactly what the renderer switches on", () => {
  assert.deepEqual([...switchLabels(copy, "wrapMark")].sort(), [...MARK_TYPES].sort());
});

test("every accepted node has a validation rule, and no rule invents a node", () => {
  assert.deepEqual(Object.keys(NODE_RULES).sort(), [...NODE_TYPES].sort());
});

test("the component types are exactly the registry's built-in templates", { skip: MONOREPO_ONLY }, () => {
  const registry = read(
    MONOREPO_ROOT,
    "ux",
    "client",
    "src",
    "components",
    "taproot-tiptap",
    "component-templates",
    "registry.ts",
  );
  const registered = [...registry.matchAll(/^\s+type: "([a-z0-9-]+)",$/gmu)].map((match) => match[1]);
  assert.deepEqual(registered.sort(), [...COMPONENT_TYPES].sort());
});
