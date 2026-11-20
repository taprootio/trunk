// Generated from shared/chrome-features.ts by scripts/sync-field-validation.mjs. Do not edit.
import { isTallHeaderPaint } from "@taprootio/espalier/shared/theme";
import { resolveFooterTarget } from "./footer-content.js";
import { resolveHeaderChromePresentation } from "./header-presentation.js";
import { describeHeaderNavigationItem, MAX_NAVIGATION_DEPTH, prepareHeaderNavigation, SITE_NAVIGATION_KINDS, } from "./site-navigation-groups.js";
import { isRenderableSocialLink } from "./social-link-url.js";
/** Flags describe reachable paint across pages, viewport sizes and header scroll positions. */
export function chromeFeatures({ headerSettings, footerSettings, navItems, footerPagePaths, logoPairs, searchEnabled, hasIconSprite, nameReportEnabled, }) {
    const features = {};
    if (headerSettings) {
        const header = resolveHeaderChromePresentation(headerSettings);
        const navigation = navigationFacts(navItems ?? []);
        const flags = [];
        if (navigation.length) {
            flags.push("burger", `drawer:${header.navDrawerStyle}`);
            if (header.menuDisplay === "auto" && header.layout !== "minimal")
                flags.push("inlineNav");
        }
        if (searchEnabled)
            flags.push("searchButton");
        if (header.showThemeToggle)
            flags.push("themeToggle");
        const modes = [false, ...(header.compactOnScroll ? [true] : [])].map(complete => isTallHeaderPaint({
            heightMultiplier: header.heightMultiplier,
            minHeightMultiplier: header.minHeightMultiplier,
            compactSize: header.compactSizeStandard ? "standard" : "compact",
            complete,
        }) ? "headerPaint:tall" : "headerPaint:standard");
        flags.push(...new Set(modes));
        // Compact artwork only replaces a configured regular logo. The regular
        // logo's generic fallback can supply either scheme.
        const hasLogo = Boolean(logoPairs?.header?.light.url || logoPairs?.header?.dark.url);
        features.header = schemeFeatures(flags, navigation, header.showBrandText ? header.brandText : undefined, {
            light: hasLogo,
            dark: hasLogo,
        });
    }
    if (footerSettings?.enabled === true) {
        const flags = footerContentFlags(footerSettings, footerPagePaths);
        if (hasIconSprite && footerSettings.socialLinks?.some(isRenderableSocialLink))
            flags.push("socialLinks");
        if (nameReportEnabled === true)
            flags.push("footerActionButton");
        const showBrand = footerSettings.showBrand !== false;
        features.footer = schemeFeatures(flags, [], showBrand && footerSettings.showBrandText !== false ? headerSettings?.brandText : undefined, {
            // A one-scheme footer override must not become the opposite scheme's logo.
            light: showBrand && Boolean(logoPairs?.footer?.light.url),
            dark: showBrand && Boolean(logoPairs?.footer?.dark.url),
        });
    }
    else if (nameReportEnabled === true) {
        features.footer = schemeFeatures(["footerActionButton:standalone"], [], undefined, { light: false, dark: false });
    }
    return features;
}
/** Use the released button paint, with the page's footer wrapper as the ring backdrop. */
export function standaloneFooterActionEntries(entries) {
    return entries.filter(entry => entry.flags.includes("footerActionButton")).map(entry => ({
        ...entry,
        flags: entry.flags.map(flag => flag === "footerActionButton" ? "footerActionButton:standalone" : flag),
        background: entry.kind === "ring" ? "background" : entry.background,
    }));
}
function schemeFeatures(flags, navigation, brandText, logos) {
    const paintedText = hasText(brandText) ? ["brandText"] : [];
    // Nonbreaking whitespace has no ink but still gives the brand link a focusable box.
    const forScheme = (hasLogo) => ({
        flags: [...flags, ...paintedText, ...(brandText || hasLogo ? ["brandLink"] : [])],
        navigation,
    });
    return { light: forScheme(logos.light), dark: forScheme(logos.dark) };
}
// The slots match NavItemKind in Sites.proto.
const NAVIGATION_KIND_NAMES = ["", SITE_NAVIGATION_KINDS.page, SITE_NAVIGATION_KINDS.externalUrl, SITE_NAVIGATION_KINDS.groupHeader];
const BUTTON_APPEARANCE = "NAV_ITEM_APPEARANCE_BUTTON";
function normalizeNavigationItem(item) {
    return {
        ...item,
        kind: typeof item.kind === "number" ? NAVIGATION_KIND_NAMES[item.kind] : item.kind,
        appearance: item.appearance === 2 ? BUTTON_APPEARANCE : item.appearance,
        children: item.children?.map(normalizeNavigationItem),
    };
}
function navigationFacts(items) {
    const facts = [];
    const visit = (nodes, depth) => {
        // Linked-group normalization can add a child just past the published cap.
        if (depth > MAX_NAVIGATION_DEPTH)
            return;
        for (const node of nodes) {
            const { group, url, button } = describeHeaderNavigationItem(node, SITE_NAVIGATION_KINDS, BUTTON_APPEARANCE);
            facts.push({
                depth: depth === 1 ? "top-level" : "nested",
                kind: group ? "group" : button ? "button" : "plain",
                anchor: Boolean(url),
                // Espalier compares the raw URL (apart from a trailing slash) to location.pathname.
                canBeCurrent: url.startsWith("/") && new URL(url, "https://taproot.invalid").pathname === url,
            });
            if (node.children?.length)
                visit(node.children, depth + 1);
        }
    };
    visit(prepareHeaderNavigation(items.map(normalizeNavigationItem), SITE_NAVIGATION_KINDS), 1);
    return facts;
}
function hasText(text) {
    return Boolean(text?.trim());
}
function footerContentFlags(settings, paths) {
    const resolves = (target) => Boolean(resolveFooterTarget(target, paths));
    const hasLinkText = (link) => hasText(link.label) && resolves(link);
    let headings = false;
    let body = false;
    let links = false;
    for (const { groups = [] } of settings.linkColumns ?? []) {
        for (const group of groups) {
            for (const link of group.links ?? []) {
                if (!resolves(link))
                    continue;
                headings ||= hasText(group.heading);
                links ||= hasText(link.label);
            }
        }
    }
    const recordParagraph = (paragraph, heading) => {
        for (const run of paragraph?.runs ?? []) {
            if (!hasText(run.text))
                continue;
            if (run.link && resolves(run.link))
                links = true;
            else if (heading)
                headings = true;
            else
                body = true;
        }
    };
    recordParagraph(settings.asideHeadingContent?.paragraphs?.[0], true);
    for (const content of [settings.asideBodyContent, settings.bottomContent]) {
        for (const paragraph of content?.paragraphs ?? [])
            recordParagraph(paragraph, false);
    }
    links ||= Boolean(settings.asideCta && hasLinkText(settings.asideCta)) || Boolean(settings.bottomLinks?.some(hasLinkText));
    return [
        ...(headings ? ["footerHeadings"] : []),
        ...(body ? ["footerBody"] : []),
        ...(links ? ["footerLinks"] : []),
    ];
}
