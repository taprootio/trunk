export const SUPPORTED_LOCALE_MAX_LENGTH = 12;

// Docs v1 deliberately supports a stable, registry-independent BCP 47 subset:
// a two- or three-letter language, then optional Script and region subtags.
// The casing is part of the wire contract and does not depend on host ICU data.
export const SUPPORTED_LOCALE_PATTERN = /^[a-z]{2,3}(?:-[A-Z][a-z]{3})?(?:-(?:[A-Z]{2}|[0-9]{3}))?$/u;
const SUPPORTED_LOCALE_SHAPE = /^[A-Za-z]{2,3}(?:-[A-Za-z]{4})?(?:-(?:[A-Za-z]{2}|[0-9]{3}))?$/u;

export function classifySupportedLocale(value) {
  if (SUPPORTED_LOCALE_PATTERN.test(value)) return "supported";
  if (SUPPORTED_LOCALE_SHAPE.test(value)) return "not_canonical";
  return "unsupported";
}

export function isDisallowedStringCodePoint(codePoint) {
  return codePoint <= 0x1f
    || (codePoint >= 0x7f && codePoint <= 0x9f)
    || codePoint === 0x061c
    || codePoint === 0x200e
    || codePoint === 0x200f
    || (codePoint >= 0x202a && codePoint <= 0x202e)
    || (codePoint >= 0x2066 && codePoint <= 0x2069);
}

export function hasDisallowedStringCharacters(value) {
  for (const character of value) {
    if (isDisallowedStringCodePoint(character.codePointAt(0))) return true;
  }
  return false;
}
