/**
 * Where the guest's files are as GEMS paths (SPEC §13.5), and back.
 *
 * The runtime's guest paths are relative to the executable's directory (`C:\game`), `\`-separated;
 * other drives' paths start with the drive letter (`C\Users\…`).
 */

import { parsePath, pathKey, type VPath } from "../gems/vfs";

const PROFILE = "C\\Users\\player\\AppData\\";
const TEMP = `${PROFILE}Local\\Temp\\`;
// SPEC §13.5, first match wins: temp, then appdata (Local and Roaming are one namespace).
const MARKERS = [
  ["temp", ["appdata\\local\\temp\\", "local settings\\temp\\"]],
  [
    "appdata",
    [
      "appdata\\local\\",
      "appdata\\roaming\\",
      "local settings\\application data\\",
      "application data\\",
    ],
  ],
] as const;

const split = (path: string) => path.split("\\").filter(Boolean);

/** A guest path as a GEMS path (SPEC §13.5's Windows mapping). */
export function toVPath(path: string): VPath {
  const lower = `${path.toLowerCase()}\\`;
  for (const [mount, markers] of MARKERS) {
    for (const marker of markers) {
      const at = lower.indexOf(marker);
      if (at !== -1) return { mount, segments: split(path.slice(at + marker.length)) };
    }
  }
  const segments = split(path);
  // Another drive's path is in `game` with the drive dropped; `C:\game` is the game's own root.
  // shortcut: a relative folder named by one letter reads as a drive (the runtime's paths do not
  // tell them apart), fix in the runtime if a game has one.
  if (segments.length > 1 && /^[a-z]$/i.test(segments[0]!)) {
    const drive = segments.shift()!;
    if (drive.toLowerCase() === "c" && segments[0]?.toLowerCase() === "game") segments.shift();
  }
  return { mount: "game", segments };
}

/**
 * Where the guest finds a GEMS path. Each mount folds several places into one, so the file goes to
 * every place the game could read it back from: Local and Roaming, and for `game` the drive's root
 * too (a rooted `\save` or `C:\x\save` lands in `game` with the drive dropped).
 */
export function fromVPath(path: VPath): string[] {
  const rest = path.segments.join("\\");
  if (path.mount === "temp") return [TEMP + rest];
  if (path.mount === "appdata") return [`${PROFILE}Local\\${rest}`, `${PROFILE}Roaming\\${rest}`];
  return [rest, `C\\${rest}`];
}

/** Where the mapping before SPEC §13.5 put a key's file: read-only, for keys stored back then. */
function legacyFromVPath(dir: string, path: VPath): string | null {
  if (path.mount === "appdata") return PROFILE + path.segments.join("\\");
  const prefix = dir.split("/").filter(Boolean);
  if (!prefix.every((s, i) => s.toLowerCase() === path.segments[i]?.toLowerCase())) return null;
  return path.segments.slice(prefix.length).join("\\");
}

/** A path the host names: a mount root string, or a Windows path as the game reported it. */
export const hostPath = (path: string): VPath =>
  /^\/(game|appdata|temp)(\/|$)/i.test(path)
    ? parsePath(path)
    : toVPath(path.replaceAll("/", "\\").replace(/^([a-z]):/i, "$1"));

/** What the store says about a path. */
export interface StoreView {
  has(path: VPath): boolean;
  isWhitedOut(path: VPath): boolean;
}

/**
 * The files the runtime starts with, as [path, bytes, mtime]: the game's own (guest paths, relative
 * to the executable's directory, whited-out ones left out), then the saves the host kept. A key
 * stored before SPEC §13.5 is placed only where no key of the current mapping is (it is never
 * moved), then the current keys on top.
 */
export function guestFiles(
  dir: string,
  bundle: { path: string; bytes: Uint8Array }[],
  saved: { path: VPath; bytes: Uint8Array }[],
  store: StoreView,
): [string, Uint8Array, number][] {
  const placed = new Map<string, [string, Uint8Array, number]>();
  const place = (guest: string, bytes: Uint8Array) =>
    placed.set(guest.toLowerCase(), [guest, bytes, 0]);
  for (const { path, bytes } of bundle) {
    if (!store.isWhitedOut(toVPath(path))) place(path, bytes);
  }
  for (const { path, bytes } of saved) {
    const old = legacyFromVPath(dir, path);
    if (old === null) continue;
    const now = toVPath(old);
    // (a current key's old reading leaves its mount: that is no old key, only a misreading)
    if (now.mount !== path.mount || pathKey(now) === pathKey(path)) continue;
    if (store.has(now) || store.isWhitedOut(now)) continue;
    for (const guest of fromVPath(now)) place(guest, bytes);
  }
  for (const { path, bytes } of saved) {
    for (const guest of fromVPath(path)) place(guest, bytes);
  }
  return [...placed.values()];
}
