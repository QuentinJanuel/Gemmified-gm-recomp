// Stands in for upstream's web/src/asset.mjs (host/build.ts swaps it in): the worker is bundled at
// the plugin's root, so its files (system32/) are found beside it, not one directory up.
export const asset = (path: string) => new URL(path, import.meta.url);
