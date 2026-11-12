/**
 * The wire protocol: the engine interface, as messages.
 *
 * `../engine` says what a host and an engine can ask of each other. This says how
 * those calls look when the two are not in the same realm -- which, under the one hosting rule, is
 * always: every engine is a worker, reached through a port. The two are deliberately not the same
 * document, because a method call and a message have genuinely different constraints (a message is
 * one-way, cloneable, and may be dropped on teardown) and pretending otherwise is how a protocol
 * ends up with calls nobody can implement.
 *
 * **Versioned with the interface, not separately.** `init` carries `apiVersion`, and a mismatch is
 * refused there. A second number for the wire would be a second thing to get wrong, and there is no
 * useful state in which an engine implements one revision of the calls and another of the messages.
 *
 * **What is not here, and why.** File I/O is not a request. GML reads and writes files
 * synchronously, in the middle of a frame, and an engine in a worker cannot await anything without
 * returning to its event loop -- so the filesystem is *replicated*: the host seeds the engine's
 * store at `init` and the engine mirrors every write back with `fs-set`/`fs-remove`, which the host
 * persists. That is the one place where this protocol carries state rather than intent, and it is
 * forced by the language, not chosen.
 */

import type { DialogRequest, DialogResult } from "../dialog";
import type { ErrorCode, GameInfo, GameInput, SettingValue } from "../engine";

export type { Envelope, Wire, WireHandlers, WirePort } from "./port";
export { openWire } from "./port";
export type { BufferedDialogResult } from "./dialog-sab";
export {
  awaitDialogResult,
  beginDialog,
  createDialogBuffer,
  dialogControl,
  dialogValueBytes,
  readDialogResult,
  writeDialogResult,
  DIALOG_BUFFER_BYTES,
  DIALOG_BUTTON,
  DIALOG_SIGNAL,
  DIALOG_VALUE_LENGTH,
  DIALOG_VALUE_OFFSET,
} from "./dialog-sab";

// -- What a game is, on the wire -----------------------------------------------------------------

/**
 * One of the game's files, as it crosses.
 *
 * The bytes travel as an `ArrayBuffer` so they can be *transferred* rather than copied: a game is
 * routinely hundreds of megabytes, and structured-cloning that into a worker would both double the
 * peak memory and stall the thread doing it. A transferred buffer is detached on the sending side
 * afterwards, which is the right default here -- the host has no further use for bytes it has handed
 * over, and the index it built them from is gone by then too.
 */
export interface WireFile {
  /** `/`-separated, no leading slash, relative to the game's root. See `IndexedFile.path`. */
  readonly path: string;
  readonly bytes: ArrayBuffer;
}

/**
 * Everything the engine needs before it can be asked anything.
 *
 * One message rather than several, because every field is required before the engine's own runtime
 * starts -- the canvas before its renderer binds, the settings before it decodes any audio, the
 * store seed before its filesystem answers a single read -- and a protocol that let them arrive
 * separately would need an ordering rule nobody could enforce.
 */
export interface WireInit {
  /** The contract revision the host implements. The engine refuses a number it does not. */
  readonly apiVersion: number;
  /** The surface, transferred. See `Surface`. */
  readonly canvas: OffscreenCanvas;
  /** Where this plugin's own payload is served from, with no trailing slash. */
  readonly assetBase: string;
  /** Every setting this engine declared, resolved. See `HostServices.settings`. */
  readonly settings: Readonly<Record<string, SettingValue>>;
  /**
   * The game's identity, as the host knows it.
   *
   * Opaque to the engine, and the engine must not derive it from the game's bytes: it is what every
   * persisted file is keyed under, including across a re-upload of the same game, and only the host
   * knows which install this is.
   */
  readonly gameId: string;
  /**
   * The persisted files this game already has, as the store's own key/value pairs.
   *
   * Opaque strings on both sides -- produced and parsed by one codec in this package, so neither end
   * reads into them. See the note at the top about why the filesystem is replicated.
   */
  readonly storeSeed: Readonly<Record<string, string>>;
  /**
   * The dialog handshake buffer, for an engine that blocks a thread rather than awaiting.
   *
   * Null when the host cannot provide one (no cross-origin isolation) or when the engine said it
   * does not need one. An engine that requires it and is given null reports
   * `"unsupported-environment"`.
   */
  readonly dialogBuffer: SharedArrayBuffer | null;
  /** See `HostServices.launchArgs`. */
  readonly launchArgs: readonly string[];
  /** See `NetworkServices.ports`. */
  readonly ports: readonly number[];
}

// -- Host to engine ------------------------------------------------------------------------------

/** `init`'s answer: nothing but acknowledgement that the engine accepted the contract. */
export interface WireReady {
  readonly engineId: string;
}

/**
 * `start`'s answer: the game's resolution, and its caption if it has one yet.
 *
 * The interface's own type, unchanged. Named here so a host can import every reply shape from one
 * module without having to know which of them the wire added.
 */
export type WireStarted = GameInfo;

/** `tick`'s answer. */
export interface WireTicked {
  /** False when the game ended itself; see `EngineSession.step`. */
  readonly running: boolean;
}

/** Everything the host sends. `kind` discriminates; the request ones name their answer. */
export type HostMessage =
  // -- requests ---------------------------------------------------------------------------------
  /** Hand over everything in `WireInit`. Answered with `WireReady`. */
  | { readonly kind: "init"; readonly init: WireInit }
  /** Load the game and be ready to run. Answered with `GameInfo`. */
  | { readonly kind: "start"; readonly files: readonly WireFile[] }
  /** Run one frame. Answered with `WireTicked`, and only once the frame is really over. */
  | { readonly kind: "tick"; readonly now: number }
  /** Ask for diagnostics. Answered with whatever the engine wants to say; opaque. */
  | { readonly kind: "stats" }
  // -- notes ------------------------------------------------------------------------------------
  /** One input event, already in game pixels where it has coordinates. See `GameInput`. */
  | { readonly kind: "input"; readonly input: GameInput }
  /** The player changed a setting this engine declared. */
  | { readonly kind: "setting"; readonly key: string; readonly value: SettingValue }
  /** Bytes the host sent down loopback connection `id`. See `NetworkServices`. */
  | { readonly kind: "net-data"; readonly id: number; readonly bytes: ArrayBuffer }
  /** The host closed loopback connection `id`. */
  | { readonly kind: "net-close"; readonly id: number }
  /**
   * A file the host is putting into the running game's filesystem -- a picture it was asked to add,
   * a restored save. Transferred, like `WireFile`.
   */
  | { readonly kind: "fs-put"; readonly path: string; readonly bytes: ArrayBuffer }
  /** A file the host removed, by store key, so a running game stops seeing it. */
  | { readonly kind: "fs-drop"; readonly key: string }
  /** The host's real fullscreen state changed, including in ways no game asked for. */
  | { readonly kind: "fullscreen-changed"; readonly enabled: boolean }
  /** One audio node finished, so the engine's own bookkeeping can catch up. See `AudioCommand`. */
  | { readonly kind: "audio-ended"; readonly id: number }
  /**
   * Shut down: release the device, stop the audio, drop the game.
   *
   * A note rather than a request, because the honest sequence on teardown is "tell it, then
   * terminate it". A host that awaited an acknowledgement would be waiting on an engine it has
   * already decided to kill, and the kill is what actually guarantees the teardown.
   */
  | { readonly kind: "unload" };

// -- Engine to host ------------------------------------------------------------------------------

/** Everything the engine sends. */
export type EngineMessage =
  // -- requests ---------------------------------------------------------------------------------
  /**
   * Show a dialog, and tell me what the player chose. Answered with a `DialogResult`.
   *
   * The path for an engine that can suspend without blocking. An engine that blocks a thread sends
   * `dialog-asked` instead and reads the answer from the shared buffer, because by the time it is
   * blocked it can no longer receive a reply.
   */
  | { readonly kind: "dialog"; readonly request: DialogRequest }
  // -- notes ------------------------------------------------------------------------------------
  /**
   * The same question, for the blocking path: the host renders it and writes the answer into the
   * dialog buffer with `writeDialogResult`. No reply is sent, because nothing could receive one.
   */
  | { readonly kind: "dialog-asked"; readonly request: DialogRequest }
  /** The engine resized its backing buffer to the game's real resolution. See `Surface.reportSize`. */
  | { readonly kind: "resize"; readonly width: number; readonly height: number }
  /** The game set its window caption. */
  | { readonly kind: "title"; readonly title: string }
  /** The game asked for smooth or crisp upscaling. See `Surface.reportSmoothing`. */
  | { readonly kind: "smoothing"; readonly enabled: boolean }
  /** The game asked to enter or leave fullscreen. */
  | { readonly kind: "set-fullscreen"; readonly enabled: boolean }
  /** A persisted file was written. Opaque key and value; see `WireInit.storeSeed`. */
  | { readonly kind: "fs-set"; readonly key: string; readonly value: string }
  /** A persisted file was deleted. */
  | { readonly kind: "fs-remove"; readonly key: string }
  /**
   * A real save landed -- the signal a host throttles into whatever it does about durability.
   *
   * Separate from `fs-set` because the two are not the same claim: `fs-set` is one key changing,
   * and an engine that persists outside the host's filesystem emits none of those while still
   * having saves. A host that mirrors the filesystem will see both for the same event and must
   * treat this as idempotent.
   */
  | { readonly kind: "save" }
  /** One audio operation for the host to perform on the real audio device. */
  | { readonly kind: "audio"; readonly command: AudioCommand }
  /**
   * The game opened loopback connection `id` to `port`, one of the host's. Ids are the engine's,
   * never reused within a session.
   */
  | { readonly kind: "net-open"; readonly id: number; readonly port: number }
  /** Bytes the game sent on connection `id`, in order. */
  | { readonly kind: "net-send"; readonly id: number; readonly bytes: ArrayBuffer }
  /** The game closed connection `id`. */
  | { readonly kind: "net-end"; readonly id: number }
  /** The game ended itself. See `EventServices.onEnded`. */
  | { readonly kind: "ended" }
  /** The game cannot continue. A code, never a sentence. See `ErrorCode`. */
  | { readonly kind: "error"; readonly code: ErrorCode; readonly detail?: string };

// -- Audio ---------------------------------------------------------------------------------------

/**
 * One operation on the host's audio device.
 *
 * Web Audio is main-thread only, so an engine in a worker cannot own an `AudioContext`. It keeps its
 * own bookkeeping -- the node graph, the clock, every synchronous getter its own code reads back --
 * and sends only the operations that actually produce sound. The host replays them against a real
 * context and reports node completions back with `audio-ended`.
 *
 * Node ids are the engine's own, with two reserved by convention: `0` is the destination and `-1`
 * the listener, neither of which is ever created.
 */
export type AudioCommand =
  | {
      readonly op: "create";
      readonly id: number;
      readonly type: string;
      readonly args: readonly unknown[];
    }
  | { readonly op: "connect"; readonly id: number; readonly target: number }
  | { readonly op: "disconnect"; readonly id: number }
  | { readonly op: "start"; readonly id: number; readonly when: number; readonly offset: number }
  | { readonly op: "stop"; readonly id: number }
  /** An `AudioParam`'s value. */
  | { readonly op: "param"; readonly id: number; readonly param: string; readonly value: number }
  /**
   * Ramp an `AudioParam` to `value` over `seconds`, starting now -- a fade.
   *
   * **Expressed as a duration, not as two points on a timeline, and that is the whole reason it is
   * its own op.** Web Audio schedules automation against the context's clock, which an engine in a
   * worker cannot read: `currentTime` is a synchronous getter and the context is on another
   * thread. An engine that sent absolute times would be sending times from a clock nobody else
   * has. A duration needs no shared clock at all, and the side that does have one anchors it.
   *
   * The host anchors the ramp at the param's current value, so a fade started while an earlier one
   * is still running continues from where it actually is rather than jumping. `seconds <= 0` is an
   * immediate set, which is what a game asking for a zero-length fade means.
   */
  | {
      readonly op: "ramp";
      readonly id: number;
      readonly param: string;
      readonly value: number;
      readonly seconds: number;
    }
  /**
   * Drop any automation scheduled on an `AudioParam`, leaving it wherever it is now.
   *
   * What an engine needs before writing a param it had previously ramped: a scheduled event still
   * on the timeline would otherwise win over the write and move the value back.
   */
  | { readonly op: "cancelRamp"; readonly id: number; readonly param: string }
  /** A plain property, as opposed to an `AudioParam`. */
  | { readonly op: "prop"; readonly id: number; readonly prop: string; readonly value: unknown }
  | {
      readonly op: "createBuffer";
      readonly id: number;
      readonly channels: number;
      readonly frames: number;
      readonly rate: number;
    }
  /**
   * One channel's samples. Sent per channel because that is how the engine has them.
   *
   * `start` is where in the channel they go, so a long render can be streamed in chunks instead of
   * existing whole on both sides at once -- a wasm engine's linear memory never shrinks, so a
   * scratch buffer for a 223-second MIDI score costs as much as a permanent one. Optional, and
   * absent means the beginning.
   */
  | {
      readonly op: "bufferData";
      readonly id: number;
      readonly ch: number;
      readonly data: Float32Array;
      readonly start?: number;
    }
  | { readonly op: "setBuffer"; readonly id: number; readonly bufferId: number }
  | { readonly op: "deleteBuffer"; readonly id: number }
  /**
   * Forget a node: the engine will never address this id again.
   *
   * Not the same as `disconnect`, which leaves a node addressable because an engine may reconnect
   * it. A host holds every node it was told to create, and a game that plays a sound effect creates
   * one per play -- so an engine with no way to say "gone" leaves thousands of dead source nodes on
   * the host's heap over a session, each pinning the buffer it played.
   */
  | { readonly op: "deleteNode"; readonly id: number }
  /** Ask to be told when this node ends, which comes back as `audio-ended`. */
  | { readonly op: "onended"; readonly id: number }
  /** The device itself. A browser only starts one from a gesture, which only the host sees. */
  | { readonly op: "resume" }
  | { readonly op: "suspend" };

/** The answer to a `dialog` request. Re-exported so one import covers a host's dialog path. */
export type { DialogRequest, DialogResult };
