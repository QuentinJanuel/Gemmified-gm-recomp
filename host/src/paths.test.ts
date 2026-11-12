import assert from "node:assert/strict";
import { test } from "node:test";
import { pathKey, type VPath } from "../gems/vfs";
import { fromVPath, guestFiles, hostPath, toVPath } from "./paths";

const key = (path: VPath) => `${path.mount}:${path.segments.join("/")}`;
const bytes = (text: string) => new TextEncoder().encode(text);
const text = (data: Uint8Array) => new TextDecoder().decode(data);

/** The files `guestFiles` places, by lowercase guest path, as text. */
function placed(
  dir: string,
  saved: Record<string, string>,
  options: { bundle?: Record<string, string>; whiteouts?: string[] } = {},
) {
  const parse = (k: string): VPath => {
    const [mount, rest] = k.split(":") as [VPath["mount"], string];
    return { mount, segments: rest.split("/").filter(Boolean) };
  };
  const keys = new Set(Object.keys(saved).map((k) => pathKey(parse(k))));
  const gone = new Set((options.whiteouts ?? []).map((k) => pathKey(parse(k))));
  const files = guestFiles(
    dir,
    Object.entries(options.bundle ?? {}).map(([path, t]) => ({ path, bytes: bytes(t) })),
    Object.entries(saved).map(([k, t]) => ({ path: parse(k), bytes: bytes(t) })),
    { has: (p) => keys.has(pathKey(p)), isWhitedOut: (p) => gone.has(pathKey(p)) },
  );
  return Object.fromEntries(files.map(([path, data]) => [path.toLowerCase(), text(data)]));
}

test("toVPath follows SPEC §13.5", () => {
  const cases: [string, string][] = [
    ["C\\Users\\player\\AppData\\Local\\Temp\\gm_ttt_1\\a.png", "temp:gm_ttt_1/a.png"],
    ["C\\Documents and Settings\\p\\Local Settings\\Temp\\a", "temp:a"],
    ["C\\Users\\player\\AppData\\Local\\Name\\Data\\cfg", "appdata:Name/Data/cfg"],
    ["C\\Users\\player\\AppData\\Roaming\\Name\\Data\\cfg", "appdata:Name/Data/cfg"],
    ["C\\Documents and Settings\\p\\Application Data\\Name\\x", "appdata:Name/x"],
    ["C\\Documents and Settings\\p\\Local Settings\\Application Data\\Name\\x", "appdata:Name/x"],
    ["save1", "game:save1"],
    ["Data\\save1", "game:Data/save1"],
    ["C\\p_rooted.txt", "game:p_rooted.txt"],
    ["D\\x\\save1", "game:x/save1"],
    ["C\\game\\save1", "game:save1"],
    ["a", "game:a"],
  ];
  for (const [guest, want] of cases) assert.equal(key(toVPath(guest)), want, guest);
});

test("every place fromVPath gives maps back to the same key", () => {
  for (const k of ["temp:gm_ttt_1/a.png", "appdata:Name/Data/cfg", "game:Data/save1", "game:x"]) {
    const [mount, rest] = k.split(":") as [VPath["mount"], string];
    for (const guest of fromVPath({ mount, segments: rest.split("/") })) {
      assert.equal(key(toVPath(guest)), k, guest);
    }
  }
});

test("a GMS save is read back where the runner wrote it", () => {
  // tijit engine 2's runner writes its config here; the key is what it is stored under.
  const written = "C\\Users\\player\\AppData\\Local\\tijit_engine_2\\Data\\cfg";
  assert.equal(key(toVPath(written)), "appdata:tijit_engine_2/Data/cfg");
  assert.equal(placed("", { "appdata:tijit_engine_2/Data/cfg": "c" })[written.toLowerCase()], "c");
});

test("a host's temp_directory path is the temp mount, and mount roots parse as such", () => {
  const raw = "C:\\Users\\player\\AppData\\Local\\Temp\\gm_ttt_31379\\slot.png";
  assert.equal(key(hostPath(raw)), "temp:gm_ttt_31379/slot.png");
  assert.equal(key(hostPath("/game/late.png")), "game:late.png");
});

test("current keys are placed, without stray copies", () => {
  assert.deepEqual(placed("", { "appdata:Name/x": "a", "game:Data/s": "g" }), {
    "c\\users\\player\\appdata\\local\\name\\x": "a",
    "c\\users\\player\\appdata\\roaming\\name\\x": "a",
    "data\\s": "g",
    "c\\data\\s": "g",
  });
});

test("old keys are placed where no current key is, and a current key wins", () => {
  const files = placed("sub/", {
    "appdata:Local/Name/old": "legacy",
    "appdata:Roaming/Name/both": "old",
    "appdata:Name/both": "new",
    "game:sub/save1": "legacy game",
  });
  assert.equal(files["c\\users\\player\\appdata\\local\\name\\old"], "legacy");
  assert.equal(files["c\\users\\player\\appdata\\roaming\\name\\old"], "legacy");
  assert.equal(files["c\\users\\player\\appdata\\local\\name\\both"], "new");
  assert.equal(files["save1"], "legacy game");
});

test("an old key under another drive is read there", () => {
  assert.equal(placed("", { "game:C/probe/x": "d" })["c\\probe\\x"], "d");
});

test("saves beat the game's files, and a whiteout hides one", () => {
  const files = placed(
    "",
    { "game:a": "saved" },
    { bundle: { a: "shipped", b: "shipped", c: "shipped" }, whiteouts: ["game:b"] },
  );
  assert.equal(files["a"], "saved");
  assert.equal(files["b"], undefined);
  assert.equal(files["c"], "shipped");
});

test("an old key is not placed over a whiteout of the current key", () => {
  assert.equal(
    placed("", { "appdata:Local/N/x": "old" }, { whiteouts: ["appdata:N/x"] })[
      "c\\users\\player\\appdata\\local\\n\\x"
    ],
    undefined,
  );
});
