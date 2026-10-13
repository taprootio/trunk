import { createHash } from "node:crypto";

function escapeText(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function idempotencyKey(deliveryId, operation) {
  return `reference:${operation}:${deliveryId}`;
}

export function referencePage(publicOrigin = "https://reference.example.com", installationId = "example") {
  const primaryId = new URL(`/installations/${encodeURIComponent(installationId)}/reference#primary`, publicOrigin).href;
  return {
    externalId: "reference-welcome",
    path: "reference/information",
    title: "Taproot reference integration",
    description: "A small managed page from the public Taproot integration reference service.",
    indexable: true,
    fragments: [
      "<section><h1>Reference integration</h1><p>This page is published by an independently deployed integration.</p><p>It remains useful without the optional browser bundle.</p></section>",
    ],
    structuredData: [JSON.stringify({ "@context": "https://schema.org", "@type": "WebPage", "@id": primaryId, name: "Taproot reference integration" })],
    primaryStructuredDataId: primaryId,
    folder: "",
    tagIds: [],
    includeInNavigation: true,
    publicationDate: "",
    archiveDate: "",
    includeInLatestPosts: false,
  };
}

export function referenceDocument() {
  return {
    key: "reference.schedule",
    json: JSON.stringify({
      version: 1,
      title: "Reference schedule",
      entries: [
        { id: "welcome", startsAt: "2026-01-01T09:00:00Z", label: "Welcome session" },
      ],
    }),
  };
}

/** A tiny opaque PNG, uploaded through the normal media reservation flow. */
export function referenceMedia() {
  return {
    fileName: "reference-marker.png",
    contentType: "image/png",
    bytes: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEklEQVR4nGNQrnD8jw8zjAwFAPPsdsH7wKkbAAAAAElFTkSuQmCC",
      "base64",
    ),
    width: 8,
    height: 8,
  };
}

export function contentHash(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * This does not interpolate HTML from the placement configuration. It renders
 * only escaped text and a boolean selected by the approved configuration
 * schema, so it stays inside the server sanitizer's conservative contract.
 */
export function placementFragment(config) {
  const source = config !== null && typeof config === "object" && !Array.isArray(config) ? config : {};
  const location = typeof source.location === "string" && source.location.length <= 120 ? source.location : "your studio";
  const capacity = source.showCapacity === true
    ? " Capacity information is enabled."
    : " Capacity information is not displayed.";
  return `<section><h2>Schedule for ${escapeText(location)}</h2><p>Published by the reference integration.${capacity}</p></section>`;
}
