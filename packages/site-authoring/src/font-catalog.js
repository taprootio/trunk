import definitions from "@taprootio/espalier/css/fonts/font-definitions.json" with { type: "json" };

import { CLI_BINARY_NAME } from "./constants.js";

/**
 * `help fonts` (TR01188): the font families a published site can load, read
 * from the catalog Espalier ships with the CLI. A theme's font fields name a
 * family from it; the generator fetches that family's faces at publish time.
 *
 * The whole catalog is larger than one result may be, so the topic lists the
 * categories and `help fonts <category>` lists one category's families.
 */

/** A catalog variant is `regular`, `italic`, or a weight with an optional `italic`. */
function variantWeight(variant) {
  return variant === "regular" || variant === "italic" ? 400 : Number.parseInt(variant, 10);
}

// Only upright weights: a publish loads one upright face per font field, and
// the browser slants it for italics.
const FAMILIES = Object.freeze(definitions.map((definition) => Object.freeze({
  family: definition.family,
  category: definition.category,
  weights: Object.freeze(definition.variants.filter((variant) => !variant.endsWith("italic")).map(variantWeight)),
})));

export const FONT_CATEGORIES = Object.freeze([...new Set(FAMILIES.map((entry) => entry.category))]);

const DETAILS = Object.freeze([
  "Set fontBody, fontHeadings, fontBrand, fontMonospace or fontMenu in settings/taproot-styles.json to a CSS "
  + "font-family list that starts with a family from this catalog, spelled exactly as listed (the match is "
  + "case-sensitive), such as \"Inter, sans-serif\". Finish with a CSS generic family: sans-serif, serif or "
  + "monospace, or cursive for a handwriting family. A first family that is not listed is not loaded: the page "
  + "falls back to the rest of the list, so a misspelled name publishes quietly in a fallback font.",
  "Each font field's weight (fontWeightBody and the others) must be one of that family's weights; normal means 400 "
  + "and bold 700. Any other weight, or lighter or bolder, would fail the publish for a catalog family, so validate "
  + "and theme push refuse it and name the nearest weight the family has. An unset weight "
  + "takes the default: 400 for body and monospace, 700 for headings, brand and menu (brand also inherits the "
  + "headings family). So when a family lacks the default weight for its field, set that field's weight.",
  "A publish loads one upright face per font field and serves it from the site itself; visitors never contact a "
  + "font service. Italic text is the browser slanting that face. A family with no weights offers only italics and "
  + "cannot be used.",
]);

/** The catalog's categories, or one category's families. */
export function getFontCatalogReference(category) {
  const base = {
    title: "Font catalog",
    summary: "The font families a published site can load, by category, with the weights each offers.",
    usage: `${CLI_BINARY_NAME} help fonts [category] [--json]`,
    details: DETAILS,
  };
  if (category === undefined) {
    return Object.freeze({
      ...base,
      familyCount: FAMILIES.length,
      categories: Object.freeze(FONT_CATEGORIES.map((name) => Object.freeze({
        category: name,
        familyCount: FAMILIES.filter((entry) => entry.category === name).length,
        helpCommand: `${CLI_BINARY_NAME} help fonts ${name}`,
      }))),
    });
  }
  if (!FONT_CATEGORIES.includes(category)) return undefined;
  const families = FAMILIES.filter((entry) => entry.category === category)
    .map(({ family, weights }) => Object.freeze({ family, weights }));
  return Object.freeze({ ...base, category, familyCount: families.length, families: Object.freeze(families) });
}

export function formatFontCatalog(reference) {
  const header = `${reference.title}\n${reference.summary}\n\nUsage: ${reference.usage}\n\n${
    reference.details.map((detail) => `- ${detail}`).join("\n")
  }\n\n`;
  if (reference.families === undefined) {
    return `${header}${reference.familyCount} families:\n${
      reference.categories.map((entry) =>
        `  ${entry.category.padEnd(14)}${String(entry.familyCount).padStart(4)}  ${entry.helpCommand}`
      ).join("\n")
    }\n\nAdd --json for stable machine-readable output.\n`;
  }
  const width = Math.max(...reference.families.map(({ family }) => family.length)) + 2;
  return `${header}${reference.familyCount} ${reference.category} families and their weights:\n${
    reference.families.map(({ family, weights }) =>
      `  ${family.padEnd(width)}${weights.length > 0 ? weights.join(" ") : "none (italic only; cannot be used)"}`
    ).join("\n")
  }\n\nAdd --json for the same list as stable machine-readable output.\n`;
}
