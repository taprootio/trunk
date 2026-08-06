import { LIMITS } from "./constants.js";
import { classifySupportedLocale, hasDisallowedStringCharacters } from "./text.js";

const ALLOWED_TAGS = new Set([
  "a",
  "abbr",
  "b",
  "blockquote",
  "br",
  "code",
  "dd",
  "del",
  "details",
  "div",
  "dl",
  "dt",
  "em",
  "figcaption",
  "figure",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "img",
  "kbd",
  "li",
  "mark",
  "ol",
  "p",
  "pre",
  "q",
  "s",
  "samp",
  "small",
  "span",
  "strong",
  "sub",
  "summary",
  "sup",
  "table",
  "tbody",
  "td",
  "th",
  "thead",
  "time",
  "tr",
  "ul",
  "var",
]);

const VOID_TAGS = new Set(["br", "hr", "img"]);
const PHRASING_TAGS = new Set([
  "a",
  "abbr",
  "b",
  "br",
  "code",
  "del",
  "em",
  "img",
  "kbd",
  "mark",
  "q",
  "s",
  "samp",
  "small",
  "span",
  "strong",
  "sub",
  "sup",
  "time",
  "var",
]);
const PHRASING_CONTAINERS = new Set([
  ...[...PHRASING_TAGS].filter((tag) => tag !== "a" && tag !== "del"),
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "p",
  "pre",
  "summary",
]);
const TRANSPARENT_CONTAINERS = new Set(["a", "del"]);
const ELEMENT_ONLY_CONTAINERS = new Set(["dl", "ol", "table", "tbody", "thead", "tr", "ul"]);
const REQUIRED_PARENTS = new Map([
  ["dd", new Set(["dl"])],
  ["dt", new Set(["dl"])],
  ["figcaption", new Set(["figure"])],
  ["li", new Set(["ol", "ul"])],
  ["summary", new Set(["details"])],
  ["tbody", new Set(["table"])],
  ["td", new Set(["tr"])],
  ["th", new Set(["tr"])],
  ["thead", new Set(["table"])],
  ["tr", new Set(["tbody", "thead"])],
]);
const ONLY_CHILDREN = new Map([
  ["dl", new Set(["dd", "dt"])],
  ["ol", new Set(["li"])],
  ["table", new Set(["tbody", "thead"])],
  ["tbody", new Set(["tr"])],
  ["thead", new Set(["tr"])],
  ["tr", new Set(["td", "th"])],
  ["ul", new Set(["li"])],
]);
const GLOBAL_ATTRIBUTES = new Set([
  "aria-describedby",
  "aria-hidden",
  "aria-label",
  "aria-labelledby",
  "dir",
  "lang",
  "title",
]);
const TAG_ATTRIBUTES = new Map([
  ["a", new Set(["data-heading-id", "data-resource-key", "href"])],
  ["code", new Set(["data-language"])],
  ["details", new Set(["open"])],
  ["h2", new Set(["id"])],
  ["h3", new Set(["id"])],
  ["h4", new Set(["id"])],
  ["h5", new Set(["id"])],
  ["h6", new Set(["id"])],
  ["img", new Set(["alt", "data-asset-key", "height", "width"])],
  ["li", new Set(["value"])],
  ["ol", new Set(["reversed", "start"])],
  ["td", new Set(["colspan", "rowspan"])],
  ["th", new Set(["colspan", "rowspan", "scope"])],
  ["time", new Set(["datetime"])],
]);
const BOOLEAN_ATTRIBUTES = new Set(["open", "reversed"]);
const RESOURCE_KEY = /^[a-z0-9]+(?:[._:/-][a-z0-9]+)*$/;
const HEADING_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TOKEN = /^[a-z0-9]+(?:[._+-][a-z0-9]+)*$/;
const HTML_WHITESPACE_RUN = /[\t\n\f\r ]+/gu;

function isHtmlWhitespace(character) {
  return character === "\t" || character === "\n" || character === "\f" || character === "\r" || character === " ";
}

function isOnlyHtmlWhitespace(value) {
  for (const character of value) {
    if (!isHtmlWhitespace(character)) return false;
  }
  return true;
}

function findTagEnd(markup, start) {
  let quote;
  for (let index = start; index < markup.length; index += 1) {
    const char = markup[index];
    if (quote) {
      if (char === quote) quote = undefined;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === ">") {
      return index;
    }
  }
  return -1;
}

function decodeEntities(value, context, path) {
  const named = new Map([
    ["amp", "&"],
    ["apos", "'"],
    ["colon", ":"],
    ["gt", ">"],
    ["lt", "<"],
    ["quot", '"'],
  ]);
  const decoded = [];
  let offset = 0;
  while (offset < value.length) {
    const ampersand = value.indexOf("&", offset);
    if (ampersand === -1) {
      decoded.push(value.slice(offset));
      break;
    }
    decoded.push(value.slice(offset, ampersand));
    const match = /^&([^;\t\n\f\r <&]{1,32});/u.exec(value.slice(ampersand));
    if (!match) {
      const preview = /^&[^\t\n\f\r <&]{0,31}/u.exec(value.slice(ampersand))?.[0] ?? "&";
      context.add("markup.unsupported_entity", path, `Raw or semicolonless ampersand sequence '${preview}' is not supported.`);
      decoded.push("&");
      offset = ampersand + 1;
      continue;
    }
    const [entity, body] = match;
    let codePoint;
    if (body.startsWith("#x") || body.startsWith("#X")) {
      if (/^[0-9a-fA-F]+$/u.test(body.slice(2))) codePoint = Number.parseInt(body.slice(2), 16);
    } else if (body.startsWith("#")) {
      if (/^[0-9]+$/u.test(body.slice(1))) codePoint = Number.parseInt(body.slice(1), 10);
    } else if (named.has(body)) {
      decoded.push(named.get(body));
      offset = ampersand + entity.length;
      continue;
    }
    const hasReplacementOrControlSemantics = !Number.isSafeInteger(codePoint)
      || codePoint === 0
      || codePoint > 0x10ffff
      || (codePoint >= 0xd800 && codePoint <= 0xdfff)
      || codePoint <= 0x1f
      || (codePoint >= 0x7f && codePoint <= 0x9f);
    if (codePoint !== undefined && !hasReplacementOrControlSemantics) {
      decoded.push(String.fromCodePoint(codePoint));
      offset = ampersand + entity.length;
      continue;
    }
    context.add("markup.unsupported_entity", path, `Unsupported or invalid HTML entity '${entity}'.`);
    decoded.push(entity);
    offset = ampersand + entity.length;
  }
  return decoded.join("");
}

function parseAttributes(source, context, path) {
  const attributes = new Map();
  let offset = 0;
  let selfClosing = false;
  while (offset < source.length) {
    while (isHtmlWhitespace(source[offset])) offset += 1;
    if (offset >= source.length) break;
    if (source[offset] === "/" && isOnlyHtmlWhitespace(source.slice(offset + 1))) {
      selfClosing = true;
      break;
    }

    const nameMatch = /^[A-Za-z][A-Za-z0-9:-]*/u.exec(source.slice(offset));
    if (!nameMatch) {
      context.add("markup.invalid_attribute", path, "Attribute names must use the supported HTML identifier form.");
      return { attributes, selfClosing, invalid: true };
    }
    const name = nameMatch[0];
    offset += name.length;
    if (name !== name.toLowerCase()) context.add("markup.not_canonical", path, `Attribute '${name}' must be lowercase.`);
    const canonicalName = name.toLowerCase();
    if (attributes.has(canonicalName)) context.add("markup.duplicate_attribute", path, `Attribute '${canonicalName}' is duplicated.`);
    while (isHtmlWhitespace(source[offset])) offset += 1;

    let value = null;
    if (source[offset] === "=") {
      offset += 1;
      while (isHtmlWhitespace(source[offset])) offset += 1;
      const quote = source[offset];
      if (quote !== '"' && quote !== "'") {
        context.add("markup.unquoted_attribute", path, `Attribute '${canonicalName}' must have a quoted value.`);
        return { attributes, selfClosing, invalid: true };
      }
      offset += 1;
      const end = source.indexOf(quote, offset);
      if (end === -1) {
        context.add("markup.invalid_attribute", path, `Attribute '${canonicalName}' has an unterminated value.`);
        return { attributes, selfClosing, invalid: true };
      }
      value = decodeEntities(source.slice(offset, end), context, path);
      offset = end + 1;
    } else if (!BOOLEAN_ATTRIBUTES.has(canonicalName)) {
      context.add("markup.boolean_attribute", path, `Attribute '${canonicalName}' requires a value.`);
    }
    attributes.set(canonicalName, value);
  }
  return { attributes, selfClosing, invalid: false };
}

function validateHttpsUrl(value, context, path) {
  try {
    const url = new URL(value);
    if (!value.startsWith("https://") || url.protocol !== "https:" || url.username !== "" || url.password !== "") {
      context.add("markup.unsafe_url", path, "External fragment links must start with canonical 'https://' and omit credentials.");
    }
  } catch {
    context.add("markup.invalid_url", path, "Expected an absolute HTTPS URL or a local heading reference.");
  }
}

function validateCommonAttributes(tag, attributes, context, path) {
  const tagAttributes = TAG_ATTRIBUTES.get(tag) ?? new Set();
  for (const [name, value] of attributes) {
    if (!GLOBAL_ATTRIBUTES.has(name) && !tagAttributes.has(name)) {
      context.add("markup.unsupported_attribute", path, `Attribute '${name}' is not supported on <${tag}>.`);
      continue;
    }
    if (value !== null && (value.length > 2_000 || hasDisallowedStringCharacters(value))) {
      context.add("markup.invalid_attribute", path, `Attribute '${name}' contains unsupported data.`);
    }
  }

  const direction = attributes.get("dir");
  if (direction !== undefined && direction !== "ltr" && direction !== "rtl" && direction !== "auto") {
    context.add("markup.attribute_value", path, "dir must be 'ltr', 'rtl', or 'auto'.");
  }
  const ariaHidden = attributes.get("aria-hidden");
  if (ariaHidden !== undefined && ariaHidden !== "true" && ariaHidden !== "false") {
    context.add("markup.attribute_value", path, "aria-hidden must be 'true' or 'false'.");
  }
  const language = attributes.get("lang");
  if (language !== undefined && (language === null || classifySupportedLocale(language) !== "supported")) {
    context.add("markup.attribute_value", path, "lang must use the canonical supported Docs v1 BCP 47 subset.");
  }
}

function validateAnchor(attributes, context, path, model) {
  const href = attributes.get("href");
  const resourceKey = attributes.get("data-resource-key");
  const targetHeading = attributes.get("data-heading-id");
  if ((href === undefined) === (resourceKey === undefined)) {
    context.add("markup.link_destination", path, "Links must have exactly one of href or data-resource-key.");
    return;
  }
  if (href !== undefined) {
    if (href === null || href.length === 0) {
      context.add("markup.link_destination", path, "href may not be empty.");
    } else if (hasDisallowedStringCharacters(href)) {
      // validateCommonAttributes owns the single stable control diagnostic.
    } else if (href.startsWith("#")) {
      const headingId = href.slice(1);
      if (!HEADING_ID.test(headingId) || !model.localHeadingIds.has(headingId)) {
        context.add("markup.unknown_heading", path, `Local link targets unknown heading '${headingId}'.`);
      }
    } else {
      validateHttpsUrl(href, context, path);
    }
    if (targetHeading !== undefined) context.add("markup.link_destination", path, "data-heading-id requires data-resource-key.");
    return;
  }

  if (resourceKey === null || !RESOURCE_KEY.test(resourceKey)) {
    context.add("markup.resource_key", path, "data-resource-key must be a canonical resource key.");
    return;
  }
  const resource = model.resources.get(resourceKey);
  const variant = resource?.variants.find((candidate) => candidate.locale === model.locale);
  if (!variant) {
    context.add("markup.unknown_resource", path, `Link target '${resourceKey}' has no '${model.locale}' variant.`);
    return;
  }
  if (targetHeading !== undefined) {
    if (targetHeading === null || !variant.headings.some((heading) => heading.id === targetHeading)) {
      context.add("markup.unknown_heading", path, `Link targets unknown heading '${targetHeading}' on resource '${resourceKey}'.`);
    }
  }
}

function validateImage(attributes, context, path, model) {
  const assetKey = attributes.get("data-asset-key");
  if (assetKey === undefined || assetKey === null || !RESOURCE_KEY.test(assetKey)) {
    context.add("markup.asset_key", path, "Images must reference one canonical data-asset-key.");
  } else if (!model.assets.has(assetKey)) {
    context.add("markup.unknown_asset", path, `Image references unknown asset '${assetKey}'.`);
  }
  if (!attributes.has("alt") || attributes.get("alt") === null) context.add("markup.image_alt", path, "Images must declare alt text; use an empty value for decorative images.");

  for (const dimension of ["width", "height"]) {
    const value = attributes.get(dimension);
    if (value !== undefined && (value === null || !/^[1-9]\d{0,4}$/u.test(value))) {
      context.add("markup.attribute_value", path, `${dimension} must be a positive decimal integer.`);
    }
  }
  const asset = assetKey === null ? undefined : model.assets.get(assetKey);
  if (asset) {
    if (attributes.has("width") && Number(attributes.get("width")) !== asset.width) context.add("markup.asset_dimensions", path, `Image width must match asset '${assetKey}'.`);
    if (attributes.has("height") && Number(attributes.get("height")) !== asset.height) context.add("markup.asset_dimensions", path, `Image height must match asset '${assetKey}'.`);
  }
}

function validateSpecialAttributes(tag, attributes, context, path, model) {
  if (tag === "a") validateAnchor(attributes, context, path, model);
  if (tag === "img") validateImage(attributes, context, path, model);
  if (/^h[2-6]$/u.test(tag)) {
    const id = attributes.get("id");
    if (id === undefined || id === null || !HEADING_ID.test(id)) context.add("markup.heading_id", path, "Headings must declare a canonical id.");
  }
  const language = attributes.get("data-language");
  if (language !== undefined && (language === null || !TOKEN.test(language))) context.add("markup.attribute_value", path, "data-language must be a canonical token.");
  for (const name of ["colspan", "rowspan", "start", "value"]) {
    const value = attributes.get(name);
    if (value !== undefined && (value === null || !/^-?(?:0|[1-9]\d{0,5})$/u.test(value))) context.add("markup.attribute_value", path, `${name} must be a decimal integer.`);
  }
  const scope = attributes.get("scope");
  if (scope !== undefined && !["col", "colgroup", "row", "rowgroup"].includes(scope)) context.add("markup.attribute_value", path, "scope has an unsupported value.");
}

function normalizeHeadingText(value) {
  return value.replace(HTML_WHITESPACE_RUN, " ").replace(/^ +| +$/gu, "");
}

function validateTextContent(text, parent, context, path) {
  if (text.includes("\u0000")) {
    context.add("markup.invalid_null", path, "HTML fragment text may not contain a literal U+0000 null character.");
  }
  if (parent && ELEMENT_ONLY_CONTAINERS.has(parent.tag) && !isOnlyHtmlWhitespace(text)) {
    context.add("markup.content_model", path, `<${parent.tag}> may contain only its supported child elements, not text.`);
  }
}

function validateElementContent(tag, stack, context, path) {
  const parent = stack.at(-1);
  const parentTag = parent?.tag;
  const requiredParents = REQUIRED_PARENTS.get(tag);
  if (requiredParents && !requiredParents.has(parentTag)) {
    context.add("markup.content_model", path, `<${tag}> is not allowed below <${parentTag ?? "root"}>.`);
  }
  const onlyChildren = ONLY_CHILDREN.get(parentTag);
  if (onlyChildren && !onlyChildren.has(tag)) {
    context.add("markup.content_model", path, `<${parentTag}> may not contain <${tag}>.`);
  }
  const contentParentTag = parent?.contentParentTag;
  if (contentParentTag && PHRASING_CONTAINERS.has(contentParentTag) && !PHRASING_TAGS.has(tag)) {
    context.add("markup.content_model", path, `<${contentParentTag}> may contain only phrasing content, not <${tag}>.`);
  }
  if (tag === "a" && stack.some((entry) => entry.tag === "a")) {
    context.add("markup.content_model", path, "Links may not be nested.");
  }
  if (tag === "summary" && parent && (parent.childElementCount !== 0 || parent.seenSummary)) {
    context.add("markup.content_model", path, "<summary> must be the first child of <details> and may appear only once.");
  }
  if (tag === "figcaption" && parent) {
    if (parent.seenFigcaption) {
      context.add("markup.content_model", path, "<figure> may contain only one <figcaption>.");
    } else if (parent.childElementCount !== 0) {
      parent.figcaptionMustBeLast = true;
    }
  } else if (parent?.figcaptionMustBeLast) {
    context.add("markup.content_model", path, "A non-leading <figcaption> must be the last child of <figure>.");
  }
  if (parent) {
    parent.childElementCount += 1;
    if (tag === "summary") parent.seenSummary = true;
    if (tag === "figcaption") parent.seenFigcaption = true;
  }
}

export function validateHtmlFragment(markup, context, path, model, maximumHeadings = LIMITS.headingsPerVariant + 1) {
  if (typeof markup !== "string") {
    context.add("markup.invalid", path, "HTML fragment must be text.");
    return { headings: [], headingCount: 0 };
  }
  const stack = [];
  const headings = [];
  let headingCount = 0;
  let elementCount = 0;
  let currentHeading;
  let offset = 0;
  const result = () => ({
    headings: headings.map(({ id, level, text }) => ({ id, level, text })),
    headingCount,
  });

  while (offset < markup.length) {
    const tagStart = markup.indexOf("<", offset);
    const textEnd = tagStart === -1 ? markup.length : tagStart;
    if (textEnd > offset) {
      const text = markup.slice(offset, textEnd);
      validateTextContent(text, stack.at(-1), context, path);
      const decodedText = decodeEntities(text, context, path);
      if (currentHeading) currentHeading.text += decodedText;
    }
    if (tagStart === -1) break;
    if (markup.startsWith("<!--", tagStart) || markup.startsWith("<!", tagStart) || markup.startsWith("<?", tagStart)) {
      context.add("markup.declaration", path, "Comments, declarations, and processing instructions are not supported in semantic fragments.");
      return result();
    }
    const tagEnd = findTagEnd(markup, tagStart + 1);
    if (tagEnd === -1) {
      context.add("markup.unterminated_tag", path, "HTML fragment contains an unterminated tag.");
      return result();
    }
    const token = markup.slice(tagStart + 1, tagEnd);
    offset = tagEnd + 1;
    if (token.length === 0 || isHtmlWhitespace(token[0])) {
      context.add("markup.invalid_tag", path, "Whitespace is not allowed between '<' and a tag name.");
      continue;
    }

    if (token.startsWith("/")) {
      const closeMatch = /^\/([A-Za-z][A-Za-z0-9]*)$/u.exec(token);
      if (!closeMatch) {
        context.add("markup.invalid_close", path, "Closing tags may not contain attributes or unsupported syntax.");
        continue;
      }
      const tag = closeMatch[1];
      if (tag !== tag.toLowerCase()) context.add("markup.not_canonical", path, `Tag <${tag}> must be lowercase.`);
      const canonicalTag = tag.toLowerCase();
      if (VOID_TAGS.has(canonicalTag)) {
        context.add("markup.void_close", path, `Void element <${canonicalTag}> may not have a closing tag.`);
        continue;
      }
      const opened = stack.pop();
      if (opened?.tag !== canonicalTag) {
        context.add("markup.nesting", path, `Closing </${canonicalTag}> does not match open <${opened?.tag ?? "none"}>.`);
        return result();
      }
      if (currentHeading?.tag === canonicalTag) {
        currentHeading.text = normalizeHeadingText(currentHeading.text);
        headingCount += 1;
        if (headings.length < maximumHeadings) headings.push(currentHeading);
        currentHeading = undefined;
      }
      continue;
    }

    const openMatch = /^([A-Za-z][A-Za-z0-9]*)([^]*)$/u.exec(token);
    if (!openMatch) {
      context.add("markup.invalid_tag", path, "HTML fragment contains invalid tag syntax.");
      continue;
    }
    const tag = openMatch[1];
    if (tag !== tag.toLowerCase()) context.add("markup.not_canonical", path, `Tag <${tag}> must be lowercase.`);
    const canonicalTag = tag.toLowerCase();
    if (!ALLOWED_TAGS.has(canonicalTag)) {
      context.add("markup.unsupported_tag", path, `Element <${canonicalTag}> is not supported in semantic fragments.`);
      return result();
    }
    if (elementCount >= LIMITS.markupElements) {
      context.add("limit.markup_elements", path, `HTML fragments may not contain more than ${LIMITS.markupElements} elements.`);
      return result();
    }
    elementCount += 1;
    if (!VOID_TAGS.has(canonicalTag) && stack.length >= LIMITS.markupDepth) {
      context.add("limit.markup_depth", path, `HTML fragment nesting may not exceed ${LIMITS.markupDepth} elements.`);
      return result();
    }
    validateElementContent(canonicalTag, stack, context, path);
    const parsed = parseAttributes(openMatch[2], context, path);
    validateCommonAttributes(canonicalTag, parsed.attributes, context, path);
    validateSpecialAttributes(canonicalTag, parsed.attributes, context, path, model);
    if (parsed.selfClosing && !VOID_TAGS.has(canonicalTag)) {
      context.add("markup.self_closing", path, `Non-void element <${canonicalTag}> may not use self-closing syntax.`);
    }
    if (!VOID_TAGS.has(canonicalTag)) {
      const parent = stack.at(-1);
      stack.push({
        tag: canonicalTag,
        contentParentTag: TRANSPARENT_CONTAINERS.has(canonicalTag)
          ? parent?.contentParentTag
          : canonicalTag,
        childElementCount: 0,
        seenFigcaption: false,
        seenSummary: false,
        figcaptionMustBeLast: false,
      });
    }
    if (/^h[2-6]$/u.test(canonicalTag)) {
      if (currentHeading) context.add("markup.heading_nesting", path, "Headings may not be nested.");
      currentHeading = {
        id: parsed.attributes.get("id") ?? "",
        level: Number(canonicalTag.slice(1)),
        text: "",
      };
      currentHeading.tag = canonicalTag;
    } else if (currentHeading && canonicalTag === "img") {
      currentHeading.text += parsed.attributes.get("alt") ?? "";
    }
  }

  if (stack.length > 0) context.add("markup.unclosed_tag", path, `HTML fragment has unclosed <${stack.at(-1).tag}> markup.`);
  return result();
}

export function compareFragmentHeadings(actual, expected, context, path, actualCount = actual.length) {
  if (actualCount !== expected.length) {
    context.add("markup.heading_drift", path, `Fragment contains ${actualCount} headings but the manifest declares ${expected.length}.`);
    return;
  }
  for (let index = 0; index < actual.length; index += 1) {
    const actualHeading = actual[index];
    const expectedHeading = expected[index];
    if (actualHeading.id !== expectedHeading.id || actualHeading.level !== expectedHeading.level || actualHeading.text !== normalizeHeadingText(expectedHeading.text)) {
      context.add("markup.heading_drift", path, `Heading ${index + 1} does not match its manifest id, level, and text.`);
    }
  }
}
