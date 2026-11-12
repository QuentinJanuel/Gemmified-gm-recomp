/**
 * The host-realm half of a plugin whose engine runs in a worker behind the shim.
 *
 * The host's realm is where the things a worker cannot have live: the `AudioContext`, the shared
 * buffer a blocking dialog is answered through, and the `Worker` itself. This is the lowering of
 * the lifecycle onto the wire from that side, so a plugin's entry only has to say which worker to
 * start. The other half is `createEngineHost` in `../shim`.
 */

import { API_VERSION } from "../index";
import {
  EngineError,
  type EngineSession,
  type FileIndex,
  type GameInfo,
  type GameInput,
  type HostServices,
  type NetworkConnection,
  type SettingValue,
} from "../engine";
import { createAudioExecutor } from "../audio";
import type { AudioExecutor } from "../audio";
import { createDialogBridge } from "../dialog/bridge";
import { createDialogBuffer, openWire } from "../wire";
import type { EngineMessage, HostMessage, Wire, WireFile, WireReady, WireTicked } from "../wire";

/**
 * One loaded game.
 *
 * Built by `createWorkerSession`, which has already completed the `init` handshake: a session that
 * exists is one whose worker is up, whose canvas it holds and whose contract matched.
 */
class WorkerSession implements EngineSession {
  /** Set when the game ended itself, or when the worker went away. Either way: no more frames. */
  private ended = false;
  /** A frame that has not finished. A frame stopped on a dialog has not finished. */
  private ticking: Promise<WireTicked> | null = null;
  /** The game's loopback connections, by the engine's id. See `NetworkServices`. */
  private readonly connections = new Map<number, NetworkConnection>();
  /** The host's last known fullscreen state, so a change can be pushed rather than polled for. */
  private fullscreen: boolean;
  /** The engine's last answer about itself. Asked for now, shown next time; see `stats`. */
  private lastStats: Record<string, unknown> = {};

  constructor(
    private readonly host: HostServices,
    private readonly wire: Wire<HostMessage, EngineMessage>,
    private readonly audio: AudioExecutor,
    private readonly release: () => void,
  ) {
    this.fullscreen = host.window.isFullscreen();
  }

  async start(files: FileIndex): Promise<GameInfo> {
    // Read here rather than in the worker: a host may hold a game as `File` handles, which a worker
    // cannot open, and this is the side that can. Transferred rather than copied -- a game is
    // routinely hundreds of megabytes. Paths stay as the host indexed them.
    const wireFiles: WireFile[] = [];
    for (const file of files.files) {
      const bytes = await file.read();
      // A fresh buffer, because the one the host handed over may be a view into something it still
      // owns and the transfer would detach it.
      const copy = bytes.slice();
      wireFiles.push({ path: file.path, bytes: copy.buffer as ArrayBuffer });
    }
    return await this.wire.request<GameInfo>(
      { kind: "start", files: wireFiles },
      wireFiles.map((file) => file.bytes),
    );
  }

  step(now: number): Promise<boolean> | boolean {
    if (this.ended) return false;
    // The contract says a step may be called again only once the previous settled, but the host's
    // loop is a rAF callback and a frame suspended on a dialog outlives several of them, so this
    // reports "still going" rather than trusting the caller. It is also what keeps ticks from
    // stacking up behind a dialog nobody has answered yet.
    if (this.ticking !== null) return true;

    this.pushFullscreenChange();
    this.relayFromHost();

    const pending = this.wire.request<WireTicked>({ kind: "tick", now });
    this.ticking = pending;
    return pending.then(
      ({ running }) => {
        this.ticking = null;
        if (!running) this.ended = true;
        return running;
      },
      (error: unknown) => {
        // A frame whose answer can never arrive is what a dead worker looks like from here. Ending
        // the session reports it; leaving `ticking` set would spin silently forever.
        this.ticking = null;
        this.ended = true;
        this.host.events.onError("internal", `the engine stopped answering: ${String(error)}`);
        return false;
      },
    );
  }

  sendInput(input: GameInput): void {
    this.wire.notify({ kind: "input", input });
  }

  setSetting(key: string, value: SettingValue): void {
    this.wire.notify({ kind: "setting", key, value });
  }

  /**
   * Asked for now, shown next time.
   *
   * The contract's `stats` is synchronous and the engine is a round trip away, so this returns the
   * previous answer and asks for the next one.
   */
  stats(): Record<string, unknown> {
    void this.wire
      .request<Record<string, unknown>>({ kind: "stats" })
      .then((answer) => {
        this.lastStats = answer;
      })
      .catch(() => {});
    return this.lastStats;
  }

  dispose(): void {
    this.ended = true;
    this.release();
  }

  /** A note arrived from the worker. Wired up by `createWorkerSession`, which owns the wire. */
  note(message: EngineMessage): void {
    switch (message.kind) {
      case "resize":
        this.host.surface.reportSize(message.width, message.height);
        return;
      case "title":
        this.host.window.setTitle(message.title);
        return;
      case "smoothing":
        this.host.surface.reportSmoothing(message.enabled);
        return;
      case "set-fullscreen":
        this.host.window.setFullscreen(message.enabled);
        // Taken as read rather than waited for: the next `pushFullscreenChange` corrects it if the
        // host declined or the player undid it.
        this.fullscreen = message.enabled;
        return;
      case "fs-set":
        this.host.replica.set(message.key, message.value);
        return;
      case "fs-remove":
        this.host.replica.remove(message.key);
        return;
      case "save":
        // The mirror's own call, not `events.onSave`: this is the side that stamps the write time
        // and reports the save upward, and calling both would count one save twice.
        this.host.replica.save();
        return;
      case "audio":
        this.audio.execute(message.command);
        return;
      case "net-open": {
        const connection = this.host.network.connect(message.port);
        if (connection) this.connections.set(message.id, connection);
        else this.wire.notify({ kind: "net-close", id: message.id });
        return;
      }
      case "net-send":
        this.connections.get(message.id)?.send(new Uint8Array(message.bytes));
        return;
      case "net-end":
        this.connections.get(message.id)?.close();
        this.connections.delete(message.id);
        return;
      case "ended":
        this.ended = true;
        this.host.events.onEnded();
        return;
      case "error":
        this.host.events.onError(message.code, message.detail);
        return;
      case "dialog-asked":
      case "dialog":
        // Handled by the dialog bridge, which is the only thing holding the shared buffer the
        // engine is blocked on.
        return;
    }
  }

  /** The worker died without answering. */
  fail(detail: string): void {
    this.ended = true;
    this.host.events.onError("internal", detail);
    this.wire.close();
  }

  /**
   * Tell the engine about a fullscreen change the host made.
   *
   * Pulled once per frame because `WindowServices` has no event for it, and `window_get_fullscreen`
   * has to answer correctly in the middle of a frame, which means the worker needs the value in hand.
   */
  private pushFullscreenChange(): void {
    const now = this.host.window.isFullscreen();
    if (now === this.fullscreen) return;
    this.fullscreen = now;
    this.wire.notify({ kind: "fullscreen-changed", enabled: now });
  }

  /** What the host sent on each loopback connection since the last frame, handed to the worker. */
  private relayFromHost(): void {
    for (const [id, connection] of this.connections) {
      const bytes = connection.receive();
      if (bytes.length > 0) {
        const buffer = bytes.slice().buffer as ArrayBuffer;
        this.wire.notify({ kind: "net-data", id, bytes: buffer }, [buffer]);
      }
      if (connection.closed) {
        this.wire.notify({ kind: "net-close", id });
        this.connections.delete(id);
      }
    }
  }
}

/**
 * Starts `worker`'s engine on `host` and completes the `init` handshake.
 *
 * `name` prefixes this side's console warnings. Anything short of a matched contract throws, with
 * the worker, the audio device and the listeners released.
 */
export async function createWorkerSession(
  host: HostServices,
  worker: Worker,
  name: string,
): Promise<EngineSession> {
  // The real AudioContext, because a worker cannot have one; the engine sends the operations that
  // make sound and the executor replays them. Created in the host's realm, so whatever the host has
  // done to `AudioContext.prototype.destination` -- a master volume, say -- applies to it.
  const AudioCtor = (globalThis as unknown as { AudioContext?: typeof AudioContext }).AudioContext;
  if (AudioCtor === undefined) {
    worker.terminate();
    throw new EngineError("unsupported-environment", "this realm has no AudioContext");
  }
  const audioContext = new AudioCtor();
  const unsupported = new Set<string>();
  const audio = createAudioExecutor({
    context: audioContext,
    onEnded: (id) => wire.notify({ kind: "audio-ended", id }),
    // A command that did nothing, never a reason to end the game (§7.4): Firefox, for one, has no
    // AudioListener.positionX. Once per kind, because some of these arrive every frame.
    onUnsupported: (reason, command) => {
      const kind = `${command.op} ${"param" in command ? command.param : ""} (${reason})`;
      if (unsupported.has(kind)) return;
      unsupported.add(kind);
      console.warn(`${name}: audio command ${kind} did nothing`);
    },
  });

  // Browsers only let audio start from a user gesture. A realm with no document (a test, a
  // reference host) simply has no gestures to wait for.
  const gestures = new AbortController();
  if (typeof document !== "undefined") {
    const unlock = () => audio.resume();
    document.addEventListener("pointerdown", unlock, { signal: gestures.signal });
    document.addEventListener("keydown", unlock, { signal: gestures.signal });
  }

  // Requires cross-origin isolation. The engine blocks its worker thread on this buffer while the
  // host shows the dialog; the bridge writes the answer back and releases it, then sends a
  // `focus-lost` so a key held when the dialog opened is not still held after it closes.
  const dialogBuffer = createDialogBuffer();
  const dialogs = createDialogBridge({
    ui: { show: (request) => host.dialogs.show(request) },
    buffer: dialogBuffer,
    releaseInput: (input) => wire.notify({ kind: "input", input }),
    onError: (code, detail) => host.events.onError(code, detail),
  });

  let session: WorkerSession | null = null;
  const wire = openWire<HostMessage, EngineMessage>(worker, {
    onRequest: (message) => {
      // A dialog, on the path for an engine that can await one; a blocking engine sends
      // `dialog-asked` instead, and both arrive here.
      if (message.kind === "dialog") return dialogs.requested(message.request);
      return undefined;
    },
    onNote: (message) => {
      if (message.kind === "dialog-asked") {
        void dialogs.asked(message.request);
        return;
      }
      session?.note(message);
    },
  });

  /** Everything this session took hold of, released. Also used when the handshake fails. */
  const release = () => {
    gestures.abort();
    audio.dispose();
    // "Tell it, then terminate it": waiting for an acknowledgement would be waiting on an engine
    // already decided against.
    wire.notify({ kind: "unload" });
    wire.close();
    worker.terminate();
    // The executor never closes a context it was handed, so closing it is this side's job.
    void audioContext.close().catch(() => {});
  };

  // A worker that fails to even start answers nothing, and every outstanding request would
  // otherwise hang forever. Closing the wire is what rejects them.
  worker.addEventListener("error", (event) => {
    if (session === null) wire.close();
    else session.fail(`the engine's worker failed: ${event.message}`);
  });

  try {
    await wire.request<WireReady>(
      {
        kind: "init",
        init: {
          apiVersion: API_VERSION,
          canvas: host.surface.canvas,
          assetBase: host.assets.base,
          settings: host.settings,
          // The replica's own scope. The host keyed its storage by this and seeds from it.
          gameId: host.game,
          storeSeed: host.replica.seed(),
          dialogBuffer,
          launchArgs: host.launchArgs,
          ports: host.network.ports,
        },
      },
      [host.surface.canvas],
    );
  } catch (error) {
    release();
    throw error;
  }

  session = new WorkerSession(host, wire, audio, release);

  // Host-side changes to the filesystem, straight into the running game's replica. Installed after
  // init because that is when there is a replica to put them in.
  host.replica.watch({
    put: (path, bytes) => {
      // The mirror handed over a copy for exactly this, so it is transferred rather than sent.
      const buffer = bytes.buffer as ArrayBuffer;
      wire.notify({ kind: "fs-put", path, bytes: buffer }, [buffer]);
    },
    drop: (key) => wire.notify({ kind: "fs-drop", key }),
  });

  return session;
}
