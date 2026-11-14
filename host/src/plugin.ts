/**
 * gm-recomp as a GEMS plugin: the module a host loads by URL.
 *
 * The engine runs in a worker (worker.ts) behind the shim; this is the host-realm half, which says
 * which worker to start and answers the host's questions about the game.
 */

import { API_VERSION } from "../gems";
import type { PluginManifest } from "../gems/engine/manifest";
import type {
  Acceptance,
  EnginePlugin,
  EngineSession,
  FileIndex,
  HostServices,
} from "../gems/engine";
import { createWorkerSession } from "../gems/worker-session";
import { findEntry } from "./entry";

/** The runtime's mix rate (crates/runtime/src/hle/audio.rs `RATE`); the ring holds a second of it. */
const RATE = 48_000;

/**
 * The runtime mixes finished stereo PCM, so its sound is not the shim's graph commands: the worker
 * writes it into a ring that upstream's ring-player worklet (web/src/audio-worklet.js) plays here.
 */
async function create(host: HostServices): Promise<EngineSession> {
  const worker = new Worker(new URL("worker.js", import.meta.url), { type: "module" });
  const ring = new SharedArrayBuffer(8 + RATE * 8);
  // Not a GEMS envelope, so the shim ignores it; posted before `init`, so it arrives first.
  worker.postMessage({ audioRing: ring });

  const context = new AudioContext({ sampleRate: RATE, latencyHint: 0.005 });
  const gestures = new AbortController();
  const release = () => {
    gestures.abort();
    void context.close().catch(() => {});
  };
  let session: EngineSession;
  try {
    await context.audioWorklet.addModule(new URL("audio-worklet.js", import.meta.url));
    const latency = Math.max(0.015, context.baseLatency + 0.01);
    new AudioWorkletNode(context, "ring-player", {
      outputChannelCount: [2],
      processorOptions: { sab: ring, frames: RATE, latency },
    }).connect(context.destination);
    session = await createWorkerSession(host, worker, "gm-recomp");
  } catch (error) {
    release();
    worker.terminate();
    throw error;
  }
  // Browsers start audio only from a gesture.
  const unlock = () => void context.resume().catch(() => {});
  document.addEventListener("pointerdown", unlock, { signal: gestures.signal });
  document.addEventListener("keydown", unlock, { signal: gestures.signal });
  unlock();

  const dispose = session.dispose.bind(session);
  session.dispose = () => {
    dispose();
    release();
  };
  return session;
}

const plugin: EnginePlugin = {
  id: "gm-recomp",
  apiVersion: API_VERSION,
  // The guest runs on its own virtual clock: each step is one presented frame (SPEC §8.1).
  capabilities: { settings: [], clock: "engine" },

  /** By extension only: the runner is an ordinary .exe until it is parsed. */
  async accepts(files: FileIndex): Promise<Acceptance | null> {
    const entry = findEntry(files);
    return entry ? { confidence: "probable", entry: entry.path } : null;
  },

  create,
};

export default plugin;

/** This engine's manifest, as host/build.ts writes it, from the same constants as the plugin. */
export function manifest(version: string): PluginManifest {
  return {
    id: plugin.id,
    version,
    apiVersion: plugin.apiVersion,
    entry: "host.js",
    name: "gm-recomp",
    // The real GameMaker runner, recompiled: GM8.x and Studio 1.4 (YYC included), not GMS2.
    formats: ["gm8", "gms1"],
    description:
      "Runs GameMaker 8 and GameMaker Studio 1.4 games in the browser by recompiling the original GameMaker runner from x86 to WebAssembly.",
    author: "Dapper Mink",
    updates: "https://gemmified-gm-recomp.dappermink.me/latest.json",
    credits: [
      {
        name: "gm-recomp",
        license: "MIT",
        url: "https://github.com/QuentinJanuel/Gemmified-gm-recomp",
        copyright: "Copyright (c) 2026 KurathSec",
        upstream: "https://github.com/KurathSec/gm-recomp",
      },
      {
        name: "Wine (redistributable DLLs)",
        license: "LGPL-2.1-or-later",
        url: "https://gitlab.winehq.org/wine/wine",
        copyright: "Copyright (C) The Wine project",
        note: "The source archive of the version shipped is published beside each gm-recomp build.",
      },
    ],
    capabilities: plugin.capabilities,
  };
}
