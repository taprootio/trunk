export const PREBUILT_MANIFEST_FILE_NAME = "taproot-docs-prebuilt-manifest.json";
export const PREBUILT_SCHEMA_VERSION = 1;
export const PREBUILT_MODE = "prebuilt";
export const PREBUILT_ARCHIVE_FORMAT = "taproot-docs-prebuilt-tar-gzip-v1";
export const PREBUILT_FILES_CAPABILITY = "taproot.docs.prebuilt.files.v1";
export const PREBUILT_NOT_FOUND_FILE = "404.html";

export const PREBUILT_SUPPORTED_CAPABILITIES = Object.freeze([
  PREBUILT_FILES_CAPABILITY,
]);

export const PREBUILT_LIMITS = Object.freeze({
  manifestBytes: 8 * 1024 * 1024,
  manifestObjectWork: 250_000,
  manifestObjectDepth: 64,
  artifactBytes: 512 * 1024 * 1024,
  fileBytes: 64 * 1024 * 1024,
  files: 25_000,
  resources: 25_000,
  redirects: 10_000,
  artifactPathBytes: 255,
  directoryDepth: 64,
  directoryEntries: 40_000,
  supportedCapabilities: 100,
  resourceKey: 200,
  title: 300,
  routeBytes: 2_000,
});

export const PREBUILT_MEDIA_TYPES = Object.freeze([
  "application/json; charset=utf-8",
  "application/manifest+json; charset=utf-8",
  "application/octet-stream",
  "application/wasm",
  "application/xml; charset=utf-8",
  "font/otf",
  "font/ttf",
  "font/woff",
  "font/woff2",
  "image/avif",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/svg+xml",
  "image/vnd.microsoft.icon",
  "image/webp",
  "text/css; charset=utf-8",
  "text/html; charset=utf-8",
  "text/javascript; charset=utf-8",
  "text/plain; charset=utf-8",
]);

export const PREBUILT_TEXT_MEDIA_TYPES = Object.freeze(
  PREBUILT_MEDIA_TYPES.filter((mediaType) => mediaType.includes("charset=utf-8") || mediaType === "image/svg+xml"),
);
