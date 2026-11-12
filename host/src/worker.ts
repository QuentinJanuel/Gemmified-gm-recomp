/**
 * gm-recomp's worker: upstream's runtime (`runGame`, web/src/host.mjs), served on the GEMS shim.
 *
 * `runGame` owns its loop: the guest runs on its virtual clock and suspends (JSPI) at every Present.
 * Each GEMS `step` lets it run on to its next Present: `onFrame` returns a promise that the next
 * `step` resolves. Nothing in the engine changes for this.
 */

import { createEngineHost, EngineError } from "../gems/shim";
import type { GameInfo, GameInput } from "../gems/engine";
import type { DialogRequest } from "../gems/dialog";
import { pathKey } from "../gems/vfs";
import type { WirePort } from "../gems/wire";
// Upstream's host imports and its KeyboardEvent.code -> [virtual key, scan code] table.
import { runGame } from "../../web/src/host.mjs";
import { KEYS } from "../../web/src/keys.mjs";
import { findEntry } from "./entry";
import { fromVPath, guestFiles, hostPath, toVPath } from "./paths";
import { profileFor } from "./profile";

/** OR'd into the scan code: NumLock is on (GEMS sends no lock state; the keypad sends digits). */
const NUMLOCK = 0x200;
const BUTTONS = { left: 1, right: 2, middle: 4 } as const;
const LOOPBACK = ["127.0.0.1", "localhost", "::1"];
/** What `runGame` hands `onReady`: input entry points, called while the guest is suspended. */
interface Input {
  key(vk: number, scan: number, down: boolean): void;
  mouse(x: number, y: number, buttons: number): void;
  /** Files written into the guest's filesystem at its next input poll. */
  files(changes: { path: string; data: Uint8Array }[]): void;
}

// The sound ring the plugin's host-realm half plays (plugin.ts), posted before `init`.
let audioRing: { sab: SharedArrayBuffer; frames: number } | undefined;
self.addEventListener("message", ({ data }: MessageEvent) => {
  if (data?.audioRing instanceof SharedArrayBuffer) {
    audioRing = { sab: data.audioRing, frames: (data.audioRing.byteLength - 8) / 8 };
  }
});

createEngineHost({
  port: self as unknown as WirePort,
  id: "gm-recomp",
  create: async (host, shim) => {
    // A dialog blocks this thread until the host answers it; on the host's own thread that is a
    // deadlock. `blockingDialogs` is null unless this thread may block and the host is elsewhere.
    const dialogs = shim.blockingDialogs;
    if (dialogs === null) {
      throw new EngineError(
        "unsupported-environment",
        "blocking dialogs need a worker and a dialog buffer",
      );
    }
    if (!("Suspending" in WebAssembly)) {
      throw new EngineError("unsupported-environment", "no JSPI (WebAssembly.Suspending)");
    }
    let runtime: WebAssembly.Module;
    try {
      runtime = await WebAssembly.compileStreaming(fetch(`${host.assets.base}/web.wasm`));
    } catch (error) {
      throw new EngineError("asset-unavailable", String(error));
    }

    let input: Input | null = null;
    const held = new Map<string, readonly number[]>();
    let pointer = { x: 0, y: 0, buttons: 0 };
    const queued: GameInput[] = [];

    // The guest waits in `onFrame` until the next step lets it go on.
    let resume: (() => void) | null = null;
    let presented: (() => void) | null = null;
    let ended = false;
    let failure: unknown = null;
    const nextFrame = () =>
      new Promise<void>((resolve) => {
        presented = resolve;
      });
    let frame = nextFrame();

    const apply = (event: GameInput) => {
      if (!input) return;
      switch (event.kind) {
        case "key-down":
        case "key-up": {
          const key = KEYS[event.code as keyof typeof KEYS];
          if (!key) return;
          const down = event.kind === "key-down";
          if (down) held.set(event.code, key);
          else held.delete(event.code);
          input.key(key[0], key[1] | NUMLOCK, down);
          return;
        }
        case "pointer-move":
          pointer = { ...pointer, x: event.x, y: event.y };
          break;
        case "pointer-down":
          pointer = { x: event.x, y: event.y, buttons: pointer.buttons | BUTTONS[event.button] };
          break;
        case "pointer-up":
          pointer = { ...pointer, buttons: pointer.buttons & ~BUTTONS[event.button] };
          break;
        case "focus-lost":
          for (const [vk, scan] of held.values()) input.key(vk, scan | NUMLOCK, false);
          held.clear();
          pointer = { ...pointer, buttons: 0 };
          break;
        // shortcut: the runtime takes no mouse wheel; add one if a game needs it.
        case "wheel":
          return;
      }
      input.mouse(pointer.x, pointer.y, pointer.buttons);
    };

    // Upstream's prompt kinds: 0 a message, 1 a string, 2 yes/no, 3 a game error (Ignore/Abort).
    // An answer is a string ('' for OK, Yes, Ignore), or null for Cancel, No, Abort.
    const prompt = (
      title: string,
      text: string,
      initial: string | null,
      kind: number,
    ): string | null => {
      const labels = [["OK"], ["OK", "Cancel"], ["Yes", "No"], ["Ignore", "Abort"]][kind] ?? ["OK"];
      const request: DialogRequest = {
        text: title ? `${title}\n\n${text}` : text,
        buttons: labels.map((label, value) => ({
          label,
          value,
          kind: value === 0 ? "primary" : undefined,
        })),
        input: kind === 1 ? { kind: "string", initial: initial ?? "" } : undefined,
        dismissible: kind === 1,
      };
      const answer = dialogs.show(request);
      // (DIALOG_DISMISSED is not 0 either)
      if (answer.button !== 0) return null;
      return kind === 1 ? answer.value : "";
    };

    return {
      async start(files): Promise<GameInfo> {
        const entry = findEntry(files);
        if (!entry) throw new EngineError("unsupported-game", "no .exe");
        const dir = entry.path.slice(0, entry.path.lastIndexOf("/") + 1);

        // A file the host puts while the game runs (a mod's sprite) is copied in; until onReady,
        // queued. (One that also lands in the files below is written twice, harmlessly.)
        const late: { path: string; data: Uint8Array }[] = [];
        host.replica.watch({
          put: (path, data) => {
            const changes = fromVPath(hostPath(path)).map((guest) => ({ path: guest, data }));
            if (input) input.files(changes);
            else late.push(...changes);
          },
          // shortcut: a host-side delete is not forwarded; no mod deletes a file a running game reads.
          drop: () => {},
        });

        // The game's files and the saves the host kept, as the runtime takes them (paths.ts).
        const store = shim.files.store;
        // (a deleted file the game came with stays deleted: a whiteout over it)
        const bundled = new Set<string>();
        const bundle = await Promise.all(
          files.files
            .filter((file) => file.path.startsWith(dir))
            .map(async (file) => {
              const path = file.path.slice(dir.length).replaceAll("/", "\\");
              bundled.add(pathKey(toVPath(path)));
              return { path, bytes: await file.read() };
            }),
        );
        const saved = store.list().flatMap(({ path }) => {
          const bytes = store.read(path);
          return bytes === null ? [] : [{ path, bytes }];
        });
        const triples = guestFiles(dir, bundle, saved, store);

        const onSave = (changes: { path: string; data: Uint8Array | null }[]) => {
          for (const { path, data } of changes) {
            const at = toVPath(path);
            if (data) store.write(at, data);
            else store.remove(at, bundled.has(pathKey(at)));
          }
          host.events.onSave();
        };

        const finished = (status: unknown) => {
          ended = true;
          if (status !== 0) console.warn(`gm-recomp: the game ended with status ${String(status)}`);
          presented?.();
        };
        // (`prompt` is missing from runGame's JSDoc: a variable, not a literal, so it type-checks)
        const options = {
          ...(await profileFor(host.game)),
          runtimeBytes: runtime,
          files: triples,
          exe: entry.path.slice(dir.length).replaceAll("/", "\\"),
          canvas: host.surface.canvas,
          pace: true,
          pacing: "clock" as const,
          print: (line: string) => console.debug(`gm-recomp: ${line}`),
          prompt,
          onSave,
          audioRing,
          args: [...host.launchArgs],
          // GEMS loopback (SPEC §14): TCP to this machine on a port the host listens on.
          connect: (to: string, port: number, udp: boolean) =>
            !udp && LOOPBACK.includes(to.toLowerCase()) ? host.network.connect(port) : null,
          onReady: (ready: unknown) => {
            input = ready as Input;
            input.files(late.splice(0));
          },
          onResize: (width: number, height: number) => host.surface.reportSize(width, height),
          onFrame: () => {
            presented?.();
            return new Promise<void>((resolve) => {
              resume = resolve;
            });
          },
          // shortcut: no SoundFont is shipped, so MIDI music is silent; ship one to fix it.
          soundfontUrl: `${host.assets.base}/soundfont.sf2`,
        };
        runGame(options).then(finished, (error: unknown) => {
          failure = error;
          finished(-1);
        });

        await frame;
        if (failure) throw new EngineError("corrupt-game", String(failure));
        if (ended)
          throw new EngineError("unsupported-game", "the game ended before its first frame");
        const { width, height } = host.surface.canvas;
        return { width, height };
      },

      async step() {
        if (ended) return false;
        for (const event of [...queued.splice(0), ...shim.takeInput()]) apply(event);
        frame = nextFrame();
        const go = resume;
        resume = null;
        go?.();
        await frame;
        if (failure) throw new EngineError("internal", String(failure));
        return !ended;
      },

      sendInput(event) {
        queued.push(event);
      },

      setSetting() {},

      dispose() {
        // The worker is terminated by the host's half: the runtime has no stop of its own.
        ended = true;
      },
    };
  },
});
