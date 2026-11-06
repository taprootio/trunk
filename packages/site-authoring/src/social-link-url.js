// Generated from shared/social-link-url.ts by scripts/sync-field-validation.mjs. Do not edit.
/**
 * The one owner of which addresses a social link accepts (TR01324).
 *
 * A social link is an absolute https URL to a plain domain name. The rule is
 * literal on purpose: every verdict a URL parser might decide differently in
 * JavaScript and .NET (case folding, IDNA mapping, IPv4 shorthand, length
 * limits, whitespace) is decided here by explicit character checks first, and
 * the parser is only asked whether what remains parses at all. That keeps the
 * CLI, the generator, the editor and the API's own port in agreement, which
 * `shared/social-link-url-corpus.json` proves in each of them.
 *
 * It is pure and dependency-free. The generator and the site-authoring CLI
 * cannot import this file, so `node scripts/sync-field-validation.mjs` writes
 * their copies; edit only this file and re-run it. The editor imports it by
 * relative path.
 */
/** The longest address stored anywhere a social link lives. */
export const SOCIAL_LINK_URL_MAX_LENGTH = 2048;
/**
 * The whitespace a social link may not contain and a typed value is trimmed
 * of: the .NET `char.IsWhiteSpace` set, which the footer's single-line
 * normalisation already mirrors, plus U+FEFF, which JavaScript's `trim` strips
 * and .NET's does not.
 */
export function isSocialLinkWhiteSpace(codeUnit) {
    return (codeUnit >= 0x0009 && codeUnit <= 0x000d)
        || codeUnit === 0x0020
        || codeUnit === 0x0085
        || codeUnit === 0x00a0
        || codeUnit === 0x1680
        || (codeUnit >= 0x2000 && codeUnit <= 0x200a)
        || codeUnit === 0x2028
        || codeUnit === 0x2029
        || codeUnit === 0x202f
        || codeUnit === 0x205f
        || codeUnit === 0x3000
        || codeUnit === 0xfeff;
}
/** Strips the whitespace set above from both ends; what a typed address is judged on. */
export function trimSocialLinkInput(value) {
    let start = 0;
    let end = value.length;
    while (start < end && isSocialLinkWhiteSpace(value.charCodeAt(start)))
        start += 1;
    while (end > start && isSocialLinkWhiteSpace(value.charCodeAt(end - 1)))
        end -= 1;
    return value.slice(start, end);
}
/**
 * Control characters, the backslash, and the default-ignorable and format
 * code points that can hide inside an address; none has a place in a link.
 */
function isRefusedCodeUnit(codeUnit) {
    return codeUnit <= 0x001f
        || (codeUnit >= 0x007f && codeUnit <= 0x009f)
        || codeUnit === 0x005c
        || codeUnit === 0x00ad
        || codeUnit === 0x034f
        || (codeUnit >= 0x200b && codeUnit <= 0x200f)
        || (codeUnit >= 0x202a && codeUnit <= 0x202e)
        || (codeUnit >= 0x2060 && codeUnit <= 0x206f)
        || (codeUnit >= 0xfe00 && codeUnit <= 0xfe0f)
        || codeUnit >= 0xfff0;
}
/** Folds only A to Z, so no runtime's case mapping (U+212A to k, U+0130) can reach a verdict; the editors' field copy reads it too. */
export function asciiLower(value) {
    let result = "";
    for (let index = 0; index < value.length; index += 1) {
        const codeUnit = value.charCodeAt(index);
        result += codeUnit >= 0x41 && codeUnit <= 0x5a ? String.fromCharCode(codeUnit + 0x20) : value[index];
    }
    return result;
}
const LABEL_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;
/** A final label that is a number in decimal or hex makes the host an IPv4 form, which is refused. */
const NUMERIC_FINAL_LABEL_RE = /^(?:[0-9]+|0[xX][0-9a-fA-F]*)$/;
const PORT_RE = /^[0-9]+$/;
const HOST_MAX_LENGTH = 253;
const LABEL_MAX_LENGTH = 63;
function isAcceptedAuthority(authority) {
    if (authority.length === 0)
        return false;
    for (let index = 0; index < authority.length; index += 1) {
        const codeUnit = authority.charCodeAt(index);
        if (codeUnit > 0x7f)
            return false;
        const character = authority[index];
        if (character === "@" || character === "%" || character === "_")
            return false;
    }
    let host = authority;
    const colon = authority.indexOf(":");
    if (colon !== -1) {
        host = authority.slice(0, colon);
        const port = authority.slice(colon + 1);
        if (!PORT_RE.test(port))
            return false;
        const portNumber = Number(port);
        if (portNumber < 1 || portNumber > 65535)
            return false;
    }
    if (host.length > HOST_MAX_LENGTH)
        return false;
    const labels = host.split(".");
    if (labels.length < 2)
        return false;
    for (const label of labels) {
        if (label.length < 1 || label.length > LABEL_MAX_LENGTH || !LABEL_RE.test(label))
            return false;
        if (asciiLower(label).startsWith("xn--"))
            return false;
    }
    return !NUMERIC_FINAL_LABEL_RE.test(labels[labels.length - 1]);
}
/**
 * Whether a value, exactly as written, is an address a social link accepts.
 * Typed input is trimmed with `trimSocialLinkInput` first; a hand-written
 * document is judged as it is.
 */
export function isSocialLinkUrl(value) {
    if (typeof value !== "string" || value.length === 0 || value.length > SOCIAL_LINK_URL_MAX_LENGTH)
        return false;
    for (let index = 0; index < value.length; index += 1) {
        const codeUnit = value.charCodeAt(index);
        if (isSocialLinkWhiteSpace(codeUnit) || isRefusedCodeUnit(codeUnit))
            return false;
        if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
            const next = index + 1 < value.length ? value.charCodeAt(index + 1) : 0;
            if (next < 0xdc00 || next > 0xdfff)
                return false;
            index += 1;
        }
        else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
            return false;
        }
    }
    if (asciiLower(value.slice(0, 8)) !== "https://")
        return false;
    const rest = value.slice(8);
    let authorityEnd = rest.length;
    for (const terminator of ["/", "?", "#"]) {
        const at = rest.indexOf(terminator);
        if (at !== -1 && at < authorityEnd)
            authorityEnd = at;
    }
    if (!isAcceptedAuthority(rest.slice(0, authorityEnd)))
        return false;
    try {
        new URL(value);
    }
    catch {
        return false;
    }
    return true;
}
/** The address as published: the parsed form, as the footer emits its own links. */
export function socialLinkHref(value) {
    return new URL(value).toString();
}
