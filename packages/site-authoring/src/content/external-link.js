// Generated from shared/external-link.ts by scripts/sync-field-validation.mjs. Do not edit.
/**
 * The one owner of which links open in a new tab (TR01327).
 *
 * A link opens in a new tab when its address is an absolute http or https URL
 * whose host is not one of the site's own. Everything else (relative paths,
 * fragments, mailto, tel, anything that does not parse) stays in the tab.
 *
 * It is pure and dependency-free. The generator, the editor and the
 * site-authoring CLI cannot import this file across project roots, so
 * `node scripts/sync-field-validation.mjs` writes their copies; edit only this
 * file and re-run it.
 */
/** A host as the rule compares it: lowercase, with one leading `www.` dropped. */
export function normalizeLinkHost(host) {
    const lowered = (host ?? "").trim().toLowerCase();
    return lowered.startsWith("www.") ? lowered.slice(4) : lowered;
}
/** The site's own hosts, normalized. Empty and missing hosts are left out. */
export function siteLinkHosts(hosts) {
    const set = new Set();
    for (const host of hosts) {
        const normalized = normalizeLinkHost(host);
        if (normalized)
            set.add(normalized);
    }
    return set;
}
/** True for an absolute http or https URL to a host outside the set. */
export function isExternalLink(href, siteHosts) {
    if (!href)
        return false;
    let parsed;
    try {
        parsed = new URL(href.trim());
    }
    catch {
        return false;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
        return false;
    return !siteHosts.has(normalizeLinkHost(parsed.hostname));
}
/** A rel with `noopener noreferrer` after its existing tokens, without duplicates. */
export function relWithNewTabTokens(rel) {
    const tokens = new Set((rel ?? "").split(/\s+/u).filter(Boolean));
    tokens.add("noopener");
    tokens.add("noreferrer");
    return [...tokens].join(" ");
}
/**
 * The `target` and `rel` attributes for a link that opens in a new tab, as
 * markup with a leading space. The values are tokens, so nothing needs escaping.
 */
export function newTabAttributeMarkup(rel) {
    return ` target="_blank" rel="${relWithNewTabTokens(rel)}"`;
}
/**
 * What a screen reader hears after a link's name when it opens a new tab. These
 * are the words Espalier appends to its own links, so a native anchor and an
 * `esp-button` read alike. `generator/browser-tests/new-tab-cue.spec.ts` holds
 * the two together.
 */
export const NEW_TAB_CUE_TEXT = " (opens in a new tab)";
/**
 * The cue for a native anchor, as its last child. Pagefind indexes raw HTML, so
 * `data-pagefind-ignore` keeps the words out of search content and excerpts.
 * Output without `NEW_TAB_CUE_CSS` would show the words, so only published pages
 * may carry it.
 */
export const NEW_TAB_CUE_HTML = `<span class="sr-only" data-pagefind-ignore>${NEW_TAB_CUE_TEXT}</span>`;
/** Hides the cue from sight only. The page shell and each shadow stylesheet with a cued anchor carry it. */
export const NEW_TAB_CUE_CSS = ".sr-only{position:absolute;width:0.0625rem;height:0.0625rem;padding:0;margin:-0.0625rem;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}";
/** Rendered HTML without its cues, for code that reads a link's text back. */
export function withoutNewTabCue(html) {
    return html.split(NEW_TAB_CUE_HTML).join("");
}
