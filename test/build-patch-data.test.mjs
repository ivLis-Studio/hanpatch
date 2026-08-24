import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildPatchData } from "../scripts/build-patch-data.mjs";

test("builds portable P2KP metadata for source variants and shrink-only entries", async () => {
  const root = await mkdtemp(join(tmpdir(), "p2kp-builder-test-"));
  try {
    const files = join(root, "files");
    await mkdir(files);
    await Promise.all([
      writeFile(join(files, "source-a.bin"), Buffer.from("ABCDEFGH")),
      writeFile(join(files, "source-b.bin"), Buffer.from("ABCXEFGH")),
      writeFile(join(files, "target.bin"), Buffer.from("ABCYEFGH")),
      writeFile(join(files, "shrink-source.bin"), Buffer.from("SAMEPREFIXTRAIL")),
      writeFile(join(files, "shrink-target.bin"), Buffer.from("SAMEPREFIX")),
    ]);
    const specPath = join(root, "build.json");
    await writeFile(specPath, `${JSON.stringify({
      discId: "ULJM00000",
      entries: [
        {
          path: "/PSP_GAME/USRDIR/fixed.bin",
          strategy: 0,
          sourceFiles: ["./files/source-a.bin", "./files/source-b.bin"],
          targetFile: "./files/target.bin",
        },
        {
          path: "/PSP_GAME/USRDIR/shrink.bin",
          strategy: 1,
          sourceFiles: ["./files/shrink-source.bin"],
          targetFile: "./files/shrink-target.bin",
        },
      ],
    }, null, 2)}\n`);
    const outputPath = join(root, "test.p2kp");
    const metadataPath = join(root, "metadata.json");
    const result = await buildPatchData(specPath, outputPath, metadataPath);
    const payload = await readFile(outputPath);
    const metadata = JSON.parse(await readFile(metadataPath, "utf8"));

    assert.equal(payload.subarray(0, 8).toString("ascii"), "PSPDELTA");
    assert.equal(payload.readUInt32LE(8), 2);
    assert.equal(payload.readUInt32LE(12), 2);
    assert.equal(result.patch.size, payload.length);
    assert.equal(metadata.patch.sha256, result.patch.sha256);
    assert.equal(metadata.engineData.entries[0].sourceSha256Variants.length, 2);
    assert.equal(metadata.engineData.entries[1].strategy, 1);
    assert.equal(metadata.engineData.entries[1].targetSize, 10);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
