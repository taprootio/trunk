export type DocsPublicationMode = "managed" | "prebuilt";

export interface DocsPublisherConfig {
  configVersion: 1;
  siteId: string;
  artifactDirectory: string;
  /** Explicit publication mode. Absent selects "managed". */
  mode?: DocsPublicationMode;
  apiBaseUrl?: string;
}

export interface DocsPublishSuccess {
  schemaVersion: 1;
  ok: true;
  outcome?: "published";
  publisher: { name: "@taprootio/docs-publisher"; version: "1.2.0" };
  compatibility: {
    configVersion: 1;
    artifactPackageVersion: "1.1.0";
    artifactSchemaVersion: 1;
    archiveFormat: "taproot-docs-tar-gzip-v1" | "taproot-docs-prebuilt-tar-gzip-v1";
  };
  siteId: string;
  mode: DocsPublicationMode;
  artifact: { contentHash: string; byteLength: number; uploaded: boolean; reused: boolean };
  release: { id: string; status: string; sourceRevision: string };
  staging: { deploymentId: string; outputReleaseId: string; pointerVersion: number; status: string };
  production: { deploymentId: string; outputReleaseId: string; pointerVersion: number; status: string };
}

/** The validated source was superseded on main. No deployment was requested. */
export interface DocsPublishSuperseded {
  schemaVersion: 1;
  ok: true;
  outcome: "superseded";
  publisher: { name: "@taprootio/docs-publisher"; version: "1.2.0" };
  siteId: string;
  mode: DocsPublicationMode;
  release: { id: string; status: string; sourceRevision: string };
  currentRevision: string;
}

export interface PublishOptions {
  cwd?: string;
  configPath?: string;
  environment?: Record<string, string | undefined>;
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
  quiet?: boolean;
  /** Require a matching GitHub main push and re-check its head immediately before staging. */
  requireGitHubMainHead?: boolean;
  onProgress?: (message: string) => void;
}

export class PublisherError extends Error {
  readonly code: string;
  readonly field?: string;
  readonly status?: string;
  readonly exitCode: number;
}

export function publishDocs(options?: PublishOptions & { requireGitHubMainHead?: false }): Promise<DocsPublishSuccess>;
export function publishDocs(options: PublishOptions): Promise<DocsPublishSuccess | DocsPublishSuperseded>;
