// Generated from shared/site-checks.ts by scripts/sync-field-validation.mjs. Do not edit.
/**
 * The site checks the CLI can evaluate offline (TR01085).
 *
 * `shared/site-check-rules.json` is the catalogue of rules; this file is the
 * TypeScript interpretation of the ones that need only a page body or a redirect
 * source. The API carries a second interpretation in C#
 * (`Taproot.Domain/SiteChecks`), and both must pass
 * `shared/site-check-corpus.json`. Results carry rule ids and values, never
 * wording: each surface writes its own words.
 *
 * It is dependency-free so the published site-authoring package can carry a
 * compiled copy. The package cannot import this file, so
 * `node scripts/sync-field-validation.mjs` writes that copy; edit only this file
 * and re-run it.
 */
export const RULE_LINK_PAGE_MISSING = "link.page_missing";
export const RULE_REDIRECT_SOURCE_INVALID = "redirect.source_invalid";
export const RULE_REDIRECT_SOURCE_INDEX_HTML = "redirect.source_index_html";
export const RULE_REDIRECT_SOURCE_INTEGRATION_DATA = "redirect.source_integration_data";
export const RULE_REDIRECT_SOURCE_SHARE_LINK = "redirect.source_share_link";
export const RULE_REDIRECT_SOURCE_RUNTIME_MIRROR = "redirect.source_runtime_mirror";
export const RULE_REDIRECT_SOURCE_GENERATED_FILE = "redirect.source_generated_file";
export const RULE_REDIRECT_SOURCE_NOT_STORABLE = "redirect.source_not_storable";
const NON_PAGE_EXTENSIONS = new Set([
    ".avif", ".css", ".csv", ".doc", ".docx", ".gif", ".ico",
    ".jpeg", ".jpg", ".js", ".json", ".m4a", ".mov", ".mp3",
    ".mp4", ".pdf", ".png", ".svg", ".txt", ".wav", ".webm",
    ".webp", ".xls", ".xlsx", ".xml", ".zip",
]);
// The HTML 4 named character references, the table .NET's WebUtility.HtmlDecode (the server's decoder) uses,
// as name:code point pairs, with apos added.
const NAMED_ENTITY_CODES = "AElig:198 Aacute:193 Acirc:194 Agrave:192 Alpha:913 Aring:197 Atilde:195 Auml:196 Beta:914 Ccedil:199 " +
    "Chi:935 Dagger:8225 Delta:916 ETH:208 Eacute:201 Ecirc:202 Egrave:200 Epsilon:917 Eta:919 Euml:203 Gamma:915 " +
    "Iacute:205 Icirc:206 Igrave:204 Iota:921 Iuml:207 Kappa:922 Lambda:923 Mu:924 Ntilde:209 Nu:925 OElig:338 " +
    "Oacute:211 Ocirc:212 Ograve:210 Omega:937 Omicron:927 Oslash:216 Otilde:213 Ouml:214 Phi:934 Pi:928 " +
    "Prime:8243 Psi:936 Rho:929 Scaron:352 Sigma:931 THORN:222 Tau:932 Theta:920 Uacute:218 Ucirc:219 Ugrave:217 " +
    "Upsilon:933 Uuml:220 Xi:926 Yacute:221 Yuml:376 Zeta:918 aacute:225 acirc:226 acute:180 aelig:230 agrave:224 " +
    "alefsym:8501 alpha:945 amp:38 and:8743 ang:8736 aring:229 asymp:8776 atilde:227 auml:228 bdquo:8222 beta:946 " +
    "brvbar:166 bull:8226 cap:8745 ccedil:231 cedil:184 cent:162 chi:967 circ:710 clubs:9827 cong:8773 copy:169 " +
    "crarr:8629 cup:8746 curren:164 dArr:8659 dagger:8224 darr:8595 deg:176 delta:948 diams:9830 divide:247 " +
    "eacute:233 ecirc:234 egrave:232 empty:8709 emsp:8195 ensp:8194 epsilon:949 equiv:8801 eta:951 eth:240 " +
    "euml:235 euro:8364 exist:8707 fnof:402 forall:8704 frac12:189 frac14:188 frac34:190 frasl:8260 gamma:947 " +
    "ge:8805 gt:62 hArr:8660 harr:8596 hearts:9829 hellip:8230 iacute:237 icirc:238 iexcl:161 igrave:236 " +
    "image:8465 infin:8734 int:8747 iota:953 iquest:191 isin:8712 iuml:239 kappa:954 lArr:8656 lambda:955 " +
    "lang:9001 laquo:171 larr:8592 lceil:8968 ldquo:8220 le:8804 lfloor:8970 lowast:8727 loz:9674 lrm:8206 " +
    "lsaquo:8249 lsquo:8216 lt:60 macr:175 mdash:8212 micro:181 middot:183 minus:8722 mu:956 nabla:8711 nbsp:160 " +
    "ndash:8211 ne:8800 ni:8715 not:172 notin:8713 nsub:8836 ntilde:241 nu:957 oacute:243 ocirc:244 oelig:339 " +
    "ograve:242 oline:8254 omega:969 omicron:959 oplus:8853 or:8744 ordf:170 ordm:186 oslash:248 otilde:245 " +
    "otimes:8855 ouml:246 para:182 part:8706 permil:8240 perp:8869 phi:966 pi:960 piv:982 plusmn:177 pound:163 " +
    "prime:8242 prod:8719 prop:8733 psi:968 quot:34 rArr:8658 radic:8730 rang:9002 raquo:187 rarr:8594 rceil:8969 " +
    "rdquo:8221 real:8476 reg:174 rfloor:8971 rho:961 rlm:8207 rsaquo:8250 rsquo:8217 sbquo:8218 scaron:353 " +
    "sdot:8901 sect:167 shy:173 sigma:963 sigmaf:962 sim:8764 spades:9824 sub:8834 sube:8838 sum:8721 sup:8835 " +
    "sup1:185 sup2:178 sup3:179 supe:8839 szlig:223 tau:964 there4:8756 theta:952 thetasym:977 thinsp:8201 " +
    "thorn:254 tilde:732 times:215 trade:8482 uArr:8657 uacute:250 uarr:8593 ucirc:251 ugrave:249 uml:168 " +
    "upsih:978 upsilon:965 uuml:252 weierp:8472 xi:958 yacute:253 yen:165 yuml:255 zeta:950 zwj:8205 zwnj:8204";
const NAMED_ENTITIES = {
    apos: "'",
    ...Object.fromEntries(NAMED_ENTITY_CODES.split(" ").map((pair) => {
        const [name, code] = pair.split(":");
        return [name, String.fromCodePoint(Number(code))];
    })),
};
function htmlDecode(value) {
    return value.replace(/&(?:#(\d+)|#[xX]([0-9a-fA-F]+)|([A-Za-z][A-Za-z0-9]*));/gu, (match, decimal, hex, name) => {
        if (name !== undefined)
            return NAMED_ENTITIES[name] ?? match;
        const code = decimal !== undefined ? Number.parseInt(decimal, 10) : Number.parseInt(hex, 16);
        return Number.isInteger(code) && code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
            ? String.fromCodePoint(code)
            : match;
    });
}
function htmlDecodeRepeatedly(value) {
    let decoded = value;
    for (let index = 0; index < 3; index++) {
        const next = htmlDecode(decoded);
        if (next === decoded)
            break;
        decoded = next;
    }
    return decoded;
}
/** Percent-decoding that leaves a malformed run as written, the way .NET's does. */
function unescapeData(value) {
    return value.replace(/(?:%[0-9a-fA-F]{2})+/gu, (run) => {
        try {
            return decodeURIComponent(run);
        }
        catch {
            return run;
        }
    });
}
/** The stored spelling of a page path: slashes trimmed, backslashes forward. */
export function normalizeStoredPath(path) {
    const normalized = (path ?? "").trim().replaceAll("\\", "/").replace(/^\/+|\/+$/gu, "");
    return normalized === "." ? "" : normalized;
}
function normalizeSegments(path) {
    const segments = [];
    for (const segment of path.split("/")) {
        if (segment === "" || segment === ".")
            continue;
        if (segment === "..") {
            if (segments.length === 0)
                return null;
            segments.pop();
            continue;
        }
        segments.push(segment);
    }
    return segments.join("/").replace(/\/+$/gu, "");
}
function resolveRelativePath(currentPagePath, relative) {
    const current = normalizeStoredPath(currentPagePath);
    const slash = current.lastIndexOf("/");
    const directory = slash >= 0 ? current.slice(0, slash) : "";
    return normalizeSegments(directory.length === 0 ? relative : `${directory}/${relative}`);
}
function isNonPageAsset(path) {
    const fileName = path.slice(path.lastIndexOf("/") + 1);
    const extensionIndex = fileName.lastIndexOf(".");
    return extensionIndex >= 0 && NON_PAGE_EXTENSIONS.has(fileName.slice(extensionIndex).toLowerCase());
}
function addCandidate(links, rawValue, currentPagePath) {
    let value = htmlDecode(rawValue).trim();
    if (value.length === 0 || value.startsWith("#") || value.startsWith("?") || value.startsWith("//")
        || value.includes("\\"))
        return;
    const isRootRelative = value.startsWith("/");
    if (!isRootRelative && /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(value))
        return;
    let delimiter = value.search(/[?#]/u);
    if (delimiter >= 0)
        value = value.slice(0, delimiter);
    if (value.length === 0)
        return;
    value = unescapeData(value);
    // Encoded query and fragment delimiters become visible only after decoding.
    delimiter = value.search(/[?#]/u);
    if (delimiter >= 0)
        value = value.slice(0, delimiter);
    if (value.length === 0)
        return;
    const target = isRootRelative ? normalizeSegments(value) : resolveRelativePath(currentPagePath, value);
    if (target === null || isNonPageAsset(target))
        return;
    const link = target.length === 0 ? "/" : `/${target}`;
    const key = link.toUpperCase();
    if (!links.has(key))
        links.set(key, link);
}
const HREF_PATTERN = /\bhref\s*=\s*(?:["']([^"']*)["']|([^\s"'=<>`]+))/giu;
function addHtmlLinks(links, html, currentPagePath) {
    for (const match of htmlDecodeRepeatedly(html).matchAll(HREF_PATTERN)) {
        addCandidate(links, match[1] ?? match[2] ?? "", currentPagePath);
    }
}
function isUrlProperty(name) {
    const lower = name.toLowerCase();
    return lower === "href" || lower === "url" || lower === "link" || lower === "pagepath";
}
function addEncodedComponentLinks(links, value, currentPagePath) {
    const decoded = htmlDecodeRepeatedly(value);
    let parsed;
    try {
        parsed = JSON.parse(decoded);
    }
    catch {
        if (/<a/iu.test(decoded))
            addHtmlLinks(links, decoded, currentPagePath);
        return;
    }
    addLinks(links, parsed, currentPagePath);
}
function addLinks(links, element, currentPagePath) {
    if (Array.isArray(element)) {
        for (const item of element)
            addLinks(links, item, currentPagePath);
        return;
    }
    if (element === null || typeof element !== "object")
        return;
    for (const [name, value] of Object.entries(element)) {
        if (typeof value === "string") {
            if (isUrlProperty(name))
                addCandidate(links, value, currentPagePath);
            if (/<a/iu.test(value))
                addHtmlLinks(links, value, currentPagePath);
            if (name.toLowerCase() === "componentdata")
                addEncodedComponentLinks(links, value, currentPagePath);
        }
        else {
            addLinks(links, value, currentPagePath);
        }
    }
}
/**
 * The page-shaped internal link targets a page body holds, as `/path`, in
 * case-insensitive order. It reads rich-text hrefs, HTML anchors and URL-bearing
 * component properties, and skips external URLs, fragments, queries and asset
 * extensions. `templateData` is the parsed body.
 */
export function extractPageLinks(templateData, currentPagePath) {
    const links = new Map();
    addLinks(links, templateData, currentPagePath);
    return [...links.entries()]
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([, link]) => link);
}
/** The set `missingPageLinkFindings` looks links up in: page paths in the stored spelling, lower-cased. Build it once per site. */
export function normalizedPathSet(pagePaths) {
    return new Set([...pagePaths].map((path) => normalizeStoredPath(path).toLowerCase()));
}
/**
 * The `link.page_missing` findings for one page: every internal link whose
 * target is not in `knownPaths` (see `normalizedPathSet`).
 */
export function missingPageLinkFindings(templateData, currentPagePath, knownPaths) {
    return extractPageLinks(templateData, currentPagePath)
        .filter((link) => !knownPaths.has(normalizeStoredPath(link).toLowerCase()))
        .map((link) => ({ ruleId: RULE_LINK_PAGE_MISSING, severity: "warning", subject: link, detail: "" }));
}
// ---------------------------------------------------------------- redirects
const RUNTIME_MIRROR_PATH = /^taproot\/[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\/|$)/iu;
/** Whether a site-relative path (no leading slash) is `taproot/<semver>` or under it. */
export function isRuntimeMirrorPath(path) {
    return RUNTIME_MIRROR_PATH.test(path);
}
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F-\u009F]/u;
// A spelling no browser would send as a pathname: anything outside printable ASCII, a character a URL
// parser escapes on sight, or a '%' that is not an escape. No `i` flag: Unicode case folding would let
// U+212A and U+017F through `[^!-~]`.
const UNSENDABLE_SPELLING = /[^!-~]|["<>`{}]|%(?![0-9a-fA-F]{2})/u;
const RESOLVABLE_SPELLING = /\/\/|%2e|%2f/iu;
/** Whether a path is written the way a browser sends a pathname. */
export function isRequestSpelling(value) {
    return !UNSENDABLE_SPELLING.test(value);
}
/**
 * Whether a path names one thing to this pass and another wherever it is resolved: an empty interior
 * segment, a dot segment, or a dot or slash hidden behind percent-encoding.
 */
export function resolvesAway(value) {
    if (RESOLVABLE_SPELLING.test(value))
        return true;
    return value.split("/").some((segment) => segment === "." || segment === "..");
}
/**
 * Normalizes a source path as the published-site Worker's `normalizePathname`
 * does: require the leading slash, strip trailing slashes, change nothing else.
 * Returns undefined for anything that is not an absolute site path, or that some
 * other layer would resolve away or no browser would send.
 */
export function normalizeRedirectPath(value) {
    if (typeof value !== "string")
        return undefined;
    const candidate = value.trim();
    if (candidate === "" || /[?#\\]/u.test(candidate) || !isRequestSpelling(candidate) || resolvesAway(candidate)) {
        return undefined;
    }
    const withSlash = candidate.startsWith("/") ? candidate : `/${candidate}`;
    const trimmed = withSlash.replace(/\/+$/u, "");
    return trimmed === "" ? "/" : trimmed;
}
const GENERATED_ROOT_FILES = ["404.html", "sitemap.xml", "robots.txt", "favicon.ico"];
const INTEGRATION_DATA_ROOT = "integrations";
const SHARE_LINK_ROOT = "s";
const MAX_MARKER_SEGMENT_BYTES = 200;
const MAX_OUTPUT_PATH_LENGTH = 1_024;
const WINDOWS_DEVICE_STEMS = new Set(["con", "prn", "aux", "nul"]);
function isWindowsDeviceSegment(segment) {
    const stem = segment.split(".", 1)[0].toLowerCase();
    return WINDOWS_DEVICE_STEMS.has(stem) || /^(?:com|lpt)[1-9]$/u.test(stem);
}
function isStorable(decoded) {
    const output = `${decoded}/index.html`;
    if (output !== output.normalize("NFC") || output.length > MAX_OUTPUT_PATH_LENGTH || output.startsWith("/")
        || /[\\%?#]/u.test(output) || CONTROL_CHARACTERS.test(output))
        return false;
    const segments = decoded.split("/");
    return !decoded.includes("..") && !segments.some((segment) => segment === "" || segment === "." || segment.startsWith(".") || isWindowsDeviceSegment(segment)
        || new TextEncoder().encode(segment).length > MAX_MARKER_SEGMENT_BYTES);
}
/**
 * Which redirect source rule an edge-form source path breaks, or undefined when
 * it can be a redirect. `detail` is the first decoded path segment, which two of
 * the refusals name. The site root is left to the occupancy rule.
 */
export function redirectSourceRule(edgePath) {
    if (edgePath === "/")
        return undefined;
    // Every rule reads the decoded spelling, the name the marker is stored under.
    const decoded = unescapeData(edgePath.replace(/^\/+/u, "").replace(/\/+$/u, ""));
    const segments = decoded.split("/");
    const first = segments[0];
    const refuse = (ruleId) => ({ ruleId, detail: first });
    if (segments.some((segment) => segment.toLowerCase() === "index.html")) {
        return refuse(RULE_REDIRECT_SOURCE_INDEX_HTML);
    }
    if (first.toLowerCase() === INTEGRATION_DATA_ROOT)
        return refuse(RULE_REDIRECT_SOURCE_INTEGRATION_DATA);
    const shareSegments = decoded.replace(/^\/+|\/+$/gu, "").split("/");
    if (shareSegments.length > 1 && shareSegments[1].length > 0 && shareSegments[0].toLowerCase() === SHARE_LINK_ROOT) {
        return refuse(RULE_REDIRECT_SOURCE_SHARE_LINK);
    }
    if (isRuntimeMirrorPath(decoded))
        return refuse(RULE_REDIRECT_SOURCE_RUNTIME_MIRROR);
    if (GENERATED_ROOT_FILES.includes(first.toLowerCase()))
        return refuse(RULE_REDIRECT_SOURCE_GENERATED_FILE);
    if (!isStorable(decoded))
        return refuse(RULE_REDIRECT_SOURCE_NOT_STORABLE);
    return undefined;
}
/**
 * The normalized source and the finding for what a caller submitted. A source
 * that normalizes to nothing is `redirect.source_invalid`; otherwise the first
 * source rule it breaks. `finding` is undefined when the source is acceptable.
 */
export function checkRedirectSource(submitted) {
    const path = normalizeRedirectPath(submitted);
    if (path === undefined) {
        return {
            finding: {
                ruleId: RULE_REDIRECT_SOURCE_INVALID,
                severity: "error",
                subject: typeof submitted === "string" ? submitted : "",
                detail: "",
            },
        };
    }
    const refusal = redirectSourceRule(path);
    return refusal === undefined
        ? { path }
        : { path, finding: { ruleId: refusal.ruleId, severity: "error", subject: path, detail: refusal.detail } };
}
