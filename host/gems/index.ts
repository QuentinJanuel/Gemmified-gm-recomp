/**
 * The emulator/host interface: what a GameMaker emulator may assume about whatever is running it,
 * and what a host may assume about any emulator it loads.
 *
 * This code is MIT, with no copyleft dependency and no identifier naming a particular engine or a
 * particular host, so that engines under incompatible licences can each implement it as
 * independent programs speaking a common protocol.
 *
 * This module holds only the version, so that code with no DOM in its lib can ask for the contract
 * number before deciding to load anything. The interface itself is in `./engine`, the filesystem
 * engines read and write through in `./vfs`, and the wire protocol that carries the interface over
 * a `MessagePort` in `./wire`.
 */

/**
 * The contract revision an engine and a host must agree on.
 *
 * A plugin states the version it was built against in its manifest and again on its exported
 * engine object; a host refuses to load a plugin whose number it does not recognise. Hence a single
 * integer rather than a semver range: the useful question at load time is "is this the contract I
 * implement", which has a yes/no answer, and an engine that is wrong about it fails immediately
 * instead of part-way through a game.
 *
 * Anything an existing implementation can safely ignore (a new optional member, a new error code,
 * a new setting kind, a new fact in an open record) leaves this number alone. Anything an existing
 * implementation must understand (a required member, a member on `HostServices` an engine may rely
 * on, a change to what an existing member means) needs a new number.
 */
export const API_VERSION = 5;
