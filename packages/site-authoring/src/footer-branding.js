// Generated from shared/footer-branding.ts by scripts/sync-field-validation.mjs. Do not edit.
import { DISPLAY_SCALE_LIMITS, parseDisplayScale } from "./display-scale.js";
import { resolveHeaderLogoPairs, resolveLogoVariant, } from "./header-presentation.js";
export const FOOTER_LOGO_SCALE_LIMITS = DISPLAY_SCALE_LIMITS;
export const FOOTER_LOGO_BOX = Object.freeze({ heightRem: 3, maxWidthRem: 12 });
/** TR01365's unpublished Large setting scaled both logo and text before separation. */
export function parseFooterLogoScale(value, brandSize) {
    return parseDisplayScale(value === undefined || value === null ? (brandSize === "large" ? "1.5" : "1.0") : value);
}
/** Invalid stored data renders normally; writes use the strict parser. */
export function resolveFooterLogoScale(value, brandSize) {
    return parseFooterLogoScale(value, brandSize) ?? parseDisplayScale("");
}
export function footerBrandSizeStyleMap(size, logoScale) {
    const scale = resolveFooterLogoScale(logoScale, size).scale;
    const declarations = {};
    if (scale !== 1) {
        const rem = (normal) => `${Number((normal * scale).toFixed(1))}rem`;
        declarations["--esp-footer-brand-logo-size"] = rem(FOOTER_LOGO_BOX.heightRem);
        declarations["--esp-footer-brand-logo-max-width"] = rem(FOOTER_LOGO_BOX.maxWidthRem);
        declarations["--esp-footer-brand-logo-size-compact"] = rem(FOOTER_LOGO_BOX.heightRem);
        declarations["--esp-footer-brand-logo-max-width-compact"] = rem(FOOTER_LOGO_BOX.maxWidthRem);
    }
    if (size === "large") {
        declarations["--esp-footer-brand-text-size"] = "var(--esp-type-big)";
        declarations["--esp-footer-brand-text-size-compact"] = "var(--esp-type-large)";
    }
    return declarations;
}
export function footerBrandSizeStyles(size, logoScale) {
    return Object.entries(footerBrandSizeStyleMap(size, logoScale)).map(([key, value]) => `${key}: ${value};`).join(" ");
}
/** An unset footer scheme inherits its site scheme, never the other footer override. */
export function resolveFooterLogoPairs(input) {
    // A footer inherits the site pair before either surface selects its artwork.
    const site = resolveHeaderLogoPairs({ ...input, logoVariant: "" });
    const override = (id, url = "", aspectRatio = "", inherited) => id ? { url, aspectRatio: url ? aspectRatio : "" } : inherited;
    const effective = {
        light: override(input.lightFooterLogoId, input.lightFooterLogoUrl, input.lightFooterLogoAspectRatio, site.light),
        dark: override(input.darkFooterLogoId, input.darkFooterLogoUrl, input.darkFooterLogoAspectRatio, site.dark),
    };
    const variant = resolveLogoVariant(input.logoVariant);
    return variant ? { light: effective[variant], dark: effective[variant] } : effective;
}
