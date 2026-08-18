import { PREBUILT_LIMITS, PREBUILT_MANIFEST_FILE_NAME } from "./prebuilt-constants.js";

const PORTABLE_SEGMENT = /^(?:[A-Za-z0-9]|[A-Za-z0-9_-][A-Za-z0-9._-]*[A-Za-z0-9])$/;
const WINDOWS_DEVICE_SEGMENT = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu;
const PUBLISHED_SITE_ROUTING_CONTROL_ROUTE = "/__taproot/internal/published-site-routing";

function failure(code, message) {
  return { ok: false, code, message };
}

function ustarRepresentable(value) {
  if (value.length <= 100) return true;
  for (let index = value.lastIndexOf("/"); index > 0; index = value.lastIndexOf("/", index - 1)) {
    if (index <= 155 && value.length - index - 1 <= 100) return true;
  }
  return false;
}

export function normalizePrebuiltArtifactPath(value) {
  if (typeof value !== "string" || value.length === 0) {
    return failure("path.invalid", "Prebuilt artifact paths must be non-empty strings.");
  }
  if (!value.isWellFormed() || /[^\u0020-\u007e]/u.test(value)) {
    return failure("path.not_ascii", "Prebuilt artifact paths must contain only printable ASCII characters.");
  }
  if (value.length > PREBUILT_LIMITS.artifactPathBytes) {
    return failure(
      "path.too_long",
      `Prebuilt artifact paths may not exceed ${PREBUILT_LIMITS.artifactPathBytes} bytes.`,
    );
  }
  if (value.startsWith("/") || value.includes("\\") || value.includes("%") || /[?#]/u.test(value)) {
    return failure(
      "path.unsafe",
      "Prebuilt artifact paths must be relative POSIX paths without escapes, queries, or fragments.",
    );
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    return failure("path.unsafe", "Prebuilt artifact paths may not contain empty or dot segments.");
  }
  if (segments.length - 1 > PREBUILT_LIMITS.directoryDepth) {
    return failure(
      "limit.directory_depth",
      `Prebuilt artifact paths may not exceed ${PREBUILT_LIMITS.directoryDepth} directory levels.`,
    );
  }
  if (segments.some((segment) => WINDOWS_DEVICE_SEGMENT.test(segment))) {
    return failure("path.device_name", "Prebuilt artifact path segments may not use Windows device-name aliases.");
  }
  if (segments.some((segment) => !PORTABLE_SEGMENT.test(segment))) {
    return failure(
      "path.not_portable",
      "Prebuilt artifact path segments must use portable ASCII letters, digits, '.', '_', and '-'.",
    );
  }
  if (segments[0].toLowerCase() === PREBUILT_MANIFEST_FILE_NAME) {
    return failure(
      "path.manifest",
      `The manifest '${PREBUILT_MANIFEST_FILE_NAME}' and its path descendants may not be declared as payload.`,
    );
  }
  if (!ustarRepresentable(value)) {
    return failure("path.ustar", "Prebuilt artifact paths must fit POSIX USTAR name and prefix fields.");
  }
  return { ok: true, value };
}

export function prebuiltFileRoute(value) {
  const normalized = normalizePrebuiltArtifactPath(value);
  if (!normalized.ok) return normalized;
  let route = `/${value}`;
  if (value === "index.html") route = "/";
  else if (value.endsWith("/index.html")) route = `/${value.slice(0, -"index.html".length)}`;
  if (route === PUBLISHED_SITE_ROUTING_CONTROL_ROUTE) {
    return failure(
      "route.reserved",
      `The route '${PUBLISHED_SITE_ROUTING_CONTROL_ROUTE}' is reserved for Taproot routing control.`,
    );
  }
  return { ok: true, value: route };
}

export function normalizePrebuiltRedirectRoute(value) {
  if (typeof value !== "string" || value.length === 0) {
    return failure("route.invalid", "Redirect sources must be non-empty strings.");
  }
  if (!value.isWellFormed() || /[^\u0020-\u007e]/u.test(value)) {
    return failure("route.not_ascii", "Redirect sources must contain only printable ASCII characters.");
  }
  if (value.length > PREBUILT_LIMITS.routeBytes) {
    return failure("route.too_long", `Redirect sources may not exceed ${PREBUILT_LIMITS.routeBytes} bytes.`);
  }
  if (
    !value.startsWith("/") || value.startsWith("//") || value.includes("\\") || value.includes("%")
    || /[?#]/u.test(value)
  ) {
    return failure(
      "route.unsafe",
      "Redirect sources must be root-relative URL paths without escapes, queries, or fragments.",
    );
  }
  if (value.toLowerCase() === `/${PREBUILT_MANIFEST_FILE_NAME}`) {
    return failure(
      "route.reserved",
      "The prebuilt manifest path is reserved artifact metadata and cannot be a redirect source.",
    );
  }
  if (value === PUBLISHED_SITE_ROUTING_CONTROL_ROUTE) {
    return failure(
      "route.reserved",
      `The route '${PUBLISHED_SITE_ROUTING_CONTROL_ROUTE}' is reserved for Taproot routing control.`,
    );
  }
  if (value === "/") return { ok: true, value };
  const hasTrailingSlash = value.endsWith("/");
  const body = value.slice(1, hasTrailingSlash ? -1 : undefined);
  const segments = body.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    return failure("route.unsafe", "Redirect sources may not contain empty or dot segments.");
  }
  if (segments.some((segment) => WINDOWS_DEVICE_SEGMENT.test(segment))) {
    return failure("route.device_name", "Redirect source segments may not use Windows device-name aliases.");
  }
  if (segments.some((segment) => !PORTABLE_SEGMENT.test(segment))) {
    return failure("route.not_portable", "Redirect source segments must use portable ASCII characters.");
  }
  return { ok: true, value };
}
