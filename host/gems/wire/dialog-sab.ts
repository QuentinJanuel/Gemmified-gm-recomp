/**
 * The one piece of shared memory in the whole arrangement, and the rules that keep it defensible.
 *
 * A blocking GML dialog is synchronous: `show_question` stops the game mid-frame and returns the
 * answer inline. An engine in a worker can honour that literally -- block the worker thread while
 * the host, on another thread, renders a dialog and waits for a click -- but only through
 * `SharedArrayBuffer` and `Atomics.wait`, because a blocked thread cannot process its own message
 * queue, so the answer cannot arrive as a message.
 *
 * **It stays a fixed scalar handshake, deliberately.** Sharing memory with an engine is the weakest
 * point in the claim that engine and host are separate programs, and what keeps the claim honest is
 * *what* is shared: three integers and one UTF-8 string, at fixed offsets, in one direction, read
 * once. That is shared-memory IPC, which is still IPC -- two processes on a pipe would be no
 * different in kind. The moment a structured payload goes through here it becomes two programs
 * reading each other's data structures, which is the thing the FSF's own criterion asks about. So:
 *
 * - **Only the answer travels this way.** The question -- the text, the buttons, the input kind --
 *   goes as an ordinary message, where it is structured-cloned and costs nothing to send.
 * - **Nothing here is ever a serialised object**, not JSON, not a typed-array view of a struct.
 * - **No handle, pointer or index into either side's heap** crosses, so neither end can reach into
 *   the other's state even by accident.
 *
 * An engine that can suspend without blocking -- by awaiting the host's dialog request through the
 * wire -- needs none of this and should not create a buffer at all.
 */

import type { DialogResult } from "../dialog";
import { DIALOG_DISMISSED } from "../dialog";

/**
 * The buffer's size.
 *
 * 64 KiB, which is all about the one field that is not a fixed scalar: the text a player typed into
 * a `get_string`. Large enough that no plausible answer reaches it, small enough to be free.
 */
export const DIALOG_BUFFER_BYTES = 64 * 1024;

/** `signal`: 0 while the engine waits, 1 once the host has written an answer. */
export const DIALOG_SIGNAL = 0;
/** `button`: the index of what was clicked, or `DIALOG_DISMISSED`. */
export const DIALOG_BUTTON = 1;
/** `valueBytes`: how many bytes of `value` are meaningful. */
export const DIALOG_VALUE_LENGTH = 2;

/**
 * Where the string starts.
 *
 * 16 rather than 12, so the four control slots are followed by an aligned boundary: the scalars are
 * accessed as an `Int32Array` and the text as a `Uint8Array` over the same buffer, and a view that
 * starts off an alignment boundary is a portability hazard for no gain.
 */
export const DIALOG_VALUE_OFFSET = 16;

/** The three scalars, as a view a host writes and an engine reads. */
export function dialogControl(buffer: SharedArrayBuffer): Int32Array {
  return new Int32Array(buffer, 0, 4);
}

/** The text area. */
export function dialogValueBytes(buffer: SharedArrayBuffer): Uint8Array {
  return new Uint8Array(buffer, DIALOG_VALUE_OFFSET);
}

/**
 * A buffer for one session's dialogs.
 *
 * Requires cross-origin isolation (COOP/COEP); a host that is not isolated cannot construct one,
 * and an engine that needs one must report `"unsupported-environment"` rather than failing later.
 */
export function createDialogBuffer(): SharedArrayBuffer {
  return new SharedArrayBuffer(DIALOG_BUFFER_BYTES);
}

/**
 * Marks the buffer as waiting. Called by the engine **before** it sends the question.
 *
 * Before, not after, and that ordering is the whole correctness argument: a host that answers
 * instantly -- a scripted test, a host with the answer already in hand -- would otherwise write
 * `signal` before the engine cleared it, and the engine would then wait for a notification that has
 * already happened.
 */
export function beginDialog(buffer: SharedArrayBuffer): void {
  Atomics.store(dialogControl(buffer), DIALOG_SIGNAL, 0);
}

/**
 * Writes the player's answer and wakes the engine. The host's half.
 *
 * A value longer than the buffer is truncated rather than rejected: the alternative is failing a
 * frame over a pathological `get_string`, and a game that reads a shortened string behaves no worse
 * than one whose player typed less.
 */
export function writeDialogResult(buffer: SharedArrayBuffer, result: DialogResult): void {
  const control = dialogControl(buffer);
  const bytes = dialogValueBytes(buffer);
  const encoded = new TextEncoder().encode(result.value ?? "");
  const length = Math.min(encoded.length, bytes.length);
  bytes.set(encoded.subarray(0, length));
  Atomics.store(control, DIALOG_BUTTON, result.button);
  Atomics.store(control, DIALOG_VALUE_LENGTH, length);
  Atomics.store(control, DIALOG_SIGNAL, 1);
  Atomics.notify(control, DIALOG_SIGNAL);
}

/**
 * An answer read back out of the buffer.
 *
 * `value` is always a string, where `DialogResult`'s may be null: the buffer has no way to say "this
 * dialog had no input field", and the engines all read the text unconditionally, so an absent value
 * arrives as the empty string. Narrowed rather than left optional because the engine-side code that
 * reads this has to hand GML a string either way.
 */
export interface BufferedDialogResult extends DialogResult {
  value: string;
}

/** Reads whatever answer is in the buffer now, without waiting. */
export function readDialogResult(buffer: SharedArrayBuffer): BufferedDialogResult {
  const control = dialogControl(buffer);
  const length = Atomics.load(control, DIALOG_VALUE_LENGTH);
  const value = new TextDecoder().decode(dialogValueBytes(buffer).slice(0, length));
  return { button: Atomics.load(control, DIALOG_BUTTON), value };
}

/**
 * Blocks this thread until the host answers, then reads it. The engine's half.
 *
 * **Only callable on a worker thread.** `Atomics.wait` throws on the main thread of a document, by
 * design -- blocking it would freeze the page that is supposed to be drawing the dialog. An engine
 * that runs in the host's own realm must take the asynchronous path instead.
 *
 * `timeoutMs` exists for the case that would otherwise be unrecoverable: a host that goes away
 * while a dialog is open -- a closed tab, a crashed loader -- leaves this thread blocked forever
 * with no way to observe it. On a timeout the dialog reads as dismissed, which is the same answer
 * the player closing the window would have given.
 */
export function awaitDialogResult(
  buffer: SharedArrayBuffer,
  timeoutMs?: number,
): BufferedDialogResult {
  const control = dialogControl(buffer);
  const outcome = Atomics.wait(control, DIALOG_SIGNAL, 0, timeoutMs);
  if (outcome === "timed-out") return { button: DIALOG_DISMISSED, value: "" };
  return readDialogResult(buffer);
}
