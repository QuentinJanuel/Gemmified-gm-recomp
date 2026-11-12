import { test } from "node:test";
import assert from "node:assert/strict";
import { buildFeed } from "./publish-feed.mjs";

const sha = (c) => c.repeat(64);
const release = (version, c = "a") => ({
  id: "demo",
  version,
  url: `https://example.test/${version}/demo-${version}.zip`,
  sha256: sha(c),
});

test("a release is the whole feed", () => {
  assert.deepEqual(buildFeed(release("0.1.0")), {
    id: "demo",
    latest: "0.1.0",
    versions: { "0.1.0": { url: "https://example.test/0.1.0/demo-0.1.0.zip", sha256: sha("a") } },
  });
});

test("a later release replaces the previous one, it never accumulates", () => {
  const feed = buildFeed(release("0.2.0", "b"));
  assert.equal(feed.latest, "0.2.0");
  assert.deepEqual(Object.keys(feed.versions), ["0.2.0"]);
});

test("a malformed release is refused", () => {
  assert.throws(() => buildFeed({ ...release("0.1.0"), sha256: sha("A") }));
  assert.throws(() => buildFeed({ ...release("0.1.0"), url: "http://example.test/x.zip" }));
});
