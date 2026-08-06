import { LIMITS, RESERVED_ROUTE_PREFIXES, RESERVED_ROUTES } from "./constants.js";

const ARTIFACT_SEGMENT = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const ROUTE_SEGMENT = /^[a-z0-9]+(?:[._~-][a-z0-9]+)*$/;
const WINDOWS_DEVICE_SEGMENT = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu;

function pathFailure(code, message) {
  return { ok: false, code, message };
}

function hasUnsafeCharacters(value) {
  return /[\u0000-\u001f\u007f]/u.test(value) || value.includes("\\") || value.includes("%");
}

export function normalizeArtifactPath(value) {
  if (typeof value !== "string" || value.length === 0) {
    return pathFailure("path.invalid", "Artifact paths must be non-empty strings.");
  }
  if (value.length > LIMITS.artifactPath) {
    return pathFailure("path.too_long", `Artifact paths may not exceed ${LIMITS.artifactPath} characters.`);
  }
  if (value !== value.normalize("NFC")) {
    return pathFailure("path.not_normalized", "Artifact paths must use Unicode NFC normalization.");
  }
  if (value.startsWith("/") || hasUnsafeCharacters(value) || /[?#]/u.test(value)) {
    return pathFailure("path.unsafe", "Artifact paths must be relative POSIX paths without escapes, controls, queries, or fragments.");
  }

  const segments = value.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    return pathFailure("path.unsafe", "Artifact paths may not contain empty or dot segments.");
  }
  if (segments.some((segment) => WINDOWS_DEVICE_SEGMENT.test(segment))) {
    return pathFailure("path.device_name", "Artifact path segments may not use Windows device-name aliases.");
  }
  if (segments.some((segment) => !ARTIFACT_SEGMENT.test(segment))) {
    return pathFailure("path.not_canonical", "Artifact path segments must be lowercase ASCII words separated only by '.', '_', or '-'.");
  }

  return { ok: true, value: segments.join("/") };
}

export function normalizeSourcePath(value) {
  if (typeof value !== "string" || value.length === 0) {
    return pathFailure("source_path.invalid", "Source paths must be non-empty strings.");
  }
  if (!value.isWellFormed()) {
    return pathFailure("source_path.invalid_unicode", "Source paths must contain only well-formed Unicode scalar values.");
  }
  if (value.length > LIMITS.sourcePath * 2 || [...value].length > LIMITS.sourcePath) {
    return pathFailure("source_path.too_long", `Source paths may not exceed ${LIMITS.sourcePath} characters.`);
  }
  if (value !== value.normalize("NFC")) {
    return pathFailure("source_path.not_normalized", "Source paths must use Unicode NFC normalization.");
  }
  if (value.startsWith("/") || hasUnsafeCharacters(value) || /[?#]/u.test(value)) {
    return pathFailure("source_path.unsafe", "Source paths must be relative POSIX paths without escapes, controls, queries, or fragments.");
  }

  const segments = value.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    return pathFailure("source_path.unsafe", "Source paths may not contain empty or dot segments.");
  }

  return { ok: true, value: segments.join("/") };
}

export function normalizeRoute(value) {
  if (typeof value !== "string" || value.length === 0) {
    return pathFailure("route.invalid", "Routes must be non-empty strings.");
  }
  if (value.length > LIMITS.route) {
    return pathFailure("route.too_long", `Routes may not exceed ${LIMITS.route} characters.`);
  }
  if (value !== value.normalize("NFC")) {
    return pathFailure("route.not_normalized", "Routes must use Unicode NFC normalization.");
  }
  if (!value.startsWith("/") || hasUnsafeCharacters(value) || /[?#]/u.test(value)) {
    return pathFailure("route.unsafe", "Routes must be root-relative paths without escapes, controls, queries, or fragments.");
  }
  if (value !== "/" && !value.endsWith("/")) {
    return pathFailure("route.not_canonical", "Routes must end with '/' so file and directory forms cannot alias.");
  }

  const body = value === "/" ? "" : value.slice(1, -1);
  const segments = body === "" ? [] : body.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    return pathFailure("route.unsafe", "Routes may not contain empty or dot segments.");
  }
  if (segments.some((segment) => WINDOWS_DEVICE_SEGMENT.test(segment))) {
    return pathFailure("route.device_name", "Route segments may not use Windows device-name aliases.");
  }
  if (segments.some((segment) => !ROUTE_SEGMENT.test(segment))) {
    return pathFailure("route.not_canonical", "Route segments must be lowercase ASCII URL words.");
  }

  const normalized = segments.length === 0 ? "/" : `/${segments.join("/")}/`;
  if (RESERVED_ROUTES.includes(normalized) || RESERVED_ROUTE_PREFIXES.some((prefix) => normalized.startsWith(prefix))) {
    return pathFailure("route.reserved", "The route is reserved for Taproot's published shell or artifact metadata.");
  }

  return { ok: true, value: normalized };
}
