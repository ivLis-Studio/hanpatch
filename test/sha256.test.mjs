import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import test from "node:test";

const source = await readFile(new URL("../public/sha256.js", import.meta.url), "utf8");
const context = { globalThis: {} };
runInNewContext(source, context);
const { Sha256 } = context.globalThis;

const vectors = [
  new Uint8Array(),
  new TextEncoder().encode("abc"),
  new TextEncoder().encode("The quick brown fox jumps over the lazy dog"),
  Uint8Array.from({ length: 1_000_003 }, (_, index) => (index * 31 + 17) & 0xff),
];

test("browser SHA-256 matches Node for whole and chunked input", () => {
  for (const vector of vectors) {
    const expected = createHash("sha256").update(vector).digest("hex");
    assert.equal(new Sha256().update(vector).hex(), expected);

    const chunked = new Sha256();
    for (let offset = 0; offset < vector.length; offset += 7777) {
      chunked.update(vector.subarray(offset, Math.min(offset + 7777, vector.length)));
    }
    assert.equal(chunked.hex(), expected);
  }
});
