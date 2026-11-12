// The shared virtual filesystem engines run on, and the only module of it anyone imports. Nothing
// outside this directory reaches the individual modules.
//
// See types.ts for the terminology (bundle / store / whiteout / mount) and vfs.ts for the three
// rules that define the overlay.
//
// A host supplies the storage (the `StoreBackend` seam in store.ts: localStorage in a page, a
// plain Map in a worker) and nothing else. Engines reach this
// from their own side of the module graph, as a compiled ES module served next to their payload --
// which is why this barrel is the compilation entry point and not just a convenience.

export type { DirEntry, FileStat, GameId, Layer, MountKind, VPath } from "./types";
export { MOUNTS, MOUNT_LABELS, MOUNT_DESCRIPTIONS } from "./types";

export {
  MOUNT_ROOTS,
  baseName,
  formatPath,
  isDirectChild,
  isInside,
  joinPath,
  parentOf,
  parsePath,
  pathKey,
  wildcardMatcher,
} from "./path";

export { Bundle, bundleFromUpload } from "./bundle";
export type { UploadEntry } from "./bundle";
export { MemoryBackend, Store, seedForGame, storeForGame, storeKeyFor } from "./store";
export type { StoreBackend } from "./store";
export { Vfs } from "./vfs";
