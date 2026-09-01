import registry from "./free-form-section-registry.json" with { type: "json" };

import {
  CONTENT_ERROR_CODES as CODES,
  CONTENT_LIMITS,
  contentError,
  identifier,
  isPlainObject,
  isUuid,
  pointerSegment,
} from "./vocabulary.js";

function deepFreeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export const FREE_FORM_SECTION_REGISTRY = deepFreeze(registry);

function decorationDeliveryUrlIsSafe(value) {
  if (typeof value !== "string" || value === "" || /[\u0000-\u0020\u007f]/u.test(value) || value.includes("\\")) {
    return false;
  }
  if (value.startsWith("/")) return !value.startsWith("//");
  if (!/^https:\/\//iu.test(value)) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:"
      && parsed.hostname !== ""
      && parsed.username === ""
      && parsed.password === "";
  } catch {
    return false;
  }
}

function normalizeProcessedSectionImage(value, definition, path, label, report) {
  let valid = true;
  const reject = (errorPath, code, message) => {
    valid = false;
    report(errorPath, code, message);
  };

  if (!isPlainObject(value)) {
    reject(path, CODES.attrInvalid, `${label} must be an object.`);
    return undefined;
  }

  const imageKeys = [...definition.requiredKeys, ...definition.optionalKeys];
  for (const key of Object.keys(value)) {
    if (!imageKeys.includes(key)) {
      reject(
        `${path}/${pointerSegment(key)}`,
        CODES.attrUnknown,
        `${label} field '${identifier(key)}' is not part of the processed-image shape.`,
      );
    }
  }
  for (const key of definition.requiredKeys) {
    if (!Object.hasOwn(value, key)) {
      reject(
        `${path}/${key}`,
        CODES.imageKeys,
        `${label} must include '${key}' so ownership and delivery rewriting can resolve it.`,
      );
    }
  }

  if (Object.hasOwn(value, "imageId") && !isUuid(value.imageId)) {
    reject(`${path}/imageId`, CODES.attrInvalid, `${label} imageId must be a canonical lowercase UUID.`);
  }
  if (Object.hasOwn(value, "src")) {
    if (typeof value.src !== "string") {
      reject(`${path}/src`, CODES.attrInvalid, `${label} src must be a string.`);
    } else if (!decorationDeliveryUrlIsSafe(value.src)) {
      reject(
        `${path}/src`,
        value.src === "" ? CODES.imageKeys : CODES.attrInvalid,
        value.src === ""
          ? `${label} src has no usable delivery URL. Use the complete processed-image object returned by media upload.`
          : `${label} src must be an HTTPS or non-protocol-relative root URL without credentials, whitespace, controls, or backslashes.`,
      );
    }
  }

  if (Object.hasOwn(value, "urls")) {
    if (!Array.isArray(value.urls)) {
      reject(`${path}/urls`, CODES.attrInvalid, `${label} urls must be an array.`);
    } else {
      if (value.urls.length < definition.urls.minItems || value.urls.length > definition.urls.maxItems) {
        reject(
          `${path}/urls`,
          CODES.attrInvalid,
          `${label} urls must contain ${definition.urls.minItems} through ${definition.urls.maxItems} responsive candidates.`,
        );
      }
      for (let index = 0; index < value.urls.length; index += 1) {
        const option = value.urls[index];
        const optionPath = `${path}/urls/${index}`;
        if (!isPlainObject(option)) {
          reject(optionPath, CODES.attrInvalid, `A responsive ${label.toLowerCase()} URL must be an object.`);
          continue;
        }
        for (const key of Object.keys(option)) {
          if (!Object.hasOwn(definition.urls.fields, key)) {
            reject(
              `${optionPath}/${pointerSegment(key)}`,
              CODES.attrUnknown,
              `Responsive ${label.toLowerCase()} field '${identifier(key)}' is not supported.`,
            );
          }
        }
        if (
          typeof option.minWidth !== "number"
          || !Number.isInteger(option.minWidth)
          || option.minWidth < definition.urls.fields.minWidth.minimum
        ) {
          reject(`${optionPath}/minWidth`, CODES.attrInvalid, `Responsive ${label.toLowerCase()} minWidth must be a positive integer.`);
        }
        if (typeof option.url !== "string" || !decorationDeliveryUrlIsSafe(option.url)) {
          reject(
            `${optionPath}/url`,
            CODES.attrInvalid,
            `A responsive ${label.toLowerCase()} URL must be HTTPS or a non-protocol-relative root URL without credentials, whitespace, controls, or backslashes.`,
          );
        }
        if (
          option.type !== undefined
          && (typeof option.type !== "string" || !definition.urls.fields.type.values.includes(option.type))
        ) {
          reject(
            `${optionPath}/type`,
            CODES.attrInvalid,
            `Responsive ${label.toLowerCase()} type must be ${definition.urls.fields.type.values.map((entry) => JSON.stringify(entry)).join(" or ")} when present.`,
          );
        }
      }
      if (
        definition.srcMustMatchUrls
        && typeof value.src === "string"
        && !value.urls.some((option) => isPlainObject(option) && option.url === value.src)
      ) {
        reject(`${path}/src`, CODES.attrInvalid, `${label} src must equal one of its responsive urls[].url candidates.`);
      }
    }
  }

  for (const name of ["width", "height"]) {
    if (
      Object.hasOwn(value, name)
      && (typeof value[name] !== "number" || !Number.isInteger(value[name]) || value[name] <= 0)
    ) {
      reject(`${path}/${name}`, CODES.attrInvalid, `${label} ${name} must be a positive integer.`);
    }
  }
  if (Object.hasOwn(value, "alt") && typeof value.alt !== "string") {
    reject(`${path}/alt`, CODES.attrInvalid, `${label} alt must be a string.`);
  }

  if (!valid) return undefined;
  return Object.freeze({
    imageId: value.imageId,
    src: value.src,
    urls: Object.freeze(value.urls.map((option) => Object.freeze({
      minWidth: option.minWidth,
      url: option.url,
      ...(option.type === undefined ? {} : { type: option.type }),
    }))),
    ...(Object.hasOwn(value, "width") ? { width: value.width } : {}),
    ...(Object.hasOwn(value, "height") ? { height: value.height } : {}),
    ...(Object.hasOwn(value, "alt") ? { alt: value.alt } : {}),
  });
}

function normalizeSectionFocus(value, definition, path, label, report) {
  if (value === undefined) value = definition.default;
  if (value === null && definition.nullable === true) return null;
  if (!isPlainObject(value)) {
    report(path, CODES.attrInvalid, `${label} must be a closed { x, y } point.`);
    return undefined;
  }

  let valid = true;
  for (const key of Object.keys(value)) {
    if (!Object.hasOwn(definition.fields, key)) {
      valid = false;
      report(`${path}/${pointerSegment(key)}`, CODES.attrUnknown, `${label} field '${identifier(key)}' is not supported.`);
    }
  }
  const normalized = {};
  for (const [name, coordinate] of Object.entries(definition.fields)) {
    const entry = Object.hasOwn(value, name) ? value[name] : coordinate.default;
    if (
      typeof entry !== "number"
      || !Number.isFinite(entry)
      || entry < coordinate.minimum
      || entry > coordinate.maximum
    ) {
      valid = false;
      report(
        `${path}/${name}`,
        CODES.attrInvalid,
        `${label} ${name} must be a finite number from ${coordinate.minimum} through ${coordinate.maximum}.`,
      );
    }
    normalized[name] = entry;
  }
  return valid ? Object.freeze(normalized) : undefined;
}

/** Validate and canonicalize the registry-owned section photo substrate. */
export function normalizeFreeFormSectionBackground(
  value,
  path = "/attrs/background",
  source = FREE_FORM_SECTION_REGISTRY,
) {
  const errors = [];
  const report = (errorPath, code, message) => {
    if (errors.length < CONTENT_LIMITS.documentErrors) errors.push(contentError(errorPath, code, message));
  };
  const finish = (background) => Object.freeze({ background, errors: Object.freeze(errors) });

  if (value === undefined || value === null) return finish(undefined);
  if (!isPlainObject(value)) {
    report(path, CODES.attrInvalid, "Section background must be an object when present.");
    return finish(undefined);
  }

  const fields = source.section.attrs.background.fields;
  for (const key of Object.keys(value)) {
    if (!Object.hasOwn(fields, key)) {
      report(`${path}/${pointerSegment(key)}`, CODES.attrUnknown, `Section background field '${identifier(key)}' is not supported.`);
    }
  }

  if (!Object.hasOwn(value, "image")) {
    report(`${path}/image`, CODES.imageKeys, "Section background must include a site-owned processed image.");
  }
  const image = Object.hasOwn(value, "image")
    ? normalizeProcessedSectionImage(value.image, fields.image, `${path}/image`, "Section background image", report)
    : undefined;
  const portraitImage = value.portraitImage === undefined || value.portraitImage === null
    ? null
    : normalizeProcessedSectionImage(
      value.portraitImage,
      fields.portraitImage,
      `${path}/portraitImage`,
      "Section background portrait image",
      report,
    );
  const focus = normalizeSectionFocus(value.focus, fields.focus, `${path}/focus`, "Section background focus", report);
  const portraitFocus = normalizeSectionFocus(
    value.portraitFocus,
    fields.portraitFocus,
    `${path}/portraitFocus`,
    "Section background portrait focus",
    report,
  );
  const scrimStrength = Object.hasOwn(value, "scrimStrength")
    ? value.scrimStrength
    : fields.scrimStrength.default;
  if (typeof scrimStrength !== "string" || !fields.scrimStrength.values.includes(scrimStrength)) {
    report(
      `${path}/scrimStrength`,
      CODES.attrInvalid,
      `Section background scrimStrength must be one of ${fields.scrimStrength.values.map((item) => JSON.stringify(item)).join(", ")}.`,
    );
  }

  if (errors.length > 0 || image === undefined || focus === undefined || portraitFocus === undefined) {
    return finish(undefined);
  }
  return finish(Object.freeze({
    image,
    portraitImage,
    focus,
    portraitFocus,
    scrimStrength,
  }));
}

/**
 * Validate and canonicalize one section decoration from the registry.
 *
 * The returned image keeps the standard `imageId`/`src`/`urls` delivery keys:
 * the API's ownership rewriter only replaces keys already present in the
 * document. URLs are still restricted here because pulled `.pm.json` files and
 * Markdown headers are untrusted authoring input, even though an owned image is
 * re-enriched before the generator sees it.
 */
export function normalizeFreeFormSectionDecoration(
  value,
  path = "/attrs/decoration",
  source = FREE_FORM_SECTION_REGISTRY,
) {
  const errors = [];
  const report = (errorPath, code, message) => {
    if (errors.length < CONTENT_LIMITS.documentErrors) errors.push(contentError(errorPath, code, message));
  };
  const finish = (decoration) => Object.freeze({
    decoration,
    errors: Object.freeze(errors),
  });

  if (value === undefined || value === null) return finish(undefined);
  if (!isPlainObject(value)) {
    report(path, CODES.attrInvalid, "Section decoration must be an object when present.");
    return finish(undefined);
  }

  const fields = source.section.attrs.decoration.fields;
  for (const key of Object.keys(value)) {
    if (errors.length >= CONTENT_LIMITS.documentErrors) break;
    if (!Object.hasOwn(fields, key)) {
      report(
        `${path}/${pointerSegment(key)}`,
        CODES.attrUnknown,
        `Section decoration field '${identifier(key)}' is not supported.`,
      );
    }
  }

  const imagePath = `${path}/image`;
  const imageDefinition = fields.image;
  const image = value.image;
  if (!Object.hasOwn(value, "image")) {
    report(imagePath, CODES.imageKeys, "Section decoration must include a site-owned processed image.");
  } else if (!isPlainObject(image)) {
    report(imagePath, CODES.attrInvalid, "Section decoration image must be an object.");
  } else {
    const imageKeys = [...imageDefinition.requiredKeys, ...imageDefinition.optionalKeys];
    for (const key of Object.keys(image)) {
      if (errors.length >= CONTENT_LIMITS.documentErrors) break;
      if (!imageKeys.includes(key)) {
        report(
          `${imagePath}/${pointerSegment(key)}`,
          CODES.attrUnknown,
          `Section decoration image field '${identifier(key)}' is not part of the processed-image shape.`,
        );
      }
    }
    for (const key of imageDefinition.requiredKeys) {
      if (!Object.hasOwn(image, key)) {
        report(
          `${imagePath}/${key}`,
          CODES.imageKeys,
          `Section decoration image must include '${key}' so ownership and delivery rewriting can resolve it.`,
        );
      }
    }

    if (Object.hasOwn(image, "imageId") && !isUuid(image.imageId)) {
      report(`${imagePath}/imageId`, CODES.attrInvalid, "Section decoration imageId must be a canonical lowercase UUID.");
    }

    if (Object.hasOwn(image, "src")) {
      if (typeof image.src !== "string") {
        report(`${imagePath}/src`, CODES.attrInvalid, "Section decoration image src must be a string.");
      } else if (!decorationDeliveryUrlIsSafe(image.src)) {
        report(
          `${imagePath}/src`,
          image.src === "" ? CODES.imageKeys : CODES.attrInvalid,
          image.src === ""
            ? "Section decoration image src has no usable delivery URL. Use the complete processed-image object returned by media upload."
            : "Section decoration image src must be an HTTPS or non-protocol-relative root URL without credentials, whitespace, controls, or backslashes.",
        );
      }
    }

    if (Object.hasOwn(image, "urls")) {
      if (!Array.isArray(image.urls)) {
        report(`${imagePath}/urls`, CODES.attrInvalid, "Section decoration image urls must be an array.");
      } else {
        if (image.urls.length < imageDefinition.urls.minItems || image.urls.length > imageDefinition.urls.maxItems) {
          report(
            `${imagePath}/urls`,
            CODES.attrInvalid,
            `Section decoration image urls must contain ${imageDefinition.urls.minItems} through ${imageDefinition.urls.maxItems} responsive candidates.`,
          );
        }
        for (let index = 0; index < image.urls.length && errors.length < CONTENT_LIMITS.documentErrors; index += 1) {
          const option = image.urls[index];
          const optionPath = `${imagePath}/urls/${index}`;
          if (!isPlainObject(option)) {
            report(optionPath, CODES.attrInvalid, "A responsive decoration image URL must be an object.");
            continue;
          }
          for (const key of Object.keys(option)) {
            if (!Object.hasOwn(imageDefinition.urls.fields, key)) {
              report(
                `${optionPath}/${pointerSegment(key)}`,
                CODES.attrUnknown,
                `Responsive decoration image field '${identifier(key)}' is not supported.`,
              );
            }
          }
          if (
            typeof option.minWidth !== "number"
            || !Number.isInteger(option.minWidth)
            || option.minWidth < imageDefinition.urls.fields.minWidth.minimum
          ) {
            report(`${optionPath}/minWidth`, CODES.attrInvalid, "Responsive decoration minWidth must be a positive integer.");
          }
          if (typeof option.url !== "string" || !decorationDeliveryUrlIsSafe(option.url)) {
            report(
              `${optionPath}/url`,
              CODES.attrInvalid,
              "A responsive decoration URL must be HTTPS or non-protocol-relative root URL without credentials, whitespace, controls, or backslashes.",
            );
          }
          if (
            option.type !== undefined
            && (
              typeof option.type !== "string"
              || !imageDefinition.urls.fields.type.values.includes(option.type)
            )
          ) {
            report(`${optionPath}/type`, CODES.attrInvalid, "Responsive decoration image type must be 'image/webp'.");
          }
        }
        if (
          imageDefinition.srcMustMatchUrls
          && typeof image.src === "string"
          && !image.urls.some((option) => isPlainObject(option) && option.url === image.src)
        ) {
          report(`${imagePath}/src`, CODES.attrInvalid, "Section decoration image src must equal one of its responsive urls[].url candidates.");
        }
      }
    }

    for (const name of ["width", "height"]) {
      if (
        Object.hasOwn(image, name)
        && (typeof image[name] !== "number" || !Number.isInteger(image[name]) || image[name] <= 0)
      ) {
        report(`${imagePath}/${name}`, CODES.attrInvalid, `Section decoration image ${name} must be a positive integer.`);
      }
    }
    if (Object.hasOwn(image, "alt") && typeof image.alt !== "string") {
      report(`${imagePath}/alt`, CODES.attrInvalid, "Section decoration image alt must be a string.");
    }
  }

  for (const [name, definition] of Object.entries(fields)) {
    if (name === "image" || !Object.hasOwn(value, name)) continue;
    const fieldPath = `${path}/${name}`;
    const entry = value[name];
    if (definition.type === "enum") {
      if (typeof entry !== "string" || !definition.values.includes(entry)) {
        report(
          fieldPath,
          CODES.attrInvalid,
          `Section decoration ${name} must be one of ${definition.values.map((item) => JSON.stringify(item)).join(", ")}.`,
        );
      }
      continue;
    }
    if (
      typeof entry !== "number"
      || !Number.isFinite(entry)
      || (definition.type === "integer" && !Number.isInteger(entry))
      || entry < definition.minimum
      || entry > definition.maximum
    ) {
      report(
        fieldPath,
        CODES.attrInvalid,
        `Section decoration ${name} must be ${definition.type === "integer" ? "an integer" : "a finite number"} from ${definition.minimum} through ${definition.maximum}.`,
      );
    }
  }

  if (errors.length > 0 || !isPlainObject(image)) return finish(undefined);
  const normalizedImage = {
    imageId: image.imageId,
    src: image.src,
    urls: Object.freeze(image.urls.map((option) => Object.freeze({
      minWidth: option.minWidth,
      url: option.url,
      ...(option.type === undefined ? {} : { type: option.type }),
    }))),
    ...(Object.hasOwn(image, "width") ? { width: image.width } : {}),
    ...(Object.hasOwn(image, "height") ? { height: image.height } : {}),
    ...(Object.hasOwn(image, "alt") ? { alt: image.alt } : {}),
  };
  const normalized = { image: Object.freeze(normalizedImage) };
  for (const [name, definition] of Object.entries(fields)) {
    if (name !== "image") normalized[name] = value[name] ?? definition.default;
  }
  return finish(Object.freeze(normalized));
}

/** The exact, sorted context names present in both staged site themes. */
export function sharedThemeContextNames(lightTheme, darkTheme) {
  const light = isPlainObject(lightTheme?.contexts) ? lightTheme.contexts : {};
  const dark = isPlainObject(darkTheme?.contexts) ? darkTheme.contexts : {};
  return Object.freeze(Object.keys(light).filter((name) => Object.hasOwn(dark, name)).sort());
}

/**
 * Resolve one root document node through the declarative placement registry.
 * Components carry their own placement row; ordinary nodes use `rootNodes`.
 */
export function freeFormRootPresentation(node, source = FREE_FORM_SECTION_REGISTRY) {
  if (!isPlainObject(node) || typeof node.type !== "string") return undefined;
  if (node.type === "componentBlock") {
    const componentType = isPlainObject(node.attrs) ? node.attrs.componentType : undefined;
    return typeof componentType === "string" && Object.hasOwn(source.components, componentType)
      ? source.components[componentType]
      : undefined;
  }
  return Object.hasOwn(source.rootNodes, node.type) ? source.rootNodes[node.type] : undefined;
}

/** Whether a structurally validated document needs staged theme settings. */
export function hasNamedFreeFormSectionContext(document, source = FREE_FORM_SECTION_REGISTRY) {
  let found = false;
  const sectionType = source.section.nodeType;

  function visit(node) {
    if (found || !isPlainObject(node)) return;
    if (
      node.type === sectionType
      && isPlainObject(node.attrs)
      && typeof node.attrs.context === "string"
      && node.attrs.context !== ""
    ) {
      found = true;
      return;
    }
    if (Array.isArray(node.content)) node.content.forEach(visit);
  }

  visit(document);
  return found;
}

/**
 * Validate explicit section contexts without I/O or mutation. The same helper
 * can guard editor documents and generator inputs once those runtimes consume
 * the registry. Document-shape validation remains `validateDocument`'s job.
 */
export function validateFreeFormSectionContexts(
  document,
  allowedContexts,
  source = FREE_FORM_SECTION_REGISTRY,
) {
  const allowed = new Set(
    Array.isArray(allowedContexts) ? allowedContexts.filter((name) => typeof name === "string") : [],
  );
  const alternatives = [...allowed].sort();
  const suffix = alternatives.length > 0
    ? `Declared alternatives: ${alternatives.join(", ")}.`
    : "The staged light and dark themes declare no shared context alternatives.";
  const errors = [];
  const sectionType = source.section.nodeType;

  function visit(node, path) {
    if (errors.length >= CONTENT_LIMITS.documentErrors) return false;
    if (!isPlainObject(node)) return true;
    if (node.type === sectionType && isPlainObject(node.attrs) && typeof node.attrs.context === "string") {
      const context = node.attrs.context;
      if (!allowed.has(context)) {
        errors.push(contentError(
          `${path}/attrs/context`,
          CODES.sectionContextUnknown,
          `Section context '${context}' is not declared by both staged themes. ${suffix}`,
        ));
        if (errors.length >= CONTENT_LIMITS.documentErrors) return false;
      }
    }
    if (!Array.isArray(node.content)) return true;
    for (let index = 0; index < node.content.length; index += 1) {
      if (!visit(node.content[index], `${path}/content/${index}`)) return false;
    }
    return true;
  }

  visit(document, "");
  return Object.freeze({ errors: Object.freeze(errors) });
}
