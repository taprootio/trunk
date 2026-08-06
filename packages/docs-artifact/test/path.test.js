import assert from "node:assert/strict";
import test from "node:test";
import { LIMITS } from "../src/constants.js";
import { normalizeArtifactPath, normalizeRoute, normalizeSourcePath } from "../src/path.js";

test("artifact path validation rejects traversal and platform aliases", () => {
  for (const value of [
    "../secret",
    "taproot-docs/fragments/../secret.html",
    "taproot-docs\\fragments\\secret.html",
    "/taproot-docs/fragments/secret.html",
    "taproot-docs/fragments/%2e%2e/secret.html",
    "taproot-docs//fragments/secret.html",
    "Taproot-docs/fragments/secret.html",
  ]) {
    assert.equal(normalizeArtifactPath(value).ok, false, value);
  }
  assert.deepEqual(normalizeArtifactPath("taproot-docs/fragments/guide.en-us.html"), {
    ok: true,
    value: "taproot-docs/fragments/guide.en-us.html",
  });
});

test("artifact paths reject Windows device aliases in every segment", () => {
  for (const value of [
    "taproot-docs/fragments/nul.html",
    "taproot-docs/fragments/nested/CON.txt",
    "taproot-docs/assets/com1/image.png",
    "taproot-docs/assets/nested/LpT9.preview.png",
  ]) {
    assert.equal(normalizeArtifactPath(value).code, "path.device_name", value);
  }
  for (const value of [
    "taproot-docs/fragments/console.html",
    "taproot-docs/fragments/com0.html",
    "taproot-docs/assets/lpt10/image.png",
    "taproot-docs/assets/con-image.png",
  ]) {
    assert.equal(normalizeArtifactPath(value).ok, true, value);
  }
});

test("route validation requires one canonical non-reserved URL form", () => {
  for (const value of [
    "guide/",
    "/Guide/",
    "/guide",
    "/guide//child/",
    "/guide/%2e%2e/",
    "/assets/image/",
    "/taproot-docs-manifest.json/",
    "/404.html/child/",
    "/favicon.ico/child/",
    "/index.html/",
    "/index.html/child/",
    "/manifest.webmanifest/child/",
    "/robots.txt/child/",
    "/sitemap.xml/child/",
    "/taproot-docs-manifest.json/child/",
  ]) {
    assert.equal(normalizeRoute(value).ok, false, value);
  }
  assert.deepEqual(normalizeRoute("/guides/getting-started/"), {
    ok: true,
    value: "/guides/getting-started/",
  });
});

test("routes reject Windows device aliases in every segment", () => {
  for (const value of ["/con/", "/nul.txt/", "/guides/com1/"]) {
    assert.equal(normalizeRoute(value).code, "route.device_name", value);
  }
  for (const value of ["/console/", "/com0/", "/guides/lpt10/", "/con-guide/"]) {
    assert.equal(normalizeRoute(value).ok, true, value);
  }
});

test("source locations permit repository casing but not traversal", () => {
  assert.equal(normalizeSourcePath("src/Components/Button.ts").ok, true);
  assert.equal(normalizeSourcePath("src/../secrets.txt").ok, false);
  assert.equal(normalizeSourcePath("C:\\secrets.txt").ok, false);
});

test("source path bounds count Unicode scalars and reject ill-formed input", () => {
  assert.equal(normalizeSourcePath("😀".repeat(LIMITS.sourcePath)).ok, true);
  assert.deepEqual(normalizeSourcePath("😀".repeat(LIMITS.sourcePath + 1)), {
    ok: false,
    code: "source_path.too_long",
    message: `Source paths may not exceed ${LIMITS.sourcePath} characters.`,
  });
  assert.equal(normalizeSourcePath("guides/invalid-\ud800.md").code, "source_path.invalid_unicode");
});
