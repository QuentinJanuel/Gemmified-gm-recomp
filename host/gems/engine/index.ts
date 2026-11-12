/**
 * The engine interface: what a host hands an emulator, and what the emulator hands back.
 *
 * An engine implementing it needs nothing from the host that runs it -- no module of the host's, no
 * global the host installed, no string the host wrote -- and a host implementing the other side
 * needs to know nothing about which engine it loaded.
 *
 * **Two copies of this package exist at runtime, and that shapes the contract.** A plugin bundles
 * its own copy of the SDK (that is what lets engines version independently of the host), so a value
 * crossing this boundary is crossing between two module graphs. Nothing here may therefore rely on
 * `instanceof`, on a shared mutable module-level variable, or on class identity: every value that
 * crosses is plain data, and the one error type is identified by a field rather than by its
 * prototype. The same property is what makes the wire protocol possible at all -- the boundary has
 * to survive being a `postMessage`.
 *
 * **Nothing here is engine-specific, and the absence is load-bearing**, not stylistic: an interface
 * that names an emulator is poor evidence that the emulator and the host are separate programs.
 */

import type { DialogRequest, DialogResult } from "../dialog";

// -- The game's files, before anything has parsed them -------------------------------------------

/**
 * One file of a game, read on demand.
 *
 * Lazy on purpose. A game is routinely a 700MB folder, a host may hold it as `File` handles it has
 * not touched, and both `accepts()` and `start()` are allowed to look at a game without the host
 * having decided to run it -- so an index that materialized every byte would read a game three
 * times to play it once. `size` is separate from `read` for the same reason: deciding against a
 * game because it is too large to fit in a wasm heap should not require loading it first.
 */
export interface IndexedFile {
  /**
   * The path within the game, `/`-separated, with no leading slash.
   *
   * Relative to whatever the host considers the game's root -- the picked folder, the archive it
   * unpacked. An engine must treat this as a label rather than as a real filesystem path: the host
   * may never have had one (an upload in a browser does not), and the running game's own file calls
   * go through the filesystem the engine keeps over `HostServices.replica` instead.
   */
  readonly path: string;
  /** The file's length in bytes, available without reading it. */
  readonly size: number;
  /** The bytes. May be called more than once; whether it re-reads or caches is the host's business. */
  read(): Promise<Uint8Array>;
  /**
   * Bytes `[start, end)`, when the host can serve part of a file without reading all of it.
   *
   * Optional, and an engine must cope without it: a host holding a game in memory has nothing to
   * gain from it, and one reading from a stream cannot offer it at all. Where it exists it is the
   * difference between reading twelve bytes and reading a gigabyte -- which is what recognising a
   * game costs, since a container's signature is at a known offset and the host may be holding a
   * file it has not touched.
   *
   * Additive within this revision rather than a new one, because it is optional on the host's side
   * and no engine may depend on it: the rule that needs a new number is a member an engine is
   * entitled to rely on. The honest shape for an engine is `file.readRange?.(0, 12) ?? ...`.
   *
   * Clamped by the host, not by the caller: an `end` past the file returns what there is, and a
   * range entirely past it returns nothing. Never longer than `end - start`.
   */
  readRange?(start: number, end: number): Promise<Uint8Array>;
}

/**
 * Everything the host is offering as "the game", as a set of files.
 *
 * One object rather than an array so that it can answer the two questions every engine asks of an
 * upload -- "is the file I need in here" and "how big is all of this" -- without every engine
 * writing the same loop. It carries no DOM `File`, so a host with no DOM, or a test, can build one.
 */
export interface FileIndex {
  /** Every file, in no guaranteed order. */
  readonly files: readonly IndexedFile[];
  /** The sum of every file's `size`. What an out-of-memory refusal is worth reporting against. */
  readonly totalBytes: number;
  /** One file by exact path, or null. Case-sensitive: `get` answers about what the host indexed. */
  get(path: string): IndexedFile | null;
}

/**
 * Builds a `FileIndex` over files the caller already has.
 *
 * Here rather than in each host so that `files`, `totalBytes` and `get` cannot disagree between one
 * implementation and the next -- and so that a plugin returning a replacement index from
 * `accepts()` builds the same kind of object the host handed it.
 */
export function fileIndex(files: readonly IndexedFile[]): FileIndex {
  const byPath = new Map(files.map((file) => [file.path, file]));
  let totalBytes = 0;
  for (const file of files) totalBytes += file.size;
  return {
    files,
    totalBytes,
    get: (path) => byPath.get(path) ?? null,
  };
}

/** Builds a `FileIndex` over files already in memory. */
export function fileIndexFromBytes(
  files: readonly { readonly path: string; readonly bytes: Uint8Array }[],
): FileIndex {
  return fileIndex(
    files.map(({ path, bytes }) => ({
      path,
      size: bytes.byteLength,
      read: () => Promise.resolve(bytes),
    })),
  );
}

// -- Whether this engine will take the game ------------------------------------------------------

/**
 * An engine's answer to "can you run this".
 *
 * **Each engine judges its own input.** The host knows nothing about which container belongs to
 * which engine, so an engine can be added without editing the host: the host asks each plugin in
 * turn and compares answers.
 */
export interface Acceptance {
  /**
   * How sure the engine is, so a host can choose when two engines both say yes.
   *
   * `"exact"` means the engine read a structure only its own games have -- a container signature, a
   * runner's own header. `"probable"` means it recognised the shape but not the contents, which is
   * the honest answer for "there is an `.exe` here and nothing contradicts me". A host prefers an
   * `"exact"` answer over a `"probable"` one and may refuse to guess between two equal answers.
   */
  readonly confidence: "exact" | "probable";
  /**
   * The file the engine would actually load, by `IndexedFile.path`.
   *
   * The host has uses for this that are not about choosing an engine: it is the natural label for
   * the game in a save browser, and the path whose directory loose assets sit beside.
   */
  readonly entry: string;
  /**
   * A replacement index, when the engine had to unpack something to recognise the game.
   *
   * **Not the path for archives or GameMaker containers.** A conforming host delivers a normalised
   * game -- plain files, every container already opened -- so an engine may assume plain files and
   * need carry no archiver. This exists because the protocol must not enumerate container formats:
   * a future engine whose games arrive wrapped in something only it understands unwraps that here,
   * without the interface changing to name it.
   *
   * Omitted by an engine that can run what it was given. The host passes this index, not the
   * original, to `start()`.
   */
  readonly files?: FileIndex;
  /** What the engine learned about the game while answering, if anything. See `FormatInfo`. */
  readonly format?: FormatInfo;
}

/**
 * What an engine can say about a game it recognised, in a shape no engine's vocabulary is baked
 * into.
 *
 * Deliberately open. The interface cannot enumerate the formats of engines nobody has written yet,
 * and the moment it tried, adding an engine would mean editing the interface -- so `format` is an id
 * the plugin chooses and `facts` is whatever that engine can say about this game in flat scalars. A
 * host stores and groups by these without interpreting them.
 */
export interface FormatInfo {
  /** A short, stable id for the game format, chosen by the engine (`"gm8.1"`, `"gms.bytecode17"`). */
  readonly format: string;
  /** Flat, machine-readable facts: a bytecode revision, a runner version, the game's own name. */
  readonly facts?: Readonly<Record<string, string | number | boolean | null>>;
}

// -- What the host provides ----------------------------------------------------------------------

/**
 * Where the engine draws.
 *
 * **The host passes the canvas in.** An engine that is handed its drawing surface needs no
 * hardcoded DOM id, and no canvas in the document before its module is imported.
 *
 * An `OffscreenCanvas` specifically, because the surface has to be the same thing whether the engine
 * runs in a worker or in the host's own realm; a host with a visible canvas transfers control of it
 * and hands over the result.
 */
export interface Surface {
  /** The canvas to render into. The engine owns its backing-buffer size; the host owns its CSS box. */
  readonly canvas: OffscreenCanvas;
  /**
   * The engine resized the backing buffer -- the game's real resolution.
   *
   * Reported rather than observed: once control of a canvas is transferred, its size changes never
   * touch the element the host is laying out, so the host has no way to see this for itself. It is
   * how the host learns the aspect ratio to letterbox into.
   */
  reportSize(width: number, height: number): void;
  /**
   * The game asked for smooth or crisp upscaling (GML's `texture_set_interpolation`).
   *
   * On the engine's own texture sampling this is invisible at the 1:1 sprite scale most games draw
   * at; what the player actually sees is the host's upscale of the whole surface, and only the host
   * can change that. So the engine reports the intent and the host applies it.
   */
  reportSmoothing(enabled: boolean): void;
}

/** The host's window, as far as a game can affect it. */
export interface WindowServices {
  /** The game set its window caption (GML `window_set_caption`). */
  setTitle(title: string): void;
  /** The game asked to enter or leave fullscreen (GML `window_set_fullscreen`). */
  setFullscreen(enabled: boolean): void;
  /**
   * Whether the host is fullscreen now (GML `window_get_fullscreen`).
   *
   * Synchronous, and it has to be: it answers a GML function call, in the middle of a frame, in an
   * engine that may be in a worker with no way to ask anyone anything without blocking. So this is
   * the host's last reported state, cached on the engine's side of the boundary, not a question
   * asked when it is called. The host is responsible for keeping it current -- the player can leave
   * fullscreen in ways no game ever hears about, Escape above all -- and an engine must not assume
   * that a `setFullscreen` it just requested is reflected here.
   */
  isFullscreen(): boolean;
}

/** Where this plugin's own payload is served from. */
export interface AssetServices {
  /**
   * The base URL of this plugin's directory, with no trailing slash.
   *
   * An engine fetches its own wasm, its runtime and its oversized banks relative to this and never
   * from a path it hardcodes, which is what lets one host serve several versions of the same engine
   * at once and lets a developer point at a local directory. A plugin that needs an asset served
   * from somewhere else entirely declares it in its manifest (see `PluginAsset.url`) rather than
   * guessing a second base from this one.
   */
  readonly base: string;
}

/** What the host wants to hear about while a game runs. */
export interface EventServices {
  /**
   * A real save was written or deleted -- not a temporary file, not a scratch write.
   *
   * The host throttles this into whatever it does about durability (a cloud push, a backup). It is
   * fired at the engine's own choke point for persistence, so an engine that writes through
   * `HostServices.files` need not fire it at all: the filesystem does.
   */
  onSave(): void;
  /**
   * The game ended itself (GML `game_end`).
   *
   * `step()` returning false is the authoritative signal and the one a host must handle; this exists
   * for an engine that reaches the end outside a step -- asynchronously, while the host is not
   * stepping at all -- and a host may therefore see both for one ending. Teardown has to be
   * idempotent either way, which it has to be regardless: a player can close a tab mid-frame.
   */
  onEnded(): void;
  /**
   * The game cannot continue.
   *
   * **A code, never a sentence.** An engine that handed back a localized string would depend on the
   * host's i18n and could not be used by a host that has none. The host owns every word the player
   * reads; the engine owns the fact. `detail` is for a log or a bug report and is never shown as prose.
   */
  onError(code: ErrorCode, detail?: string): void;
}

/**
 * Host-side changes to the running game's filesystem, for an engine that holds a replica of it.
 *
 * The host installs nothing: it calls these when its own side of the filesystem changes, and the
 * engine decides what that means for its copy. Both are needed, because the host writes to this
 * filesystem too -- a file the host was asked to add, a restored cloud save, a file deleted from a save
 * panel -- and an engine that only hears about its own writes would carry on reading a file the
 * player deleted until the game was reloaded.
 */
export interface ReplicaSink {
  /**
   * A file the host put into the filesystem, by `formatPath` path.
   *
   * The bytes are the engine's own copy, made for it: a worker-hosted engine may transfer the
   * buffer rather than copy it again, and the host is still holding an array it can use.
   */
  put(path: string, bytes: Uint8Array): void;
  /** A persisted entry the host removed, by the store key the seed is keyed with. */
  drop(key: string): void;
}

/**
 * The host's end of a filesystem an engine cannot reach synchronously.
 *
 * **Why a replica.** GML's file calls are synchronous and an engine in a worker cannot await the
 * host, so an engine holds a complete in-memory replica of this game's persisted entries, seeded
 * before it starts, and mirrors every write back.
 *
 * **Keys, not paths, and that is the point.** What is mirrored is the *store*, not the file set:
 * a deletion that has to shadow a read-only bundle file, and a directory that exists while empty,
 * are entries in it that no path-and-bytes vocabulary can express. So the unit is the host's own
 * opaque store key, the engine treats it as opaque, and the replica is therefore complete rather
 * than nearly complete -- which is what lets an engine answer `file_exists` out of it and be right.
 *
 * Scoped to the one game the session is for: a host hands out no key-level access to anything else.
 */
export interface ReplicaServices {
  /**
   * Every persisted entry for this game, to seed the replica with.
   *
   * Read when the engine asks, not when the host built this: a host may have pulled a cloud save
   * between the two, and an engine seeded from the earlier answer would overwrite it on first save.
   */
  seed(): Record<string, string>;
  /** The replica changed at `key`. Write it through to whatever the host really persists into. */
  set(key: string, value: string): void;
  /** The replica dropped `key`. */
  remove(key: string): void;
  /**
   * A real save landed.
   *
   * Its own call rather than an inference from `set`, because one save is routinely several entries
   * and a host that counted writes would report five saves for a game writing five files. The host
   * may hear about one save twice and must be idempotent; see `EventServices.onSave`.
   */
  save(): void;
  /**
   * Where the host's own changes to this filesystem should go. Called once, by the engine, as early
   * as it has somewhere to put them.
   */
  watch(sink: ReplicaSink): void;
}

/**
 * Everything an engine may assume about its host. Nothing engine-specific crosses this.
 *
 * Handed to `create()` once, before the game is parsed, and valid until `dispose()`.
 */
export interface HostServices {
  /** Where to draw, and the two things only the host can act on. */
  readonly surface: Surface;
  /**
   * The session's game id: what the store keys of this game's persisted files carry (see
   * `ReplicaServices`). Never contains ":".
   */
  readonly game: string;
  /**
   * The game's persisted files, for an engine to keep its own filesystem over. See
   * `ReplicaServices`.
   *
   * Present whether or not an engine uses it, because whether it does is a fact about where the
   * engine runs rather than about the host -- and a host that offered it only sometimes would make
   * "can this engine run here" depend on something the manifest does not say.
   */
  readonly replica: ReplicaServices;
  /** Blocking GML dialogs: `show_message`, `show_question`, `get_string` and friends. */
  readonly dialogs: {
    /** Resolves with what the player chose; see `DialogResult` for the dismissal sentinel. */
    show(request: DialogRequest): Promise<DialogResult>;
  };
  readonly window: WindowServices;
  readonly assets: AssetServices;
  /**
   * The current value of every setting this engine declared, by `SettingDescriptor.key`.
   *
   * A snapshot, replaced wholesale by nothing: later changes arrive through `setSetting`. Values the
   * engine did not declare may be present and must be ignored; values it declared are guaranteed
   * present, because the host resolves defaults from the descriptors before create.
   */
  readonly settings: Readonly<Record<string, SettingValue>>;
  readonly events: EventServices;
  /**
   * The arguments the game was launched with, after the program itself: what GML's
   * `parameter_count` and `parameter_string(1..)` report. Empty is normal.
   */
  readonly launchArgs: readonly string[];
  /** Loopback TCP the host answers. See `NetworkServices`. */
  readonly network: NetworkServices;
}

/**
 * TCP on loopback, answered by the host.
 *
 * A game's own networking -- an extension DLL's sockets, GameMaker Studio's `network_*` -- is how
 * it talks to something running beside it, and on a real machine that something listens on
 * `127.0.0.1`. Here the host is that something: an engine routes a connection to one of `ports`
 * to the host, and fails one to anywhere else the way a machine with nothing listening would.
 * What the bytes mean is no business of the engine's.
 *
 * Never blocking, in either direction: a game can stall on a socket, and a host across a worker
 * boundary must not be able to stall it further.
 */
export interface NetworkServices {
  /** The loopback ports the host answers, fixed before the game starts. Empty is normal. */
  readonly ports: readonly number[];
  /** Opens a connection to one of `ports`, or null for any other port. Connected at once. */
  connect(port: number): NetworkConnection | null;
}

/** One open loopback connection. See `NetworkServices`. */
export interface NetworkConnection {
  /** Bytes for the host, in order. Fire-and-forget. */
  send(bytes: Uint8Array): void;
  /** Every byte the host sent since the last call, in order; empty when none. */
  receive(): Uint8Array;
  /** Whether either side has closed it. Bytes already received can still be read. */
  readonly closed: boolean;
  /** Closes it from the game's side. Safe twice. */
  close(): void;
}

// -- Engine-declared settings --------------------------------------------------------------------

/** Everything a setting's value may be. */
export type SettingValue = string | number | boolean;

/**
 * One knob an engine declares, so that the host can offer it without knowing what it means.
 *
 * **Engine-declared, not host-defined.** A settings object owned by the host would be the union of
 * every engine's knobs and would widen with each new engine. Here the host renders what the engine
 * declares and stores what the player picked.
 *
 * **No prose.** A descriptor carries no label and no description, for the same reason an error is a
 * code: the host owns the words the player reads, in the host's own language. A host titles a
 * setting from its own catalogue, keyed by engine id and setting key, and shows nothing for a key it
 * has no entry for -- which also keeps an engine from shipping English into a Chinese UI.
 */
export type SettingDescriptor =
  /** A toggle. */
  | {
      readonly kind: "flag";
      readonly key: string;
      readonly default: boolean;
    }
  /** A number, with the bounds the host should enforce before the engine has to. */
  | {
      readonly kind: "number";
      readonly key: string;
      readonly default: number;
      readonly min?: number;
      readonly max?: number;
      /** The granularity the host should offer. Omitted means "any value in range". */
      readonly step?: number;
      /**
       * What the number counts, so a host can format it without knowing what it is for.
       *
       * The host shows bytes as bytes and hertz as hertz; nothing here says what the quantity
       * means. An unrecognised unit is formatted as a bare number.
       */
      readonly unit?: "bytes" | "seconds" | "hertz" | "count";
    }
  /** One of a fixed set of values. The members are ids, not labels: the host translates them. */
  | {
      readonly kind: "choice";
      readonly key: string;
      readonly default: string;
      readonly values: readonly string[];
    };

/**
 * What an engine can do, beyond running a game.
 *
 * Read by the host from the manifest before anything is loaded, and declared again on the plugin
 * object so the two can be checked against each other.
 */
export interface EngineCapabilities {
  /** Every knob this engine declares. Empty is normal. */
  readonly settings: readonly SettingDescriptor[];
  /** Whose timing decides when a frame is due (SPEC §8.1). Absent means the host's. */
  readonly clock?: "host" | "engine";
}

// -- Errors --------------------------------------------------------------------------------------

/**
 * Why a game could not be loaded or could not continue.
 *
 * A closed set, deliberately small, and every member is a distinction a host would actually act on
 * differently -- a code the host can only turn into "something went wrong" earns nothing over
 * `"internal"`.
 *
 * **A host must treat an unrecognised code as `"internal"`.** That rule is what makes this list
 * extensible without a contract bump: a later engine may report a code this host has never heard
 * of, and the honest outcome is the generic failure, not a crash in the host's own switch.
 */
export type ErrorCode =
  /**
   * The engine recognised the game but cannot run it -- a bytecode revision it does not implement,
   * a feature it never had. Distinct from `accepts()` returning null, which means "not mine at all"
   * and is not an error.
   */
  | "unsupported-game"
  /** The game is the right kind of file and is damaged: truncated, mis-packed, failed its own checks. */
  | "corrupt-game"
  /**
   * There was not enough memory.
   *
   * Its own code because it is the one failure whose cause the player can act on -- a 2GB game in a
   * tab that allows less -- and because a host can say something useful about it instead of a
   * generic apology.
   */
  | "out-of-memory"
  /**
   * A payload asset could not be fetched: the engine's runtime, a bank, a module served from
   * elsewhere. A network fact, not a fact about the game, so a host may reasonably offer a retry.
   */
  | "asset-unavailable"
  /**
   * The host cannot run this engine: no WebGL2, no cross-origin isolation, no `OffscreenCanvas`.
   * Reported rather than assumed, because the engine is the only side that knows what it needs.
   */
  | "unsupported-environment"
  /** A bug. Anything the engine cannot attribute to the game, the host or the network. */
  | "internal";

/**
 * An error carrying an `ErrorCode`, as plain data.
 *
 * **Identified by a field, not by `instanceof`.** A plugin bundles its own copy of this package, so
 * the `EngineError` an engine throws is a different class from the one the host imported even when
 * both are this exact source -- and once the engine is in a worker the error crosses as a structured
 * clone and has no class at all. So the brand is a property, and `errorCodeOf` is how a host reads
 * one.
 */
export interface EngineErrorData {
  /** The brand. Always true; its presence is what identifies the shape. */
  readonly engineError: true;
  readonly code: ErrorCode;
  /** Context for a log or a bug report. Never shown to a player as prose. */
  readonly detail?: string;
}

/** A throwable `EngineErrorData`. Convenience: nothing requires an engine to use this class. */
export class EngineError extends Error implements EngineErrorData {
  readonly engineError = true as const;
  readonly code: ErrorCode;
  readonly detail?: string;

  constructor(code: ErrorCode, detail?: string, options?: { cause?: unknown }) {
    super(detail === undefined ? code : `${code}: ${detail}`, options);
    this.name = "EngineError";
    this.code = code;
    this.detail = detail;
  }
}

/**
 * The code to report for anything that was thrown, including values that are not errors at all.
 *
 * What a host calls in a `catch`. Anything unrecognised -- a `TypeError` from inside an engine, a
 * string, a code from a newer contract -- is `"internal"`, which is the only honest answer: the host
 * knows something failed and knows nothing else about it.
 */
export function errorCodeOf(error: unknown): ErrorCode {
  if (typeof error !== "object" || error === null) return "internal";
  const candidate = error as { engineError?: unknown; code?: unknown };
  if (candidate.engineError !== true) return "internal";
  return isErrorCode(candidate.code) ? candidate.code : "internal";
}

const ERROR_CODES: readonly string[] = [
  "unsupported-game",
  "corrupt-game",
  "out-of-memory",
  "asset-unavailable",
  "unsupported-environment",
  "internal",
];

/** Whether this is a code from *this* contract revision. See `ErrorCode` on unrecognised ones. */
export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === "string" && ERROR_CODES.includes(value);
}

// -- Input ---------------------------------------------------------------------------------------

/** Which mouse button, in the browser's own numbering. */
export type PointerButton = "left" | "middle" | "right";

/**
 * One input event, pushed to the engine by the host.
 *
 * **The host owns every listener.** Engines that each registered their own DOM listeners would each
 * carry a copy of the same work, and copies drift: one without auto-repeat suppression fires
 * "pressed" at the keyboard's repeat rate, one without release-on-blur holds a key down forever if
 * it was let go while a dialog had focus. One normalizing implementation in the host gets both right
 * for every engine, and is also what makes a headless host possible.
 *
 * Named `GameInput` rather than `InputEvent` because the DOM already has an `InputEvent` and this
 * package is compiled with the DOM in its lib: a consumer should never have to wonder which one it
 * imported.
 */
export type GameInput =
  /**
   * A key went down. `code` is a `KeyboardEvent.code` value (`"ArrowLeft"`, `"KeyZ"`).
   *
   * **Never an auto-repeat.** The host drops those: GameMaker derives "pressed this frame" from an
   * edge on the held state, so a repeat would read as a fresh press and fire a once-per-press action
   * at the repeat rate. A host that wants to force a press on an already-held key -- an on-screen
   * control, a test -- sends one of these, which is exactly what that means.
   */
  | { readonly kind: "key-down"; readonly code: string }
  | { readonly kind: "key-up"; readonly code: string }
  /**
   * The pointer moved, in **game pixels**, already mapped out of the letterbox.
   *
   * The host maps it because the host is the side that knows the surface's layout: its CSS box, its
   * device pixel ratio, and the bars around a game whose aspect ratio does not match the window. An
   * engine that mapped this itself would need the DOM.
   */
  | { readonly kind: "pointer-move"; readonly x: number; readonly y: number }
  | {
      readonly kind: "pointer-down";
      readonly button: PointerButton;
      readonly x: number;
      readonly y: number;
    }
  | { readonly kind: "pointer-up"; readonly button: PointerButton }
  /** A scroll. Only the sign is meaningful to GameMaker, which has wheel-up and wheel-down keys. */
  | { readonly kind: "wheel"; readonly delta: number }
  /**
   * The host lost input focus, so everything held must be let go.
   *
   * Its own event rather than a flurry of `key-up`s: the host does not reliably know what is still
   * held at that point -- that is the whole problem, since the releases went somewhere else -- and
   * the engine does.
   */
  | { readonly kind: "focus-lost" };

// -- The session ---------------------------------------------------------------------------------

/** What the host learns once the game is running. */
export interface GameInfo {
  /** The game's own resolution, in pixels. Also reported through `Surface.reportSize`. */
  readonly width: number;
  readonly height: number;
  /** The game's window caption, when it has one before the first frame. */
  readonly title?: string;
}

/**
 * One game, from started to disposed.
 *
 * The lifecycle is `start` -> many `step`s -> `dispose`. The game arrives exactly as it will run:
 * anything a host wants changed about it, it changes in the files before calling `start`.
 */
export interface EngineSession {
  /**
   * Load the game and be ready to run.
   *
   * Rejects with an `EngineErrorData` when the game cannot be loaded. `accepts()` having said yes is
   * not a promise that this succeeds: the cheap check is allowed to be wrong, and a damaged game
   * fails here.
   */
  start(files: FileIndex): Promise<GameInfo>;
  /**
   * Run one frame. `false` means the game ended itself.
   *
   * **It may return a promise, and it resolves only when the frame is really over.** This single
   * change is what makes blocking GML dialogs one mechanism instead of two. A game that calls
   * `show_message` stops in the middle of a frame and cannot continue until an answer comes back.
   * How an engine suspends -- a stack-unwinding pass over its own wasm, a blocked worker thread, a
   * coroutine -- stays its own business; a host loop never drives the resumption.
   * Here the engine awaits `HostServices.dialogs.show` however it likes and the host's loop knows
   * only that this frame has not finished.
   *
   * `now` is a monotonic timestamp in milliseconds, in the host's own timebase, and is the engine's
   * only clock -- so a host can run a game faster than real time, or deterministically, without the
   * engine participating.
   *
   * May be called again only after the previous call has settled.
   */
  step(now: number): Promise<boolean> | boolean;
  /**
   * Deliver one input event. See `GameInput`.
   *
   * Synchronous and non-blocking: queued by the engine and taken into account from the next frame.
   * A host may send input between frames and while a frame is pending.
   */
  sendInput(input: GameInput): void;
  /**
   * The player changed one of this engine's declared settings.
   *
   * An engine must ignore a key it did not declare and clamp a value outside its own bounds rather
   * than fail: the host may be older or newer than the engine, and a setting is never worth losing a
   * game over.
   */
  setSetting(key: string, value: SettingValue): void;
  /**
   * Whatever this engine wants to say about itself -- cache occupancy, timings, counters.
   *
   * Opaque to the host by design: it is shown in a debug panel, logged in a bug report, and never
   * branched on. That is what keeps a diagnostic from quietly becoming part of the contract.
   */
  stats?(): Record<string, unknown>;
  /**
   * Release everything this session holds, promptly.
   *
   * Promptly is the point: audio above all, which otherwise keeps playing under the next game until
   * a garbage collector gets round to it. Must be safe to call after an error, after `step` returned
   * false, and twice.
   */
  dispose(): void;
}

/**
 * An engine, as a host finds it: the default export of a plugin's entry module.
 *
 * The object is cheap to obtain and must not touch the DOM, fetch a payload or allocate a heap when
 * it is imported: a host may load several plugins only to ask each whether it recognises a game, and
 * then load none of them.
 */
export interface EnginePlugin {
  /**
   * This engine's id, matching its manifest and the directory it is served from.
   *
   * A host uses it to key settings, debug output and bug reports, and it is the only name of an
   * engine anywhere in a host's code -- as data read from a manifest, never as an identifier.
   */
  readonly id: string;
  /** The contract revision this engine implements. See `API_VERSION` and the compatibility rule. */
  readonly apiVersion: number;
  readonly capabilities: EngineCapabilities;
  /** Whether this engine will take the game, and what it learned. See `Acceptance`. */
  accepts(files: FileIndex): Promise<Acceptance | null>;
  /**
   * Make a session. Rejects with an `EngineErrorData` when the engine cannot run here at all --
   * `"unsupported-environment"`, or `"asset-unavailable"` if its own payload will not load.
   */
  create(host: HostServices): Promise<EngineSession>;
}
