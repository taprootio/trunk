import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  MANAGED_ARCHIVE_FORMAT,
  MANAGED_MANIFEST_FILE_NAME,
  validateManagedManifest,
  validateManifest,
} from "../src/index.js";
import {
  normalizePrebuiltArtifactPath,
  normalizePrebuiltRedirectRoute,
  PREBUILT_ARCHIVE_FORMAT,
  PREBUILT_LIMITS,
  PREBUILT_MANIFEST_FILE_NAME,
  prebuiltFileRoute,
  serializePrebuiltManifest,
  validatePrebuiltManifest,
} from "../src/prebuilt.js";

const fixtureUrl = new URL("../fixtures/prebuilt/valid/espalier/taproot-docs-prebuilt-manifest.json", import.meta.url);
const managedFixtureUrl = new URL("../fixtures/valid/minimal/taproot-docs-manifest.json", import.meta.url);

async function fixture() {
  return JSON.parse(await readFile(fixtureUrl, "utf8"));
}

test("prebuilt manifest validates the closed byte-preserving contract", async () => {
  const manifest = await fixture();
  const result = validatePrebuiltManifest(manifest);

  assert.equal(result.ok, true);
  assert.equal(result.value.mode, "prebuilt");
  assert.equal(result.value.notFoundFile, "404.html");
  assert.equal(PREBUILT_MANIFEST_FILE_NAME, "taproot-docs-prebuilt-manifest.json");
  assert.equal(PREBUILT_ARCHIVE_FORMAT, "taproot-docs-prebuilt-tar-gzip-v1");
  assert.deepEqual(
    result.value.resources.map(({ key, file }) => ({ key, file })),
    [
      { key: "api:show-toast", file: "api/show-toast/index.html" },
      { key: "guide:getting-started", file: "guides/index.html" },
      { key: "home", file: "index.html" },
    ],
  );
});

test("managed and prebuilt schema v1 remain distinct explicit contracts", async () => {
  const managed = JSON.parse(await readFile(managedFixtureUrl, "utf8"));
  const prebuilt = await fixture();

  assert.equal(validateManifest(managed).ok, true);
  assert.equal(validateManagedManifest(managed).ok, true);
  assert.equal(MANAGED_MANIFEST_FILE_NAME, "taproot-docs-manifest.json");
  assert.equal(MANAGED_ARCHIVE_FORMAT, "taproot-docs-tar-gzip-v1");
  assert.equal(validatePrebuiltManifest(managed).ok, false);
  assert.equal(validateManifest(prebuilt).ok, false);
  assert.equal(validatePrebuiltManifest(prebuilt).ok, true);
});

test("prebuilt canonical serialization is deterministic without changing array order", async () => {
  const manifest = await fixture();
  const first = serializePrebuiltManifest(manifest);
  const second = serializePrebuiltManifest(JSON.parse(first));

  assert.equal(first, second);
  assert.equal(first.endsWith("\n"), true);
  assert.deepEqual(JSON.parse(first).files.map((file) => file.path), manifest.files.map((file) => file.path));
});

test("prebuilt limits reject oversized public collections before unbounded validation", async (testContext) => {
  await testContext.test("files", async () => {
    const manifest = await fixture();
    manifest.files = Array.from({ length: PREBUILT_LIMITS.files + 1 }, () => manifest.files[0]);
    const result = validatePrebuiltManifest(manifest);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((error) => error.code === "array.length" && error.path === "$.files"));
  });

  await testContext.test("resources", async () => {
    const manifest = await fixture();
    manifest.resources = Array.from({ length: PREBUILT_LIMITS.resources + 1 }, () => manifest.resources[0]);
    const result = validatePrebuiltManifest(manifest);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((error) => error.code === "array.length" && error.path === "$.resources"));
  });

  await testContext.test("redirects", async () => {
    const manifest = await fixture();
    manifest.redirects = Array.from({ length: PREBUILT_LIMITS.redirects + 1 }, () => manifest.redirects[0]);
    const result = validatePrebuiltManifest(manifest);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((error) => error.code === "array.length" && error.path === "$.redirects"));
  });
});

test("prebuilt closed objects reject publisher response policy", async () => {
  const manifest = await fixture();
  manifest.files[0].headers = { "cache-control": "public, max-age=31536000" };
  manifest.csp = "default-src *";

  const result = validatePrebuiltManifest(manifest);

  assert.equal(result.ok, false);
  assert.deepEqual(
    result.errors.filter((error) => error.code === "property.unsupported").map((error) => error.path),
    ["$.csp", "$.files[0].headers"],
  );
});

test("prebuilt paths enforce directory depth, USTAR representation, and exact media types", async (testContext) => {
  await testContext.test("directory depth", async () => {
    const manifest = await fixture();
    manifest.files[1].path = `${"a/".repeat(PREBUILT_LIMITS.directoryDepth + 1)}icons.svg`;
    const result = validatePrebuiltManifest(manifest);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((error) => error.code === "limit.directory_depth"));
  });

  await testContext.test("USTAR fields", async () => {
    const manifest = await fixture();
    manifest.files[1].path = `${"a".repeat(101)}.svg`;
    const result = validatePrebuiltManifest(manifest);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((error) => error.code === "path.ustar"));
  });

  await testContext.test("media type", async () => {
    const manifest = await fixture();
    manifest.files[3].mediaType = "application/octet-stream";
    const result = validatePrebuiltManifest(manifest);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((error) => error.code === "file.media_type"));
  });
});

test("prebuilt paths and JSON Schema accept portable segments beginning with '-' or '_'", async () => {
  const manifest = await fixture();
  const schema = JSON.parse(
    await readFile(
      new URL("../schema/taproot-docs-prebuilt-manifest.schema.json", import.meta.url),
      "utf8",
    ),
  );
  const schemaPath = new RegExp(schema.$defs.path.pattern);

  assert.equal(validatePrebuiltManifest(manifest).ok, true);
  for (const path of ["dist/-6iE9DOe.css", "dist/_AN3XUT_.css"]) {
    assert.ok(manifest.files.some((file) => file.path === path));
    assert.equal(normalizePrebuiltArtifactPath(path).ok, true);
    assert.equal(schemaPath.test(path), true);
  }
  for (const path of [".hidden.css", "trailing-", "trailing_", "trailing."]) {
    assert.equal(normalizePrebuiltArtifactPath(path).ok, false);
    assert.equal(schemaPath.test(path), false);
  }
});

test("prebuilt inventory rejects case-folded aliases in parent-directory spelling", async () => {
  const manifest = await fixture();
  manifest.files.push(
    {
      bytes: 0,
      mediaType: "text/css; charset=utf-8",
      path: "zAlias/a.css",
      sha256: `sha256:${"0".repeat(64)}`,
    },
    {
      bytes: 0,
      mediaType: "text/css; charset=utf-8",
      path: "zalias/b.css",
      sha256: `sha256:${"0".repeat(64)}`,
    },
  );

  const result = validatePrebuiltManifest(manifest);

  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.code === "duplicate.directory_path_casefold"));
});

test("prebuilt routing reserves only the Worker's exact internal control route", async (testContext) => {
  await testContext.test("file route", async () => {
    const manifest = await fixture();
    const descriptor = manifest.files.find((file) => file.path === "api/show-toast/index.html");
    descriptor.path = "__taproot/internal/published-site-routing";
    descriptor.mediaType = "application/octet-stream";
    manifest.resources = manifest.resources.filter((resource) => resource.key !== "api:show-toast");

    const result = validatePrebuiltManifest(manifest);

    assert.equal(result.ok, false);
    assert.ok(result.errors.some((error) => error.code === "route.reserved"));
  });

  await testContext.test("redirect source", async () => {
    const manifest = await fixture();
    manifest.redirects[0].from = "/__taproot/internal/published-site-routing";

    const result = validatePrebuiltManifest(manifest);

    assert.equal(result.ok, false);
    assert.ok(result.errors.some((error) => error.code === "route.reserved"));
  });

  assert.deepEqual(prebuiltFileRoute("api/index.html"), { ok: true, value: "/api/" });
  assert.deepEqual(prebuiltFileRoute("__taproot/assets/index.html"), { ok: true, value: "/__taproot/assets/" });
  assert.deepEqual(
    prebuiltFileRoute("__Taproot/internal/published-site-routing"),
    { ok: true, value: "/__Taproot/internal/published-site-routing" },
  );
  assert.deepEqual(normalizePrebuiltRedirectRoute("/api/"), { ok: true, value: "/api/" });
  assert.deepEqual(normalizePrebuiltRedirectRoute("/__taproot/assets/"), { ok: true, value: "/__taproot/assets/" });
});

test("oversized object manifests return the byte-bound error before options or schema diagnostics", async () => {
  let optionReads = 0;
  const options = Object.create(null, {
    supportedCapabilities: {
      get() {
        optionReads += 1;
        throw new Error("must not be read");
      },
    },
  });

  const result = validatePrebuiltManifest({ padding: "x".repeat(PREBUILT_LIMITS.manifestBytes + 1) }, options);

  assert.equal(optionReads, 0);
  assert.deepEqual(result.errors.map((error) => error.code), ["manifest.too_large"]);
});

test("grossly oversized strings stop after their bounded length diagnostic", async () => {
  const manifest = await fixture();
  manifest.resources[0].title = `${"x".repeat((PREBUILT_LIMITS.title * 2) + 1)}\u0000`;

  const result = validatePrebuiltManifest(manifest);

  assert.equal(result.ok, false);
  assert.deepEqual(
    result.errors.filter((error) => error.path === "$.resources[0].title").map((error) => error.code),
    ["string.length"],
  );
});

test("prebuilt inventory rejects a file that aliases a required directory", async () => {
  const manifest = await fixture();
  manifest.files.splice(1, 0, {
    bytes: 0,
    mediaType: "application/octet-stream",
    path: "assets",
    sha256: `sha256:${"0".repeat(64)}`,
  });

  const result = validatePrebuiltManifest(manifest);

  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.code === "file.path_collision"));
});

test("prebuilt payload paths cannot place descendants beneath the reserved manifest file", async () => {
  for (
    const reservedPath of [
      "taproot-docs-prebuilt-manifest.json/payload.js",
      "TAPROOT-DOCS-PREBUILT-MANIFEST.JSON/payload.js",
    ]
  ) {
    const manifest = await fixture();
    manifest.files[1].path = reservedPath;
    manifest.files[1].mediaType = "text/javascript; charset=utf-8";
    manifest.resources = manifest.resources.filter((resource) => resource.key !== "api:show-toast");

    const result = validatePrebuiltManifest(manifest);

    assert.equal(result.ok, false);
    assert.ok(result.errors.some((error) => error.code === "path.manifest"));
  }
});

test("prebuilt supported capabilities enforce the exported 200-character limit", async () => {
  const manifest = await fixture();
  const result = validatePrebuiltManifest(manifest, {
    supportedCapabilities: [`a${"b".repeat(PREBUILT_LIMITS.resourceKey)}`],
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.errors.map((error) => error.code), ["capability.invalid_value"]);
});

test("oversized prebuilt object preflight never dereferences later properties", () => {
  let laterReads = 0;
  const manifest = {
    padding: "x".repeat(PREBUILT_LIMITS.manifestBytes + 1),
    get later() {
      laterReads += 1;
      throw new Error("must not be read");
    },
  };

  const result = validatePrebuiltManifest(manifest);

  assert.equal(laterReads, 0);
  assert.deepEqual(result.errors.map((error) => error.code), ["manifest.too_large"]);
});
