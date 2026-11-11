import assert from "node:assert/strict";
import test from "node:test";
import { markdownToProseMirror } from "../../src/content/markdown.js";
import { validateDocument } from "../../src/content/validate-document.js";
import { normalizeColumnsBody } from "../../src/content/free-form-columns.js";

const convert = async source => (await markdownToProseMirror(source, {
  resolveImage: async () => ({ imageId: "3f1c2b4a-5d6e-4f70-8a91-b2c3d4e5f607", width: 1200, height: 800, alt: "Garden" }),
})).doc;
const region = text => `:::column {}\n${text}\n:::endcolumn`;
const layout = (attrs = {}, regions = ["First", "Second"]) => `:::section {}\n:::columns ${JSON.stringify(attrs)}\n${regions.map(region).join("\n")}\n:::endcolumns\n:::`;

for (const [count, ratio] of [[2, "equal"], [2, "40-60"], [2, "60-40"], [3, "equal"]]) {
  test(`Markdown preserves ${count} columns with ${ratio} widths and omits defaults`, async () => {
    const document = await convert(layout({ count, ratio }, Array.from({ length: count }, (_, i) => `Region ${i + 1}`)));
    assert.deepEqual(validateDocument(document).errors, []);
    const row = document.content[0].content[0];
    assert.equal(row.type, "columns");
    assert.equal(row.content.length, count);
    assert.deepEqual(row.attrs, count === 2 && ratio === "equal" ? undefined : { ...(count === 3 ? { count } : {}), ...(ratio !== "equal" ? { ratio } : {}) });
    assert.deepEqual(normalizeColumnsBody(document).body, document);
  });
}

test("a region uses ordinary image, table, inline-facts and component parsers", async () => {
  const document = await convert(layout({}, [
    "![Garden](media/garden.webp)\n\n| Name | Value |\n| --- | --- |\n| Garden | Green |",
    '```inline-facts\n[{"value":"Open daily"}]\n```\n\n```component:form\n{"formKey":"contact"}\n```',
  ]));
  assert.deepEqual(validateDocument(document).errors, []);
  const [first, second] = document.content[0].content[0].content;
  assert.deepEqual(first.content.map(node => node.type), ["taprootImage", "table"]);
  assert.deepEqual(second.content.map(node => node.type), ["inlineFacts", "componentBlock"]);
});

for (const fence of ["```", "~~~~"]) {
  test(`${fence} code keeps all structural markers literal`, async () => {
    const document = await convert(layout({}, [`${fence}text\n:::columns {}\n:::column {}\n:::endcolumn\n:::endcolumns\n:::\n${fence}`, "Other"]));
    const code = document.content[0].content[0].content[0].content[0];
    assert.equal(code.type, "codeBlock");
    assert.match(code.content[0].text, /:::endcolumns/);
  });
}

for (const marker of [":::columns {}", ":::column {}", ":::endcolumn", ":::endcolumns", ":::section {}", ":::"]) {
  test(`escaped ${marker} remains ordinary text`, async () => {
    const document = await convert(layout({}, [`Before\n\\${marker}\nAfter`, "Other"]));
    const paragraph = document.content[0].content[0].content[0].content[0];
    assert.equal(paragraph.type, "paragraph");
    assert.match(paragraph.content.map(node => node.text ?? "").join(""), new RegExp(marker.replace(/[{}]/gu, "\\$&")));
  });
}

for (const prose of [":::columnsfoo", ":::columnar", ":::endcolumnx", ":::sectional"]) {
  test(`${prose} is prefix prose`, async () => {
    const document = await convert(layout({}, [prose, "Other"]));
    assert.equal(document.content[0].content[0].content[0].content[0].content[0].text, prose);
  });
}

const malformed = [
  ["root layout", ':::columns {}\n:::column {}\nFirst\n:::endcolumn\n:::endcolumns'],
  ["missing region", layout({}, ["First"])],
  ["extra region", layout({}, ["First", "Second", "Third"])],
  ["empty region", layout({}, ["", "Second"])],
  ["unequal three", layout({ count: 3, ratio: "40-60" }, ["One", "Two", "Three"])],
  ["unknown option", layout({ gap: "large" })],
  ["region option", layout().replace(":::column {}", ':::column {"width":1}')],
  ["indented header", layout().replace(":::columns {}", " :::columns {}")],
  ["trailing text", layout().replace(":::columns {}", ":::columns {} extra")],
  ["missing endcolumn", layout().replace(":::endcolumn", "")],
  ["missing endcolumns", layout().replace(":::endcolumns", "")],
  ["nested row", layout({}, [":::columns {}", "Other"])],
  ["nested section", layout({}, [":::section {}", "Other"])],
  ["list row", layout({}, ["- List\n  :::columns {}", "Other"])],
  ["quote row", layout({}, ["> :::columns {}", "Other"])],
];
for (const [name, source] of malformed) {
  test(`refuses ${name} with a structural location`, async () => {
    await assert.rejects(convert(source), error => error.code === "content.markdown_columns" || error.code === "content.markdown_section_nested");
  });
}
