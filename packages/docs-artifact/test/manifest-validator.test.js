import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { LIMITS } from "../src/constants.js";
import { canonicalJson, preflightManifestObject } from "../src/json.js";
import { serializeManifest, validateManifest } from "../src/manifest-validator.js";

const fixtureUrl = new URL("../fixtures/valid/minimal/taproot-docs-manifest.json", import.meta.url);

async function minimalManifest() {
  return JSON.parse(await readFile(fixtureUrl, "utf8"));
}

function setOnlyLocale(manifest, locale) {
  manifest.defaultLocale = locale;
  manifest.locales[0].tag = locale;
  manifest.resources[0].variants[0].locale = locale;
  manifest.navigation[0].locale = locale;
}

function changingSchemaVersion(manifest) {
  let reads = 0;
  Object.defineProperty(manifest, "schemaVersion", {
    enumerable: true,
    get() {
      reads += 1;
      return reads;
    },
  });
  return { input: manifest, reads: () => reads };
}

function singleReadProxy(manifest) {
  const reads = new Map();
  return {
    input: new Proxy(manifest, {
      get(target, key, receiver) {
        if (typeof key === "string") {
          const count = (reads.get(key) ?? 0) + 1;
          reads.set(key, count);
          if (count > 1) throw new Error(`Property '${key}' was read more than once.`);
        }
        return Reflect.get(target, key, receiver);
      },
    }),
    reads,
  };
}

function expandedManifest(template, resourceCount) {
  const manifest = structuredClone(template);
  manifest.resources = Array.from({ length: resourceCount }, (_, index) => {
    const resource = structuredClone(template.resources[0]);
    const suffix = String(index).padStart(5, "0");
    resource.key = `guide:item-${suffix}`;
    const variant = resource.variants[0];
    variant.route = `/item-${suffix}/`;
    variant.title = `Item ${suffix}`;
    variant.description = "";
    variant.source.path = `guides/item-${suffix}.md`;
    variant.fragments[0].path = `taproot-docs/fragments/item-${suffix}.html`;
    return resource;
  });
  manifest.navigation[0].items = [{
    label: manifest.resources[0].variants[0].title,
    resourceKey: manifest.resources[0].key,
  }];
  return manifest;
}

function canonicalBytes(value) {
  return new TextEncoder().encode(canonicalJson(value)).byteLength;
}

function navigationChain(depth) {
  let node = { label: `Level ${depth}`, resourceKey: "guide:welcome" };
  for (let level = depth - 1; level >= 1; level -= 1) {
    node = { label: `Level ${level}`, children: [node] };
  }
  return [node];
}

function exactMaximumManifest(template) {
  let low = 1;
  let high = LIMITS.resources;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (canonicalBytes(expandedManifest(template, middle)) <= LIMITS.manifestBytes) low = middle;
    else high = middle - 1;
  }
  const manifest = expandedManifest(template, low);
  let remaining = LIMITS.manifestBytes - canonicalBytes(manifest);
  for (const resource of manifest.resources) {
    const addition = Math.min(remaining, LIMITS.description);
    resource.variants[0].description = "x".repeat(addition);
    remaining -= addition;
    if (remaining === 0) break;
  }
  assert.equal(remaining, 0, "fixture must have enough bounded strings to reach the exact byte ceiling");
  return manifest;
}

test("resource identity remains valid when its route changes", async () => {
  const manifest = await minimalManifest();
  const stableKey = manifest.resources[0].key;
  manifest.resources[0].variants[0].route = "/moved/welcome/";

  const result = validateManifest(manifest);

  assert.equal(result.ok, true);
  assert.equal(result.value.resources[0].key, stableKey);
});

test("canonical serialization does not depend on JSON object insertion order", async () => {
  const manifest = await minimalManifest();
  const reversedRoot = Object.fromEntries(Object.entries(manifest).reverse());

  assert.equal(serializeManifest(manifest), serializeManifest(reversedRoot));
});

test("object manifest APIs use one materialized JSON snapshot", async () => {
  const changingValidation = changingSchemaVersion(await minimalManifest());
  const validation = validateManifest(changingValidation.input);
  assert.equal(validation.ok, true);
  assert.equal(changingValidation.reads(), 1);
  assert.equal(validation.value.schemaVersion, 1);
  assert.equal(Object.getPrototypeOf(validation.value), null);
  assert.equal(Object.getPrototypeOf(validation.value.source), null);

  const changingSerialization = changingSchemaVersion(await minimalManifest());
  const serialized = serializeManifest(changingSerialization.input);
  assert.equal(changingSerialization.reads(), 1);
  assert.equal(JSON.parse(serialized).schemaVersion, 1);

  const proxiedValidation = singleReadProxy(await minimalManifest());
  const proxyResult = validateManifest(proxiedValidation.input);
  assert.equal(proxyResult.ok, true);
  assert.equal(proxiedValidation.reads.get("schemaVersion"), 1);
  assert.ok([...proxiedValidation.reads.values()].every((count) => count === 1));

  const proxiedSerialization = singleReadProxy(await minimalManifest());
  assert.equal(JSON.parse(serializeManifest(proxiedSerialization.input)).schemaVersion, 1);
  assert.equal(proxiedSerialization.reads.get("schemaVersion"), 1);
  assert.ok([...proxiedSerialization.reads.values()].every((count) => count === 1));
});

test("manifest bytes are bounded identically for objects, bytes, and canonical serialization", async () => {
  const exact = exactMaximumManifest(await minimalManifest());
  const serialized = serializeManifest(exact);
  const bytes = new TextEncoder().encode(serialized);

  assert.equal(bytes.byteLength, LIMITS.manifestBytes);
  assert.equal(validateManifest(exact).ok, true);
  assert.equal(validateManifest(bytes).ok, true);
  const oversizedBytes = new Uint8Array(bytes.byteLength + 1);
  oversizedBytes.set(bytes);
  oversizedBytes[bytes.byteLength] = 0x20;
  assert.equal(validateManifest(oversizedBytes).errors[0].code, "manifest.too_large");

  const oversized = structuredClone(exact);
  const expandable = oversized.resources.find((resource) => resource.variants[0].description.length < LIMITS.description);
  expandable.variants[0].description += "x";
  const objectResult = validateManifest(oversized);
  assert.equal(objectResult.ok, false);
  assert.deepEqual(objectResult.errors.map((error) => error.code), ["manifest.too_large"]);
  assert.throws(
    () => serializeManifest(oversized),
    (error) => error.errors.some((item) => item.code === "manifest.too_large"),
  );
});

test("Uint8Array manifest snapshots ignore shadowed byteLength and caller iterators", async () => {
  const source = await readFile(fixtureUrl);
  const hostile = new Uint8Array(LIMITS.manifestBytes + 1);
  hostile.fill(0x20);
  hostile.set(source);
  let iteratorCalls = 0;
  Object.defineProperty(hostile, "byteLength", { value: source.byteLength });
  Object.defineProperty(hostile, Symbol.iterator, {
    value: function* hostileIterator() {
      iteratorCalls += 1;
      yield* source;
    },
  });
  assert.ok(canonicalBytes(JSON.parse(source.toString("utf8"))) < LIMITS.manifestBytes);

  const result = validateManifest(hostile);

  assert.equal(result.ok, false);
  assert.deepEqual(result.errors.map((error) => error.code), ["manifest.too_large"]);
  assert.equal(iteratorCalls, 0);
});

test("ArrayBuffer manifest bounds use the intrinsic byte length before allocating a snapshot", async () => {
  const source = await readFile(fixtureUrl);
  const hostile = new ArrayBuffer(LIMITS.manifestBytes + 1);
  const bytes = new Uint8Array(hostile);
  bytes.fill(0x20);
  bytes.set(source);
  Object.defineProperty(hostile, "byteLength", { value: source.byteLength });

  const result = validateManifest(hostile);

  assert.equal(result.ok, false);
  assert.deepEqual(result.errors.map((error) => error.code), ["manifest.too_large"]);
});

test("detached and shared manifest buffers fail closed", () => {
  const detachedBuffer = new ArrayBuffer(1);
  const detachedView = new Uint8Array(detachedBuffer);
  structuredClone(detachedBuffer, { transfer: [detachedBuffer] });
  for (const input of [detachedBuffer, detachedView]) {
    const result = validateManifest(input);
    assert.equal(result.ok, false);
    assert.deepEqual(result.errors.map((error) => error.code), ["json.invalid_input"]);
  }

  if (typeof SharedArrayBuffer !== "undefined") {
    const sharedBuffer = new SharedArrayBuffer(1);
    for (const input of [sharedBuffer, new Uint8Array(sharedBuffer)]) {
      const result = validateManifest(input);
      assert.equal(result.ok, false);
      assert.deepEqual(result.errors.map((error) => error.code), ["json.invalid_input"]);
    }
  }
});

test("manifest input classification sanitizes hostile prototype traps without reading constructors", async () => {
  const trapped = new Proxy({}, {
    getPrototypeOf() {
      throw new Error("prototype trap must not escape");
    },
  });
  const trappedResult = validateManifest(trapped);
  assert.equal(trappedResult.ok, false);
  assert.deepEqual(trappedResult.errors.map((error) => error.code), ["json.invalid_input"]);

  const manifest = await minimalManifest();
  Object.defineProperty(manifest, "constructor", {
    configurable: true,
    get() {
      throw new Error("own constructor must not be read");
    },
  });
  const hostilePrototype = Object.create(null);
  Object.defineProperty(hostilePrototype, "constructor", {
    get() {
      throw new Error("prototype constructor must not be read");
    },
  });
  const proxied = new Proxy(manifest, {
    getPrototypeOf() {
      return hostilePrototype;
    },
  });

  assert.equal(validateManifest(proxied).ok, true);
});

test("asset descriptors enforce the decoded-pixel product at runtime and document it in the schema", async () => {
  const manifest = await minimalManifest();
  manifest.assets = [{
    key: "image:large",
    path: "taproot-docs/assets/large.png",
    mediaType: "image/png",
    bytes: 1,
    sha256: `sha256:${"0".repeat(64)}`,
    width: 8_193,
    height: 8_192,
  }];

  const result = validateManifest(manifest);

  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.code === "asset.decoded_pixels"));
  assert.throws(
    () => serializeManifest(manifest),
    (error) => error.errors.some((item) => item.code === "asset.decoded_pixels"),
  );

  const schema = JSON.parse(await readFile(new URL("../schema/taproot-docs-manifest.schema.json", import.meta.url), "utf8"));
  assert.match(schema.$defs.route.$comment, /complete first-segment subtrees/u);
  assert.match(schema.$defs.route.$comment, /Windows device-name aliases/u);
  assert.equal(schema.$defs.asset.properties.width.maximum, 32_768);
  assert.equal(schema.$defs.asset.properties.height.maximum, 32_768);
  assert.match(schema.$defs.asset.$comment, /width \* height <= 67108864/u);
  assert.match(schema.$defs.asset.$comment, /sum of animated frame rectangle areas <= 67108864/u);
});

test("canonical serialization rejects strings that strict JSON cannot round-trip", async () => {
  const manifest = await minimalManifest();
  manifest.resources[0].variants[0].title = "Invalid \ud800 title";

  const objectResult = validateManifest(manifest);
  const jsonResult = validateManifest(JSON.stringify(manifest));

  assert.equal(objectResult.ok, false);
  assert.ok(objectResult.errors.some((error) => error.code === "string.invalid_unicode"));
  assert.equal(jsonResult.ok, false);
  assert.deepEqual(jsonResult.errors.map((error) => error.code), ["json.invalid_unicode"]);
  assert.throws(
    () => serializeManifest(manifest),
    (error) => error.errors.some((item) => item.code === "string.invalid_unicode"),
  );
});

test("raw manifest string input rejects ill-formed Unicode before UTF-8 encoding", async () => {
  const source = await readFile(fixtureUrl, "utf8");
  const result = validateManifest(source.replace('"Welcome"', '"Welcome\ud800"'));

  assert.equal(result.ok, false);
  assert.deepEqual(result.errors.map((error) => error.code), ["json.invalid_unicode"]);
});

test("raw manifest strings enforce UTF-16 and exact UTF-8 bounds before allocation", () => {
  const oversizedUtf16 = `${"x".repeat(LIMITS.manifestBytes + 1)}\ud800`;
  const utf16Result = validateManifest(oversizedUtf16);
  assert.equal(utf16Result.ok, false);
  assert.deepEqual(utf16Result.errors.map((error) => error.code), ["manifest.too_large"]);

  const oversizedUtf8 = "\u0800".repeat(Math.floor(LIMITS.manifestBytes / 3) + 1);
  assert.ok(oversizedUtf8.length <= LIMITS.manifestBytes);
  const utf8Result = validateManifest(oversizedUtf8);
  assert.equal(utf8Result.ok, false);
  assert.deepEqual(utf8Result.errors.map((error) => error.code), ["manifest.too_large"]);
});

test("object manifest preflight rejects cycles before schema traversal", async () => {
  const manifest = await minimalManifest();
  manifest.cycle = manifest;

  const result = validateManifest(manifest);

  assert.equal(result.ok, false);
  assert.deepEqual(result.errors.map((error) => error.code), ["manifest.cyclic"]);
});

test("object manifest preflight accounts for shared output without retraversing shared objects", async () => {
  const manifest = await minimalManifest();
  let reads = 0;
  const shared = {};
  Object.defineProperty(shared, "payload", {
    enumerable: true,
    get() {
      reads += 1;
      return "x".repeat(100_000);
    },
  });
  manifest.shared = Array.from({ length: 30 }, () => shared);

  const result = preflightManifestObject(manifest);

  assert.equal(result.ok, true);
  assert.equal(result.exceedsByteLimit, true);
  assert.equal(reads, 1);
});

test("object manifest preflight charges nested shared fan-out before schema traversal", async () => {
  const manifest = await minimalManifest();
  const template = manifest.resources[0];
  const sharedVariants = Array.from({ length: LIMITS.variants }, () => null);
  manifest.resources = Array.from({ length: LIMITS.resources }, (_, index) => ({
    key: `guide:fan-out-${String(index).padStart(5, "0")}`,
    semantic: template.semantic,
    variants: sharedVariants,
  }));

  const result = validateManifest(manifest);

  assert.equal(result.ok, false);
  assert.deepEqual(result.errors.map((error) => error.code), ["manifest.too_large"]);
  assert.match(result.errors[0].message, /validation work/u);
});

test("object manifest preflight applies cached subtree depth at every occurrence", async () => {
  const manifest = await minimalManifest();
  const shared = { child: { leaf: {} } };
  manifest.shallow = shared;
  manifest.deep = {};
  let current = manifest.deep;
  for (let depth = 0; depth < 61; depth += 1) {
    current.next = {};
    current = current.next;
  }
  current.reuse = shared;

  const result = validateManifest(manifest);

  assert.equal(result.ok, false);
  assert.deepEqual(result.errors.map((error) => error.code), ["manifest.object_too_deep"]);
});

test("object manifest preflight bounds traversal work independently of serialized bytes", async () => {
  const manifest = await minimalManifest();
  manifest.work = Array.from({ length: LIMITS.manifestObjectWork }, () => null);

  const result = validateManifest(manifest);

  assert.equal(result.ok, false);
  assert.deepEqual(result.errors.map((error) => error.code), ["manifest.too_large"]);
  assert.match(result.errors[0].message, /validation work/u);
});

test("object manifest preflight bounds nesting before recursive schema validation", async () => {
  const manifest = await minimalManifest();
  let current = manifest;
  for (let depth = 0; depth <= LIMITS.manifestObjectDepth; depth += 1) {
    current.deep = {};
    current = current.deep;
  }

  const result = validateManifest(manifest);

  assert.equal(result.ok, false);
  assert.deepEqual(result.errors.map((error) => error.code), ["manifest.object_too_deep"]);
});

test("string bounds count Unicode scalar values like JSON Schema maxLength", async () => {
  const validManifest = await minimalManifest();
  validManifest.resources[0].variants[0].title = "😀".repeat(LIMITS.title);
  assert.equal(validateManifest(validManifest).ok, true);

  const invalidManifest = await minimalManifest();
  invalidManifest.resources[0].variants[0].title = "😀".repeat(LIMITS.title + 1);
  const result = validateManifest(invalidManifest);

  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => (
    error.code === "string.length"
    && error.path === "$.resources[0].variants[0].title"
  )));
});

test("manifest strings reject C1 and bidirectional formatting controls with one stable diagnostic", async () => {
  for (const character of ["\u0085", "\u061c", "\u202e", "\u2067"]) {
    const manifest = await minimalManifest();
    manifest.resources[0].variants[0].title = `Unsafe${character}title`;

    const result = validateManifest(manifest);

    assert.equal(result.ok, false);
    assert.deepEqual(result.errors.map(({ code, path }) => ({ code, path })), [{
      code: "string.control",
      path: "$.resources[0].variants[0].title",
    }]);
  }
});

test("runtime and JSON Schema share the pinned Docs v1 locale subset", async () => {
  const schema = JSON.parse(await readFile(new URL("../schema/taproot-docs-manifest.schema.json", import.meta.url), "utf8"));
  const schemaPattern = new RegExp(schema.$defs.locale.pattern, "u");
  const cases = [
    ["en", true, undefined],
    ["en-US", true, undefined],
    ["fr-FR", true, undefined],
    ["zxx", true, undefined],
    ["zh-Hant", true, undefined],
    ["es-419", true, undefined],
    ["abc-Latn-419", true, undefined],
    ["e", false, "locale.invalid"],
    ["abcd", false, "locale.invalid"],
    ["en-us", false, "locale.not_canonical"],
    ["EN-US", false, "locale.not_canonical"],
    ["de-1901", false, "locale.invalid"],
    ["en_Latn_US", false, "locale.invalid"],
  ];

  for (const [locale, valid, expectedCode] of cases) {
    const manifest = await minimalManifest();
    setOnlyLocale(manifest, locale);
    const result = validateManifest(manifest);

    assert.equal(result.ok, valid, locale);
    assert.equal(schemaPattern.test(locale), valid, `schema: ${locale}`);
    if (!valid) assert.ok(result.errors.every((error) => error.code === expectedCode), locale);
  }
  assert.equal(schema.$defs.locale.maxLength, "abc-Latn-419".length);
});

test("runtime URL checks preserve the schema's literal lowercase HTTPS prefix", async () => {
  for (const field of ["repository", "source-location"]) {
    const manifest = await minimalManifest();
    if (field === "repository") {
      manifest.source.repositoryUrl = manifest.source.repositoryUrl.replace("https://", "HTTPS://");
    } else {
      const source = manifest.resources[0].variants[0].source;
      source.url = source.url.replace("https://", "HTTPS://");
    }

    const result = validateManifest(manifest);

    assert.equal(result.ok, false);
    assert.ok(result.errors.some((error) => error.code === "url.unsafe"));
  }
});

test("runtime and fragment/asset schemas reject Windows device-name path segments", async () => {
  const fragmentManifest = await minimalManifest();
  fragmentManifest.resources[0].variants[0].fragments[0].path = "taproot-docs/fragments/nested/nul.html";
  const fragmentResult = validateManifest(fragmentManifest);
  assert.equal(fragmentResult.ok, false);
  assert.ok(fragmentResult.errors.some((error) => error.code === "path.device_name"));

  const assetManifest = await minimalManifest();
  assetManifest.assets = [{
    key: "image:device",
    path: "taproot-docs/assets/nested/com1.png",
    mediaType: "image/png",
    bytes: 1,
    sha256: `sha256:${"0".repeat(64)}`,
    width: 1,
    height: 1,
  }];
  const assetResult = validateManifest(assetManifest);
  assert.equal(assetResult.ok, false);
  assert.ok(assetResult.errors.some((error) => error.code === "path.device_name"));

  const schema = JSON.parse(await readFile(new URL("../schema/taproot-docs-manifest.schema.json", import.meta.url), "utf8"));
  const fragmentPattern = new RegExp(schema.$defs.fragment.properties.path.pattern);
  const assetPattern = new RegExp(schema.$defs.asset.properties.path.pattern);
  assert.equal(fragmentPattern.test("taproot-docs/fragments/nested/prn.html"), false);
  assert.equal(assetPattern.test("taproot-docs/assets/lpt1/image.png"), false);
  assert.equal(fragmentPattern.test("taproot-docs/fragments/nested/print.html"), true);
  assert.equal(assetPattern.test("taproot-docs/assets/lpt10/image.png"), true);
});

test("runtime and JSON Schema enforce SemVer 2.0 prerelease numeric identifiers", async () => {
  const schema = JSON.parse(await readFile(new URL("../schema/taproot-docs-manifest.schema.json", import.meta.url), "utf8"));
  const schemaPattern = new RegExp(schema.properties.build.properties.producerVersion.pattern);
  const cases = [
    ["1.0.0-0", true],
    ["1.0.0-alpha.1", true],
    ["1.0.0-01a", true],
    ["1.0.0+001", true],
    ["1.0.0-01", false],
    ["1.0.0-alpha.01", false],
  ];
  for (const [version, valid] of cases) {
    const manifest = await minimalManifest();
    manifest.build.producerVersion = version;
    assert.equal(validateManifest(manifest).ok, valid, version);
    assert.equal(schemaPattern.test(version), valid, `schema: ${version}`);
  }
});

test("strict JSON diagnostics neutralize hostile object keys", () => {
  const result = validateManifest('{"bad\\u202e\\n":1,"bad\\u202e\\n":2}');

  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, "json.duplicate_key");
  assert.ok(!/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(result.errors[0].path));
  assert.match(result.errors[0].path, /\\u202e/);
  assert.match(result.errors[0].path, /\\u000a/);
});

test("unknown optional capabilities remain ignorable while schema fields stay closed", async () => {
  const manifest = await minimalManifest();
  manifest.capabilities.optional = ["example.future.optional.v1"];
  assert.equal(validateManifest(manifest).ok, true);

  manifest.resources[0].futurePayload = {};
  const result = validateManifest(manifest);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.code === "property.unsupported"));
});

test("supported-capability options reject oversized, malformed, and non-string values generically", async () => {
  const sensitiveMessage = "do not inspect hostile capability values";
  const hostile = Object.create(null);
  Object.defineProperty(hostile, "toString", {
    get() {
      throw new Error(sensitiveMessage);
    },
  });
  const values = ["a".repeat(LIMITS.resourceKey + 1), "Taproot Docs", hostile];
  for (const value of values) {
    const result = validateManifest(await minimalManifest(), { supportedCapabilities: [value] });
    assert.equal(result.ok, false);
    assert.deepEqual(result.errors, [{
      code: "capability.invalid_value",
      path: "$options.supportedCapabilities",
      message: `Supported capabilities must be canonical strings of at most ${LIMITS.resourceKey} characters.`,
    }]);
    assert.ok(result.errors.every((error) => !error.message.includes(sensitiveMessage)));
  }
});

test("a scalar supported-capabilities string cannot satisfy a required one-character capability", async () => {
  const manifest = await minimalManifest();
  manifest.capabilities.required.push("a");
  manifest.capabilities.required.sort();

  const result = validateManifest(manifest, { supportedCapabilities: "a" });

  assert.equal(result.ok, false);
  assert.deepEqual(result.errors, [{
    code: "capability.invalid_iterable",
    path: "$options.supportedCapabilities",
    message: "Could not enumerate supported capabilities safely.",
  }]);
});

test("validation diagnostics are deterministically ordered", async () => {
  const manifest = await minimalManifest();
  manifest.resources[0].variants[0].route = "/api/";
  manifest.resources[0].variants[0].fragments[0].path = "../escape.html";

  const first = validateManifest(manifest);
  const second = validateManifest(manifest);

  assert.equal(first.ok, false);
  assert.deepEqual(first, second);
});

test("declared byte and collection bounds fail closed", async () => {
  const manifest = await minimalManifest();
  manifest.resources[0].variants[0].fragments[0].bytes = LIMITS.fragmentBytes + 1;
  manifest.resources[0].variants[0].headings = Array.from(
    { length: LIMITS.headingsPerVariant + 1 },
    (_, index) => ({ id: `section-${index}`, text: `Section ${index}`, level: 2 }),
  );

  const result = validateManifest(manifest);

  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.code === "number.range"));
  assert.ok(result.errors.some((error) => error.code === "array.length"));
});

test("navigation node limit is global across valid nested arrays", async () => {
  const manifest = await minimalManifest();
  const template = manifest.resources[0];
  const nodesPerResource = 10;
  const resourceCount = Math.ceil((LIMITS.navigationNodes + 1) / nodesPerResource);
  manifest.resources = Array.from({ length: resourceCount }, (_, index) => {
    const resource = structuredClone(template);
    const suffix = String(index).padStart(5, "0");
    resource.key = `guide:item-${suffix}`;
    resource.variants[0].route = `/item-${suffix}/`;
    resource.variants[0].title = `Item ${suffix}`;
    resource.variants[0].source.path = `guides/item-${suffix}.md`;
    resource.variants[0].fragments[0].path = `taproot-docs/fragments/item-${suffix}.html`;
    return resource;
  });
  manifest.navigation[0].items = manifest.resources.map((resource, index) => {
    let node = { label: resource.variants[0].title, resourceKey: resource.key };
    const remainingNodes = LIMITS.navigationNodes + 1 - (resourceCount - 1) * nodesPerResource;
    const depth = index === manifest.resources.length - 1 ? remainingNodes : nodesPerResource;
    for (let level = 1; level < depth; level += 1) {
      node = { label: `Section ${index}-${level}`, children: [node] };
    }
    return node;
  });

  const result = validateManifest(manifest);

  assert.equal(result.ok, false);
  assert.deepEqual(
    result.errors.map(({ code, path }) => ({ code, path })),
    [{ code: "limit.navigation_nodes", path: "$.navigation" }],
  );
});

test("navigation depth accepts the exact ceiling and rejects the next level", async () => {
  const boundary = await minimalManifest();
  boundary.navigation[0].items = navigationChain(LIMITS.navigationDepth);
  assert.equal(validateManifest(boundary).ok, true);

  const excessive = await minimalManifest();
  excessive.navigation[0].items = navigationChain(LIMITS.navigationDepth + 1);
  const result = validateManifest(excessive);
  assert.equal(result.ok, false);
  assert.deepEqual(
    result.errors.map(({ code }) => code),
    ["navigation.too_deep"],
  );

  const empty = await minimalManifest();
  empty.navigation[0].items = [{ label: "Empty" }];
  const emptyResult = validateManifest(empty);
  assert.equal(emptyResult.ok, false);
  assert.ok(emptyResult.errors.some((error) => error.code === "navigation.empty_node"));

  const schema = JSON.parse(await readFile(new URL("../schema/taproot-docs-manifest.schema.json", import.meta.url), "utf8"));
  assert.match(schema.$defs.navigationNode.$comment, /accepts leaves through level 12/u);
});
