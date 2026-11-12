import type { FileIndex, IndexedFile } from "../gems/engine";

/** The executable to run: the shallowest .exe, so a game's bundled tools in subfolders lose. */
export function findEntry(files: FileIndex): IndexedFile | null {
  let best: IndexedFile | null = null;
  for (const file of files.files) {
    if (!/\.exe$/i.test(file.path)) continue;
    if (!best || depth(file.path) < depth(best.path)) best = file;
  }
  return best;
}

const depth = (path: string) => path.split("/").length;
