import { hasControlCharacter } from "./errors.js";

/**
 * The one rule for an outbound target on a footer link or a navigation item.
 *
 * A local business's phone number and address are the two things a visitor
 * looks for in a header and a footer, and page links have accepted `tel:` and
 * `mailto:` since D12. This is the same permissive scheme set the published
 * renderer already applies to page content (`generator/src/url-safety.ts`,
 * `shared/tiptap-prosemirror.ts`, `ux/client/src/common/sanitize-html.ts`),
 * narrowed to what a *stored* target may be: absolute, so there is no base to
 * resolve against at publish time, and credential-free, so a footer cannot
 * carry someone's password into published HTML.
 *
 * `tel:` and `mailto:` are opaque URLs whose body is content — a number with
 * its punctuation, an address with its plus-tag. Callers emit the value
 * verbatim after this check rather than round-tripping it through
 * `URL.toString()`, which re-encodes both.
 */

/** Longest external target a footer link or a navigation item may carry. */
export const CONTACT_OR_WEB_URL_MAX_LENGTH = 2_048;

/**
 * The requirement clause every layer says when it refuses a target, so the
 * CLI, the editors, and the server all name the same four schemes.
 */
export const CONTACT_OR_WEB_URL_REQUIREMENT =
  "must be an absolute http or https URL without credentials, or a mailto or tel contact URL";

const WEB_PROTOCOLS = new Set(["http:", "https:"]);
const CONTACT_PROTOCOLS = new Set(["mailto:", "tel:"]);

/**
 * Whether `value` is a target the footer and navigation contracts accept.
 *
 * ASCII controls, C1 controls, and backslashes are refused before the scheme
 * is looked at: browsers normalize them inconsistently, and a line break in a
 * `mailto:` is the header-injection vector.
 */
export function isContactOrWebUrl(value, maximumLength = CONTACT_OR_WEB_URL_MAX_LENGTH) {
  if (typeof value !== "string" || value.length === 0 || value.length > maximumLength) return false;
  if (hasControlCharacter(value) || value.includes("\\")) return false;

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }

  if (WEB_PROTOCOLS.has(parsed.protocol)) {
    return parsed.username === "" && parsed.password === "" && parsed.hostname !== "";
  }
  // The body is everything after `tel:` or `mailto:`; an empty one is a link
  // to nothing, which publishes as a dead anchor rather than a refusal. A
  // body that opens with `//` is an authority, which a contact URL has no use
  // for, and the four layers agree on refusing it rather than on how each
  // parser validates one.
  return CONTACT_PROTOCOLS.has(parsed.protocol)
    && parsed.pathname !== ""
    && !value.slice(value.indexOf(":") + 1).startsWith("//");
}
