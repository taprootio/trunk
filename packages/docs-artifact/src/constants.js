export const MANIFEST_FILE_NAME = "taproot-docs-manifest.json";
export const SCHEMA_VERSION = 1;
export const HTML_FRAGMENT_CAPABILITY = "taproot.docs.fragments.html.v1";

export const SUPPORTED_CAPABILITIES = Object.freeze([
  HTML_FRAGMENT_CAPABILITY,
]);

export const LIMITS = Object.freeze({
  manifestBytes: 2 * 1024 * 1024,
  manifestObjectWork: 250_000,
  manifestObjectDepth: 64,
  artifactBytes: 256 * 1024 * 1024,
  files: 20_000,
  resources: 10_000,
  variants: 20_000,
  fragments: 20_000,
  assets: 10_000,
  redirects: 10_000,
  navigationNodes: 20_000,
  navigationDepth: 12,
  headingsPerVariant: 500,
  markupElements: 100_000,
  markupDepth: 128,
  fragmentBytes: 2 * 1024 * 1024,
  assetBytes: 25 * 1024 * 1024,
  decodedPixels: 64 * 1024 * 1024,
  decodedAnimationPixels: 64 * 1024 * 1024,
  animationFrames: 1_000,
  supportedCapabilities: 100,
  string: 2_000,
  title: 300,
  description: 1_000,
  resourceKey: 200,
  artifactPath: 512,
  directoryEntries: 40_000,
  directoryDepth: 32,
  route: 512,
  sourcePath: 1_000,
  url: 2_000,
  validationErrors: 200,
  diagnosticPathScalars: 1_000,
  diagnosticPathBytes: 4_096,
  diagnosticMessageScalars: 2_000,
  diagnosticMessageBytes: 8_192,
  diagnosticAggregateScalars: 16_000,
  diagnosticAggregateBytes: 32_768,
});

export const ASSET_MEDIA_TYPES = Object.freeze([
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

export const FRAGMENT_MEDIA_TYPE = "text/html; charset=utf-8";

export const RESOURCE_KINDS = Object.freeze([
  "api",
  "changelog",
  "concept",
  "guide",
  "other",
  "reference",
]);

export const AUDIENCES = Object.freeze([
  "administrator",
  "developer",
  "operator",
  "user",
]);

export const FRAGMENT_ROLES = Object.freeze(["aside", "body", "example"]);

export const RESERVED_ROUTE_PREFIXES = Object.freeze([
  "/.well-known/",
  "/_taproot/",
  "/api/",
  "/assets/",
  "/bust/",
  "/pagefind/",
  "/public/",
  "/taproot-docs/",
  "/404.html/",
  "/favicon.ico/",
  "/index.html/",
  "/manifest.webmanifest/",
  "/robots.txt/",
  "/sitemap.xml/",
  "/taproot-docs-manifest.json/",
]);

export const RESERVED_ROUTES = Object.freeze([
  "/404/",
  "/404.html/",
  "/favicon.ico/",
  "/index.html/",
  "/manifest.webmanifest/",
  "/robots.txt/",
  "/sitemap.xml/",
  "/taproot-docs-manifest.json/",
]);
