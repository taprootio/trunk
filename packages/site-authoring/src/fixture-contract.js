import { fileURLToPath } from "node:url";

/**
 * The offline authoring-fixture contract (TR00647).
 *
 * `validate` enforces this; `help fixture` states it. Both read the constants
 * below rather than restating them, so a change to what the verb requires
 * cannot leave the reference describing the previous contract. The one thing
 * this module deliberately does not own is the *page* entry's key set: a
 * fixture page entry is a `pull` manifest entry, and `validate` reads the
 * fields it needs rather than closing the shape, so a fixture written by a
 * newer `pull` is not refused for carrying a field this release ignores.
 */

export const FIXTURE_MANIFEST_FILE_NAME = "manifest.fixture.json";
export const FIXTURE_CONTRACT_VERSION = 1;

/** Root fields whose absence or wrong value fails validation. */
export const FIXTURE_REQUIRED_ROOT_FIELDS = Object.freeze([
  "manifestVersion",
  "siteId",
  "pages",
  "pagesTruncated",
  "navigation",
  "settings",
  "settingsSkipped",
  "fixture",
]);

/**
 * Root fields `pull` writes that a fixture may carry unchanged. They are
 * accepted and read for nothing: a fixture proves local structure, and neither
 * the snapshot time nor a recorded deployment can be checked without a server.
 */
export const FIXTURE_OPTIONAL_ROOT_FIELDS = Object.freeze(["pulledAt", "deployments"]);

/** Every root field the manifest may declare. Anything else is refused. */
export const FIXTURE_ROOT_FIELDS = Object.freeze(
  [...FIXTURE_REQUIRED_ROOT_FIELDS, ...FIXTURE_OPTIONAL_ROOT_FIELDS].sort(),
);

/** Every field the versioned `fixture` block may declare. All are required. */
export const FIXTURE_METADATA_FIELDS = Object.freeze(["contractVersion", "imageIds", "deliveryOrigins"]);

/**
 * Delivery origins are restricted to the reserved example domain rather than
 * merely to HTTPS. A fixture is example data that ships and is copied; a real
 * delivery host in one would be a live reference in every copy of it.
 */
export const FIXTURE_DELIVERY_ORIGIN_DOMAIN = "example.test";
export const FIXTURE_MAXIMUM_DELIVERY_ORIGINS = 100;

/** The complete example fixture this package ships. */
export const SHIPPED_FIXTURE_NAME = "riverbend-wellness";

/**
 * The absolute path of the shipped fixture, resolved from this module rather
 * than from the caller's directory, so it is correct for a global install as
 * well as a checkout. `help fixture` reports it and `validate` accepts it.
 */
export function shippedFixtureDirectory() {
  return fileURLToPath(new URL(`../examples/${SHIPPED_FIXTURE_NAME}/`, import.meta.url)).replace(/[\\/]$/u, "");
}
