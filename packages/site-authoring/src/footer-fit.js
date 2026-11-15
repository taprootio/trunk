// Generated from shared/footer-fit.ts by scripts/sync-field-validation.mjs. Do not edit.
import { FOOTER_LOGO_BOX, resolveFooterLogoScale } from "./footer-branding.js";
import { FOOTER_WIDTHS, MAX_FOOTER_FIT_FINDINGS } from "./footer-fit-widths.js";
import { FOOTER_FONT_METRICS } from "./footer-font-metrics.js";
export { footerBrandSizeStyles } from "./footer-branding.js";
export { FOOTER_FIT_WIDTH_LABELS, FOOTER_WIDTHS, MAX_FOOTER_FIT_FINDINGS, } from "./footer-fit-widths.js";
const noto = (fontSize, bold = false) => ({
    fontSize,
    fontWeight: bold ? "700" : "400",
    fontFamily: "\"Noto Sans\", sans-serif",
    metricProfile: bold ? "noto700" : "noto400",
    boldMetricProfile: "noto700",
});
const inika = (fontSize) => ({
    fontSize,
    fontWeight: "400",
    fontFamily: "\"Inika\", serif",
    metricProfile: "inika400",
    boldMetricProfile: "inika700",
});
function assumption(width, viewportWidth, padding, brandGap, type) {
    return {
        width,
        viewportWidth,
        paddingInline: padding,
        columnGap: padding,
        brandGap,
        type,
        roles: {
            link: noto(type.normal, true),
            groupHeading: inika(type.normal),
            brand: inika(type.medium),
            brandLarge: inika(type.big),
            brandLargeCompact: inika(type.large),
            asideHeading: inika(type.large),
            asideBody: noto(type.normal),
            asideCta: noto(type.normal),
        },
    };
}
// Espalier 7 default scale, Taproot's default theme: 16px root, 1.25 type,
// 1.618 space, 320–1200 viewport clamps. Viewport includes both inline pads.
// Values retain clamp rounding; the production style oracle guards this table.
export const DEFAULT_FIT_ASSUMPTIONS = {
    desktop: assumption(1152, 1194, 20.862692, 12.920528, {
        tiny: 15.332618,
        small: 19.166172,
        normal: 23.95642,
        medium: 29.946921,
        big: 37.431957,
        large: 46.791241,
        huge: 58.489953,
    }),
    small_desktop: assumption(1025, 1063, 19.198797, 12.441313, {
        tiny: 14.763867,
        small: 18.455234,
        normal: 23.067845,
        medium: 28.836138,
        big: 36.043575,
        large: 45.055666,
        huge: 56.320516,
    }),
    tablet: assumption(769, 801, 15.844804, 11.475336, {
        tiny: 13.617409,
        small: 17.022162,
        normal: 21.276702,
        medium: 26.597078,
        big: 33.244946,
        large: 41.557184,
        huge: 51.947479,
    }),
    phone: assumption(360, 381, 10.486277, 9.932036, {
        tiny: 11.785764,
        small: 14.732605,
        normal: 18.415071,
        medium: 23.019829,
        big: 28.773701,
        large: 35.967811,
        huge: 44.960869,
    }),
    small_phone: assumption(300.5824, 320, 9.7088, 9.7088, {
        tiny: 11.52,
        small: 14.4,
        normal: 18,
        medium: 22.5008,
        big: 28.1248,
        large: 35.1568,
        huge: 43.94592,
    }),
};
// The independent Espalier fixture uses bundled Inter v4.001, 16px inherited
// normal type, bold links/headings, and 24px gaps.
export const CALIBRATION_FIT_ASSUMPTIONS = Object.fromEntries(FOOTER_WIDTHS.map(width => {
    const base = DEFAULT_FIT_ASSUMPTIONS[width];
    const font = {
        fontSize: 16,
        fontWeight: "700",
        fontFamily: "\"Inter\", sans-serif",
        metricProfile: "inter700",
        boldMetricProfile: "inter700",
    };
    return [width, {
            ...base,
            columnGap: 24,
            brandGap: 24,
            roles: Object.fromEntries(Object.keys(base.roles).map(role => [role, { ...font }])),
        }];
}));
export const footerTargetIsSet = (target) => Boolean(target.pageResourceId || target.externalUrl);
/** The same presence test the generator's renderAside uses, including CTA resolution. */
export function footerAsideRenders(heading, body, ctaResolves) {
    const text = (paragraph) => paragraph?.runs?.some(run => Boolean(run.text)) ?? false;
    return text(heading?.paragraphs?.[0]) || (body?.paragraphs?.some(text) ?? false) || ctaResolves;
}
/** Offline callers treat set targets as present; the deploy supplies its real resolver. */
export function buildFooterFitInput(settings, brand = {}, resolves = footerTargetIsSet) {
    const value = settings ?? {};
    const brandText = value.showBrandText === false ? "" : brand.brandText ?? "";
    const hasLogo = brand.hasLogo === true;
    const paragraph = (p) => ({
        runs: (p?.runs ?? []).map(run => ({
            text: run.text ?? "",
            bold: run.bold === true,
            link: Boolean(run.link && resolves(run.link)),
        })),
    });
    const ctaResolves = Boolean(value.asideCta && resolves(value.asideCta));
    return {
        enabled: value.enabled === true,
        brand: value.showBrand !== false && (hasLogo || brandText)
            ? {
                text: brandText,
                hasLogo,
                logoAspectRatio: brand.logoAspectRatio,
                span: value.brandSpan ?? 1,
                size: value.brandSize || "standard",
                logoScale: resolveFooterLogoScale(value.logoScale, value.brandSize).canonical,
            }
            : undefined,
        columns: (value.linkColumns ?? []).flatMap(column => {
            const groups = (column.groups ?? []).flatMap(group => {
                const labels = (group.links ?? []).filter(resolves).map(link => link.label ?? "");
                return labels.length ? [{ heading: group.heading, labels }] : [];
            });
            return groups.length ? [{ span: column.span ?? 1, groups }] : [];
        }),
        aside: footerAsideRenders(value.asideHeadingContent, value.asideBodyContent, ctaResolves)
            ? {
                span: value.asideSpan ?? 1,
                heading: paragraph(value.asideHeadingContent?.paragraphs?.[0]),
                body: (value.asideBodyContent?.paragraphs ?? []).map(paragraph),
                ctaLabel: ctaResolves ? value.asideCta?.label : undefined,
            }
            : undefined,
    };
}
/** Use the wider known scheme. An unavailable measurement keeps the 4:1 estimate. */
export function footerLogoAspectRatio(ratios) {
    const known = ratios.flatMap(ratio => {
        const parts = typeof ratio === "string" ? ratio.split("/").map(Number) : [];
        const n = typeof ratio === "number" ? ratio : parts.length === 2 ? parts[0] / parts[1] : Number(ratio);
        return Number.isFinite(n) && n > 0 ? [n] : [];
    });
    return known.length ? Math.max(...known) : undefined;
}
const ordinarySpace = (text) => /[^\S\u00a0\u202f\u2007\ufeff]/u.test(text);
const joiningCharacter = (text = "") => /[\u00a0\u202f\u2007\ufeff\u2060]/u.test(text);
const zeroAdvance = (text) => /[\u00ad\u200b\ufeff\u2060]/u.test(text);
const unsupportedBreakingScript = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}]/u;
function characterAdvance(character) {
    if (zeroAdvance(character.text))
        return 0;
    const metrics = FOOTER_FONT_METRICS[character.profile];
    const codePoint = character.text.codePointAt(0);
    const supported = metrics.advances[codePoint];
    if (supported !== undefined)
        return supported;
    // These joining spaces retain their spacing even when a source cmap omits them.
    if (character.text === "\u00a0" || character.text === "\u202f") {
        return metrics.advances[32] ?? metrics.unsupportedAdvance;
    }
    if (character.text === "\u2007")
        return metrics.advances[48] ?? metrics.unsupportedAdvance;
    return metrics.unsupportedAdvance;
}
function measuredCharacters(characters, fontSize) {
    let width = 0;
    let previous;
    for (const character of characters) {
        if (zeroAdvance(character.text))
            continue;
        width += characterAdvance(character);
        const left = previous?.text.codePointAt(0) ?? 0;
        const right = character.text.codePointAt(0);
        if (previous?.profile === character.profile && left >= 32 && left <= 126 && right >= 32 && right <= 126) {
            width += FOOTER_FONT_METRICS[character.profile].positivePairs[left * 128 + right] ?? 0;
        }
        previous = character;
    }
    return {
        text: characters.map(character => character.text).join("").replace(/[\u00ad\u200b]/gu, ""),
        width: width * fontSize,
    };
}
/** Bounded Latin-style break fragments, with default-font advances rather than contextual shaping. */
export function footerFitSegments(paragraph, font, availableWidth = Infinity) {
    const characters = [];
    for (const run of paragraph.runs ?? []) {
        const profile = run.bold || run.link ? font.boldMetricProfile : font.metricProfile;
        for (const text of run.text ?? "") {
            if (ordinarySpace(text)) {
                if (characters[characters.length - 1]?.text === " ")
                    continue;
                characters.push({ text: " ", profile });
            }
            else
                characters.push({ text, profile });
        }
    }
    const result = [];
    let current = [];
    const append = (fragment, hyphenProfile) => {
        if (hyphenProfile && fragment.length)
            fragment = [...fragment, { text: "-", profile: hyphenProfile }];
        const measured = measuredCharacters(fragment, font.fontSize);
        if (measured.text)
            result.push(measured);
    };
    const flush = () => {
        // A discretionary hyphen is invisible when the complete word already fits.
        if (measuredCharacters(current, font.fontSize).width > availableWidth) {
            let fragment = [];
            for (const character of current) {
                if (character.softBreak) {
                    append(fragment, character.profile);
                    fragment = [];
                }
                else
                    fragment.push(character);
            }
            append(fragment);
        }
        else
            append(current);
        current = [];
    };
    for (const [index, character] of characters.entries()) {
        const text = character.text;
        // Look at both sides before committing a break, including across rich-text runs.
        const joined = joiningCharacter(characters[index - 1]?.text) || joiningCharacter(characters[index + 1]?.text);
        if ((text === " " || text === "\u200b") && !joined) {
            flush();
            continue;
        }
        if (/[\u2012-\u2014]/u.test(text) && !joined)
            flush();
        current.push({ ...character, softBreak: text === "\u00ad" && !joined });
        if (/[-\u2010\u2012-\u2014]/u.test(text) && !joined)
            flush();
    }
    flush();
    return result;
}
const plain = (text = "") => ({ runs: [{ text }] });
/** Findings are widest first, then brand/column order/aside, once per word and region. */
export function footerFitFindings(input, assumptions = DEFAULT_FIT_ASSUMPTIONS) {
    if (!input.enabled)
        return { findings: [], total: 0 };
    const found = [];
    const seen = new Set();
    const columns = input.columns.filter(column => column.groups.some(group => group.labels.length));
    const brand = input.brand && (input.brand.hasLogo || input.brand.text) ? input.brand : undefined;
    for (const name of FOOTER_WIDTHS) {
        const a = assumptions[name];
        const stacked = a.width <= 768;
        const middle = !stacked && a.width <= 1024;
        const brandSpan = brand?.span ?? 1;
        const asideSpan = input.aside?.span ?? 1;
        const totalSpan = columns.reduce((sum, column) => sum + (column.span ?? 1), 0)
            + (input.aside ? asideSpan : 0) + (brand && !middle ? brandSpan : 0);
        const regionWidth = (span) => stacked || (middle && totalSpan === 0)
            ? a.width
            : span * (a.width - (totalSpan - 1) * a.columnGap) / totalSpan + (span - 1) * a.columnGap;
        const check = (paragraph, font, width, region) => {
            for (const word of footerFitSegments(paragraph, font, Math.max(0, width))) {
                const key = `${region}\0${word.text}`;
                if (unsupportedBreakingScript.test(word.text) || word.width <= Math.max(0, width) || seen.has(key))
                    continue;
                seen.add(key);
                found.push({
                    ruleId: "footer.word_breaks",
                    severity: "warning",
                    subject: word.text,
                    detail: `${name}:${region}`,
                });
            }
        };
        if (brand) {
            let width = middle || stacked ? a.width : regionWidth(brandSpan);
            if (brand.hasLogo && brand.text) {
                const scale = resolveFooterLogoScale(brand.logoScale, brand.size).scale;
                const height = FOOTER_LOGO_BOX.heightRem * 16 * scale;
                const max = FOOTER_LOGO_BOX.maxWidthRem * 16 * scale;
                width -= Math.min(height * (brand.logoAspectRatio ?? 4), max) + a.brandGap;
            }
            const font = brand.size === "large" ? (stacked ? a.roles.brandLargeCompact : a.roles.brandLarge) : a.roles.brand;
            check(plain(brand.text), font, width, "brand");
        }
        for (const column of columns) {
            const width = regionWidth(column.span ?? 1);
            for (const group of column.groups) {
                if (!group.labels.length)
                    continue;
                check(plain(group.heading), a.roles.groupHeading, width, "column");
                for (const label of group.labels)
                    check(plain(label), a.roles.link, width, "column");
            }
        }
        if (input.aside) {
            const width = regionWidth(asideSpan);
            check(input.aside.heading ?? {}, a.roles.asideHeading, width, "aside");
            for (const p of input.aside.body ?? [])
                check(p, a.roles.asideBody, width, "aside");
            check(plain(input.aside.ctaLabel), a.roles.asideCta, width, "aside");
        }
    }
    return { findings: found.slice(0, MAX_FOOTER_FIT_FINDINGS), total: found.length };
}
