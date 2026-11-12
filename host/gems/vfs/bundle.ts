// The BUNDLE: the read-only lower layer -- everything that came with the game rather than from the
// player.
//
// Two sources feed it, and keeping them in one layer is deliberate:
//
//   1. a folder upload's loose files (a game's `BGM/`, `data/sounds/`, `Graphics/` ...)
//   2. engine-provided payloads -- files an engine unpacks on the game's behalf, which the game
//      then expects to find on disk. GM8.2 extension packages ship sprites, shaders and DLLs this
//      way and read them straight back out of `temp_directory`.
//
// Source (2) is neither upload data nor save data: a GM8.2 game's message-box sprites and
// pass-through shaders, say. Its home is this layer of read-only files the game can see.

import type { FileStat, VPath } from "./types";
import { MOUNT_ROOTS, parsePath, pathKey } from "./path";

export class Bundle {
  private files = new Map<string, { path: VPath; data: Uint8Array }>();

  add(path: VPath, data: Uint8Array): void {
    this.files.set(pathKey(path), { path, data });
  }

  read(path: VPath): Uint8Array | null {
    return this.files.get(pathKey(path))?.data ?? null;
  }

  has(path: VPath): boolean {
    return this.files.has(pathKey(path));
  }

  list(): FileStat[] {
    return Array.from(this.files.values(), ({ path, data }) => ({
      path,
      size: data.length,
      layer: "bundle" as const,
    }));
  }

  get size(): number {
    return this.files.size;
  }
}

/// One file from a folder upload: a path relative to the folder root, and its bytes.
export interface UploadEntry {
  readonly path: string;
  readonly bytes: Uint8Array;
}

/// Builds the bundle for a freshly-uploaded game. Upload paths are relative to the game's own
/// folder, so they all land on the `game` mount -- the engines' `working_directory` root.
export function bundleFromUpload(entries: readonly UploadEntry[]): Bundle {
  const bundle = new Bundle();
  for (const entry of entries) {
    bundle.add(parsePath(MOUNT_ROOTS.game + entry.path), entry.bytes);
  }
  return bundle;
}
