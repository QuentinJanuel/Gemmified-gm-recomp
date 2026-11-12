/**
 * The runtime's translation profile: [address, code hash, frame first needed] triples of the
 * functions sessions translated, so the next session translates them before it needs them.
 *
 * A cache, not a save: kept in this plugin's own IndexedDB, never in the game's files. The browser
 * may evict it, and a cold one only costs stalls the first time a room or effect is reached. A stale
 * entry is harmless: the runtime checks each function's code hash before using it.
 *
 * Ported from upstream's web/src/worker.mjs: a profile per game, plus one per runner module
 * (`module:<code id>:<base>`), since games built with the same runner run the same code. Before any
 * game has filled a module's, the plugin's shipped profiles/ (upstream's site profiles) stand in.
 */

import { asset } from "./asset";

type Module = { base: number; size: number; id: number };

const STORE = "profiles";

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("gm-recomp-cache", 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function get(db: IDBDatabase, key: string): Promise<Uint32Array | null> {
  return new Promise((resolve) => {
    const request = db.transaction(STORE).objectStore(STORE).get(key);
    request.onsuccess = () =>
      resolve(request.result instanceof Uint32Array ? request.result : null);
    request.onerror = () => resolve(null);
  });
}

function put(db: IDBDatabase, key: string, data: Uint32Array): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(data, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

const moduleKey = (m: Module) => `module:${m.id.toString(16)}:${m.base.toString(16)}`;

async function shipped(m: Module): Promise<Uint32Array | null> {
  try {
    const r = await fetch(asset(`profiles/module-${m.id.toString(16)}-${m.base.toString(16)}.bin`));
    if (!r.ok) return null;
    const bytes = await r.arrayBuffer();
    return bytes.byteLength % 12 === 0 ? new Uint32Array(bytes) : null;
  } catch {
    return null;
  }
}

/** `runGame`'s `profile`, `sharedProfile` and `onProfile` for the game `game`. */
export async function profileFor(game: string) {
  // No IndexedDB here (a private window may refuse it): the session runs without, only slower.
  const db = await open().catch(() => null);
  const key = `game:${game}`;
  let own = db ? await get(db, key) : null;
  const modules = new Map<string, { data: Uint32Array; seen: Set<number> }>();
  const moduleProfile = async (m: Module) => {
    const k = moduleKey(m);
    let mp = modules.get(k);
    if (!mp) {
      const data = (db && (await get(db, k))) ?? (await shipped(m)) ?? new Uint32Array(0);
      const seen = new Set<number>();
      for (let i = 0; i < data.length; i += 3) seen.add(data[i]!);
      mp = { data, seen };
      modules.set(k, mp);
    }
    return mp;
  };
  let saving = Promise.resolve();

  return {
    profile: own ?? undefined,
    /** What other games with the same modules needed, in order of need. */
    async sharedProfile(list: Module[]): Promise<Uint32Array | null> {
      const all: number[][] = [];
      for (const m of list) {
        const { data } = await moduleProfile(m);
        for (let i = 0; i < data.length; i += 3) all.push([data[i]!, data[i + 1]!, data[i + 2]!]);
      }
      all.sort((a, b) => a[2]! - b[2]!);
      return all.length ? Uint32Array.from(all.flat()) : null;
    },
    /** Functions this session needed that the profile lacked: added to the game's and its modules'. */
    onProfile(entries: Uint32Array, list: Module[]) {
      const merged = new Uint32Array((own?.length ?? 0) + entries.length);
      if (own) merged.set(own);
      merged.set(entries, own?.length ?? 0);
      own = merged;
      if (!db) return;
      saving = saving
        .then(async () => {
          await put(db, key, merged);
          for (const m of list) {
            const mp = await moduleProfile(m);
            const add: number[] = [];
            for (let i = 0; i < entries.length; i += 3) {
              const a = entries[i]!;
              if (a >= m.base && a < m.base + m.size && !mp.seen.has(a)) {
                mp.seen.add(a);
                add.push(a, entries[i + 1]!, entries[i + 2]!);
              }
            }
            if (!add.length) continue;
            const data = new Uint32Array(mp.data.length + add.length);
            data.set(mp.data);
            data.set(add, mp.data.length);
            mp.data = data;
            await put(db, moduleKey(m), data);
          }
        })
        .catch((error) =>
          console.warn(`gm-recomp: storing the translation profile failed: ${error}`),
        );
    },
  };
}
