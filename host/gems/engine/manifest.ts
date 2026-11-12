/**
 * The plugin manifest: what a host reads before it loads anything at all.
 *
 * A plugin is a directory served over HTTP, and this is the one file in it whose name the host
 * knows. Everything else -- the entry module, the wasm, a runtime, a 31MiB sound
 * bank -- is named *by* the manifest, which is the point: the host fetches one small JSON document,
 * learns what this engine is and what it needs, and decides whether to go on.
 *
 * A plugin that declares its own assets and bundles its own copy of this package can be versioned
 * apart from the host and from every other engine: the host's build needs to know nothing about it.
 *
 * **Must stay free of the DOM and of `fetch`.** A host may read manifests from disk outside a
 * browser, and a build script validates them with no network at all. Fetching is the host's
 * job; this module only says what a manifest is and whether a given document is one.
 */

import type { EngineCapabilities, SettingDescriptor, SettingValue } from "./index";

/** The file a plugin directory is identified by. */
export const PLUGIN_MANIFEST_NAME = "plugin.json";

/**
 * One file a plugin needs at runtime, declared so the host can serve, cache or relocate it without
 * knowing what it is for.
 *
 * Two examples: an engine runtime too large for a static host's per-file limit, served from
 * elsewhere, and an optional 31MiB MIDI bank that almost no game needs and that is fetched only once
 * the engine says this game has MIDI in it. Both are facts about one engine's payload, not about the
 * host.
 */
export interface PluginAsset {
  /** Path relative to the plugin directory, `/`-separated, no leading slash. */
  readonly path: string;
  /** Its size in bytes, so a deploy can route oversized files without downloading them first. */
  readonly bytes?: number;
  /**
   * An absolute URL to fetch it from instead, when this file is not served beside the manifest.
   *
   * The escape hatch for a file the plugin's own host cannot serve. A host should treat it as
   * advisory -- it may have its own mirror -- and must still refuse a URL it does not trust.
   */
  readonly url?: string;
  /**
   * Whether the engine still works without it.
   *
   * An optional asset that fails to load costs a feature (music, a codec) and must not fail the
   * game; a required one that fails is `"asset-unavailable"`. Defaults to required.
   */
  readonly optional?: boolean;
}

/** A plugin, as its manifest declares it. */
export interface PluginManifest {
  /**
   * The engine's id: lowercase, and stable across versions.
   *
   * It keys the player's settings for this engine and names it in a bug report, so changing it
   * orphans both. A host may also require it to match the directory the manifest came from, which
   * is the cheapest defence against a mirror serving one engine's manifest under another's name.
   */
  readonly id: string;
  /**
   * This build's version, which the host also expects to be the directory name.
   *
   * Duplicated between the path and the document on purpose: the path is how a host pins a build,
   * the document is how a loaded engine can say which build it is, and a disagreement between the
   * two is a deploy that went wrong and is worth refusing rather than running.
   */
  readonly version: string;
  /**
   * The contract revision this engine was built against.
   *
   * Parsing does not check it. A host that merely refused an unparseable manifest could not tell a
   * player the difference between "this is not a plugin" and "this plugin is built for a newer
   * contract than this host implements", and the second is the one worth saying out loud.
   */
  readonly apiVersion: number;
  /** The module exporting the `EnginePlugin` as its default, relative to the plugin directory. */
  readonly entry: string;
  /** A display name for the engine; advisory (SPEC §3.2). */
  readonly name?: string;
  /** The kinds of game this engine runs, e.g. `gm8`, `gms1`, `gms2`; advisory (SPEC §3.2). */
  readonly formats?: readonly string[];
  /** One sentence on what the engine runs, at most 280 characters. Advisory. */
  readonly description?: string;
  /** An https URL of the engine's public page. Advisory. */
  readonly homepage?: string;
  /** Who maintains the engine, at most 80 characters. Advisory. */
  readonly author?: string;
  /** An https URL of the update feed (`latest.json`) that lists this engine's releases. Advisory. */
  readonly updates?: string;
  /** Every payload file. See `PluginAsset`; omitted or empty means the entry module is self-contained. */
  readonly assets?: readonly PluginAsset[];
  /**
   * What this engine can do, and what it lets the player configure.
   *
   * In the manifest as well as on the plugin object so that a host can show a game's engine
   * requirements, or a settings page, without executing any of the engine's code.
   */
  readonly capabilities: EngineCapabilities;
}

/**
 * Reads a manifest, failing with a sentence rather than letting a malformed one surface later as a
 * missing module or an undefined setting.
 *
 * Validates the envelope and the settings descriptors; it does not fetch anything, does not check
 * `apiVersion` (see the field), and does not verify that the files named here exist. A descriptor is
 * checked because an invalid one would otherwise reach the host as a control with no value and no
 * bounds, which is worse than a refused plugin.
 */
export function parsePluginManifest(json: string): PluginManifest {
  const parsed: unknown = JSON.parse(json);
  // An array is `typeof "object"` too, and a list of anything is not a manifest.
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("plugin manifest: not an object");
  }
  const manifest = parsed as Record<string, unknown>;

  for (const key of ["id", "version", "entry"] as const) {
    if (typeof manifest[key] !== "string" || manifest[key] === "") {
      throw new Error(`plugin manifest: ${key} must be a non-empty string`);
    }
  }
  if (typeof manifest.apiVersion !== "number" || !Number.isInteger(manifest.apiVersion)) {
    throw new Error("plugin manifest: apiVersion must be an integer");
  }
  if (manifest.assets !== undefined) {
    if (!Array.isArray(manifest.assets)) throw new Error("plugin manifest: assets must be a list");
    for (const asset of manifest.assets) parseAsset(asset);
  }

  const capabilities = manifest.capabilities;
  if (typeof capabilities !== "object" || capabilities === null) {
    throw new Error("plugin manifest: capabilities must be an object");
  }
  const { settings } = capabilities as Record<string, unknown>;
  if (!Array.isArray(settings))
    throw new Error("plugin manifest: capabilities.settings must be a list");
  for (const descriptor of settings) parseDescriptor(descriptor);

  return manifest as unknown as PluginManifest;
}

function parseAsset(value: unknown): void {
  if (typeof value !== "object" || value === null)
    throw new Error("plugin manifest: an asset is not an object");
  const asset = value as Record<string, unknown>;
  if (typeof asset.path !== "string" || asset.path === "") {
    throw new Error("plugin manifest: an asset has no path");
  }
  if (asset.bytes !== undefined && typeof asset.bytes !== "number") {
    throw new Error(`plugin manifest: ${asset.path}'s bytes must be a number`);
  }
  if (asset.url !== undefined && typeof asset.url !== "string") {
    throw new Error(`plugin manifest: ${asset.path}'s url must be a string`);
  }
  if (asset.optional !== undefined && typeof asset.optional !== "boolean") {
    throw new Error(`plugin manifest: ${asset.path}'s optional must be a boolean`);
  }
}

function parseDescriptor(value: unknown): void {
  if (typeof value !== "object" || value === null) {
    throw new Error("plugin manifest: a setting is not an object");
  }
  const descriptor = value as Record<string, unknown>;
  const { kind, key } = descriptor;
  if (typeof key !== "string" || key === "")
    throw new Error("plugin manifest: a setting has no key");

  if (typeof kind !== "string") throw new Error(`plugin manifest: setting ${key} has no kind`);

  const expected: Record<string, "boolean" | "number" | "string"> = {
    flag: "boolean",
    number: "number",
    choice: "string",
  };
  const type = expected[kind];
  // A kind this revision does not know is not a broken document: it may be from a newer contract,
  // and the rule there is that the host skips what it cannot interpret. Nothing further to check.
  if (type === undefined) return;
  if (typeof descriptor.default !== type) {
    throw new Error(`plugin manifest: setting ${key} needs a ${type} default`);
  }
  if (kind === "choice") {
    const { values } = descriptor;
    if (
      !Array.isArray(values) ||
      values.length === 0 ||
      values.some((v) => typeof v !== "string")
    ) {
      throw new Error(`plugin manifest: setting ${key} needs a non-empty list of string values`);
    }
    if (!values.includes(descriptor.default)) {
      throw new Error(`plugin manifest: setting ${key}'s default is not one of its values`);
    }
  }
}

/**
 * The value every setting starts at, by key.
 *
 * What a host resolves before `create()`, so `HostServices.settings` is complete from the first
 * frame -- which is what lets an engine read a setting without checking whether it is there. A
 * stored value the player chose is layered on top by the host; a descriptor whose `kind` this
 * contract revision does not know is skipped, by the same rule that governs error codes.
 */
export function defaultSettings(
  descriptors: readonly SettingDescriptor[],
): Record<string, SettingValue> {
  const values: Record<string, SettingValue> = {};
  for (const descriptor of descriptors) {
    // Read through a widened view, because the interesting case is the one the types say cannot
    // happen: a manifest from a newer contract, carrying a kind this revision has never heard of.
    const { kind } = descriptor as { kind: string };
    if (kind !== "flag" && kind !== "number" && kind !== "choice") continue;
    values[descriptor.key] = descriptor.default;
  }
  return values;
}
