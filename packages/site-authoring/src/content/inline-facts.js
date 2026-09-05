import { FREE_FORM_SECTION_REGISTRY } from "./free-form-sections.js";
import {
  CONTENT_ERROR_CODES as CODES,
  CONTENT_LIMITS,
  contentError,
  identifier,
  isPlainObject,
  isSafeUrl,
  pointerSegment,
} from "./vocabulary.js";

function scalarLength(value, stopAfter = Number.POSITIVE_INFINITY) {
  let length = 0;
  for (const _character of value) {
    length += 1;
    if (length > stopAfter) break;
  }
  return length;
}

function inlineFactUrlIsSafe(value) {
  return typeof value === "string" && value.trim() !== "" && isSafeUrl(value.trim());
}

/** Validate and canonically order the first-class inlineFacts item array. */
export function normalizeInlineFactsItems(
  value,
  path = "/attrs/items",
  source = FREE_FORM_SECTION_REGISTRY,
) {
  const errors = [];
  const report = (errorPath, code, message) => {
    if (errors.length < CONTENT_LIMITS.documentErrors) errors.push(contentError(errorPath, code, message));
  };
  const finish = (items) => Object.freeze({ items, errors: Object.freeze(errors) });
  const definition = source.inlineFacts.attrs.items;

  if (!Array.isArray(value)) {
    report(path, CODES.attrInvalid, "Inline facts items must be an array.");
    return finish(undefined);
  }
  if (value.length < definition.minItems || value.length > definition.maxItems) {
    report(
      path,
      CODES.attrInvalid,
      `Inline facts must contain ${definition.minItems} through ${definition.maxItems} items.`,
    );
  }

  const items = [];
  value.forEach((item, index) => {
    const itemPath = `${path}/${index}`;
    if (!isPlainObject(item)) {
      report(itemPath, CODES.attrInvalid, "An inline fact must be an object.");
      return;
    }
    for (const key of Object.keys(item)) {
      if (!Object.hasOwn(definition.fields, key)) {
        report(
          `${itemPath}/${pointerSegment(key)}`,
          CODES.attrUnknown,
          `Inline fact field '${identifier(key)}' is not supported.`,
        );
      }
    }

    // The value is the fact; the label names it when the value does not name
    // itself. An omitted or null label is the standalone fact, while an empty
    // string stays refused so a half-authored item is still caught.
    for (const name of ["value", "label"]) {
      const field = definition.fields[name];
      const entry = item[name];
      if (!field.required && (entry === undefined || entry === null)) continue;
      if (typeof entry !== "string" || (field.nonWhitespace && entry.trim() === "")) {
        report(`${itemPath}/${name}`, CODES.attrInvalid, `Inline fact ${name} must contain non-whitespace text.`);
      } else if (scalarLength(entry, field.maxScalars) > field.maxScalars) {
        report(
          `${itemPath}/${name}`,
          CODES.attrInvalid,
          `Inline fact ${name} must contain at most ${field.maxScalars} Unicode scalar values.`,
        );
      }
    }

    if (item.url !== undefined && item.url !== null && !inlineFactUrlIsSafe(item.url)) {
      report(
        `${itemPath}/url`,
        CODES.attrInvalid,
        "Inline fact url must be a safe HTTP(S), mailto, tel, non-protocol-relative root, fragment, query, or relative URL without backslashes or ASCII controls.",
      );
    }

    items.push(Object.freeze({
      value: item.value,
      ...(typeof item.label === "string" ? { label: item.label } : {}),
      ...(typeof item.url === "string" ? { url: item.url.trim() } : {}),
    }));
  });

  return errors.length === 0 ? finish(Object.freeze(items)) : finish(undefined);
}
