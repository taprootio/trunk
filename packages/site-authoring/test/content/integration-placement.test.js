import test from "node:test";
import assert from "node:assert/strict";
import { renderProseMirrorDocumentToHtml } from "../../src/content/tiptap-prosemirror.ts";
import { validateDocument } from "../../src/content/validate-document.js";

const attrs = { placementId: "placement", installationId: "installation", componentId: "list", config: '{"secret":"draft"}' };
const document = { type: "doc", content: [{ type: "integrationPlacement", attrs }] };
const selected = { placementId: "placement", installationId: "installation", componentId: "list", status: "ready", fragmentRevision: 1, frozen: false, html: "<p>Published A</p>" };

test("a pulled placement retains its server revision through authoring validation", () => {
  const pulled = { type: "doc", content: [{ type: "integrationPlacement", attrs: {
    ...attrs, placementId: "9d6e41a3-a910-4906-bf61-222d1ae07253", installationId: "b776e693-fc84-4347-af11-bd908b4c552b", configurationRevision: 7,
  } }] };
  assert.deepEqual(validateDocument(pulled).errors, []);
  pulled.content[0].attrs.configurationRevision = -1;
  assert.notDeepEqual(validateDocument(pulled).errors, []);
});

test("integration renderer uses only the exact selected immutable fragment", () => {
  const rendered = renderProseMirrorDocumentToHtml(document, { integrationPlacements: [selected] });
  assert.match(rendered, /<p>Published A<\/p>/u);
  assert.doesNotMatch(rendered, /secret|draft/u);
  assert.equal(renderProseMirrorDocumentToHtml(document, { integrationPlacements: [{ ...selected, installationId: "other" }] }), "");
  assert.equal(renderProseMirrorDocumentToHtml(document, { integrationPlacements: [{ ...selected, componentId: "other" }] }), "");
});

test("missing content is empty in production and frozen emptiness never loads forever", () => {
  assert.equal(renderProseMirrorDocumentToHtml(document), "");
  assert.match(renderProseMirrorDocumentToHtml(document, { integrationPreview: true }), /Save this page/u);
  assert.equal(renderProseMirrorDocumentToHtml(document, { integrationPreview: true, integrationPlacements: [{ ...selected, fragmentRevision: 0, html: "", frozen: true }] }), "");
  assert.match(renderProseMirrorDocumentToHtml(document, { integrationPreview: true, integrationPlacements: [{ ...selected, fragmentRevision: 0, html: "" }] }), /Content pending/u);
});
