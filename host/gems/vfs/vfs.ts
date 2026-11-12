// The overlay: one filesystem view over the bundle (read-only, lower) and the store (persisted,
// upper).
//
// The whole model is three rules:
//
//   read    store, unless whited out, then bundle
//   write   always the store
//   delete  drop from the store; if the bundle still has it, leave a whiteout
//
// Everything else in this file is those rules plus directory synthesis. The layers do not know
// about each other, and no caller needs to know which one answered.

import type { DirEntry, FileStat, GameId, VPath } from "./types";
import { Bundle } from "./bundle";
import { Store, type StoreBackend, storeForGame } from "./store";
import { baseName, isDirectChild, isInside, pathKey, wildcardMatcher } from "./path";

export class Vfs {
  readonly bundle: Bundle;
  readonly store: Store;

  constructor(
    readonly game: GameId,
    backend: StoreBackend,
    bundle: Bundle = new Bundle(),
    /// Forwarded straight to the Store -- see its own doc comment. Optional because most Vfs
    /// construction (tests, say) has nothing to notify.
    onPersist?: () => void,
  ) {
    this.bundle = bundle;
    this.store = storeForGame(game, backend, onPersist);
  }

  read(path: VPath): Uint8Array | null {
    const stored = this.store.read(path);
    if (stored !== null) return stored;
    if (this.store.isWhitedOut(path)) return null;
    return this.bundle.read(path);
  }

  exists(path: VPath): boolean {
    if (this.store.has(path)) return true;
    if (this.store.isWhitedOut(path)) return false;
    return this.bundle.has(path);
  }

  write(path: VPath, data: Uint8Array): void {
    this.store.write(path, data);
  }

  /// Returns whether anything was actually there to delete, which is what GML's `file_delete`
  /// reports.
  remove(path: VPath): boolean {
    const existed = this.exists(path);
    this.store.remove(path, this.bundle.has(path));
    return existed;
  }

  /// Every file visible at this moment, both layers merged, whiteouts applied. The store shadows
  /// the bundle at the same path -- same precedence as `read`, so the listing can never disagree
  /// with what a read would actually return.
  listAll(): FileStat[] {
    const merged = new Map<string, FileStat>();
    for (const stat of this.bundle.list()) {
      if (!this.store.isWhitedOut(stat.path)) merged.set(pathKey(stat.path), stat);
    }
    for (const stat of this.store.list()) {
      merged.set(pathKey(stat.path), stat);
    }
    return Array.from(merged.values());
  }

  /// Whether `dir` exists: it was explicitly created, or some file lives under it.
  ///
  /// Both layers store files by full path, with no directory entries, so a directory is normally
  /// *inferred* from its contents -- which covers the near-universal GML idiom of guarding an asset
  /// folder before enumerating it. Inference alone cannot represent an empty directory though, so
  /// `createDir` records one explicitly and that is checked first. A mount root always exists; a
  /// game asking about its own folder should never be told it is missing.
  dirExists(dir: VPath): boolean {
    if (dir.segments.length === 0) return true;
    if (this.store.isMarkedDirectory(dir)) return true;
    return this.listAll().some((stat) => isInside(dir, stat.path));
  }

  /// GML's `directory_create`. Records the directory explicitly, so it exists even while empty --
  /// inference alone cannot represent that, and a game which verifies its own `directory_create`
  /// with `directory_exists` would otherwise be told its folder was never made.
  createDir(dir: VPath): void {
    this.store.markDirectory(dir);
  }

  /// GML's `directory_destroy`/`directory_delete`. Drops the explicit marker; files inside are left
  /// alone, matching the real call's refusal to remove a non-empty directory.
  removeDir(dir: VPath): void {
    this.store.unmarkDirectory(dir);
  }

  /// One directory's immediate contents: the files directly in it, plus a synthetic entry for each
  /// subdirectory that has anything in it. `pattern` filters file names only (subdirectories are
  /// always listed), matching `file_find_first`'s wildcard behaviour.
  listDir(dir: VPath, pattern = "*"): DirEntry[] {
    const matches = wildcardMatcher(pattern);
    const files: DirEntry[] = [];
    const dirs = new Map<string, string>();

    for (const stat of this.listAll()) {
      if (!isInside(dir, stat.path)) continue;
      if (isDirectChild(dir, stat.path)) {
        const name = baseName(stat.path);
        if (matches(name)) files.push({ type: "file", name, size: stat.size, layer: stat.layer });
      } else {
        // Deeper than a direct child, so the segment right after `dir` names a subdirectory.
        const name = stat.path.segments[dir.segments.length];
        const key = name.toLowerCase();
        if (!dirs.has(key)) dirs.set(key, name);
      }
    }

    // Explicitly-created directories that are still empty have no files to be inferred from, so
    // fold them in here or `directory_create` followed by a listing would show nothing.
    for (const marked of this.store.markedDirectories()) {
      if (!isDirectChild(dir, marked)) continue;
      const name = baseName(marked);
      const key = name.toLowerCase();
      if (!dirs.has(key)) dirs.set(key, name);
    }

    const dirEntries: DirEntry[] = Array.from(dirs.values(), (name) => ({ type: "dir", name }));
    const byName = (a: DirEntry, b: DirEntry) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    // Directories first, then files -- and each sorted, so a given upload always enumerates in the
    // same order. Real `FindFirstFile` order is filesystem-dependent, so there is no "correct"
    // order to reproduce, only a stable one worth guaranteeing.
    return [...dirEntries.sort(byName), ...files.sort(byName)];
  }

  /// `file_find_first`'s flat form: the names in one directory matching a wildcard.
  ///
  /// `includeDirs` is GM's `fa_directory` attribute, and it is not a nicety. A game that keeps its
  /// assets in per-category folders has to discover those folders first, and the way to do that in
  /// GML is `file_find_first(dir + "*", fa_directory)` — GM8.2's own sound loader opens exactly
  /// that way. Answering with files only made a `data/sounds/` holding nothing but subdirectories
  /// look empty, so no sound in the game was ever registered and every later `sound_play` reported
  /// a sound that does not exist.
  findFiles(dir: VPath, pattern: string, includeDirs = false): string[] {
    return this.listDir(dir, pattern)
      .filter((entry) => entry.type === "file" || includeDirs)
      .map((entry) => entry.name);
  }
}
