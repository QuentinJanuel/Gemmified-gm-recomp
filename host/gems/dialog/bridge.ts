/**
 * The host's side of a dialog: one path for every blocking GML question, whichever way the engine
 * asked it.
 *
 * **Two transports, one answer.** An engine that can suspend without blocking sends a `dialog`
 * request over the wire and awaits the reply. An engine that blocks a worker thread cannot receive
 * a reply -- a blocked thread does not drain its own message queue -- so it sends a `dialog-asked`
 * note and reads the answer out of the shared buffer. Those are genuinely different mechanisms and
 * both have to exist. What must *not* differ is anything the player or the game can observe, and
 * that is what this module is: both transports funnel into one `settle`, so dismissal, the
 * `DIALOG_DISMISSED` sentinel, the null-versus-string rule for `value`, and the keyboard release
 * afterwards are decided in exactly one place.
 *
 * **It also releases the keyboard after every dialog, for every engine.** Otherwise a game that
 * swallows the key which opened a dialog sees it as freshly pressed on the next frame and reopens
 * the dialog, forever (the `io_clear()` loop). This is not optional: see `releaseInput`.
 *
 * No DOM, and no `AudioContext`-style global: the host passes its own dialog UI in. So this runs in
 * a test, and a host with no document at all -- a scripted replay, the reference host under Node --
 * can answer dialogs by supplying a `ui` that returns a fixed choice.
 */

import type { GameInput } from "../engine";
import { DIALOG_DISMISSED } from "./index";
import type { DialogRequest, DialogResult } from "./index";
import { writeDialogResult } from "../wire/dialog-sab";

/** Whatever the host renders dialogs with. `HostServices.dialogs` satisfies this. */
export interface DialogUi {
  show(request: DialogRequest): Promise<DialogResult>;
}

/** How to build a bridge. */
export interface DialogBridgeOptions {
  /**
   * The host's dialog UI.
   *
   * Its answer is normalised, never trusted verbatim -- see `settle`. A UI that throws, or that
   * resolves with something the contract does not allow, must not be able to wedge an engine that
   * is blocked on a buffer waiting for it.
   */
  readonly ui: DialogUi;
  /**
   * This session's shared buffer, for the blocking path, or null when there is none.
   *
   * Null is the ordinary case for an engine that suspends asynchronously, and the honest case for a
   * host that is not cross-origin isolated and so cannot construct one at all. A `dialog-asked`
   * note arriving with no buffer is a protocol error by the engine rather than a condition to
   * recover from, because there is nowhere to put the answer; it is reported and dropped rather
   * than thrown, since the caller is a message handler with no one to throw to.
   */
  readonly buffer?: SharedArrayBuffer | null;
  /**
   * Where to send the keyboard release that follows every dialog. **Required.**
   *
   * Required, rather than an optional hook, because a game that never sees the keys released can
   * reopen its dialog forever (see the module comment). The host wires this to whatever carries
   * input to the engine -- over the wire, `(input) => wire.notify({ kind: "input", input })`.
   *
   * It is a `focus-lost` rather than a `key-up` per held key for the reason `GameInput` gives: a
   * dialog takes focus from the whole page, the releases that happened while it was open were seen
   * by nobody, and the engine is the only side that still knows what it is holding.
   */
  readonly releaseInput: (input: GameInput) => void;
  /**
   * Where to report an engine that asked impossibly -- a blocking question with no buffer.
   *
   * Optional, and a code rather than a sentence, like every other error crossing this boundary.
   */
  readonly onError?: (code: "internal", detail: string) => void;
}

/** A running bridge. */
export interface DialogBridge {
  /**
   * Answer a `dialog` request from an engine that suspends asynchronously.
   *
   * The host returns this promise straight to the wire's `onRequest`.
   */
  requested(request: DialogRequest): Promise<DialogResult>;
  /**
   * Answer a `dialog-asked` note from an engine blocked on the buffer.
   *
   * Returns nothing: there is no reply to send, and the caller is a note handler. The returned
   * promise is for tests and for a host that wants to await its own quiescence; ignoring it is
   * correct and is what a message handler does.
   */
  asked(request: DialogRequest): Promise<void>;
  /** How many dialogs are open or queued. A running game should never exceed 1; see `settle`. */
  readonly pending: number;
}

/**
 * Normalises whatever the UI said into what the contract guarantees an engine.
 *
 * Three rules, each one a way the two engines could otherwise disagree:
 *
 * - **`value` is a string exactly when the request had an `input`, and null otherwise.** The
 *   contract says so, and engines rely on it: one reads the field unconditionally and would hand
 *   GML the string `"null"`, the other checks for null first. A UI that returns a value for a
 *   question with no field has it dropped, and one that returns null for a question with a field
 *   gets the empty string.
 * - **An unrecognised button is a dismissal.** Not the first button, not the primary one: the
 *   contract is explicit that inventing a press on the player's behalf is worse than reporting that
 *   none happened, because `show_message_ext` numbers its buttons from 1 and returns 0 on Escape,
 *   so a host that substituted a real button would make the game act on something nobody clicked.
 * - **A dismissal on a non-dismissible request is passed through, not corrected.** `show_message`
 *   declares no dismissed value, but a host that lost the player -- a closed tab, a torn-down
 *   session -- has no better answer, and the contract asks engines to tolerate it. Correcting it
 *   here would mean acknowledging a message the player never saw.
 */
function normalise(request: DialogRequest, result: DialogResult): DialogResult {
  const known = request.buttons.some((button) => button.value === result.button);
  const button = known ? result.button : DIALOG_DISMISSED;
  const value = request.input ? (result.value ?? "") : null;
  return { button, value };
}

/** The answer when the UI could not give one. Dismissal is what losing the player looks like. */
function dismissed(request: DialogRequest): DialogResult {
  return { button: DIALOG_DISMISSED, value: request.input ? "" : null };
}

/**
 * Builds the bridge.
 *
 * Dialogs are **serialised**: a second question waits for the first to be answered. A running game
 * cannot ask two at once -- every one of these functions blocks the game mid-frame, which is the
 * whole reason this module exists -- so the queue is not there to support concurrency but to stop
 * two UIs racing if an engine is buggy or if a host drives two sessions through one bridge by
 * mistake. Without it, two overlapping `dialog-asked` notes would write two answers into one
 * buffer and the engine would read whichever landed last.
 */
export function createDialogBridge(options: DialogBridgeOptions): DialogBridge {
  const { ui, releaseInput, onError } = options;
  const buffer = options.buffer ?? null;

  let pending = 0;
  /** The tail of the queue: every dialog chains onto the one before it. */
  let tail: Promise<unknown> = Promise.resolve();

  /**
   * Shows one dialog and returns the normalised answer.
   *
   * The UI is never allowed to fail the caller. A rejection becomes a dismissal, because the
   * alternative on the blocking path is an engine that waits on a buffer nobody will ever write --
   * a frozen game, with the cause three layers away from where it shows up.
   */
  const settle = async (request: DialogRequest): Promise<DialogResult> => {
    let result: DialogResult;
    try {
      result = normalise(request, await ui.show(request));
    } catch {
      result = dismissed(request);
    }
    // Before the engine is told the answer, and the order is deliberate. On the blocking path
    // `writeDialogResult` wakes the worker inside the frame it suspended in, and that frame then
    // runs to completion without draining its message queue -- so a release sent afterwards would
    // still arrive before the next `tick`, but only because of how the host happens to sequence
    // its loop. Sent first, it is ahead of everything in port order and the guarantee is the
    // transport's rather than the caller's.
    releaseInput({ kind: "focus-lost" });
    return result;
  };

  /** Chains `work` after whatever is already queued, keeping `pending` honest either way. */
  const enqueue = <T>(work: () => Promise<T>): Promise<T> => {
    pending += 1;
    const run = tail.then(work, work);
    // The tail must not carry a rejection forward, or one failed dialog would reject the next.
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run.finally(() => {
      pending -= 1;
    });
  };

  return {
    requested: (request) => enqueue(() => settle(request)),

    asked: (request) =>
      enqueue(async () => {
        if (buffer === null) {
          // Nothing can be done for this engine: it is blocked on a buffer that does not exist, and
          // it will time out if it passed a timeout to `awaitDialogResult`. Reported so the cause is
          // visible, because the symptom is a game that stopped.
          onError?.(
            "internal",
            "engine sent a blocking dialog request but the session has no dialog buffer",
          );
          return;
        }
        // `writeDialogResult` coerces a null value to the empty string, which is what the buffer can
        // represent and what the engine-side read expects; see `BufferedDialogResult`.
        writeDialogResult(buffer, await settle(request));
      }),

    get pending() {
      return pending;
    },
  };
}
