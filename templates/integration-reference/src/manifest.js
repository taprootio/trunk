export function referenceManifest(publicOrigin) {
  return Object.freeze({
    slug: "taproot-reference",
    displayName: "Taproot reference integration",
    description: "A minimal independently deployed Node and PostgreSQL integration that publishes a page, media, data document, and placement fragment.",
    webhookEndpointUrl: `${publicOrigin}/webhooks`,
    settingsUrl: `${publicOrigin}/settings`,
    requestedCapabilities: ["pages.manage_own", "data.manage_own", "media.manage_own", "publish", "fragments.manage_own"],
    offeredComponents: [{
      id: "schedule",
      name: "Reference schedule",
      configSchema: {
        type: "object",
        properties: {
          location: { type: "string", minLength: 1, maxLength: 120 },
          showCapacity: { type: "boolean" },
        },
        required: ["location", "showCapacity"],
        additionalProperties: false,
      },
    }],
    externalScriptOrigins: [],
    externalConnectOrigins: [],
    defaultPublishPolicy: "stage",
    recommendedUninstallDisposition: "freeze",
    contractVersion: "1",
    pricingOptions: [{ id: "free", version: "1", quantityMin: 1, quantityMax: null, cadence: "free", catalogueItemKey: null }],
  });
}
