/**
 * The dialog contract: how an engine asks the host to put a question to the player, and what it
 * gets back.
 *
 * GameMaker's blocking dialog functions -- `show_message`, `show_message_ext`, `show_question`,
 * `get_string`, `get_integer` -- all reduce to one shape: a message, one or more buttons, and an
 * optional text field. An engine builds a request and suspends; the host renders it however it
 * likes and resolves with which button was chosen plus the field's contents.
 *
 * This lives in the SDK rather than in a host because both sides have to agree on it, and because
 * the host's rendering is the part that should be free to differ. Nothing here describes an
 * appearance: no colours, no sizes, no layout, no markup. `kind` is the one concession, and it
 * carries emphasis rather than styling.
 *
 * The host owns the strings it adds (a close affordance, say). It does not own `text` or `label`,
 * which come from the game and are shown verbatim -- a host that translates a game's own words is
 * rewriting the game. The common exception is worth knowing: the labels an engine puts on its
 * *built-in* dialogs ("OK", "Yes", "No", "Cancel") are engine chrome rather than game text, and a
 * host may reasonably localise exactly those.
 */

/**
 * The value `DialogResult.button` carries when the player answered without choosing a button.
 *
 * It is deliberately outside any button's range rather than a valid index, because "dismissed" is
 * a distinct outcome from every rendered choice and several GameMaker functions distinguish it:
 * `show_message_ext` returns 0 on Escape even though its buttons are numbered from 1, so a host
 * that reported the last button instead would make the game act as though something was pressed.
 *
 * Each engine maps it to its own not-OK / not-Yes outcome. An engine must handle it on any request
 * it marked `dismissible`, and should tolerate it on one it did not: a host that loses the player
 * -- a closed tab, a torn-down session -- has no better answer to give, and inventing a button
 * press on their behalf is worse than reporting that none happened.
 */
export const DIALOG_DISMISSED = -1;

export interface DialogButton {
  /** Shown verbatim. This is the game's text, not the host's. */
  label: string;
  /**
   * Handed back as `DialogResult.button` when this button is chosen. It is whatever the engine
   * needs to recognise its own choice -- a 0-based index, `show_message_ext`'s 1-based one, or
   * `show_question`'s 0/1 -- and the host only ever carries it, never interprets it.
   */
  value: number;
  /**
   * Emphasis, not styling: `"primary"` marks the default choice, the one a host should also
   * trigger on Enter. Whether the dialog can be dismissed at all is `DialogRequest.dismissible`
   * and has nothing to do with any button -- see `DIALOG_DISMISSED`.
   */
  kind?: "primary" | "default";
}

export interface DialogInput {
  /** `"integer"` asks the host to accept only a signed whole number, matching `get_integer`. */
  kind: "string" | "integer";
  initial: string;
}

export interface DialogRequest {
  /** Shown verbatim. The game's text. */
  text: string;
  buttons: DialogButton[];
  input?: DialogInput;
  /**
   * Whether the player may close this dialog without choosing a button -- by Escape, by clicking
   * away, or by whatever the host offers.
   *
   * It is per-request because GameMaker is: `show_message` has no dismissed value and must be
   * acknowledged, while `show_question`, `get_string`, `get_integer` and `show_message_ext` all
   * define one. When a dismissible dialog is dismissed, the host resolves with
   * `button: DIALOG_DISMISSED`.
   */
  dismissible?: boolean;
}

export interface DialogResult {
  /** The chosen button's `value`, or `DIALOG_DISMISSED` if none was chosen. */
  button: number;
  /** The text field's contents, or `null` when the request had no `input`. */
  value: string | null;
}
