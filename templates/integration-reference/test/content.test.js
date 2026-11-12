import { assertTimeCloseTo } from "../test-support/timing.js";
import assert from "node:assert/strict";
import test from "node:test";

import { idempotencyKey, placementFragment, referenceDocument, referenceMedia, referencePage } from "../src/content.js";

test("reference content is deterministic and placement configuration cannot become markup", () => {
  assert.match(referencePage().path, /^[a-z0-9-]+(?:\/[a-z0-9-]+)*$/u, "Managed paths must be canonical without boundary slashes");
  const page = referencePage();
  assert.notEqual(page.path.split("/")[0], "integrations", "The immutable data namespace cannot contain managed HTML pages");
  assert.equal(page.structuredData.map(JSON.parse).filter(node => node["@id"] === page.primaryStructuredDataId).length, 1, "Managed pages require exactly one primary structured-data node");
  const media = referenceMedia();
  assert.equal(media.bytes.readUInt32BE(16), media.width);
  assert.equal(media.bytes.readUInt32BE(20), media.height);
  assert(media.width >= 5 && media.height >= 5, "Media must satisfy the public upload dimensions");
  const actualWithTimingFields1 = JSON.parse(referenceDocument().json).entries;
  assert.deepEqual(actualWithTimingFields1, [
    { id: "welcome", startsAt: actualWithTimingFields1[0]["startsAt"], label: "Welcome session" },
  ]);
  assertTimeCloseTo(Date.parse(actualWithTimingFields1[0]["startsAt"]), Date.parse("2026-01-01T09:00:00Z"));
  assert.match(placementFragment({ location: "<img src=x onerror=alert(1)>", showCapacity: true }), /&lt;img/u);
  assert.doesNotMatch(placementFragment({ location: "<img src=x onerror=alert(1)>" }), /<img/u);
  assert.equal(idempotencyKey("delivery-a", "page"), idempotencyKey("delivery-a", "page"));
});
