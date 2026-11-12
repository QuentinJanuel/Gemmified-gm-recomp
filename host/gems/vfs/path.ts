// Turning the path strings GML hands us into structured `VPath`s, and back.
//
// The single most important idea here: each mount has a REAL, non-empty root string, and the
// engines report those as `working_directory` / `program_directory` / `temp_directory` /
// `game_save_id`. An empty root would make the near-universal GML idiom
//
//     ini_open(working_directory + "\Save\save1")
//
// arrive at the filesystem as `"\Save\save1"` -- a rooted, backslashed path with nothing before the
// separator, which every layer would have to guess the meaning of. With named roots the same idiom
// arrives as `"/game/Save/save1"`, which parses unambiguously.

import type { VPath } from "./types";
import { MOUNTS } from "./types";

/// The root string for each mount, as the engines report it to the game. Trailing slash included:
/// GML code concatenates directly (`working_directory + "\Save\x"`), and while `parsePath` copes
/// with a doubled separator anyway, games also *display* these and build them into `file_find_first`
/// patterns, so the conventional trailing separator is what they expect to see.
export const MOUNT_ROOTS = {
  game: "/game/",
  appdata: "/appdata/",
  temp: "/temp/",
} as const;

/// Windows path fragments that identify the application-data folder, for games that hardcode a real
/// absolute path instead of going through `game_save_id`. Rare but not hypothetical, and cheap to
/// honour: matching here puts the file in the same place the same game's `game_save_id`-relative
/// writes go, instead of stranding it in a bogus `game`-mount subfolder named after a drive letter.
const APPDATA_MARKERS = ["appdata/local/", "appdata/roaming/", "application data/"];

/// Splits on both separators and drops the segments that carry no meaning. `..` pops, and a `..`
/// that would climb above a mount root is dropped -- nothing above a root is reachable, so there is
/// no correct target to resolve it to.
function cleanSegments(raw: string): string[] {
  const out: string[] = [];
  for (const segment of raw.split(/[\\/]+/)) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      out.pop();
      continue;
    }
    out.push(segment);
  }
  return out;
}

/// Parses a GML-supplied path string into a `VPath`.
///
/// Resolution order, first match wins:
///   1. an explicit mount root (`/game/...`, `/appdata/...`, `/temp/...`)
///   2. a Windows absolute path containing an AppData marker
///   3. anything else -- relative to the game folder, which is what a bare `"save1"` means and
///      what GM8 games assume when they pass a name with no directory at all.
export function parsePath(raw: string): VPath {
  const unified = raw.replace(/\\/g, "/");
  const lower = unified.toLowerCase();

  for (const mount of MOUNTS) {
    const root = MOUNT_ROOTS[mount];
    // Match the root with or without its trailing slash, so both `working_directory + "\x"` and a
    // bare `working_directory` (a game asking "does my own folder exist") resolve.
    const bare = root.slice(0, -1);
    if (lower.startsWith(root) || lower === bare) {
      return { mount, segments: cleanSegments(unified.slice(bare.length)) };
    }
  }

  for (const marker of APPDATA_MARKERS) {
    const at = lower.indexOf(marker);
    if (at !== -1) {
      return { mount: "appdata", segments: cleanSegments(unified.slice(at + marker.length)) };
    }
  }

  // A drive-letter path that isn't AppData has no meaningful home here; treating it as
  // game-relative (dropping the drive) at least keeps it inside the game's own sandbox rather than
  // inventing a mount for it.
  const withoutDrive = /^[a-z]:/i.test(unified) ? unified.slice(2) : unified;
  return { mount: "game", segments: cleanSegments(withoutDrive) };
}

/// The string form the engines hand back to GML. Round-trips through `parsePath`.
export function formatPath(path: VPath): string {
  return MOUNT_ROOTS[path.mount] + path.segments.join("/");
}

/// Case-insensitive identity, for use as a Map key. GM8 and GMS games were written against
/// case-insensitive Windows filesystems and freely mix casing between the script that writes a file
/// and the one that reads it, so `Save/Game1` and `save/game1` must be the same entry.
///
/// Never compare `VPath`s any other way -- structural equality on `segments` would make those two
/// distinct and silently split a game's saves in half.
export function pathKey(path: VPath): string {
  return `${path.mount}:${path.segments.join("/").toLowerCase()}`;
}

/// The directory containing `path`. A mount root's parent is itself -- there is nothing above it.
export function parentOf(path: VPath): VPath {
  return { mount: path.mount, segments: path.segments.slice(0, -1) };
}

/// The final segment, i.e. the file name. Empty at a mount root.
export function baseName(path: VPath): string {
  return path.segments[path.segments.length - 1] ?? "";
}

export function joinPath(path: VPath, ...segments: string[]): VPath {
  return { mount: path.mount, segments: [...path.segments, ...segments.flatMap(cleanSegments)] };
}

/// Whether `dir` is a prefix of `path` -- i.e. `path` sits somewhere inside `dir`.
export function isInside(dir: VPath, path: VPath): boolean {
  if (dir.mount !== path.mount || path.segments.length <= dir.segments.length) return false;
  return dir.segments.every((seg, i) => seg.toLowerCase() === path.segments[i].toLowerCase());
}

/// Whether `path` is a direct child of `dir` (not nested deeper). What a directory listing shows.
export function isDirectChild(dir: VPath, path: VPath): boolean {
  return isInside(dir, path) && path.segments.length === dir.segments.length + 1;
}

/// Compiles a `file_find_first` wildcard (`*.ogg`, `save?.dat`, `*`) into a matcher.
///
/// Hand-rolled rather than pulled from a glob library: the GM surface is only `*` and `?`, the
/// input is a single path segment with no `/` to reason about, and everything else in a real glob
/// implementation (character classes, `**`, brace expansion) would be extra behaviour these games
/// never ask for and could only surprise us with.
export function wildcardMatcher(pattern: string): (name: string) => boolean {
  const source = pattern
    .split("")
    .map((ch) => {
      if (ch === "*") return "[^/]*";
      if (ch === "?") return "[^/]";
      return ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    })
    .join("");
  const re = new RegExp(`^${source}$`, "i");
  return (name) => re.test(name);
}
