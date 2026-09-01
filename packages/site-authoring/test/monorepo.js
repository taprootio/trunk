import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Whether this package is sitting inside the private Taproot monorepo, and
 * where that monorepo is (TR00635).
 *
 * A handful of tests are cross-service contracts: they compare this package
 * against the canonical renderer, the shared section registry, the seeded
 * default theme, `Settings.proto`, and the API's domain constants — sources
 * that live beside the package in the monorepo and nowhere else. The public
 * Trunk tree that releases the package carries the package alone, and its
 * publish workflow runs `npm test` on exactly those bytes, so there is nothing
 * there for those tests to compare against.
 *
 * The rule is asymmetric on purpose. Outside the monorepo a comparison skips
 * by name, so the public tree reports the boundary rather than a module that
 * failed to load. Inside it nothing ever skips: a missing source is a failure,
 * because a silently skipped parity test is the exact drift these tests exist
 * to catch.
 */
export const MONOREPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

// AGENTS.md is the monorepo's canonical guide. It sits at the root of every
// Taproot checkout and at the root of no Trunk checkout, which makes it the one
// marker that cannot be confused with a sibling package or a workspace root.
export const INSIDE_MONOREPO = existsSync(path.join(MONOREPO_ROOT, "AGENTS.md"));

/**
 * The `skip` option for a test that reads the monorepo: `false` inside it, and
 * the reason outside it. Pass as `test(name, { skip: MONOREPO_ONLY }, fn)`.
 */
export const MONOREPO_ONLY = INSIDE_MONOREPO
  ? false
  : "cross-repository contract: the private Taproot monorepo is not present";

/** A monorepo-relative path, resolved from the monorepo root. */
export function monorepoPath(...segments) {
  return path.join(MONOREPO_ROOT, ...segments);
}
