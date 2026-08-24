import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { deflateSync } from "node:zlib";
import { validatePatcherConfig } from "../lib/patcher-config.mjs";
import "../public/dlc-patch-core.js";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function u16(value) {
  const bytes = Buffer.alloc(2);
  bytes.writeUInt16LE(value);
  return bytes;
}

function u32(value) {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE(value);
  return bytes;
}

function u64(value) {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64LE(BigInt(value));
  return bytes;
}

function makeFixture() {
  const source = Buffer.from("ABCDEF", "ascii");
  const target = Buffer.from("ABXYEF", "ascii");
  const commands = Buffer.concat([
    Buffer.from([0]), u64(0), u64(2),
    Buffer.from([1]), u64(2), Buffer.from("XY", "ascii"),
    Buffer.from([0]), u64(4), u64(2),
  ]);
  const stored = deflateSync(commands, { level: 9 });
  const name = Buffer.from("quest01.EDAT", "utf8");
  const payload = Buffer.concat([
    Buffer.from("P2KODLC1", "ascii"),
    u32(1),
    u32(1),
    u16(name.length),
    name,
    u64(source.length),
    u64(target.length),
    Buffer.from(sha256(source), "hex"),
    Buffer.from(sha256(target), "hex"),
    u64(commands.length),
    u64(stored.length),
    stored,
  ]);
  const engineData = {
    format: "P2KODLC1",
    formatVersion: 1,
    discId: "ULJM00000",
    requiresMainPatch: ">=1.0.0",
    entries: [{
      name: "quest01.EDAT",
      sourceSize: source.length,
      targetSize: target.length,
      sourceSha256: sha256(source),
      targetSha256: sha256(target),
    }],
  };
  return { source, target, payload, engineData };
}

test("parses, validates, and applies a multi-file DLC delta entry", async () => {
  const fixture = makeFixture();
  const entries = await HanpatchDlcCore.parsePatch(new Blob([fixture.payload]));
  HanpatchDlcCore.compareMetadata(entries, fixture.engineData);
  const output = await HanpatchDlcCore.applyEntry(new Uint8Array(fixture.source), entries[0]);
  assert.deepEqual(Buffer.from(output), fixture.target);
});

test("accepts a declarative directory-mode patch configuration", () => {
  const fixture = makeFixture();
  const config = validatePatcherConfig({
    schemaVersion: 1,
    slug: "example-dlc",
    title: "예시 DLC 한국어 패치",
    shortTitle: "예시 DLC 패치",
    version: "1.0.0",
    engine: "psp-file-set-delta-v1",
    description: "여러 DLC 파일을 한 번에 변환합니다.",
    input: {
      mode: "directory",
      label: "원본 DLC 폴더",
      extensions: [".pbp", ".edat"],
      discId: "ULJM00000",
      supportedVariants: ["정식 DLC 폴더"],
    },
    output: { suggestedName: "ULJM00000_KO" },
    patch: {
      file: "example-dlc.p2kd",
      size: fixture.payload.length,
      sha256: sha256(fixture.payload),
    },
    notices: ["원본 폴더는 수정하지 않습니다."],
    engineData: fixture.engineData,
  });
  assert.equal(config.input.mode, "directory");
  assert.equal(config.engineData.entries.length, 1);
});
