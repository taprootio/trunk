import { isCanonicalUuid } from "./errors.js";

const identity = value => isCanonicalUuid(value) ? value : "";
const record = value => value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};

/** Stable image identities can go through the URL resolver without copying its fallback rules. */
export function logoInputsFromSettings(styles = {}, footer = {}, media = {}) {
  styles = record(styles);
  footer = record(footer);
  const dimensions = new Map(Object.values(record(media)).filter(value => isCanonicalUuid(value?.imageId)).map(value => [value.imageId, value]));
  const ratio = id => {
    const image = dimensions.get(id);
    return Number.isFinite(image?.width) && image.width > 0 && Number.isFinite(image?.height) && image.height > 0
      ? String(image.width / image.height) : "";
  };
  const input = {};
  for (const name of ["light", "dark", "lightCompact", "darkCompact"]) {
    const id = identity(styles[`${name}LogoId`]);
    input[`${name}LogoUrl`] = id;
    input[`${name}LogoAspectRatio`] = ratio(id);
  }
  for (const scheme of ["light", "dark"]) {
    const id = identity(footer[scheme]?.logoId);
    input[`${scheme}FooterLogoId`] = id;
    input[`${scheme}FooterLogoUrl`] = id;
    input[`${scheme}FooterLogoAspectRatio`] = ratio(id);
  }
  return input;
}

/** Shared artwork has no single intended brightness; classify the artifact that actually resolved. */
export function logoArtworkScheme(identity, input) {
  if (!identity) return undefined;
  const schemes = ["light", "dark"].filter(scheme => [
    input[`${scheme}LogoUrl`], input[`${scheme}CompactLogoUrl`], input[`${scheme}FooterLogoUrl`],
  ].includes(identity));
  return schemes.length === 1 ? schemes[0] : undefined;
}
