/**
 * The engine's side of the wire, so an adapter never speaks the protocol itself.
 *
 * An engine written against this hands over one function -- "given these host services, here is a
 * session" -- and the shim does the rest: it decodes every message, builds the `HostServices` the
 * interface promises, drives the lifecycle in order, and turns everything the engine wants to tell
 * the host into the right note. The adapter sees method calls and never a `postMessage`.
 *
 * **No globals.** The engine reaches the host only through this module and the port it is handed,
 * never through names installed on `globalThis` and agreed on out of band: those would tie an engine
 * to one host, could not be type-checked, and a missing one would be a crash halfway into a game.
 *
 * **It ships inside the plugin, and it is MIT**, like everything else here, so an engine under any
 * licence can link it.
 *
 * Runs unchanged in a worker and in the host's own realm; see `blockingDialogs` for the one place
 * the difference is observable, and `createEngineHost` for what the adapter supplies.
 */

import { API_VERSION } from "../index";
import type { DialogRequest } from "../dialog";
import {
  EngineError,
  fileIndexFromBytes,
  type EngineSession,
  type GameInput,
  type HostServices,
  type NetworkConnection,
  type ReplicaSink,
  type SettingValue,
} from "../engine";
import { MemoryBackend, Vfs, parsePath, seedForGame } from "../vfs";
import type { GameId } from "../vfs";
import type {
  AudioCommand,
  BufferedDialogResult,
  EngineMessage,
  HostMessage,
  WireReady,
  WireTicked,
  WirePort,
} from "../wire";
import { awaitDialogResult, beginDialog, openWire } from "../wire";

/**
 * Re-exported because an engine served through this shim imports *this* module and no other: its
 * payload is a compiled bundle, and `throw new EngineError("unsupported-environment", ...)` is the
 * one thing every engine has to be able to do -- see `ErrorCode` on why a code and not a sentence.
 */
export { EngineError } from "../engine";

/**
 * What the shim offers an engine that the interface cannot carry.
 *
 * `HostServices` is the contract and says nothing about queues, because in the same realm there are
 * none -- a host would simply call a method. Across a port there are, and an engine's frame loop has
 * to drain them. So these are affordances of *this* shim rather than parts of the contract, which is
 * why they arrive separately and why an engine can ignore every one of them.
 */
export interface ShimServices {
  /**
   * Input the host has pushed since the last call, oldest first, and drains the queue.
   *
   * Called once per frame by an engine's own event pump. Already normalized and, where it has
   * coordinates, already in game pixels -- see `GameInput`.
   */
  takeInput(): GameInput[];
  /**
   * The blocking dialog path, or null where it cannot work.
   *
   * Non-null only when the host supplied a handshake buffer *and* this thread is allowed to block,
   * which together mean "a worker in a cross-origin-isolated page". An engine whose GML dialogs are
   * synchronous all the way down -- no async, no unwinding -- needs this and must report
   * `"unsupported-environment"` when it is null. An engine that can await uses
   * `host.dialogs.show` instead and should never look at this.
   */
  readonly blockingDialogs: BlockingDialogs | null;
  /**
   * This game's filesystem, built over the replica the host seeded: the bundle the engine fills from
   * `start`'s files, the store mirroring every write back. Readable once `create` is called.
   *
   * The shim's, not the contract's: a host offers only `HostServices.replica`, and an engine keeps
   * its own filesystem over it. This is that filesystem, for an engine using this shim.
   */
  readonly files: Vfs;
  /** The audio device, which lives wherever the host is. See `AudioCommand`. */
  readonly audio: {
    /**
     * Perform one operation on the real device. Fire-and-forget. `transfer` is handed to
     * `postMessage`: a buffer the engine owns and will not touch again, so samples move, not copy.
     */
    send(command: AudioCommand, transfer?: Transferable[]): void;
    /**
     * Be told when a node the engine asked about finishes.
     *
     * One listener; a second call replaces the first. The engine keeps the bookkeeping, so there is
     * nothing here to fan out.
     */
    onEnded(listener: (id: number) => void): void;
  };
}

/** The synchronous dialog path. See `ShimServices.blockingDialogs`. */
export interface BlockingDialogs {
  /**
   * Shows a dialog and **blocks this thread** until the player answers.
   *
   * The thread is blocked, not the host: the host is elsewhere, rendering the dialog. Returns the
   * answer inline, which is what GML's `show_question` needs and what no promise can give it.
   */
  show(request: DialogRequest): BufferedDialogResult;
}

/** What an adapter supplies. */
export interface EngineHostOptions {
  /** The port the host is on: a worker's own scope, or a `MessagePort` in the host's realm. */
  readonly port: WirePort;
  /** This engine's id, as its manifest declares it. Echoed back to the host on `init`. */
  readonly id: string;
  /**
   * Build a session. Called once, when the host's `init` arrives and not before -- the services do
   * not exist until then, and neither does the canvas.
   */
  create(host: HostServices, shim: ShimServices): Promise<EngineSession> | EngineSession;
}

/** A running shim. */
export interface EngineHost {
  /** Stop serving, dispose the session if there is one, and close the port. */
  close(): void;
}

/**
 * Serves one engine on a port.
 *
 * Returns as soon as it is listening, which is before the host has said anything: the host's first
 * message is `init`, and an engine that did work before it arrived would be doing it without a
 * canvas, without settings and without knowing whether the contract matches.
 */
export function createEngineHost(options: EngineHostOptions): EngineHost {
  const { port, id, create } = options;

  let session: EngineSession | null = null;
  let dialogBuffer: SharedArrayBuffer | null = null;
  let fullscreen = false;
  let onAudioEnded: ((id: number) => void) | null = null;
  const inputQueue: GameInput[] = [];
  // Loopback connections the game opened, by the id this side gave them. See `NetworkServices`.
  const connections = new Map<number, { inbox: Uint8Array[]; closed: boolean }>();
  let nextConnection = 1;
  const settings: Record<string, SettingValue> = {};
  let files: Vfs | null = null;
  let backend: MemoryBackend | null = null;
  let gameId: GameId | null = null;
  // An engine that is itself worker-hosted behind this shim -- which is not a hypothetical shape,
  // it is this shim's own arrangement one level down. Null for the ordinary case of an engine that
  // reads `files` directly, and then the host's changes need no forwarding because applying them
  // to the replica below is already all of it.
  let replicaSink: ReplicaSink | null = null;

  const wire = openWire<EngineMessage, HostMessage>(port, {
    onNote: (message) => {
      switch (message.kind) {
        case "input":
          inputQueue.push(message.input);
          return;
        case "setting":
          settings[message.key] = message.value;
          // The session is told as well as the snapshot being updated: an engine may need to act on
          // the change now (re-reading a budget, dropping a cache) rather than at the next read.
          session?.setSetting(message.key, message.value);
          return;
        case "net-data":
          connections.get(message.id)?.inbox.push(new Uint8Array(message.bytes));
          return;
        case "net-close": {
          const open = connections.get(message.id);
          if (open) open.closed = true;
          return;
        }
        case "fs-put": {
          // Straight into the filesystem the game reads, so a file the host adds is simply a file
          // rather than something the game has to be taught about.
          const bytes = new Uint8Array(message.bytes);
          files?.write(parsePath(message.path), bytes);
          replicaSink?.put(message.path, bytes);
          return;
        }
        case "fs-drop":
          // The host deleted a file; drop it from this replica so a running game stops seeing it,
          // and do it *without* mirroring the removal back -- the host is where it came from.
          backend?.drop(message.key);
          replicaSink?.drop(message.key);
          return;
        case "fullscreen-changed":
          fullscreen = message.enabled;
          return;
        case "audio-ended":
          onAudioEnded?.(message.id);
          return;
        case "unload":
          closeHost();
          return;
      }
    },
    onRequest: async (message) => {
      switch (message.kind) {
        case "init":
          return init(message.init);
        case "start":
          return requireSession().start(
            fileIndexFromBytes(
              message.files.map((file) => ({ path: file.path, bytes: new Uint8Array(file.bytes) })),
            ),
          );
        case "tick": {
          const running = await requireSession().step(message.now);
          return { running } satisfies WireTicked;
        }
        case "stats":
          return requireSession().stats?.() ?? {};
      }
    },
  });

  const shim: ShimServices = {
    takeInput: () => inputQueue.splice(0, inputQueue.length),
    get files(): Vfs {
      if (files === null) throw new EngineError("internal", "the host has not sent init yet");
      return files;
    },
    get blockingDialogs(): BlockingDialogs | null {
      // A getter, because the buffer only exists once `init` has arrived -- and an adapter that
      // captured this during module evaluation would have captured null.
      if (dialogBuffer === null || !threadCanBlock()) return null;
      const buffer = dialogBuffer;
      return {
        show(request) {
          // Marked as waiting *before* the question goes out, so an instant answer cannot be
          // erased by this line. See `beginDialog`.
          beginDialog(buffer);
          wire.notify({ kind: "dialog-asked", request });
          return awaitDialogResult(buffer);
        },
      };
    },
    audio: {
      send: (command, transfer) => wire.notify({ kind: "audio", command }, transfer),
      onEnded: (listener) => {
        onAudioEnded = listener;
      },
    },
  };

  function connect(port: number): NetworkConnection {
    const id = nextConnection++;
    const open = { inbox: [] as Uint8Array[], closed: false };
    connections.set(id, open);
    wire.notify({ kind: "net-open", id, port });
    return {
      send: (bytes) => {
        if (open.closed || bytes.length === 0) return;
        // A copy, transferred: the caller may reuse its array, and the host has no use for a view.
        const copy = bytes.slice().buffer as ArrayBuffer;
        wire.notify({ kind: "net-send", id, bytes: copy }, [copy]);
      },
      receive: () => {
        const parts = open.inbox.splice(0, open.inbox.length);
        if (parts.length === 1) return parts[0]!;
        const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
        parts.reduce((at, part) => (out.set(part, at), at + part.length), 0);
        return out;
      },
      get closed() {
        return open.closed;
      },
      close: () => {
        if (open.closed) return;
        open.closed = true;
        wire.notify({ kind: "net-end", id });
      },
    };
  }

  function host(payload: InitPayload): HostServices {
    const { canvas, assetBase, launchArgs, ports } = payload;
    return {
      surface: {
        canvas,
        reportSize: (width, height) => wire.notify({ kind: "resize", width, height }),
        reportSmoothing: (enabled) => wire.notify({ kind: "smoothing", enabled }),
      },
      game: payload.gameId,
      // The same filesystem by key, for an engine that keeps its own rather than using `shim.files`.
      // Every write lands in the replica this shim built, whose own mirror carries it to the real
      // host -- so this adds a level of replication rather than a second route to storage.
      replica: {
        seed: () => (backend === null || gameId === null ? {} : seedForGame(backend, gameId)),
        set: (key, value) => backend?.set(key, value),
        remove: (key) => backend?.remove(key),
        save: () => wire.notify({ kind: "save" }),
        watch: (sink) => {
          replicaSink = sink;
        },
      },
      dialogs: {
        show: (request) => wire.request({ kind: "dialog", request }),
      },
      window: {
        setTitle: (title) => wire.notify({ kind: "title", title }),
        setFullscreen: (enabled) => wire.notify({ kind: "set-fullscreen", enabled }),
        // The host's last reported state, never a question asked across the wire: this answers a
        // GML call in the middle of a frame. See `WindowServices.isFullscreen`.
        isFullscreen: () => fullscreen,
      },
      assets: { base: assetBase },
      settings,
      events: {
        onSave: () => wire.notify({ kind: "save" }),
        onEnded: () => wire.notify({ kind: "ended" }),
        onError: (code, detail) => wire.notify({ kind: "error", code, detail }),
      },
      launchArgs,
      network: {
        ports,
        connect: (port) => (ports.includes(port) ? connect(port) : null),
      },
    };
  }

  async function init(payload: InitPayload): Promise<WireReady> {
    if (session !== null) throw new EngineError("internal", "init arrived twice");
    if (payload.apiVersion !== API_VERSION) {
      // The host's contract revision is as much a property of where this engine has been put as a
      // missing WebGL2 is, and it is the one incompatibility worth saying out loud rather than
      // failing part-way into a game.
      throw new EngineError(
        "unsupported-environment",
        `host implements contract ${payload.apiVersion}, this engine implements ${API_VERSION}`,
      );
    }

    dialogBuffer = payload.dialogBuffer;
    gameId = payload.gameId;
    Object.assign(settings, payload.settings);

    // The engine's replica of the persisted filesystem: seeded with what the host already has, and
    // mirroring every write back so the host can persist it. See the note on replication in the
    // wire module -- GML file calls are synchronous mid-frame, so this cannot be a request.
    backend = new MemoryBackend(payload.storeSeed, (key, value) => {
      wire.notify(value === null ? { kind: "fs-remove", key } : { kind: "fs-set", key, value });
    });
    files = new Vfs(payload.gameId, backend, undefined, () => wire.notify({ kind: "save" }));

    session = await create(host(payload), shim);
    return { engineId: id } satisfies WireReady;
  }

  function requireSession(): EngineSession {
    if (session === null) throw new EngineError("internal", "the host has not sent init yet");
    return session;
  }

  function closeHost(): void {
    try {
      session?.dispose();
    } finally {
      session = null;
      wire.close();
    }
  }

  return { close: closeHost };
}

/** The `init` payload, named locally so `init` can be read without chasing the wire module. */
type InitPayload = Extract<HostMessage, { kind: "init" }>["init"];

/**
 * Whether this thread may block in `Atomics.wait`.
 *
 * Probed rather than inferred from the globals, because what matters is the answer and not how this
 * code was loaded: `Atomics.wait` throws on a document's main thread, by design -- blocking it would
 * freeze the page that is supposed to be drawing the dialog -- and returns immediately here, with no
 * wait at all, because the value it is told to expect is not the value in the array.
 */
function threadCanBlock(): boolean {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 1, 0);
    return true;
  } catch {
    return false;
  }
}
