// Generated from shared/placed-image-ids.ts by scripts/sync-field-validation.mjs. Do not edit.
/**
 * The images a page places (TR01364), read from the wire form the CLI holds.
 *
 * `PageImageReferenceExtractor.Extract` in the API decides which images a page places, over its stored
 * `templateData`. The CLI holds the wire form (the proto-JSON data member of a page read or of
 * `wireTemplate(document)`), so this mirrors `Extract` over that shape, and C# is authoritative.
 * `shared/image-reference-corpus.json` holds the two together: the API test maps each case's wire twin to its stored
 * twin and runs `Extract` over it, and the CLI test runs this over the wire twin.
 *
 * It does not validate, so it cannot reproduce `ColumnsBodyPolicy`: for a body `PageTemplateBodies.Read` would
 * reject, it returns every id its walk reaches. It never throws. Known gaps, all outside this file's reach:
 * - ids that are server-only and absent from the wire form (the freezer's integration placements, and an
 *   integration-managed page's own referenced ids), which the stored Site Health report still covers;
 * - C# stops at `System.Text.Json`'s default depth of 64 where this walk is bounded at 256;
 * - C# keeps duplicate property names in decoded component data where `JSON.parse` keeps the last one;
 * - the `Guid.TryParse` X format (`{0x...}`), and the numeric entities .NET also decodes with a sign or
 *   whitespace (`&#+34;`, `&# 34;`).
 *
 * It is dependency-free so the published site-authoring package can carry a compiled copy. Only the CLI uses it,
 * so `node scripts/sync-field-validation.mjs` writes just that copy; edit only this file and re-run it.
 */
/** Matches the depth the link extractors use, so a hostile body cannot overflow the stack. */
const MAXIMUM_DEPTH = 256;
const DOTNET_WHITESPACE = "\\t-\\r \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const LEADING_WHITESPACE = new RegExp(`^[${DOTNET_WHITESPACE}]+`, "u");
const TRAILING_WHITESPACE = new RegExp(`[${DOTNET_WHITESPACE}]+$`, "u");
const GROUPED_GUID = "([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{12})";
const GUID_N = /^([0-9a-f]{8})([0-9a-f]{4})([0-9a-f]{4})([0-9a-f]{4})([0-9a-f]{12})$/iu;
const GUID_D = new RegExp(`^${GROUPED_GUID}$`, "iu");
const GUID_B = new RegExp(`^\\{${GROUPED_GUID}\\}$`, "iu");
const GUID_P = new RegExp(`^\\(${GROUPED_GUID}\\)$`, "iu");
/** The lowercase hyphenated form of a GUID `Guid.TryParse` accepts (formats N, D, B and P), else `undefined`. */
function parseGuid(value) {
    if (typeof value !== "string")
        return undefined;
    const trimmed = value.replace(LEADING_WHITESPACE, "").replace(TRAILING_WHITESPACE, "");
    const match = GUID_N.exec(trimmed) ?? GUID_D.exec(trimmed) ?? GUID_B.exec(trimmed) ?? GUID_P.exec(trimmed);
    return match === null ? undefined : match.slice(1).join("-").toLowerCase();
}
const NAMED_ENTITIES = {
    quot: "\"",
    amp: "&",
    lt: "<",
    gt: ">",
    apos: "'",
    nbsp: "\u00a0",
    ensp: "\u2002",
    emsp: "\u2003",
    thinsp: "\u2009",
};
const ENTITY = /&(?:#[xX]([0-9a-fA-F]+)|#([0-9]+)|(quot|amp|lt|gt|apos|nbsp|ensp|emsp|thinsp));/gu;
/** One decoded code point, or `undefined` when .NET leaves the entity as text (too large, or a surrogate). */
function numericEntity(digits, radix) {
    const significant = digits.replace(/^0+/u, "");
    // 0x10FFFF is six hex digits and 1114111 seven decimal ones; a longer run is above it, or overflows .NET's parse.
    if (significant.length > (radix === 16 ? 6 : 7))
        return undefined;
    const codePoint = significant === "" ? 0 : Number.parseInt(significant, radix);
    if (codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff))
        return undefined;
    return String.fromCodePoint(codePoint);
}
/**
 * `PageTemplateBodies.HtmlDecodeRepeatedly`: exactly three rounds, each one left-to-right pass over the closed
 * set of entities that can change JSON structure or a GUID read (the four whitespace ones are there because
 * .NET decodes them to characters `Guid.TryParse` trims). An unknown or malformed entity stays text.
 */
function decodeComponentData(text) {
    let decoded = text;
    for (let round = 0; round < 3; round += 1) {
        decoded = decoded.replace(ENTITY, (entity, hex, decimal, name) => {
            if (name !== undefined)
                return NAMED_ENTITIES[name] ?? entity;
            return numericEntity(hex ?? decimal ?? "", hex === undefined ? 10 : 16) ?? entity;
        });
    }
    return decoded;
}
function isDictionary(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function own(dictionary, key) {
    return Object.hasOwn(dictionary, key) ? dictionary[key] : undefined;
}
function addGuid(ids, value) {
    const guid = parseGuid(value);
    if (guid !== undefined)
        ids.add(guid);
}
/** The id in `parent[property].imageId`, when `parent[property]` is an object. */
function addProcessedImage(ids, parent, property) {
    const image = own(parent, property);
    if (isDictionary(image) && typeof own(image, "imageId") === "string")
        addGuid(ids, own(image, "imageId"));
}
/** The nodes of one body that name an image: what `AddImageIdsFromProseMirrorJson` reads at each node. */
function addNodeImages(ids, node) {
    const type = own(node, "type");
    const attributes = own(node, "attrs");
    if (!isDictionary(attributes))
        return;
    if (type === "section") {
        const decoration = own(attributes, "decoration");
        if (isDictionary(decoration))
            addProcessedImage(ids, decoration, "image");
        const background = own(attributes, "background");
        if (isDictionary(background)) {
            addProcessedImage(ids, background, "image");
            addProcessedImage(ids, background, "portraitImage");
        }
    }
    else if (type === "taprootImage") {
        if (typeof own(attributes, "imageId") === "string")
            addGuid(ids, own(attributes, "imageId"));
    }
    else if (type === "integrationFragment") {
        const imageIds = own(attributes, "imageIds");
        if (Array.isArray(imageIds))
            for (const imageId of imageIds)
                if (typeof imageId === "string")
                    addGuid(ids, imageId);
    }
    else if (type === "componentBlock" && Object.hasOwn(attributes, "componentData")) {
        addComponentImages(ids, own(attributes, "componentData"));
    }
}
/**
 * `AddImageIdsFromJson`: every string-valued `imageId` property at any depth, and nothing else. It is iterative and
 * bounded, like the body walk.
 */
function addGenericImageIds(ids, root) {
    const stack = [[root, 0]];
    for (let next = stack.pop(); next !== undefined; next = stack.pop()) {
        const [value, depth] = next;
        if (depth > MAXIMUM_DEPTH)
            continue;
        if (Array.isArray(value)) {
            for (const item of value)
                stack.push([item, depth + 1]);
        }
        else if (isDictionary(value)) {
            for (const [key, child] of Object.entries(value)) {
                if (key === "imageId" && typeof child === "string")
                    addGuid(ids, child);
                else
                    stack.push([child, depth + 1]);
            }
        }
    }
}
/**
 * A string `componentData` is decoded, parsed and searched by the generic rule only. An object or array gets the
 * generic rule here too, and the body walk then also recurses into it, so a nested `integrationFragment` counts
 * inside an object but not inside a decoded string. Malformed component JSON reads as no ids, as in C#.
 */
function addComponentImages(ids, componentData) {
    if (typeof componentData === "string") {
        let parsed;
        try {
            parsed = JSON.parse(decodeComponentData(componentData));
        }
        catch {
            return;
        }
        addGenericImageIds(ids, parsed);
    }
    else if (Array.isArray(componentData) || isDictionary(componentData)) {
        addGenericImageIds(ids, componentData);
    }
}
/** Every node of a rich-text body, to the depth bound, so each one is read by `addNodeImages`. */
function addBodyImageIds(ids, body) {
    const stack = [[body, 0]];
    for (let next = stack.pop(); next !== undefined; next = stack.pop()) {
        const [value, depth] = next;
        if (depth > MAXIMUM_DEPTH)
            continue;
        if (Array.isArray(value)) {
            for (const item of value)
                stack.push([item, depth + 1]);
        }
        else if (isDictionary(value)) {
            addNodeImages(ids, value);
            for (const child of Object.values(value))
                stack.push([child, depth + 1]);
        }
    }
}
/** The wire keys of a template's rich-text bodies, as `PageTemplateBodies.Read` walks them. */
function templateBodies(templateType, data) {
    switch (templateType) {
        case "free-form":
        case "article":
        case "place-review":
        case "legal":
            return [own(data, "body")];
        case "recipe": {
            const sections = own(data, "instructionSections");
            return [
                own(data, "introductionBody"),
                ...(Array.isArray(sections)
                    ? sections.flatMap((section) => {
                        const steps = isDictionary(section) ? own(section, "stepBodies") : undefined;
                        return Array.isArray(steps) ? steps : [];
                    })
                    : []),
            ];
        }
        case "album":
        case "generated":
            return [own(data, "introductionBody")];
        default:
            return [];
    }
}
/**
 * The image ids a page places, as a sorted, de-duplicated array of lowercase hyphenated GUIDs. `templateType` is a
 * workspace template name (`free-form`, `article`, `recipe`, `album`, `place-review`, `legal` or `generated`); any
 * other value, including `integration-managed`, returns an empty list. `data` is the wire form's data member (the
 * `[dataKey]` member of `wireTemplate(document)`), never the wrapper. The caller adds the cover image separately.
 */
export function placedImageIds(templateType, data) {
    const ids = new Set();
    try {
        if (isDictionary(data)) {
            for (const body of templateBodies(templateType, data))
                addBodyImageIds(ids, body);
            if (templateType === "album") {
                const images = own(data, "images");
                if (Array.isArray(images)) {
                    for (const image of images)
                        if (isDictionary(image))
                            addGuid(ids, own(image, "imageId"));
                }
            }
        }
    }
    catch {
        // Never throw: an unreadable shape returns what the walk had reached.
    }
    return [...ids].sort();
}
