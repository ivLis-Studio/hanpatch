import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const MAGIC = "PSPDELTA";
const FORMAT_VERSION = 2;
const MAX_ENTRIES = 32;
const MAX_SEGMENT_BYTES = 8 * 1024 * 1024;
const MERGE_GAP_BYTES = 32;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function integer(value, label, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} 값이 올바르지 않습니다.`);
  }
  return value;
}

function text(value, label, maximum) {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value || value.length > maximum) {
    throw new Error(`${label} 문자열이 올바르지 않습니다.`);
  }
  return value;
}

function u8(value) {
  return Buffer.from([integer(value, "u8", 0, 0xff)]);
}

function u16(value) {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16LE(integer(value, "u16", 0, 0xffff));
  return buffer;
}

function u32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(integer(value, "u32", 0, 0xffff_ffff));
  return buffer;
}

function u64(value) {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64LE(BigInt(integer(value, "u64", 0, Number.MAX_SAFE_INTEGER)));
  return buffer;
}

function findChangedRanges(source, target) {
  const ranges = [];
  let start = -1;
  let lastDifference = -1;

  for (let offset = 0; offset < target.length; offset += 1) {
    const different = offset >= source.length || source[offset] !== target[offset];
    if (different) {
      if (start < 0) start = offset;
      lastDifference = offset;
    } else if (start >= 0 && offset - lastDifference > MERGE_GAP_BYTES) {
      ranges.push([start, lastDifference + 1]);
      start = -1;
      lastDifference = -1;
    }
  }
  if (start >= 0) ranges.push([start, lastDifference + 1]);

  return ranges.flatMap(([rangeStart, rangeEnd]) => {
    const chunks = [];
    for (let cursor = rangeStart; cursor < rangeEnd; cursor += MAX_SEGMENT_BYTES) {
      chunks.push([cursor, Math.min(cursor + MAX_SEGMENT_BYTES, rangeEnd)]);
    }
    return chunks;
  });
}

function verifyVariant(source, target, ranges, label) {
  let rangeIndex = 0;
  for (let offset = 0; offset < target.length; offset += 1) {
    while (rangeIndex < ranges.length && offset >= ranges[rangeIndex][1]) rangeIndex += 1;
    const patched = rangeIndex < ranges.length
      && offset >= ranges[rangeIndex][0]
      && offset < ranges[rangeIndex][1];
    if (!patched && source[offset] !== target[offset]) {
      throw new Error(`${label}은(는) 같은 패치 조각으로 목표 파일을 만들 수 없습니다. 오프셋: ${offset}`);
    }
  }
}

function encodeSegment(target, start, end) {
  const raw = target.subarray(start, end);
  const compressed = deflateSync(raw, { level: 9 });
  const encoding = compressed.length < raw.length ? 1 : 0;
  const stored = encoding === 1 ? compressed : raw;
  return Buffer.concat([
    u64(start),
    u64(raw.length),
    u8(encoding),
    u64(stored.length),
    stored,
  ]);
}

async function buildEntry(specDirectory, value, index) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`entries[${index}]은(는) 객체여야 합니다.`);
  }
  const path = text(value.path, `entries[${index}].path`, 1024);
  if (!path.startsWith("/") || path.includes("\\") || path.includes("\0") || path.split("/").includes("..")) {
    throw new Error(`entries[${index}].path가 올바르지 않습니다.`);
  }
  const strategy = integer(value.strategy, `entries[${index}].strategy`, 0, 2);
  if (strategy === 2 && path !== "/PSP_GAME/SYSDIR/EBOOT.BIN") {
    throw new Error("전략 2는 /PSP_GAME/SYSDIR/EBOOT.BIN에만 사용할 수 있습니다.");
  }
  if (!Array.isArray(value.sourceFiles) || value.sourceFiles.length === 0 || value.sourceFiles.length > 64) {
    throw new Error(`entries[${index}].sourceFiles 배열이 올바르지 않습니다.`);
  }

  const sourcePaths = value.sourceFiles.map((file, sourceIndex) => (
    resolve(specDirectory, text(file, `entries[${index}].sourceFiles[${sourceIndex}]`, 2048))
  ));
  const targetPath = resolve(specDirectory, text(value.targetFile, `entries[${index}].targetFile`, 2048));
  const [target, ...sources] = await Promise.all([
    readFile(targetPath),
    ...sourcePaths.map((file) => readFile(file)),
  ]);
  if (target.length === 0 || sources[0].length === 0) throw new Error(`${path} 파일은 비어 있을 수 없습니다.`);
  const sourceSize = sources[0].length;
  if (sources.some((source) => source.length !== sourceSize)) {
    throw new Error(`${path}의 모든 원본 변형은 크기가 같아야 합니다.`);
  }
  if (strategy === 0 && sourceSize !== target.length) throw new Error(`전략 0의 ${path}는 원본과 결과 크기가 같아야 합니다.`);
  if (strategy === 1 && target.length > sourceSize) throw new Error(`전략 1의 ${path}는 결과가 원본보다 클 수 없습니다.`);

  const ranges = findChangedRanges(sources[0], target);
  if (ranges.length === 0 && strategy === 1 && target.length < sourceSize) ranges.push([0, 1]);
  if (ranges.length === 0) throw new Error(`${path}에서 변경된 바이트를 찾지 못했습니다.`);
  if (ranges.length > 100_000) throw new Error(`${path}의 변경 조각이 100000개를 넘었습니다.`);
  for (const [sourceIndex, source] of sources.entries()) {
    verifyVariant(source, target, ranges, `${path} 원본 변형 ${sourceIndex + 1}`);
  }

  const pathBytes = Buffer.from(path, "utf8");
  if (pathBytes.length > 1024) throw new Error(`${path}의 UTF-8 경로가 너무 깁니다.`);
  const sourceHashes = sources.map(sha256);
  const targetHash = sha256(target);
  const segments = ranges.map(([start, end]) => encodeSegment(target, start, end));
  const binary = Buffer.concat([
    u8(strategy),
    u16(pathBytes.length),
    pathBytes,
    u64(sourceSize),
    u64(target.length),
    u16(sourceHashes.length),
    ...sourceHashes.map((hash) => Buffer.from(hash, "hex")),
    Buffer.from(targetHash, "hex"),
    u32(segments.length),
    ...segments,
  ]);

  return {
    binary,
    metadata: {
      path,
      strategy,
      sourceSize,
      targetSize: target.length,
      sourceSha256Variants: sourceHashes,
      targetSha256: targetHash,
    },
  };
}

export async function buildPatchData(specPath, outputPath, metadataPath = `${outputPath}.json`) {
  const absoluteSpec = resolve(specPath);
  const absoluteOutput = resolve(outputPath);
  const absoluteMetadata = resolve(metadataPath);
  const spec = JSON.parse(await readFile(absoluteSpec, "utf8"));
  const discId = text(spec.discId, "discId", 32);
  if (!Array.isArray(spec.entries) || spec.entries.length === 0 || spec.entries.length > MAX_ENTRIES) {
    throw new Error(`entries는 1개 이상 ${MAX_ENTRIES}개 이하여야 합니다.`);
  }
  const builtEntries = [];
  for (const [index, entry] of spec.entries.entries()) {
    builtEntries.push(await buildEntry(dirname(absoluteSpec), entry, index));
  }
  const uniquePaths = new Set(builtEntries.map((entry) => entry.metadata.path));
  if (uniquePaths.size !== builtEntries.length) throw new Error("entries의 ISO 경로가 중복됩니다.");
  if (builtEntries.filter((entry) => entry.metadata.strategy === 2).length > 1) {
    throw new Error("전략 2 항목은 하나만 사용할 수 있습니다.");
  }

  const payload = Buffer.concat([
    Buffer.from(MAGIC, "ascii"),
    u32(FORMAT_VERSION),
    u32(builtEntries.length),
    ...builtEntries.map((entry) => entry.binary),
  ]);
  const metadata = {
    patch: {
      file: basename(absoluteOutput),
      size: payload.length,
      sha256: sha256(payload),
    },
    engineData: {
      format: MAGIC,
      formatVersion: FORMAT_VERSION,
      discId,
      entries: builtEntries.map((entry) => entry.metadata),
    },
  };
  await Promise.all([
    mkdir(dirname(absoluteOutput), { recursive: true }),
    mkdir(dirname(absoluteMetadata), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(absoluteOutput, payload),
    writeFile(absoluteMetadata, `${JSON.stringify(metadata, null, 2)}\n`, "utf8"),
  ]);
  return { outputPath: absoluteOutput, metadataPath: absoluteMetadata, ...metadata };
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  const [specPath, outputPath, metadataPath] = process.argv.slice(2);
  if (!specPath || !outputPath) {
    console.error("사용법: node scripts/build-patch-data.mjs <build.json> <출력.p2kp> [메타데이터.json]");
    process.exitCode = 2;
  } else {
    try {
      const result = await buildPatchData(specPath, outputPath, metadataPath);
      console.log(`패치 데이터 생성 완료: ${result.outputPath}`);
      console.log(`메타데이터 생성 완료: ${result.metadataPath}`);
      console.log(`size   ${result.patch.size}`);
      console.log(`sha256 ${result.patch.sha256}`);
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}
