// Generated from shared/site-navigation-groups.ts by scripts/sync-field-validation.mjs. Do not edit.
import { isSafeUrl } from "./url-safety.js";
// Published navigation depth stays aligned with the API command validation cap.
export const MAX_NAVIGATION_DEPTH = 3;
export const SITE_NAVIGATION_KINDS = {
    page: "NAV_ITEM_KIND_PAGE",
    externalUrl: "NAV_ITEM_KIND_EXTERNAL_URL",
    groupHeader: "NAV_ITEM_KIND_GROUP_HEADER",
};
/** Whether a page or external link without children can use button appearance. */
export function canStyleNavigationAsButton(kind, hasChildren, kinds = SITE_NAVIGATION_KINDS) {
    return !hasChildren && (kind === kinds.page || kind === kinds.externalUrl);
}
/** Only top-level destination leaves can sit beside the header controls. */
export function canPlaceNavigationAtHeaderEnd(kind, depth, hasChildren, kinds = SITE_NAVIGATION_KINDS) {
    return depth === 1 && canStyleNavigationAsButton(kind, hasChildren, kinds);
}
/** Rendering treatment after the navigation tree has been prepared. */
export function describeHeaderNavigationItem(item, kinds, buttonAppearance) {
    const group = item.kind === kinds.groupHeader || (item.children?.length ?? 0) > 0;
    const url = !group && item.url && isSafeUrl(item.url) ? item.url : "";
    const button = Boolean(url) && item.appearance === buttonAppearance
        && canStyleNavigationAsButton(item.kind, group, kinds);
    return { group, url, button };
}
/** Adapt old trees for rendering without changing their stored manifest or identities. */
export function normalizeSiteNavigationGroups(items, kinds) {
    const usedIds = new Set();
    const collect = (nodes) => {
        for (const node of nodes) {
            usedIds.add(node.id);
            collect(node.children ?? []);
        }
    };
    collect(items);
    const normalize = (item) => {
        const children = (item.children ?? []).map(normalize);
        if (children.length === 0)
            return item;
        const hasDestination = item.kind === kinds.page
            ? Boolean(item.resourceId?.trim())
            : item.kind === kinds.externalUrl && Boolean(item.externalUrl?.trim());
        if (hasDestination) {
            // These opaque IDs exist only while rendering; persisted children get UUIDs from the API.
            const base = `${item.id}-link`;
            let id = base;
            for (let suffix = 1; usedIds.has(id); suffix++)
                id = `${base}-${suffix}`;
            usedIds.add(id);
            children.unshift({ ...item, id, children: [] });
        }
        return {
            ...item,
            kind: kinds.groupHeader,
            resourceId: "",
            externalUrl: "",
            url: "",
            children,
        };
    };
    return items.map(normalize);
}
/** Preserve the old depth boundary before adapting linked groups. */
export function prepareHeaderNavigation(items, kinds) {
    const project = (nodes, depth) => nodes.map((item) => ({
        ...item,
        children: depth < MAX_NAVIGATION_DEPTH ? project(item.children ?? [], depth + 1) : [],
    }));
    return normalizeSiteNavigationGroups(project(items, 1), kinds);
}
