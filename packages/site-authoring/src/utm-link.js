// Generated from ux/client/src/common/utm-link.ts by scripts/sync-field-validation.mjs. Do not edit.
/**
 * UTM parameters on an address, as string work so every byte the creator typed is kept (TR01273). One module
 * serves the Marketing link builder and the page editor's placement picker, so the two cannot disagree about
 * what a query string means.
 *
 * Parameter names are compared the way the published-site Worker compares them: decoded once and lowercased.
 */
/** The parameters the link builder owns; a pasted copy of any is replaced, never duplicated. */
export const BUILDER_UTM_PARAMETERS = new Set([
    "utm_source",
    "utm_medium",
    "utm_campaign",
    "utm_content",
]);
/** A placement rides in `utm_content`. */
export const PLACEMENT_PARAMETER = "utm_content";
/**
 * Outside-link destinations the engagement beacon records: lowercase ASCII host names with a letter-led final
 * label. A copy of `ENGAGEMENT_HOST_PATTERN` in `generator/src/edge/analytics-engagement.ts`; a test keeps them equal.
 */
export const ENGAGEMENT_HOST_PATTERN = /^(?=.{3,100}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
export function splitAddress(address) {
    const hash = address.indexOf("#");
    const beforeFragment = hash < 0 ? address : address.slice(0, hash);
    const fragment = hash < 0 ? "" : address.slice(hash + 1);
    const mark = beforeFragment.indexOf("?");
    return {
        base: mark < 0 ? beforeFragment : beforeFragment.slice(0, mark),
        query: mark < 0 ? "" : beforeFragment.slice(mark + 1),
        fragment,
    };
}
function normalizedName(raw) {
    try {
        return decodeURIComponent(raw).toLowerCase();
    }
    catch {
        return raw.toLowerCase();
    }
}
/**
 * A pair's value as the beacon reads it: `+` as a space, decoded once, then trimmed and lowercased. Empty when it
 * cannot decode or holds a control character, which the beacon rejects before it trims (so `%0Abio-link` is not
 * the placement `bio-link`).
 */
function normalizedValue(raw) {
    try {
        const decoded = decodeURIComponent(raw.replace(/\+/gu, " "));
        return /[\u0000-\u001f\u007f-\u009f]/u.test(decoded) ? "" : decoded.trim().toLowerCase();
    }
    catch {
        return "";
    }
}
function pairsOf(query) {
    return query.split("&").filter(pair => pair !== "").map(raw => {
        const equals = raw.indexOf("=");
        return {
            raw,
            name: normalizedName(equals < 0 ? raw : raw.slice(0, equals)),
            value: equals < 0 ? "" : normalizedValue(raw.slice(equals + 1)),
        };
    });
}
/**
 * Applies a change to an address's query string and returns the address. Pairs the change does not touch are kept
 * byte for byte and in order; empty pairs are dropped, so a bare `?` or `&&` never leaves a stray separator; no
 * remaining pair means no `?`; the fragment goes back last.
 */
export function rewriteQuery(address, change) {
    const { base, query, fragment } = splitAddress(address);
    const kept = pairsOf(query)
        .filter(pair => !change.remove?.has(pair.name) && !change.removeWhen?.(pair.name, pair.value))
        .map(pair => pair.raw);
    const added = (change.append ?? []).map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`);
    const pairs = [...kept, ...added];
    return `${base}${pairs.length ? `?${pairs.join("&")}` : ""}${fragment ? `#${fragment}` : ""}`;
}
/** Every `utm_content` value in an address, normalized the way the beacon reads one. */
export function placementValues(address) {
    return pairsOf(splitAddress(address).query).filter(pair => pair.name === PLACEMENT_PARAMETER).map(pair => pair.value);
}
/**
 * Writes a placement into an address. A key replaces every `utm_content` (the beacon drops a click's label unless
 * exactly one exists). No key removes a `utm_content` only when it is one of the site's own placement keys, so a
 * value another tool wrote stays.
 */
export function withPlacement(address, key, siteKeys) {
    return key
        ? rewriteQuery(address, { remove: new Set([PLACEMENT_PARAMETER]), append: [[PLACEMENT_PARAMETER, key]] })
        : rewriteQuery(address, {
            removeWhen: (name, value) => name === PLACEMENT_PARAMETER && siteKeys.has(value),
        });
}
/**
 * Whether the beacon would record a click on this address as an outbound click from the site: an absolute
 * `http(s)` address whose host differs from the site's (exact comparison, as the beacon does, so `www.` counts as
 * different) and fits the host grammar the beacon accepts (dotted, letter-led final label, so IP addresses and
 * single-label hosts never count). A site with no public address yet has no host to differ from.
 */
export function isOutsideLink(address, siteHost) {
    let url;
    try {
        url = new URL(address.trim());
    }
    catch {
        return false;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:")
        return false;
    const host = url.hostname.toLowerCase();
    return host !== siteHost.trim().toLowerCase() && ENGAGEMENT_HOST_PATTERN.test(host);
}
const SITE_AUTHORITY = /^(?:https?:)?\/\/([^/?#]*)([\s\S]*)$/iu;
/** Lowercased, a leading `www.` dropped. It does not trim: a space inside a pasted address is not part of a host. */
function bareHost(host) {
    return host.toLowerCase().replace(/^www\./u, "");
}
/**
 * Reads an address that starts with `http(s)://` or `//` and names the site's own host: no userinfo, no port,
 * a leading `www.` ignored on either side. Returns what follows the authority, or undefined for anything else.
 * One rule for the builder's path box and for a link in an email (TR01302), judged on the raw authority so an
 * explicit default port is refused the same way in both.
 */
export function ownSiteAuthority(address, siteHost) {
    const match = SITE_AUTHORITY.exec(address.trim());
    if (!match)
        return undefined;
    const host = match[1].toLowerCase();
    if (host === "" || /[@:]/u.test(host) || bareHost(host) !== bareHost(siteHost.trim()))
        return undefined;
    return { rest: match[2] };
}
/** Whether an address is an absolute `http(s)` link to the site's own host (an email link the toggle applies to). */
export function isOwnSiteLink(address, siteHost) {
    return /^https?:\/\//iu.test(address.trim()) && ownSiteAuthority(address, siteHost) !== undefined;
}
export const OTHER_SITE_ERROR = "Enter a path on this site.";
/**
 * Turns what a creator typed into a path on their own site: starting with `/`, with an existing query and
 * fragment kept. A pasted address must be on the site's own host (a leading `www.` on either side is ignored,
 * with no userinfo or port); its host is removed so a pasted address can never point the result elsewhere.
 * Spaces, control characters and non-ASCII characters are percent-encoded; every other byte is kept.
 */
export function normalizeSitePath(input, siteHost) {
    let rest = input.trim();
    if (SITE_AUTHORITY.test(rest)) {
        const own = ownSiteAuthority(rest, siteHost);
        if (!own)
            return { ok: false, error: OTHER_SITE_ERROR };
        rest = own.rest;
    }
    else if (/^[a-z][a-z0-9+.-]*:/iu.test(rest)) {
        return { ok: false, error: OTHER_SITE_ERROR };
    }
    else {
        // An address pasted without its scheme ("example.com/blog") is the site's own host followed by a path.
        const lead = /^([^/?#]+)([\s\S]*)$/u.exec(rest);
        if (lead && bareHost(lead[1]) === bareHost(siteHost.trim()))
            rest = lead[2];
    }
    const { base, query, fragment } = splitAddress(rest);
    const path = base === "" ? "/" : base.startsWith("/") ? base : `/${base}`;
    // A lone surrogate (a truncated emoji) cannot be percent-encoded and would throw; it becomes U+FFFD first.
    const wellFormed = (value) => value.replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/gu, "\ufffd");
    const encode = (value) => wellFormed(value).replace(/[^\x21-\x7e]/gu, character => encodeURIComponent(character));
    return {
        ok: true,
        path: encode(`${path}${query ? `?${query}` : ""}${fragment ? `#${fragment}` : ""}`),
    };
}
/** The medium and source the builder appends, then the optional campaign and placement. */
export function trackedAddress(siteHost, path, parts) {
    const append = [["utm_source", parts.source], ["utm_medium", parts.medium]];
    if (parts.campaign)
        append.push(["utm_campaign", parts.campaign]);
    if (parts.placement)
        append.push([PLACEMENT_PARAMETER, parts.placement]);
    return `https://${siteHost.trim().toLowerCase()}${rewriteQuery(path, { remove: BUILDER_UTM_PARAMETERS, append })}`;
}
/** What an address carries of a tracking, read the way the Worker reads it. `on` needs exactly one source and one medium that match. */
export function readEmailTracking(address, tracking) {
    const pairs = pairsOf(splitAddress(address).query);
    const values = (name) => pairs.filter(pair => pair.name === name).map(pair => pair.value);
    const sources = values("utm_source"), mediums = values("utm_medium");
    return {
        on: sources.length === 1 && sources[0] === tracking.source && mediums.length === 1
            && mediums[0] === tracking.medium,
        campaigns: values("utm_campaign"),
        placements: values(PLACEMENT_PARAMETER),
    };
}
/** Writes an email tracking into an address, replacing any source, medium, campaign or placement already on it. */
export function withEmailTracking(address, tracking) {
    const append = [["utm_source", tracking.source], ["utm_medium", tracking.medium]];
    if (tracking.campaign)
        append.push(["utm_campaign", tracking.campaign]);
    if (tracking.placement)
        append.push([PLACEMENT_PARAMETER, tracking.placement]);
    return rewriteQuery(address, { remove: BUILDER_UTM_PARAMETERS, append });
}
/**
 * Takes an email tracking back out: only what the switch writes. The source and medium go when they are the
 * Newsletter pair, a campaign or placement goes when it is one of the site's own keys, and any other value stays.
 */
export function withoutEmailTracking(address, tracking, siteKeys) {
    return rewriteQuery(address, {
        removeWhen: (name, value) => (name === "utm_source" && value === tracking.source)
            || (name === "utm_medium" && value === tracking.medium)
            || (name === "utm_campaign" && siteKeys.campaigns.has(value))
            || (name === PLACEMENT_PARAMETER && siteKeys.placements.has(value)),
    });
}
