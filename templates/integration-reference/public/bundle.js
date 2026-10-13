// This optional browser module has no network calls and no Taproot credentials.
// Upload it only with scripts/upload-bundle.mjs, then have a Taproot operator
// approve/select it and a site owner pin it through the separate platform flow.
export function enhanceReferenceSchedule(root) {
  if (!(root instanceof Element)) return;
  root.dataset.taprootReferenceEnhanced = "true";
}
