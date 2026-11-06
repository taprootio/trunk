// Generated from shared/image-description-document.ts by scripts/sync-field-validation.mjs. Do not edit.
import { IMAGE_DESCRIPTION_HYDRATED_KEYS, resolveImageDescription } from "./image-description-validation.js";
export function imageDescriptionImageId(image) {
    return typeof image.imageId === "string"
        ? image.imageId
        : typeof image.id === "string" && "caption" in image
            ? image.id
            : undefined;
}
/** Component data may be serialized inside a structured document. Keep unchanged bytes intact. */
export function visitImageDescriptionObjects(value, transform, seen = new WeakSet()) {
    if (!value || typeof value !== "object" || seen.has(value))
        return;
    seen.add(value);
    if (Array.isArray(value)) {
        for (const child of value)
            visitImageDescriptionObjects(child, transform, seen);
        return;
    }
    const record = value;
    transform(record);
    for (const [key, child] of Object.entries(record)) {
        if (key === "componentData" && typeof child === "string") {
            try {
                const data = JSON.parse(child);
                const before = JSON.stringify(data);
                visitImageDescriptionObjects(data, transform, seen);
                const after = JSON.stringify(data);
                if (before !== after)
                    record[key] = after;
            }
            catch { /* Existing content validation owns malformed component data. */ }
        }
        else
            visitImageDescriptionObjects(child, transform, seen);
    }
}
export function referencedImageDescriptionIds(value) {
    const ids = new Set();
    visitImageDescriptionObjects(value, image => {
        const id = imageDescriptionImageId(image);
        if (id)
            ids.add(id);
    });
    return ids;
}
/** API delivery state does not belong in authored documents or workspace hashes. */
export function stripImageDescriptionHydration(value) {
    const copy = structuredClone(value);
    visitImageDescriptionObjects(copy, image => {
        for (const key of IMAGE_DESCRIPTION_HYDRATED_KEYS)
            delete image[key];
        if (image.descriptionMode === "inherit") {
            delete image.alt;
            delete image.altText;
        }
        const nested = image.image;
        if (nested && typeof nested === "object" && !Array.isArray(nested)) {
            const bannerImage = nested;
            if ((image.descriptionMode ?? bannerImage.descriptionMode) === "inherit") {
                delete image.altText;
                delete bannerImage.alt;
                delete bannerImage.altText;
            }
        }
    });
    return copy;
}
const text = (value) => typeof value === "string" ? value : undefined;
const placementMode = (mode, contextual) => mode === undefined || mode === null || mode === "" ? contextual.trim() ? "custom" : "inherit" : mode;
export function hydrateImageDescriptions(value, source) {
    const copy = structuredClone(value);
    const metadata = (image, delivery) => {
        image.defaultDescription = delivery.defaultDescription ?? null;
        image.descriptionRevision = delivery.descriptionRevision;
    };
    visitImageDescriptionObjects(copy, image => {
        const id = imageDescriptionImageId(image);
        const delivery = id ? source(id) : undefined;
        if (delivery) {
            const album = "caption" in image && "urls" in image;
            const field = "altText" in image || album ? "altText" : "alt";
            const contextual = text(image[field])
                ?? (album && image.descriptionMode == null ? text(image.caption) : undefined) ?? "";
            const mode = placementMode(text(image.descriptionMode), contextual);
            image.descriptionMode = mode;
            image[field] = resolveImageDescription(mode, contextual, delivery.defaultDescription ?? "");
            metadata(image, delivery);
        }
        const nested = image.image;
        if (!("altText" in image || "descriptionMode" in image || "overlayText" in image)
            || !nested || typeof nested !== "object" || Array.isArray(nested))
            return;
        const bannerImage = nested;
        const bannerId = imageDescriptionImageId(bannerImage);
        const bannerSource = bannerId ? source(bannerId) : undefined;
        if (!bannerSource)
            return;
        const contextual = text(image.altText) ?? "";
        const mode = placementMode(text(image.descriptionMode) ?? text(bannerImage.descriptionMode), contextual);
        image.descriptionMode = mode;
        image.altText = resolveImageDescription(mode, contextual, bannerSource.defaultDescription ?? "");
        metadata(image, bannerSource);
        bannerImage.descriptionMode = mode;
        bannerImage.alt = image.altText;
    });
    return copy;
}
