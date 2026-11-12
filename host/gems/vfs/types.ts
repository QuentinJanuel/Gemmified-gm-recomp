// The shared filesystem model engines run on. Deliberately data-only: no localStorage, no engine
// glue, no DOM.
//
// TERMINOLOGY. This is a
// union/overlay filesystem, and it borrows that model's established vocabulary rather than
// inventing any:
//
//   bundle    the LOWER layer: read-only files that came with the game -- a folder upload's loose
//             assets (BGM/, data/sounds/, ...) and engine-provided payloads (GM8.2 extension files
//             unpacked into temp). Never written, never persisted; re-created identically on every
//             load from the upload itself.
//   store     the UPPER layer: everything the game has written -- save files, config, scratch.
//             Persisted per game, and the only layer that survives a reload -- except under the
//             `temp` mount, which is scratch by definition and stays in session memory (see
//             `Store.isSession`).
//   whiteout  a tombstone in the store marking a bundle path as deleted. Needed because the bundle
//             lives in memory for the whole session and genuinely cannot be erased: without one, a
//             game that deletes a save shipped next to its .exe would see it reappear on the very
//             next `file_exists`.
//
// A read checks store, then whiteouts, then bundle. A write always lands in the store.

/// Which root a path hangs off. A sum type rather than a bare path prefix so every consumer has to
/// handle each case explicitly, and so the persisted key format stays a *derived* detail rather
/// than something logic reads back.
///
/// These are the only roots that exist. Everything a game can reach resolves into exactly one:
///
///   game     the game's own folder -- what GML calls `working_directory`/`program_directory`.
///            Where a folder upload's files land, and where most games put their saves.
///   appdata  the per-user application-data folder. GameMaker Studio games save here by default
///            (`game_save_id`, `%LOCALAPPDATA%\<game name>\`), and so do GM8.1 games built with
///            local settings, whose working directory the runner redirects to the same place.
///   temp     `temp_directory`. Scratch space, plus where extension packages unpack their payload
///            files (GM8.2 ships sprites/shaders/DLLs this way).
export type MountKind = "game" | "appdata" | "temp";

export const MOUNTS: readonly MountKind[] = ["game", "appdata", "temp"] as const;

/// Human-readable mount labels, for the file browser.
export const MOUNT_LABELS: Record<MountKind, string> = {
  game: "Game folder",
  appdata: "Application data",
  temp: "Temporary files",
};

/// What each mount corresponds to on a real Windows install. Shown under the label in the file
/// browser: "Game folder" and "Application data" mean nothing on their own to someone looking for
/// where their save went, and the two are easy to confuse -- GameMaker Studio games save to
/// application data by default while GM8 games save next to the .exe, so the same game on two
/// engines puts its files in visibly different places for reasons the player cannot infer.
export const MOUNT_DESCRIPTIONS: Record<MountKind, string> = {
  game: "Next to the game's executable — working_directory",
  appdata: "Per-user app data (%LOCALAPPDATA%) — where GameMaker Studio games save by default",
  temp: "Scratch space — temp_directory, cleared by the real system between runs",
};

/// A resolved path: a mount plus its segments, already split, cleaned of `.`/`..`, and free of any
/// separator ambiguity.
///
/// Structured rather than a string on purpose: re-deriving meaning from Windows-ish path strings at
/// each call site is how a backslashed path collapses to nothing useful on a unix-semantics wasm
/// target, or how `Save\game1` and `Backup\game1` end up the same file. Neither is expressible here.
///
/// `segments` preserves the case it was created with (games display file names, and concatenate
/// them into further paths); comparison is case-insensitive, matching the Windows filesystems these
/// games were written against. Use `pathKey` for identity, never `===` on segments.
export interface VPath {
  readonly mount: MountKind;
  readonly segments: readonly string[];
}

/// Which layer a file was found in. Surfaced to the UI so a player can tell "this came with the
/// game" apart from "this is my save data" -- only the latter is theirs to delete.
export type Layer = "bundle" | "store";

/// One entry in a directory listing. A sum type so a caller cannot forget that directories exist
/// and treat everything as a file -- otherwise `directory_exists` could never be true.
export type DirEntry =
  | { readonly type: "file"; readonly name: string; readonly size: number; readonly layer: Layer }
  | { readonly type: "dir"; readonly name: string };

/// A stored file as the UI and the persistence layer see it.
export interface FileStat {
  readonly path: VPath;
  readonly size: number;
  readonly layer: Layer;
}

/// Identifies a game across sessions: an id the host chooses, never derived from the game's bytes.
export type GameId = string;
