import type { GeneratedWebhookEvent, GeneratedWebhookEventType, IntegrationOpenApiOperationMap } from "./src/openapi-contract.js";

export type { GeneratedWebhookEvent, GeneratedWebhookEventMap, GeneratedWebhookEventType, IntegrationOpenApiOperationMap } from "./src/openapi-contract.js";
export { INTEGRATION_OPENAPI_OPERATIONS, INTEGRATION_OPENAPI_SCHEMAS, INTEGRATION_WEBHOOK_EVENTS } from "./src/openapi-contract.js";

type OperationRequest<Name extends keyof IntegrationOpenApiOperationMap> = IntegrationOpenApiOperationMap[Name]["request"];
type OperationResponse<Name extends keyof IntegrationOpenApiOperationMap> = IntegrationOpenApiOperationMap[Name]["response"];

export const INTEGRATION_SDK_VERSION: "0.1.3";
export const WEBHOOK_VERSION: "1";
export const WEBHOOK_EVENT_TYPES: readonly WebhookEventType[];
export const INTEGRATION_CAPABILITIES: readonly IntegrationCapability[];
export const HANDOFF_JWKS_PATH: ".well-known/taproot-integrations-jwks.json";
export const HANDOFF_LIFETIME_SECONDS: 300;
export const DEFAULT_TIMESTAMP_TOLERANCE_SECONDS: 300;
export const DEFAULT_RETRY_ATTEMPTS: 3;

export type IntegrationCapability =
  | "pages.manage_own"
  | "data.manage_own"
  | "media.manage_own"
  | "publish"
  | "site.pages.read"
  | "fragments.manage_own";

export class IntegrationSdkError extends Error {
  readonly code: string;
  readonly status?: number;
  readonly details?: unknown;
}

export class IntegrationApiError extends IntegrationSdkError {
  readonly status: number;
}

export interface IntegrationConfigurationSchema {
  type: "object" | "array" | "string" | "number" | "integer" | "boolean";
  properties?: Record<string, IntegrationConfigurationSchema>;
  required?: string[];
  items?: IntegrationConfigurationSchema;
  enum?: Array<string | number | boolean>;
  additionalProperties?: false;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
}

export interface IntegrationManifestComponent {
  id: string;
  name: string;
  configSchema: IntegrationConfigurationSchema;
}

export interface IntegrationPricingOption {
  id: string;
  version: string;
  quantityMin: number;
  quantityMax: number | null;
  cadence: "free" | "monthly" | "annual";
  catalogueItemKey: string | null;
}

export interface IntegrationManifest {
  slug: string;
  displayName: string;
  webhookEndpointUrl: string;
  settingsUrl: string;
  requestedCapabilities: IntegrationCapability[];
  offeredComponents: IntegrationManifestComponent[];
  externalScriptOrigins: string[];
  externalConnectOrigins?: string[];
  externalScriptOriginReasons?: Record<string, string>;
  externalConnectOriginReasons?: Record<string, string>;
  defaultPublishPolicy: "auto" | "stage";
  recommendedUninstallDisposition: "freeze" | "remove";
  contractVersion: string;
  pricingOptions: IntegrationPricingOption[];
  description?: string;
}

export interface ManifestValidationError {
  field: string;
  code: string;
}

export type ManifestValidationResult =
  | { ok: true; value: IntegrationManifest }
  | { ok: false; errors: ManifestValidationError[] };

export function validateManifest(input: unknown): ManifestValidationResult;
export function assertValidManifest(input: unknown): IntegrationManifest;

export interface FragmentPreflightError {
  code: "invalid_html" | "size_exceeded" | "element_not_allowed" | "attribute_not_allowed" | "invalid_url";
  message: string;
}

/** Advisory only. Taproot's write-time sanitizer is authoritative. */
export function validateFragment(html: unknown): { ok: true } | { ok: false; errors: FragmentPreflightError[] };

/** Canonical v1 event union emitted from the reviewed webhook JSON Schemas. */
export type WebhookEvent = GeneratedWebhookEvent;
export type WebhookEventType = GeneratedWebhookEventType;
export type WebhookHeaders = Headers | Map<string, string> | Record<string, string | string[] | undefined>;

export interface VerifiedWebhookEvent {
  event: WebhookEvent;
  deliveryId: string;
  eventType: WebhookEventType;
  installationId: string;
  keyId: string;
  timestamp: number;
  body: Uint8Array;
  bodySha256: string;
}

export interface VerifyWebhookSignatureOptions {
  headers: WebhookHeaders;
  /** The request body exactly as received, before JSON parsing or reformatting. */
  body: Uint8Array | ArrayBuffer | string;
  /** Active and overlapping retired key ids mapped to base64 HMAC secrets or decoded secret bytes. */
  signingSecrets: Map<string, string | Uint8Array> | Record<string, string | Uint8Array>;
  now?: Date | number;
  timestampToleranceSeconds?: number;
}

export function parseWebhookEvent(body: Uint8Array | ArrayBuffer | string): WebhookEvent;
export function verifyWebhookSignature(options: VerifyWebhookSignatureOptions): VerifiedWebhookEvent;

export interface WebhookReceipt {
  deliveryId: string;
  eventType: WebhookEventType;
  installationId: string;
  integrationId: string;
  occurredAt: string;
  keyId: string;
  bodySha256: string;
  receivedAt: string;
}

export type WebhookReceiptClaim =
  | { state: "claimed"; token: string }
  | { state: "duplicate" }
  | { state: "in_progress" }
  | { state: "conflict" };

/**
 * Implement with an atomic, durable database transaction. An in-memory Set is not sufficient.
 * Return `duplicate` only for a delivered receipt. Failed receipts and expired processing leases
 * must return `claimed` with a fresh token so Taproot can redeliver them safely.
 */
export interface WebhookReceiptStore {
  claim(receipt: WebhookReceipt): Promise<WebhookReceiptClaim> | WebhookReceiptClaim;
  finish(completion: {
    deliveryId: string;
    bodySha256: string;
    token: string;
    status: "delivered" | "failed";
    failureCode?: string;
    completedAt: string;
  }): Promise<void> | void;
}

export function claimWebhookReceipt(options: { store: WebhookReceiptStore; verified: VerifiedWebhookEvent; now?: Date | number }): Promise<{ receipt: WebhookReceipt } & WebhookReceiptClaim>;
export function finishWebhookReceipt(options: {
  store: WebhookReceiptStore;
  verified: VerifiedWebhookEvent;
  token: string;
  status: "delivered" | "failed";
  failureCode?: string;
  now?: Date | number;
}): Promise<void>;

/** Exact OpenAPI types emitted from the reviewed integration-operation allowlist. */
export type ClaimInstallationResponse = OperationResponse<"claimInstallation">;
export type IntegrationInstallation = ClaimInstallationResponse extends { installation?: infer Value } ? NonNullable<Value> : never;
export type IntegrationCredential = ClaimInstallationResponse extends { credential?: infer Value } ? NonNullable<Value> : never;
export type ValidateInstallationResponse = OperationResponse<"validateInstallation">;
export type IntegrationSyncResult = OperationResponse<"createSync">;
export type TaprootImage = OperationResponse<"confirmMediaUpload"> extends { image?: infer Value } ? NonNullable<Value> : never;
export type RequestMediaUploadResponse = OperationResponse<"requestMediaUpload">;
export type IntegrationPlacement = OperationResponse<"listPlacements"> extends { placements?: Array<infer Value> } ? Value : never;
export type IntegrationPlacementFragmentResult = OperationResponse<"putFragment">;
export type IntegrationBundle = OperationResponse<"confirmBundleUpload">;
export type RequestBundleUploadResponse = OperationResponse<"requestBundleUpload">;
export type IntegrationManagedPageContent = OperationRequest<"putManagedPage"> extends { page?: infer Value } ? NonNullable<Value> : never;

export interface TaprootIntegrationClientOptions {
  /** Canonical API base, such as https://app.example/api; do not include /v1. */
  baseUrl: string;
  fetch?: typeof globalThis.fetch;
  installationCredential?: string;
  publisherCredential?: string;
  timeoutMs?: number;
  maxAttempts?: 1 | 2 | 3;
  maxConcurrentRequests?: number;
  maxQueuedRequests?: number;
}

export class TaprootIntegrationClient {
  constructor(options: TaprootIntegrationClientOptions);
  claimInstallation(input: { installationId: string; claimCode: string }): Promise<ClaimInstallationResponse>;
  validateInstallation(input: { installationId: string }): Promise<ValidateInstallationResponse>;
  createSync(input: { installationId: string; mode: string; requestedSyncId?: string; idempotencyKey: string }): Promise<IntegrationSyncResult>;
  completeSync(input: { installationId: string; syncId: string; summary?: string; idempotencyKey: string }): Promise<IntegrationSyncResult>;
  abortSync(input: { installationId: string; syncId: string; summary?: string; idempotencyKey: string }): Promise<IntegrationSyncResult>;
  putManagedPage(input: { installationId: string; syncId?: string; page: IntegrationManagedPageContent; idempotencyKey: string }): Promise<IntegrationSyncResult>;
  deleteManagedPage(input: { installationId: string; syncId?: string; externalId: string; idempotencyKey: string }): Promise<IntegrationSyncResult>;
  putDataDocument(input: { installationId: string; syncId?: string; key: string; json: string; idempotencyKey: string }): Promise<IntegrationSyncResult>;
  deleteDataDocument(input: { installationId: string; syncId?: string; key: string; idempotencyKey: string }): Promise<IntegrationSyncResult>;
  requestMediaUpload(input: { installationId: string; fileName: string; contentType: string; fileSize: number; contentHash: string; width: number; height: number; operationKey?: string }): Promise<RequestMediaUploadResponse>;
  confirmMediaUpload(input: { installationId: string; uploadId: string }): Promise<OperationResponse<"confirmMediaUpload">>;
  putMedia(input: { installationId: string; fileName: string; contentType: string; fileSize: number; contentHash: string; width: number; height: number; body: Uint8Array | ArrayBuffer | string; operationKey?: string }): Promise<TaprootImage>;
  uploadPresigned(input: { url: string; requiredHeaders?: Record<string, string>; body: Uint8Array | ArrayBuffer | string }): Promise<void>;
  listPlacements(input: { installationId: string }): Promise<{ placements: IntegrationPlacement[] }>;
  putFragment(input: { installationId: string; placementId: string; configurationRevision: number; expectedFragmentRevision?: number; html: string; structuredData?: string[]; syncId?: string; idempotencyKey: string }): Promise<IntegrationPlacementFragmentResult>;
  deleteFragment(input: { installationId: string; placementId: string; configurationRevision: number; expectedFragmentRevision?: number; syncId?: string; idempotencyKey: string }): Promise<IntegrationPlacementFragmentResult>;
  requestBundleUpload(input: { integrationId: string; contentHash: string; byteLength: number; runtimeMajor: number }): Promise<RequestBundleUploadResponse>;
  confirmBundleUpload(input: { integrationId: string; uploadId: string }): Promise<IntegrationBundle>;
  confirmHandoff(input: { installationId: string; token: string }): Promise<ConfirmedHandoff>;
}

export function createIdempotencyKey(): string;

export interface HandoffClaims {
  userId: string;
  siteId: string;
  installationId: string;
  integrationId: string;
  credentialId: string;
  jti: string;
  role: "owner" | "engagement";
  engagementId: string | null;
  issuedAt: string;
  expiresAt: string;
}
export type ConfirmedHandoff = OperationResponse<"confirmHandoff">;
export interface HandoffJwk { kty: "RSA"; use: "sig"; alg: "RS256"; kid: string; n: string; e: string; }
export interface HandoffJwks { keys: HandoffJwk[]; }
export function verifyHandoff(options: {
  token: string;
  issuer: string;
  audience: string;
  installationId: string;
  jwksUrl?: string;
  jwks?: HandoffJwks;
  fetch?: typeof globalThis.fetch;
  now?: Date | number;
}): Promise<HandoffClaims>;
export function confirmHandoff(options: {
  client: TaprootIntegrationClient;
  claims: HandoffClaims;
  token: string;
  now?: Date | number;
  maximumSessionLifetimeSeconds?: number;
}): Promise<HandoffClaims & { sessionExpiresAt: string }>;
export function clearHandoffJwksCache(jwksUrl?: string): void;
