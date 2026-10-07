/**
 * An Espalier module that sits beside the exported theme module but is not
 * exported itself (the fit report, the color engine). Its package root
 * re-exports every component module, which registers custom elements as it
 * loads, so these are loaded from beside the theme module instead, sharing its
 * instance. The exact Espalier pin and this package's tests catch a release
 * that moves them.
 */
export function loadEspalierShared(file) {
  return import(new URL(`./${file}`, import.meta.resolve("@taprootio/espalier/shared/theme")).href);
}
