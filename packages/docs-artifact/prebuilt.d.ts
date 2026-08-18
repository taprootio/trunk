import type {
  ArtifactFileContent,
  ArtifactFileEntry,
  DocsArtifactBuild,
  DocsArtifactSource,
  NormalizedPath,
  InvalidPath,
  ValidationResult,
} from "./index.js";

export type PrebuiltMediaType =
  | "application/json; charset=utf-8"
  | "application/manifest+json; charset=utf-8"
  | "application/octet-stream"
  | "application/wasm"
  | "application/xml; charset=utf-8"
  | "font/otf"
  | "font/ttf"
  | "font/woff"
  | "font/woff2"
  | "image/avif"
  | "image/gif"
  | "image/jpeg"
  | "image/png"
  | "image/svg+xml"
  | "image/vnd.microsoft.icon"
  | "image/webp"
  | "text/css; charset=utf-8"
  | "text/html; charset=utf-8"
  | "text/javascript; charset=utf-8"
  | "text/plain; charset=utf-8";

export interface PrebuiltArtifactCapabilities {
  required: string[];
  optional: string[];
}

export interface PrebuiltFile {
  path: string;
  mediaType: PrebuiltMediaType;
  bytes: number;
  sha256: string;
}

export interface PrebuiltResource {
  key: string;
  file: string;
  title: string;
}

export interface PrebuiltRedirect {
  from: string;
  toResourceKey: string;
  status: 301 | 308;
}

export interface PrebuiltArtifactManifest {
  schemaVersion: 1;
  mode: "prebuilt";
  source: DocsArtifactSource;
  build: DocsArtifactBuild;
  capabilities: PrebuiltArtifactCapabilities;
  notFoundFile: "404.html";
  files: PrebuiltFile[];
  resources: PrebuiltResource[];
  redirects: PrebuiltRedirect[];
}

export interface PrebuiltValidationOptions {
  supportedCapabilities?: Iterable<string> & object;
}

export type PrebuiltManifestInput = PrebuiltArtifactManifest | string | Uint8Array | ArrayBuffer;

export interface ValidatedPrebuiltArtifact {
  manifest: PrebuiltArtifactManifest;
  /** Caller-isolated snapshots of the exact validated bytes, in manifest path order. */
  files: Array<{ path: string; content: Uint8Array }>;
  fileCount: number;
  totalBytes: number;
}

export interface PrebuiltArtifactLimits {
  readonly manifestBytes: number;
  readonly manifestObjectWork: number;
  readonly manifestObjectDepth: number;
  readonly artifactBytes: number;
  readonly fileBytes: number;
  readonly files: number;
  readonly resources: number;
  readonly redirects: number;
  readonly artifactPathBytes: number;
  readonly directoryDepth: number;
  readonly directoryEntries: number;
  readonly supportedCapabilities: number;
  readonly resourceKey: number;
  readonly title: number;
  readonly routeBytes: number;
}

export const PREBUILT_MANIFEST_FILE_NAME: "taproot-docs-prebuilt-manifest.json";
export const PREBUILT_SCHEMA_VERSION: 1;
export const PREBUILT_MODE: "prebuilt";
export const PREBUILT_ARCHIVE_FORMAT: "taproot-docs-prebuilt-tar-gzip-v1";
export const PREBUILT_FILES_CAPABILITY: "taproot.docs.prebuilt.files.v1";
export const PREBUILT_NOT_FOUND_FILE: "404.html";
export const PREBUILT_SUPPORTED_CAPABILITIES: readonly string[];
export const PREBUILT_LIMITS: Readonly<PrebuiltArtifactLimits>;
export const PREBUILT_MEDIA_TYPES: readonly PrebuiltMediaType[];
export const PREBUILT_TEXT_MEDIA_TYPES: readonly PrebuiltMediaType[];

export { DocsArtifactValidationError } from "./index.js";
export function normalizePrebuiltArtifactPath(value: unknown): NormalizedPath | InvalidPath;
export function normalizePrebuiltRedirectRoute(value: unknown): NormalizedPath | InvalidPath;
export function prebuiltFileRoute(value: unknown): NormalizedPath | InvalidPath;
export function validatePrebuiltManifest(input: unknown, options?: PrebuiltValidationOptions): ValidationResult<PrebuiltArtifactManifest>;
export function assertValidPrebuiltManifest(input: unknown, options?: PrebuiltValidationOptions): PrebuiltArtifactManifest;
export function serializePrebuiltManifest(input: unknown, options?: PrebuiltValidationOptions): string;
export function validatePrebuiltArtifact(
  manifest: unknown,
  files: Iterable<ArtifactFileEntry>,
  options?: PrebuiltValidationOptions,
): Promise<ValidationResult<ValidatedPrebuiltArtifact>>;
export function assertValidPrebuiltArtifact(
  manifest: unknown,
  files: Iterable<{ path: string; content: ArtifactFileContent }>,
  options?: PrebuiltValidationOptions,
): Promise<ValidatedPrebuiltArtifact>;
