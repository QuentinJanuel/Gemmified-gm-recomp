/**
 * The transport: a port, and the envelope that makes a port carry requests as well as events.
 *
 * **One abstraction, used identically by both ends.** `openWire` is symmetric -- the host calls it
 * on a `Worker` or a `MessagePort`, the engine calls it on its own worker scope, and neither has a
 * privileged side. That is not elegance for its own sake: it means an engine that has to be moved
 * back onto the host's own thread, because it cannot hold its frame rate in a worker, is a
 * `MessageChannel` instead of a `Worker` and nothing else changes. The escape hatch costs no second
 * implementation of anything.
 *
 * **Why a request/reply layer at all.** Three of the lifecycle's steps have answers -- parsing hands
 * back the game's code, building hands back its resolution, a frame hands back whether the game is
 * still running -- and a protocol of bare events would make each caller invent its own correlation,
 * differently. So an envelope carries an id, and `request` returns a promise. Everything with no
 * answer stays a plain note, because most of the traffic (input, a frame's worth of audio commands)
 * is one-way and must not pay for bookkeeping it does not need.
 *
 * Nothing here knows what the messages mean; see `./index` for the protocol itself.
 */

import type { EngineErrorData } from "../engine";
import { EngineError, errorCodeOf } from "../engine";

/**
 * What `openWire` can run on.
 *
 * Structural rather than a union of DOM types, because the three things that satisfy it are not
 * related by inheritance in a useful way -- a `Worker`, a `MessagePort`, and the
 * `DedicatedWorkerGlobalScope` an engine sees as `self` -- and because a test wants to satisfy it
 * with twenty lines of its own.
 */
export interface WirePort {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  removeEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  /**
   * A `MessagePort` delivers nothing until this is called, and only when listeners were attached
   * with `addEventListener` rather than `onmessage`. A `Worker` has no such method, which is why
   * this is optional and why `openWire` calls it if it is there.
   */
  start?(): void;
  close?(): void;
}

/**
 * The envelope every message travels in.
 *
 * Short field names because this is the one object on the hot path: a frame's worth of audio
 * commands and input events all carry one.
 */
export type Envelope =
  /** No answer wanted. */
  | { readonly w: "note"; readonly body: unknown }
  /** An answer is wanted, under this id. */
  | { readonly w: "req"; readonly id: number; readonly body: unknown }
  /** The answer. */
  | { readonly w: "ok"; readonly id: number; readonly body: unknown }
  /** The request threw. `error` is plain data, never an `Error` instance -- see `EngineErrorData`. */
  | { readonly w: "err"; readonly id: number; readonly error: EngineErrorData };

/** What one end of a wire can do. */
export interface Wire<Out, In> {
  /** Send something that wants no answer. */
  notify(message: Out, transfer?: Transferable[]): void;
  /**
   * Send something that does, and wait for it.
   *
   * Rejects with an `EngineError` carrying the far end's code if the far end threw, and with
   * `"internal"` if the wire is closed while the request is outstanding -- which is what a crashed
   * worker looks like from here, and is the one failure a caller is most likely to forget.
   */
  request<R>(message: Out, transfer?: Transferable[]): Promise<R>;
  /** Stop listening, reject everything outstanding, and close the port if it can be closed. */
  close(): void;
  /** The messages this end has been handed, for a caller that wants to read them as a stream. */
  readonly incoming: AsyncIterable<In>;
}

/** How a wire answers what arrives. */
export interface WireHandlers<In> {
  /** A note arrived. */
  onNote?(message: In): void;
  /**
   * A request arrived; resolve with its answer.
   *
   * A rejection is sent back as an error with the thrown value's code, so the far end's `request`
   * rejects rather than hanging. A request arriving with no handler at all is answered with
   * `"internal"` for the same reason: silence is the one outcome a caller cannot recover from.
   */
  onRequest?(message: In): Promise<unknown> | unknown;
}

/**
 * Opens a wire on a port.
 *
 * Both ends call this. The generic parameters are what each end sends and expects to receive, which
 * is the only asymmetry between a host and an engine at this layer.
 */
export function openWire<Out, In>(port: WirePort, handlers: WireHandlers<In> = {}): Wire<Out, In> {
  let nextId = 1;
  let closed = false;
  const pending = new Map<
    number,
    { resolve(value: unknown): void; reject(error: unknown): void }
  >();
  const queue: In[] = [];
  let waiting: ((value: IteratorResult<In>) => void) | null = null;

  const deliver = (message: In): void => {
    if (waiting) {
      const resume = waiting;
      waiting = null;
      resume({ value: message, done: false });
      return;
    }
    queue.push(message);
  };

  const listener = (event: { data: unknown }): void => {
    const envelope = event.data as Envelope | undefined;
    // Anything that is not one of ours is ignored rather than thrown on: a port may be shared with
    // another protocol (a bundler's hot-reload channel, a test harness), and crashing on a stranger's
    // message would make this layer impossible to embed.
    if (typeof envelope !== "object" || envelope === null || !("w" in envelope)) return;

    switch (envelope.w) {
      case "note":
        handlers.onNote?.(envelope.body as In);
        deliver(envelope.body as In);
        return;
      case "req": {
        const { id } = envelope;
        void (async () => {
          try {
            if (!handlers.onRequest) throw new EngineError("internal", "no request handler");
            const body = await handlers.onRequest(envelope.body as In);
            port.postMessage({ w: "ok", id, body } satisfies Envelope);
          } catch (error) {
            const data: EngineErrorData = {
              engineError: true,
              code: errorCodeOf(error),
              detail: detailOf(error),
            };
            port.postMessage({ w: "err", id, error: data } satisfies Envelope);
          }
        })();
        return;
      }
      case "ok": {
        const entry = pending.get(envelope.id);
        pending.delete(envelope.id);
        entry?.resolve(envelope.body);
        return;
      }
      case "err": {
        const entry = pending.get(envelope.id);
        pending.delete(envelope.id);
        entry?.reject(new EngineError(envelope.error.code, envelope.error.detail));
        return;
      }
    }
  };

  port.addEventListener("message", listener);
  port.start?.();

  return {
    notify(message, transfer) {
      if (closed) return; // A note into a closed wire is not worth an exception; see `close`.
      port.postMessage({ w: "note", body: message } satisfies Envelope, transfer);
    },
    request<R>(message: Out, transfer?: Transferable[]): Promise<R> {
      if (closed) {
        return Promise.reject(new EngineError("internal", "the wire is closed"));
      }
      const id = nextId++;
      return new Promise<R>((resolve, reject) => {
        pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
        port.postMessage({ w: "req", id, body: message } satisfies Envelope, transfer);
      });
    },
    close() {
      if (closed) return;
      closed = true;
      port.removeEventListener("message", listener);
      // Everything outstanding is rejected rather than left to hang: a request whose answer can no
      // longer arrive is the shape a terminated worker takes, and a promise that never settles is
      // indistinguishable from a game that is merely slow.
      for (const [, entry] of pending) {
        entry.reject(new EngineError("internal", "the wire closed before the reply arrived"));
      }
      pending.clear();
      waiting?.({ value: undefined, done: true });
      waiting = null;
      port.close?.();
    },
    incoming: {
      [Symbol.asyncIterator](): AsyncIterator<In> {
        return {
          next(): Promise<IteratorResult<In>> {
            const next = queue.shift();
            if (next !== undefined) return Promise.resolve({ value: next, done: false });
            if (closed) return Promise.resolve({ value: undefined, done: true });
            return new Promise((resolve) => {
              waiting = resolve;
            });
          },
        };
      },
    },
  };
}

/** A line for a log, out of whatever was thrown. Never shown to a player; see `ErrorCode`. */
function detailOf(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const candidate = error as { detail?: unknown; message?: unknown };
  if (typeof candidate.detail === "string") return candidate.detail;
  if (typeof candidate.message === "string") return candidate.message;
  return undefined;
}
