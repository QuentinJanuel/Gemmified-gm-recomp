// The STORE: the writable, persisted upper layer, plus the codec that turns a `VPath` into a
// storage key and back.
//
// That codec is the only code anywhere that knows what a persisted key looks like. Everything else
// -- the overlay, the engine bridges, a file browser -- works on `VPath` and `GameId` and never
// sees the string, so a file name containing `:` is no parse hazard and the key format can change
// without touching them.

import type { FileStat, GameId, MountKind, VPath } from "./types";
import { MOUNTS } from "./types";
import { pathKey } from "./path";

/// The namespace every key in this codec hangs off: GEMS's store-key prefix (SPEC.md §13.4), which
/// an engine's replica mints and the host persists verbatim.
const PREFIX = "gems";
const FILE_TAG = "file";
const WHITEOUT_TAG = "gone";
// An explicitly-created directory. Needed because directories are otherwise *inferred* from the
// files inside them, which cannot represent an empty one -- so a game that calls directory_create
// and then verifies it with directory_exists would be told its own folder does not exist.
const DIR_TAG = "dir";
const GAME_TAG = "game";
// Not a `parseKey`-recognized tag (no mount/path component) -- see `metaKey` below, next to the
// GAME_TAG index entry it parallels.
const META_TAG = "meta";

/// A key/value byte store. Abstracted so the same `Store` logic runs against localStorage on the
/// main thread and against a plain Map inside an engine that runs in a Web Worker (which has no
/// localStorage at all) -- the worker's copy is seeded at load and mirrors writes back out.
export interface StoreBackend {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
  keys(): string[];
}

/// In-memory backend for the Web Worker, and for tests. `onWrite` lets the worker forward every
/// mutation to the main thread, which owns the real localStorage.
export class MemoryBackend implements StoreBackend {
  private map: Map<string, string>;
  private onWrite?: (key: string, value: string | null) => void;

  constructor(
    seed: Record<string, string> = {},
    onWrite?: (key: string, value: string | null) => void,
  ) {
    this.map = new Map(Object.entries(seed));
    this.onWrite = onWrite;
  }
  get(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  set(key: string, value: string): void {
    this.map.set(key, value);
    this.onWrite?.(key, value);
  }
  remove(key: string): void {
    this.map.delete(key);
    this.onWrite?.(key, null);
  }
  keys(): string[] {
    return Array.from(this.map.keys());
  }
  /// Applied when the main thread deletes something from the file browser, so the running game
  /// sees the deletion without a reload. Deliberately does not echo back through `onWrite`.
  drop(key: string): void {
    this.map.delete(key);
  }
}

// -- key codec ------------------------------------------------------------------------------
// `encodeURIComponent` per segment, so a file name containing `/`, `:`, or `%` survives the round
// trip intact instead of splitting into extra path segments or terminating a field early.

function encodePath(path: VPath): string {
  return path.segments.map(encodeURIComponent).join("/");
}

function decodeSegments(encoded: string): string[] {
  if (encoded === "") return [];
  return encoded.split("/").map(decodeURIComponent);
}

function fileKey(game: GameId, path: VPath): string {
  return `${PREFIX}:${FILE_TAG}:${game}:${path.mount}:${encodePath(path)}`;
}

/**
 * The key one file is persisted under, for a caller that has to *name* a path's entry.
 *
 * The one place the codec is reachable from outside, and it exists for exactly one shape of
 * problem: an engine holding a replica of this store is sent removals by key (see the wire
 * protocol's `fs-drop`), because that is what its own backend is keyed by, while a file browser
 * deleting a file has a path. Without this the host would either encode the key itself -- a second
 * copy of the layout below, drifting -- or send something that is not a key at all and silently
 * drop nothing.
 *
 * Still opaque: produced here, consumed only by a `StoreBackend`, and never parsed by a caller.
 */
export function storeKeyFor(game: GameId, path: VPath): string {
  return fileKey(game, path);
}

function whiteoutKey(game: GameId, path: VPath): string {
  return `${PREFIX}:${WHITEOUT_TAG}:${game}:${path.mount}:${encodePath(path)}`;
}

function dirKey(game: GameId, path: VPath): string {
  return `${PREFIX}:${DIR_TAG}:${game}:${path.mount}:${encodePath(path)}`;
}

function gameKey(game: GameId): string {
  return `${PREFIX}:${GAME_TAG}:${game}`;
}

function metaKey(game: GameId): string {
  return `${PREFIX}:${META_TAG}:${game}`;
}

interface ParsedKey {
  tag: string;
  game: GameId;
  path: VPath;
}

/// Inverse of `fileKey`/`whiteoutKey`. Returns null for anything that isn't ours.
function parseKey(key: string): ParsedKey | null {
  const parts = key.split(":");
  if (parts.length < 5 || parts[0] !== PREFIX) return null;
  const [, tag, game, mount] = parts;
  if (tag !== FILE_TAG && tag !== WHITEOUT_TAG && tag !== DIR_TAG) return null;
  if (!MOUNTS.includes(mount as MountKind)) return null;
  // Re-join the remainder: segments are percent-encoded, so they contain no literal `:`, but the
  // path itself may legitimately have contained one before encoding.
  const encoded = parts.slice(4).join(":");
  return { tag, game, path: { mount: mount as MountKind, segments: decodeSegments(encoded) } };
}

// -- base64 ---------------------------------------------------------------------------------
// localStorage stores strings only, so bytes go through base64 (which costs a third more space --
// see the quota note on `write`).

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 8192;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/// The writable upper layer for one game. Persisted, *except* under the `temp` mount -- see
/// `isSession`.
export class Store {
  constructor(
    private readonly game: GameId,
    private readonly backend: StoreBackend,
    /// Called right after a real (non-session) write or removal actually lands in `backend` --
    /// the signal a host throttles into cloud pushes, if it has somewhere to push to. Never
    /// fired for `temp`-mount (session-only) mutations, since those never reach `backend` at all
    /// -- see `isSession`. Optional because most callers (tests, say) have nothing to notify.
    private readonly onPersist?: () => void,
  ) {}

  /// Files, whiteouts and directory marks that live for this session only, keyed exactly like the
  /// persisted ones so every method below is one branch rather than a parallel implementation.
  private readonly session = new Map<string, Uint8Array>();
  private readonly sessionFlags = new Set<string>();

  /// Whether a path is scratch rather than data worth keeping.
  ///
  /// `temp_directory` is scratch by definition -- a real Windows install has the OS clear it
  /// between runs, which is exactly what the file browser tells the player it does. Persisting it
  /// was wrong twice over: GM8.2's model-bundle loader round-trips every texture through
  /// `temp_directory\gm82\bundle_texture.png` on its way into a background, so a game that loads
  /// 23 of them wrote 23 PNGs into a ~5MB localStorage budget it also has to fit real saves into --
  /// and whatever landed there last stayed forever, describing itself in the save panel as the
  /// player's data.
  ///
  /// Session-scoped, not discarded: within a run these are ordinary files, because a game writes
  /// one specifically to read it straight back.
  private isSession(path: VPath): boolean {
    return path.mount === "temp";
  }

  read(path: VPath): Uint8Array | null {
    if (this.isSession(path)) return this.session.get(fileKey(this.game, path)) ?? null;
    const value = this.backend.get(fileKey(this.game, path));
    if (value === null) return null;
    try {
      return base64ToBytes(value);
    } catch {
      return null;
    }
  }

  has(path: VPath): boolean {
    if (this.isSession(path)) return this.session.has(fileKey(this.game, path));
    return this.backend.get(fileKey(this.game, path)) !== null;
  }

  /// Writing a path also lifts any whiteout on it: whatever the game deleted, this is the file now.
  /** Returns whether the bytes were *persisted*. A session-mount write is always true; a persistent
   *  one is false when storage refused it, which the caller may need to know -- see
   *  `hydrateSnapshot`. Engines ignore it: the data is live either way. */
  write(path: VPath, data: Uint8Array): boolean {
    if (this.isSession(path)) {
      this.sessionFlags.delete(whiteoutKey(this.game, path));
      this.session.set(fileKey(this.game, path), data);
      return true;
    }
    this.backend.remove(whiteoutKey(this.game, path));
    try {
      this.backend.set(fileKey(this.game, path), bytesToBase64(data));
      this.onPersist?.();
      return true;
    } catch {
      // Almost always QuotaExceededError: localStorage is ~5MB per origin counted in UTF-16 code
      // units, and base64 adds a third on top, so a single `screen_save` of an 800x608 BMP blows
      // the entire budget by itself.
      //
      // A failed write must not leave the previous value sitting there pretending to be this file.
      // Reads consult the store before the bundle, so a stale entry would shadow the real uploaded
      // file on every subsequent load, permanently. Dropping the key degrades cleanly: the data
      // stays live in this session's memory, and after a reload the game reads what the upload
      // actually contains.
      this.backend.remove(fileKey(this.game, path));
      console.warn(
        `vfs: could not persist ${pathKey(path)} (${data.length} bytes) -- it will not survive a reload`,
      );
      return false;
    }
  }

  /// Records that a path is deleted. Takes `alsoInBundle` because a whiteout is only meaningful
  /// over a bundle file -- for a store-only file, removing the entry is the whole job, and leaving
  /// a tombstone behind would just be litter the file browser has to filter out.
  remove(path: VPath, alsoInBundle: boolean): void {
    if (this.isSession(path)) {
      this.session.delete(fileKey(this.game, path));
      // A whiteout over a *temp* bundle file has to be session-scoped too: extension payloads are
      // unpacked into temp and re-created identically on every launch, so a persisted tombstone
      // would suppress one for good after a single `file_delete`.
      if (alsoInBundle) this.sessionFlags.add(whiteoutKey(this.game, path));
      return;
    }
    this.backend.remove(fileKey(this.game, path));
    if (alsoInBundle) this.backend.set(whiteoutKey(this.game, path), "1");
    this.onPersist?.();
  }

  isWhitedOut(path: VPath): boolean {
    if (this.isSession(path)) return this.sessionFlags.has(whiteoutKey(this.game, path));
    return this.backend.get(whiteoutKey(this.game, path)) !== null;
  }

  /// Records a directory that exists even while empty (GML's `directory_create`).
  markDirectory(path: VPath): void {
    if (path.segments.length === 0) return; // a mount root always exists
    if (this.isSession(path)) {
      this.sessionFlags.add(dirKey(this.game, path));
      return;
    }
    this.backend.set(dirKey(this.game, path), "1");
  }

  unmarkDirectory(path: VPath): void {
    if (this.isSession(path)) {
      this.sessionFlags.delete(dirKey(this.game, path));
      return;
    }
    this.backend.remove(dirKey(this.game, path));
  }

  isMarkedDirectory(path: VPath): boolean {
    if (this.isSession(path)) return this.sessionFlags.has(dirKey(this.game, path));
    return this.backend.get(dirKey(this.game, path)) !== null;
  }

  /// Every persisted tombstone: the bundle files this game has deleted.
  ///
  /// Persisted only, deliberately. A session whiteout lives under the `temp` mount, which is
  /// scratch by definition (see `isSession`) -- carrying one into a snapshot would tell the other
  /// replica to delete an extension payload that gets re-created on its next launch anyway.
  listWhiteouts(): VPath[] {
    const out: VPath[] = [];
    for (const key of this.backend.keys()) {
      const parsed = parseKey(key);
      if (parsed && parsed.tag === WHITEOUT_TAG && parsed.game === this.game) out.push(parsed.path);
    }
    return out;
  }

  /// Every explicitly-created directory, so listings can show an empty one.
  markedDirectories(): VPath[] {
    const out: VPath[] = [];
    for (const key of [...this.backend.keys(), ...this.sessionFlags]) {
      const parsed = parseKey(key);
      if (parsed && parsed.tag === DIR_TAG && parsed.game === this.game) out.push(parsed.path);
    }
    return out;
  }

  /// Every file in this layer, persisted or session. Drives the file browser and the engines'
  /// initial seeding -- both of which want what the game can actually see right now, which includes
  /// scratch files it has written this run.
  list(): FileStat[] {
    const out: FileStat[] = [];
    for (const key of this.backend.keys()) {
      const parsed = parseKey(key);
      if (!parsed || parsed.tag !== FILE_TAG || parsed.game !== this.game) continue;
      const value = this.backend.get(key) ?? "";
      // Report the decoded byte length, not the base64 string length.
      out.push({ path: parsed.path, size: Math.floor((value.length * 3) / 4), layer: "store" });
    }
    for (const [key, data] of this.session) {
      const parsed = parseKey(key);
      if (parsed && parsed.tag === FILE_TAG && parsed.game === this.game) {
        out.push({ path: parsed.path, size: data.length, layer: "store" });
      }
    }
    return out;
  }

  clear(): void {
    for (const key of this.backend.keys()) {
      const parsed = parseKey(key);
      if (parsed && parsed.game === this.game) this.backend.remove(key);
    }
    this.backend.remove(gameKey(this.game));
    this.backend.remove(metaKey(this.game));
    this.session.clear();
    this.sessionFlags.clear();
  }
}

export function storeForGame(game: GameId, backend: StoreBackend, onPersist?: () => void): Store {
  return new Store(game, backend, onPersist);
}

/// This game's raw persisted entries, for seeding a `MemoryBackend` in a Web Worker.
///
/// Raw rather than decoded: a worker has no localStorage, so the main thread hands it a
/// snapshot of exactly the key/value pairs it would otherwise have read, and the worker's own
/// `Store` interprets them with the same codec. Scoped to one game so a worker never holds another
/// game's data.
export function seedForGame(backend: StoreBackend, game: GameId): Record<string, string> {
  const seed: Record<string, string> = {};
  for (const key of backend.keys()) {
    const parsed = parseKey(key);
    if (!parsed || parsed.game !== game) continue;
    const value = backend.get(key);
    if (value !== null) seed[key] = value;
  }
  return seed;
}
