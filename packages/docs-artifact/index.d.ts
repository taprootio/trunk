export interface DocsArtifactSource {
  provider: "github";
  repositoryId: string;
  repository: string;
  repositoryUrl: string;
  revision: string;
  ref: string;
}

export interface DocsArtifactBuild {
  producer: string;
  producerVersion: string;
  configurationSha256: string;
  sourceDateEpoch: number;
}

export interface DocsArtifactCapabilities {
  required: string[];
  optional: string[];
}

export interface DocsLocale {
  tag: string;
  label: string;
}

export type DocsResourceKind = "api" | "changelog" | "concept" | "guide" | "other" | "reference";
export type DocsAudience = "administrator" | "developer" | "operator" | "user";

export interface DocsSemanticMetadata {
  kind: DocsResourceKind;
  audiences: DocsAudience[];
  tags: string[];
}

export interface DocsHeading {
  id: string;
  text: string;
  level: 2 | 3 | 4 | 5 | 6;
}

export interface DocsSourceLocation {
  path: string;
  url: string;
  startLine?: number;
  endLine?: number;
}

export type DocsFragmentRole = "aside" | "body" | "example";

export interface DocsFragment {
  key: string;
  role: DocsFragmentRole;
  path: string;
  mediaType: "text/html; charset=utf-8";
  bytes: number;
  sha256: string;
}

export interface DocsResourceVariant {
  locale: string;
  route: string;
  title: string;
  description: string;
  headings: DocsHeading[];
  source: DocsSourceLocation;
  fragments: DocsFragment[];
}

export interface DocsResource {
  key: string;
  semantic: DocsSemanticMetadata;
  variants: DocsResourceVariant[];
}

export interface DocsNavigationNode {
  label: string;
  resourceKey?: string;
  children?: DocsNavigationNode[];
}

export interface DocsNavigation {
  locale: string;
  items: DocsNavigationNode[];
}

export interface DocsRedirect {
  from: string;
  toResourceKey: string;
  locale: string;
  status: 301 | 308;
}

export type DocsAssetMediaType = "image/gif" | "image/jpeg" | "image/png" | "image/webp";

export interface DocsAsset {
  key: string;
  path: string;
  mediaType: DocsAssetMediaType;
  bytes: number;
  sha256: string;
  width: number;
  height: number;
}

export interface DocsArtifactManifest {
  schemaVersion: 1;
  defaultLocale: string;
  source: DocsArtifactSource;
  build: DocsArtifactBuild;
  capabilities: DocsArtifactCapabilities;
  locales: DocsLocale[];
  resources: DocsResource[];
  navigation: DocsNavigation[];
  redirects: DocsRedirect[];
  assets: DocsAsset[];
}

export interface DocsArtifactValidationErrorItem {
  code: string;
  path: string;
  message: string;
}

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; errors: DocsArtifactValidationErrorItem[] };

export interface ValidationOptions {
  /**
   * At most LIMITS.supportedCapabilities canonical resource-key strings, each
   * no longer than LIMITS.resourceKey.
   */
  supportedCapabilities?: Iterable<string> & object;
}

export type ManifestInput = DocsArtifactManifest | string | Uint8Array | ArrayBuffer;
export type ArtifactFileContent = string | Uint8Array | ArrayBuffer;

export interface ArtifactFileEntry {
  path: string;
  content: ArtifactFileContent;
}

export interface ValidatedArtifact {
  manifest: DocsArtifactManifest;
  fileCount: number;
  totalBytes: number;
}

export class DocsArtifactValidationError extends Error {
  readonly errors: DocsArtifactValidationErrorItem[];
  constructor(errors: DocsArtifactValidationErrorItem[]);
}

export interface NormalizedPath {
  ok: true;
  value: string;
}

export interface InvalidPath {
  ok: false;
  code: string;
  message: string;
}

export interface DocsArtifactLimits {
  readonly [name: string]: number;
  readonly decodedPixels: number;
  readonly decodedAnimationPixels: number;
  readonly animationFrames: number;
  readonly supportedCapabilities: number;
  readonly resourceKey: number;
}

export const MANIFEST_FILE_NAME: "taproot-docs-manifest.json";
export const SCHEMA_VERSION: 1;
export const HTML_FRAGMENT_CAPABILITY: "taproot.docs.fragments.html.v1";
export const SUPPORTED_CAPABILITIES: readonly string[];
export const ASSET_MEDIA_TYPES: readonly DocsAssetMediaType[];
export const AUDIENCES: readonly DocsAudience[];
export const FRAGMENT_MEDIA_TYPE: "text/html; charset=utf-8";
export const FRAGMENT_ROLES: readonly DocsFragmentRole[];
export const RESOURCE_KINDS: readonly DocsResourceKind[];
export const RESERVED_ROUTE_PREFIXES: readonly string[];
export const RESERVED_ROUTES: readonly string[];
export const LIMITS: Readonly<DocsArtifactLimits>;

export function normalizeArtifactPath(value: unknown): NormalizedPath | InvalidPath;
export function normalizeSourcePath(value: unknown): NormalizedPath | InvalidPath;
export function normalizeRoute(value: unknown): NormalizedPath | InvalidPath;
export function validateManifest(input: unknown, options?: ValidationOptions): ValidationResult<DocsArtifactManifest>;
export function assertValidManifest(input: unknown, options?: ValidationOptions): DocsArtifactManifest;
export function serializeManifest(input: unknown, options?: ValidationOptions): string;
export function validateArtifact(
  manifest: unknown,
  files: Iterable<ArtifactFileEntry>,
  options?: ValidationOptions,
): Promise<ValidationResult<ValidatedArtifact>>;
export function assertValidArtifact(
  manifest: unknown,
  files: Iterable<ArtifactFileEntry>,
  options?: ValidationOptions,
): Promise<ValidatedArtifact>;
