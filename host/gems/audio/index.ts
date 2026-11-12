/**
 * The host's audio device, driven by an engine that cannot reach one.
 *
 * **Why this exists at all.** Web Audio is main-thread only: there is no `AudioContext` in a worker.
 * Every engine here ends up in a worker, so no engine can own the device that makes its sound. Each
 * one instead keeps its own bookkeeping -- the node graph, the clock, every synchronous getter its
 * own code reads back -- and sends only the operations that actually produce sound, as
 * `AudioCommand`s. This module is the other end: it replays them against a real context, on the
 * thread that has one.
 *
 * **One executor, not one per engine.** Every worker-hosted engine needs the same thing, and one
 * implementation gives one behaviour for `start` on an already-started node and for a node type
 * nobody implemented.
 *
 * **The host passes the context in.** This module never constructs an `AudioContext` and never
 * reads one off a global; it is handed one, like the surface. No module here touches a DOM global
 * without being given it. A host can then control the volume of everything by patching its
 * context's `destination` getter, so everything that reaches the speakers passes through one gain,
 * and an executor handed the host's context is inside that patch by construction.
 */

import type { AudioCommand } from "../wire";

/**
 * Node ids the protocol reserves. Everything else is the engine's own numbering, opaque here.
 *
 * `0` is the device's output and `-1` its listener; neither is ever created, which is why `create`
 * is free to use any other id without asking.
 */
export const AUDIO_DESTINATION = 0;
export const AUDIO_LISTENER = -1;

/** Why a command did nothing. A code, never a sentence -- see `ErrorCode`'s reasoning. */
export type AudioUnsupported =
  /** `create` named a node type this executor does not build. */
  | "node-type"
  /** A command addressed an id that was never created, or was deleted. */
  | "unknown-node"
  /** `param` named something that is not an `AudioParam` on that node. */
  | "unknown-param"
  /** The browser rejected it: a read-only property, a node used out of order. */
  | "rejected";

export interface AudioExecutorOptions {
  /**
   * The host's own context.
   *
   * Host-owned, and that ownership is the point: a host's master-volume patch lives on it, the
   * title screen's sounds may share it, and a browser only starts one from a user gesture the host
   * is the one to see. See `dispose`, which deliberately does not close it.
   */
  readonly context: AudioContext;
  /**
   * A source node finished. The host forwards this as `audio-ended` so the engine's own bookkeeping
   * can catch up, since the engine has no way to observe it.
   */
  readonly onEnded?: (id: number) => void;
  /** A command that did nothing, and why. Diagnostics; nothing here is fatal. */
  readonly onUnsupported?: (reason: AudioUnsupported, command: AudioCommand) => void;
}

export interface AudioExecutor {
  /** Replay one command. Never throws: see `execute`. */
  execute(command: AudioCommand): void;
  /** Replay a frame's worth, in order. */
  executeAll(commands: readonly AudioCommand[]): void;
  /** Start the device. Browsers require a gesture, which only the host sees. */
  resume(): void;
  /** Drop every node and buffer this executor made. Does **not** close the host's context. */
  dispose(): void;
}

/** The node types an engine may ask for, and how to build each one. */
const CREATORS: Record<string, (ctx: AudioContext, args: readonly unknown[]) => AudioNode> = {
  gain: (ctx) => ctx.createGain(),
  stereoPanner: (ctx) => ctx.createStereoPanner(),
  panner: (ctx) => ctx.createPanner(),
  bufferSource: (ctx) => ctx.createBufferSource(),
  biquadFilter: (ctx) => ctx.createBiquadFilter(),
  dynamicsCompressor: (ctx) => ctx.createDynamicsCompressor(),
  // The one creator that reads an argument. A missing or non-numeric maxDelayTime falls back to the
  // Web Audio default rather than throwing, because a command that is nearly right should still
  // make a sound.
  delay: (ctx, args) => ctx.createDelay(typeof args[0] === "number" ? args[0] : 1),
  oscillator: (ctx) => ctx.createOscillator(),
  convolver: (ctx) => ctx.createConvolver(),
};

/**
 * Builds the executor.
 *
 * **No command is ever allowed to throw out of here.** One frame's audio is a stream of operations
 * against state the engine believes in and this side merely mirrors, and the two can legitimately
 * disagree: `start` on a node the browser has already stopped throws, `disconnect` on a node
 * already disconnected throws, assigning a read-only property throws. None of those is worth
 * failing a frame over -- the sound is wrong at worst, the game keeps running -- and an exception
 * escaping into the host's message handler would take the whole session down. So everything is
 * guarded, and what was skipped is reported through `onUnsupported` instead.
 */
export function createAudioExecutor(options: AudioExecutorOptions): AudioExecutor {
  const { context, onEnded, onUnsupported } = options;

  /** Only what `create` made. The reserved ids are resolved on demand; see `nodeOf`. */
  const nodes = new Map<number, AudioNode>();
  const buffers = new Map<number, AudioBuffer>();

  /**
   * Resolves an id to a node.
   *
   * `AUDIO_DESTINATION` is read from the context **every time rather than cached**, and that is
   * deliberate. The host's master-volume control replaces `destination` with a gain of its own by
   * patching the getter, and the patch may be installed after this executor was built -- a host
   * that creates its context early, a second realm that installs its own patch on import. Reading
   * through the getter each time means the executor is inside whatever the host has arranged by the
   * time a game actually connects something, instead of holding a reference captured before it.
   * The spec guarantees repeated reads return the same node, so this costs nothing.
   */
  const nodeOf = (id: number): AudioNode | undefined =>
    id === AUDIO_DESTINATION ? context.destination : nodes.get(id);

  /**
   * One `AudioParam` by node and name, or which half of the lookup failed.
   *
   * Checked by shape rather than by `instanceof`: nothing crossing this boundary may rely on class
   * identity, and a plain property that happens to be named like a param is not one.
   */
  const paramOf = (id: number, name: string): AudioParam | "no-node" | "no-param" => {
    const params = paramsOf(id);
    if (!params) return "no-node";
    const param = params[name] as AudioParam | undefined;
    if (!param || typeof param !== "object" || !("value" in param)) return "no-param";
    return param;
  };

  /** `param` addresses either a node's params or the context listener's. */
  const paramsOf = (id: number): Record<string, unknown> | undefined =>
    id === AUDIO_LISTENER
      ? (context.listener as unknown as Record<string, unknown>)
      : (nodeOf(id) as unknown as Record<string, unknown> | undefined);

  const execute = (command: AudioCommand): void => {
    switch (command.op) {
      case "create": {
        const create = CREATORS[command.type];
        if (!create) {
          onUnsupported?.("node-type", command);
          return;
        }
        try {
          nodes.set(command.id, create(context, command.args));
        } catch {
          onUnsupported?.("rejected", command);
        }
        return;
      }

      case "connect": {
        const from = nodeOf(command.id);
        const to = nodeOf(command.target);
        if (!from || !to) {
          onUnsupported?.("unknown-node", command);
          return;
        }
        try {
          from.connect(to);
        } catch {
          onUnsupported?.("rejected", command);
        }
        return;
      }

      case "disconnect": {
        const node = nodeOf(command.id);
        if (!node) {
          onUnsupported?.("unknown-node", command);
          return;
        }
        try {
          node.disconnect();
        } catch {
          // Already disconnected. Routine rather than exceptional: an engine tearing down a voice
          // does not track whether the browser got there first.
        }
        return;
      }

      case "start": {
        const node = nodeOf(command.id) as AudioBufferSourceNode | undefined;
        if (!node) {
          onUnsupported?.("unknown-node", command);
          return;
        }
        try {
          // The buffer-source overload, so `offset` is accepted; an oscillator ignores it.
          node.start(command.when, command.offset);
        } catch {
          // Already started, or already stopped. A source node is single-use in Web Audio and an
          // engine replaying its own graph will hit this.
        }
        return;
      }

      case "stop": {
        const node = nodeOf(command.id) as AudioScheduledSourceNode | undefined;
        if (!node) {
          onUnsupported?.("unknown-node", command);
          return;
        }
        try {
          node.stop();
        } catch {
          // Never started, or stopped twice.
        }
        return;
      }

      case "param": {
        const param = paramOf(command.id, command.param);
        if (param === "no-node" || param === "no-param") {
          onUnsupported?.(param === "no-node" ? "unknown-node" : "unknown-param", command);
          return;
        }
        try {
          param.value = command.value;
        } catch {
          onUnsupported?.("rejected", command);
        }
        return;
      }

      case "ramp": {
        const param = paramOf(command.id, command.param);
        if (param === "no-node" || param === "no-param") {
          onUnsupported?.(param === "no-node" ? "unknown-node" : "unknown-param", command);
          return;
        }
        try {
          const now = context.currentTime;
          // Anchored at where the value actually is, which is what makes a fade started during
          // another fade continue rather than jump: `linearRampToValueAtTime` interpolates from the
          // previous event on the timeline, and without an anchor there may not be one.
          param.cancelScheduledValues(now);
          param.setValueAtTime(param.value, now);
          if (command.seconds > 0) {
            param.linearRampToValueAtTime(command.value, now + command.seconds);
          } else {
            param.value = command.value;
          }
        } catch {
          onUnsupported?.("rejected", command);
        }
        return;
      }

      case "cancelRamp": {
        const param = paramOf(command.id, command.param);
        if (param === "no-node" || param === "no-param") {
          onUnsupported?.(param === "no-node" ? "unknown-node" : "unknown-param", command);
          return;
        }
        try {
          // Pinned where it is as well as cancelled: cancelling alone leaves the value wherever the
          // last event put it, which for a half-finished ramp is not where the sound currently is.
          const now = context.currentTime;
          const held = param.value;
          param.cancelScheduledValues(now);
          param.setValueAtTime(held, now);
        } catch {
          onUnsupported?.("rejected", command);
        }
        return;
      }

      case "deleteNode": {
        const node = nodes.get(command.id);
        // An engine tearing down a node the executor never built, or has already forgotten, is
        // saying something true; there is nothing to report.
        if (node) {
          try {
            node.disconnect();
          } catch {
            // Already disconnected.
          }
          nodes.delete(command.id);
        }
        return;
      }

      case "prop": {
        const node = nodeOf(command.id) as unknown as Record<string, unknown> | undefined;
        if (!node) {
          onUnsupported?.("unknown-node", command);
          return;
        }
        try {
          node[command.prop] = command.value;
        } catch {
          // Read-only, or a property this browser does not have.
          onUnsupported?.("rejected", command);
        }
        return;
      }

      case "createBuffer": {
        try {
          buffers.set(
            command.id,
            context.createBuffer(command.channels, command.frames, command.rate),
          );
        } catch {
          // A zero-length or absurd buffer. Reported rather than thrown; the voice stays silent.
          onUnsupported?.("rejected", command);
        }
        return;
      }

      case "bufferData": {
        const buffer = buffers.get(command.id);
        if (!buffer) {
          onUnsupported?.("unknown-node", command);
          return;
        }
        try {
          // Copied here and now, never retained: the data may be a view straight into an engine's
          // own memory, which the next thing it allocates can move out from under us.
          buffer.copyToChannel(
            command.data as Float32Array<ArrayBuffer>,
            command.ch,
            command.start ?? 0,
          );
        } catch {
          onUnsupported?.("rejected", command);
        }
        return;
      }

      case "setBuffer": {
        const node = nodeOf(command.id) as AudioBufferSourceNode | undefined;
        const buffer = buffers.get(command.bufferId);
        if (!node || !buffer) {
          onUnsupported?.("unknown-node", command);
          return;
        }
        try {
          node.buffer = buffer;
        } catch {
          // Setting a buffer twice on one source throws.
          onUnsupported?.("rejected", command);
        }
        return;
      }

      case "deleteBuffer": {
        buffers.delete(command.id);
        return;
      }

      case "onended": {
        const node = nodeOf(command.id);
        if (!node) {
          onUnsupported?.("unknown-node", command);
          return;
        }
        const id = command.id;
        (node as AudioScheduledSourceNode).onended = () => onEnded?.(id);
        return;
      }

      case "resume": {
        void context.resume().catch(() => {
          // A context the browser will not start without a gesture. The host retries on the next
          // one; nothing here can do better.
        });
        return;
      }

      case "suspend": {
        void context.suspend().catch(() => {});
        return;
      }
    }
  };

  return {
    execute,

    executeAll(commands) {
      for (const command of commands) execute(command);
    },

    resume() {
      void context.resume().catch(() => {});
    },

    dispose() {
      // Disconnected rather than closed, and the distinction matters: the context belongs to the
      // host. It may be the same one the host's own UI sounds use, and it outlives any single game.
      // Closing it would silence the whole host.
      for (const node of nodes.values()) {
        try {
          node.disconnect();
        } catch {
          // Already gone.
        }
      }
      nodes.clear();
      buffers.clear();
    },
  };
}
