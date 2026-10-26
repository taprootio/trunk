import { INTEGRATION_WEBHOOK_EVENTS } from "./openapi-contract.js";

export const INTEGRATION_SDK_VERSION = "0.1.3";
export const WEBHOOK_VERSION = "1";
export const WEBHOOK_EVENT_TYPES = Object.freeze(Object.keys(INTEGRATION_WEBHOOK_EVENTS));
export const INTEGRATION_CAPABILITIES = Object.freeze([
  "pages.manage_own",
  "data.manage_own",
  "media.manage_own",
  "publish",
  "site.pages.read",
  "fragments.manage_own",
]);
export const HANDOFF_JWKS_PATH = ".well-known/taproot-integrations-jwks.json";
export const HANDOFF_LIFETIME_SECONDS = 5 * 60;
export const DEFAULT_TIMESTAMP_TOLERANCE_SECONDS = 5 * 60;
export const DEFAULT_RETRY_ATTEMPTS = 3;
