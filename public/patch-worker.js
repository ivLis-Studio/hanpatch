"use strict";

importScripts("sha256.js");

const SECTOR_SIZE = 2048;
const IO_CHUNK_SIZE = 4 * 1024 * 1024;
const PATCH_FORMAT_VERSION = 2;
const ENGINE_FORMATS = Object.freeze({
  "psp-iso-delta-v2": "PSPDELTA",
  "p2kofsp1-v2": "P2KOFSP1",
});
const STRATEGY_FIXED_DELTA = 0;
const STRATEGY_SHRINK_REPLACE = 1;
const STRATEGY_EXTENDED_EBOOT = 2;
const UPDATE_FILES = [
  "/PSP_GAME/SYSDIR/UPDATE/PARAM.SFO",
  "/PSP_GAME/SYSDIR/UPDATE/EBOOT.BIN",
  "/PSP_GAME/SYSDIR/UPDATE/DATA.BIN",
];

const PHASE_RANGES = {
  validate: [0, 0.23],
  download: [0.23, 0.36],
  copy: [0.36, 0.7],
  apply: [0.7, 0.84],
  verify: [0.84, 1],
};

let cancelled = false;
let activeWriter = null;

class CancelledError extends Error {
  constructor() {
    super("패치가 중단됐습니다.");
    this.name = "CancelledError";
  }
}

function checkCancelled() {
  if (cancelled) throw new CancelledError();
}

function progress(phase, fraction, message) {
  const [start, end] = PHASE_RANGES[phase];
  const local = Math.max(0, Math.min(1, Number(fraction) || 0));
  postMessage({
    type: "progress",
    phase,
    fraction: start + (end - start) * local,
    message,
  });
}

function invalid(message) {
  const error = new Error(message);
  error.name = "InvalidDataError";
  return error;
}

function byteHex(bytes) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function bytesEqual(left, right) {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function ascii(bytes) {
  let result = "";
  for (const byte of bytes) result += String.fromCharCode(byte);
  return result;
}

async function readExact(file, offset, length) {
  checkCancelled();
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > file.size) {
    throw invalid("파일 읽기 범위가 잘못됐습니다.");
  }
  const data = new Uint8Array(await file.slice(offset, offset + length).arrayBuffer());
  if (data.length !== length) throw invalid("파일을 끝까지 읽지 못했습니다.");
  return data;
}

function readU64(view, offset) {
  const value = view.getBigUint64(offset, true);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw invalid("64비트 크기 값이 브라우저 범위를 넘었습니다.");
  return Number(value);
}

function bothEndianU32(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw invalid("ISO 레코드 값이 32비트 범위를 넘었습니다.");
  }
  const bytes = new Uint8Array(8);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, value, true);
  view.setUint32(4, value, false);
  return bytes;
}

function recordFromBytes(bytes, recordOffset) {
  if (bytes.length < 34) throw invalid("ISO9660 디렉터리 레코드가 너무 짧습니다.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    dataOffset: view.getUint32(2, true) * SECTOR_SIZE,
    dataLength: view.getUint32(10, true),
    recordOffset,
    isDirectory: (bytes[25] & 0x02) !== 0,
  };
}

function normalizedIdentifier(bytes) {
  return ascii(bytes).split(";", 1)[0].replace(/\.+$/, "").toUpperCase();
}

class IsoImage {
  constructor(file) {
    this.file = file;
    this.recordCache = new Map();
    this.root = null;
  }

  async primaryRoot() {
    if (this.root) return this.root;
    for (let sector = 16; sector < 64; sector += 1) {
      const offset = sector * SECTOR_SIZE;
      const descriptor = await readExact(this.file, offset, SECTOR_SIZE);
      if (ascii(descriptor.subarray(1, 6)) !== "CD001") {
        throw invalid("ISO9660 볼륨 디스크립터를 찾을 수 없습니다.");
      }
      if (descriptor[0] === 1) {
        const length = descriptor[156];
        this.root = recordFromBytes(descriptor.subarray(156, 156 + length), offset + 156);
        return this.root;
      }
      if (descriptor[0] === 255) break;
    }
    throw invalid("ISO9660 기본 볼륨 디스크립터가 없습니다.");
  }

  async findChild(directory, name) {
    if (!directory.isDirectory) throw invalid("ISO 경로의 중간 항목이 폴더가 아닙니다.");
    if (directory.dataLength > 64 * 1024 * 1024) throw invalid("ISO 폴더가 지나치게 큽니다.");
    const data = await readExact(this.file, directory.dataOffset, directory.dataLength);
    const wanted = name.toUpperCase();
    let cursor = 0;
    while (cursor < data.length) {
      const recordLength = data[cursor];
      if (recordLength === 0) {
        cursor = (Math.floor(cursor / SECTOR_SIZE) + 1) * SECTOR_SIZE;
        continue;
      }
      if (recordLength < 34 || cursor + recordLength > data.length) {
        throw invalid("손상된 ISO9660 폴더 레코드입니다.");
      }
      const record = data.subarray(cursor, cursor + recordLength);
      const identifierLength = record[32];
      if (33 + identifierLength > record.length) throw invalid("손상된 ISO9660 파일 이름입니다.");
      const identifier = record.subarray(33, 33 + identifierLength);
      if (!(identifier.length === 1 && (identifier[0] === 0 || identifier[0] === 1)) && normalizedIdentifier(identifier) === wanted) {
        return recordFromBytes(record, directory.dataOffset + cursor);
      }
      cursor += recordLength;
    }
    throw invalid(`ISO 내부에서 ${name} 항목을 찾을 수 없습니다.`);
  }

  async findRecord(path) {
    if (this.recordCache.has(path)) return this.recordCache.get(path);
    let current = await this.primaryRoot();
    for (const component of path.split("/").filter(Boolean)) current = await this.findChild(current, component);
    this.recordCache.set(path, current);
    return current;
  }
}

async function hashRange(file, offset, length, onProgress = null) {
  const hasher = new Sha256();
  let completed = 0;
  while (completed < length) {
    checkCancelled();
    const amount = Math.min(IO_CHUNK_SIZE, length - completed);
    hasher.update(await readExact(file, offset + completed, amount));
    completed += amount;
    onProgress?.(completed, length);
  }
  return hasher.hex();
}

async function validateDiscId(iso, discId) {
  const record = await iso.findRecord("/PSP_GAME/PARAM.SFO");
  if (record.dataLength === 0 || record.dataLength > 1024 * 1024) {
    throw invalid("PARAM.SFO 크기가 올바르지 않습니다.");
  }
  const data = await readExact(iso.file, record.dataOffset, record.dataLength);
  const wanted = new TextEncoder().encode(discId);
  let found = false;
  outer: for (let offset = 0; offset <= data.length - wanted.length; offset += 1) {
    for (let index = 0; index < wanted.length; index += 1) {
      if (data[offset + index] !== wanted[index]) continue outer;
    }
    found = true;
    break;
  }
  if (!found) {
    throw invalid(`지원하지 않는 게임입니다. 일본 ${discId} 원본이 필요합니다.`);
  }
}

async function validateSource(file, engineData) {
  const iso = new IsoImage(file);
  progress("validate", 0, `게임 ID ${engineData.discId}을 확인하고 있습니다.`);
  await validateDiscId(iso, engineData.discId);
  const total = engineData.entries.reduce((sum, entry) => sum + entry.sourceSize, 0);
  let completed = 0;
  const records = new Map();

  for (const entry of engineData.entries) {
    checkCancelled();
    const record = await iso.findRecord(entry.path);
    records.set(entry.path, record);
    if (record.isDirectory || record.dataLength !== entry.sourceSize) {
      throw invalid(`지원하지 않는 원본입니다: ${entry.path} 크기가 다릅니다.`);
    }
    const actual = await hashRange(file, record.dataOffset, record.dataLength, (done) => {
      progress("validate", (completed + done) / total, `원본 검증: ${entry.path.split("/").at(-1)}`);
    });
    if (!entry.sourceSha256Variants.includes(actual)) {
      throw invalid(`지원하지 않는 원본입니다: ${entry.path} 내용이 깨끗한 원본과 다릅니다.`);
    }
    completed += entry.sourceSize;
  }
  if (engineData.entries.some((entry) => entry.strategy === STRATEGY_EXTENDED_EBOOT)) {
    const updater = await iso.findRecord("/PSP_GAME/SYSDIR/UPDATE/EBOOT.BIN");
    if (updater.isDirectory || updater.dataLength === 0) throw invalid("업데이터 EBOOT 슬롯을 확인할 수 없습니다.");
  }
  progress("validate", 1, "지원하는 깨끗한 원본입니다.");
  return { iso, records };
}

async function verifyCachedPatch(file, manifest) {
  if (file.size !== manifest.patch.size) return false;
  const actual = await hashRange(file, 0, file.size, (done, total) => {
    progress("download", done / total, "저장된 패치 데이터를 확인하고 있습니다.");
  });
  return actual === manifest.patch.sha256;
}

async function ensurePatch(manifest) {
  const root = await navigator.storage.getDirectory();
  const directory = await root.getDirectoryHandle("psp-web-patches", { create: true });
  const cacheName = `${manifest.slug}-${manifest.version}-${manifest.patch.sha256}.patch`;
  let handle = await directory.getFileHandle(cacheName, { create: true });
  let cached = await handle.getFile();
  if (cached.size > 0 && await verifyCachedPatch(cached, manifest)) {
    progress("download", 1, "검증된 패치 데이터를 사용합니다.");
    return cached;
  }
  if (cached.size > 0) {
    await directory.removeEntry(cacheName);
    handle = await directory.getFileHandle(cacheName, { create: true });
  }

  progress("download", 0, "패치 데이터를 다운로드하고 있습니다.");
  const response = await fetch(manifest.patch.url, { cache: "no-store" });
  if (!response.ok || !response.body) throw new Error(`패치 다운로드 실패: HTTP ${response.status}`);
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength !== manifest.patch.size) {
    throw invalid("서버 패치 크기가 매니페스트와 다릅니다.");
  }
  const reader = response.body.getReader();
  const writer = await handle.createWritable();
  const hasher = new Sha256();
  let received = 0;
  try {
    while (true) {
      checkCancelled();
      const { done, value } = await reader.read();
      if (done) break;
      hasher.update(value);
      await writer.write(value);
      received += value.length;
      progress("download", received / manifest.patch.size, `패치 다운로드: ${Math.round((received / manifest.patch.size) * 100)}%`);
    }
    if (received !== manifest.patch.size || hasher.hex() !== manifest.patch.sha256) {
      throw invalid("다운로드한 패치 데이터의 SHA-256이 올바르지 않습니다.");
    }
    await writer.close();
  } catch (error) {
    await reader.cancel().catch(() => {});
    await writer.abort().catch(() => {});
    await directory.removeEntry(cacheName).catch(() => {});
    throw error;
  }
  cached = await handle.getFile();
  progress("download", 1, "패치 데이터를 다운로드하고 검증했습니다.");
  return cached;
}

async function parsePatch(file, expectedMagic) {
  let cursor = 0;
  const take = async (length) => {
    const value = await readExact(file, cursor, length);
    cursor += length;
    return value;
  };
  const u8 = async () => (await take(1))[0];
  const u16 = async () => new DataView((await take(2)).buffer).getUint16(0, true);
  const u32 = async () => new DataView((await take(4)).buffer).getUint32(0, true);
  const u64 = async () => readU64(new DataView((await take(8)).buffer), 0);

  if (ascii(await take(8)) !== expectedMagic) throw invalid("패치 데이터 형식이 올바르지 않습니다.");
  const version = await u32();
  if (version !== PATCH_FORMAT_VERSION) throw invalid(`지원하지 않는 패치 데이터 버전입니다: ${version}`);
  const count = await u32();
  if (count === 0 || count > 32) throw invalid("패치 항목 수가 올바르지 않습니다.");
  const entries = [];

  for (let entryIndex = 0; entryIndex < count; entryIndex += 1) {
    const strategy = await u8();
    if (![STRATEGY_FIXED_DELTA, STRATEGY_SHRINK_REPLACE, STRATEGY_EXTENDED_EBOOT].includes(strategy)) {
      throw invalid("알 수 없는 패치 전략입니다.");
    }
    const pathLength = await u16();
    if (pathLength === 0 || pathLength > 1024) throw invalid("패치 대상 경로 길이가 올바르지 않습니다.");
    const path = new TextDecoder("utf-8", { fatal: true }).decode(await take(pathLength));
    const sourceSize = await u64();
    const targetSize = await u64();
    const hashCount = await u16();
    if (hashCount === 0 || hashCount > 64) throw invalid("원본 해시 수가 올바르지 않습니다.");
    const sourceSha256Variants = [];
    for (let hashIndex = 0; hashIndex < hashCount; hashIndex += 1) sourceSha256Variants.push(byteHex(await take(32)));
    const targetSha256 = byteHex(await take(32));
    const segmentCount = await u32();
    if (segmentCount === 0 || segmentCount > 100_000) throw invalid("패치 조각 수가 올바르지 않습니다.");
    const segments = [];
    let previousEnd = 0;
    for (let segmentIndex = 0; segmentIndex < segmentCount; segmentIndex += 1) {
      const targetOffset = await u64();
      const rawLength = await u64();
      const encoding = await u8();
      const storedLength = await u64();
      const payloadOffset = cursor;
      if (
        rawLength === 0 || storedLength === 0 || targetOffset < previousEnd
        || targetOffset + rawLength > targetSize || ![0, 1].includes(encoding)
        || payloadOffset + storedLength > file.size
      ) {
        throw invalid("손상된 패치 조각을 발견했습니다.");
      }
      cursor += storedLength;
      previousEnd = targetOffset + rawLength;
      segments.push({ targetOffset, rawLength, encoding, storedLength, payloadOffset });
    }
    if (strategy === STRATEGY_FIXED_DELTA && sourceSize !== targetSize) throw invalid("고정 크기 패치의 파일 크기가 다릅니다.");
    if (strategy === STRATEGY_SHRINK_REPLACE && targetSize > sourceSize) throw invalid("교체 파일이 원본 슬롯보다 큽니다.");
    entries.push({ strategy, path, sourceSize, targetSize, sourceSha256Variants, targetSha256, segments });
  }
  if (cursor !== file.size) throw invalid("패치 데이터 뒤에 알 수 없는 바이트가 있습니다.");
  return entries;
}

function comparePatchMetadata(entries, engineData, expectedMagic) {
  if (engineData.format !== expectedMagic || engineData.formatVersion !== PATCH_FORMAT_VERSION) {
    throw invalid("웹 매니페스의 패치 포맷이 올바르지 않습니다.");
  }
  if (entries.length !== engineData.entries.length) throw invalid("패치 파일과 웹 매니페스트의 항목 수가 다릅니다.");
  for (const expected of engineData.entries) {
    const actual = entries.find((entry) => entry.path === expected.path);
    if (
      !actual || actual.strategy !== expected.strategy || actual.sourceSize !== expected.sourceSize
      || actual.targetSize !== expected.targetSize || actual.targetSha256 !== expected.targetSha256
      || actual.sourceSha256Variants.length !== expected.sourceSha256Variants.length
      || actual.sourceSha256Variants.some((hash, index) => hash !== expected.sourceSha256Variants[index])
    ) {
      throw invalid(`패치 파일과 웹 매니페스트가 다릅니다: ${expected.path}`);
    }
  }
}

async function decodeSegment(patchFile, segment) {
  const stored = await readExact(patchFile, segment.payloadOffset, segment.storedLength);
  if (segment.encoding === 0) {
    if (stored.length !== segment.rawLength) throw invalid("원시 패치 조각 크기가 잘못됐습니다.");
    return stored;
  }
  const stream = new Blob([stored]).stream().pipeThrough(new DecompressionStream("deflate"));
  const raw = new Uint8Array(await new Response(stream).arrayBuffer());
  if (raw.length !== segment.rawLength) throw invalid("패치 조각의 압축 해제 크기가 잘못됐습니다.");
  return raw;
}

async function writeAt(writer, position, data) {
  checkCancelled();
  await writer.write({ type: "write", position, data });
}

async function zeroRange(writer, offset, length) {
  const zeroes = new Uint8Array(IO_CHUNK_SIZE);
  let completed = 0;
  while (completed < length) {
    const amount = Math.min(zeroes.length, length - completed);
    await writeAt(writer, offset + completed, zeroes.subarray(0, amount));
    completed += amount;
  }
}

async function copyRange(source, writer, sourceOffset, length, targetOffset, onProgress = null) {
  let completed = 0;
  while (completed < length) {
    checkCancelled();
    const amount = Math.min(IO_CHUNK_SIZE, length - completed);
    const data = await readExact(source, sourceOffset + completed, amount);
    await writeAt(writer, targetOffset + completed, data);
    completed += amount;
    onProgress?.(completed, length);
  }
}

async function patchRecordSize(writer, record, size) {
  await writeAt(writer, record.recordOffset + 10, bothEndianU32(size));
}

async function patchRecordExtent(writer, record, extent) {
  await writeAt(writer, record.recordOffset + 2, bothEndianU32(extent));
}

async function patchVolumeSpaceSize(source, writer, sectors) {
  let patched = 0;
  for (let sector = 16; sector < 64; sector += 1) {
    const offset = sector * SECTOR_SIZE;
    const descriptor = await readExact(source, offset, SECTOR_SIZE);
    if (ascii(descriptor.subarray(1, 6)) !== "CD001") break;
    if (descriptor[0] === 1 || descriptor[0] === 2) {
      await writeAt(writer, offset + 80, bothEndianU32(sectors));
      patched += 1;
    }
    if (descriptor[0] === 255) break;
  }
  if (patched === 0) throw invalid("ISO 볼륨 크기 레코드를 갱신할 수 없습니다.");
}

function align(value, boundary) {
  return Math.ceil(value / boundary) * boundary;
}

function rangesOverlap(leftOffset, leftLength, rightOffset, rightLength) {
  return leftLength > 0 && rightLength > 0
    && leftOffset < rightOffset + rightLength
    && rightOffset < leftOffset + leftLength;
}

async function applySegments(writer, patchFile, baseOffset, entry, state) {
  for (const segment of entry.segments) {
    checkCancelled();
    const raw = await decodeSegment(patchFile, segment);
    await writeAt(writer, baseOffset + segment.targetOffset, raw);
    state.completed += segment.rawLength;
    progress("apply", state.completed / state.total, `패치 적용: ${entry.path.split("/").at(-1)}`);
  }
}

async function applyPatch(source, outputHandle, patchFile, entries, validated) {
  const writer = await outputHandle.createWritable();
  activeWriter = writer;
  const relocated = [];
  try {
    await copyRange(source, writer, 0, source.size, 0, (done, total) => {
      progress("copy", done / total, `원본 ISO를 새 파일로 복사하고 있습니다. ${Math.round((done / total) * 100)}%`);
    });
    await writer.truncate(source.size);

    const applyState = {
      completed: 0,
      total: entries.reduce((sum, entry) => sum + entry.segments.reduce((inner, segment) => inner + segment.rawLength, 0), 0),
    };
    for (const entry of entries.filter((item) => item.strategy !== STRATEGY_EXTENDED_EBOOT)) {
      const record = validated.records.get(entry.path);
      await applySegments(writer, patchFile, record.dataOffset, entry, applyState);
      if (entry.strategy === STRATEGY_SHRINK_REPLACE) {
        await zeroRange(writer, record.dataOffset + entry.targetSize, record.dataLength - entry.targetSize);
        await patchRecordSize(writer, record, entry.targetSize);
      }
    }

    const ebootEntry = entries.find((entry) => entry.strategy === STRATEGY_EXTENDED_EBOOT);
    if (!ebootEntry) {
      await writer.close();
      activeWriter = null;
      progress("apply", 1, "패치 데이터를 모두 적용했습니다.");
      return relocated;
    }
    const gameRecord = validated.records.get(ebootEntry.path);
    const updaterRecord = await validated.iso.findRecord("/PSP_GAME/SYSDIR/UPDATE/EBOOT.BIN");
    if (
      gameRecord.dataOffset + gameRecord.dataLength > updaterRecord.dataOffset
      || gameRecord.dataOffset + ebootEntry.targetSize > updaterRecord.dataOffset + updaterRecord.dataLength
    ) {
      throw invalid("확장 EBOOT가 원본 EBOOT/업데이터 슬롯에 맞지 않습니다.");
    }

    let appendOffset = source.size;
    for (const path of UPDATE_FILES) {
      const record = await validated.iso.findRecord(path);
      if (record.isDirectory) throw invalid(`업데이트 파일 레코드가 올바르지 않습니다: ${path}`);
      if (!rangesOverlap(gameRecord.dataOffset, ebootEntry.targetSize, record.dataOffset, record.dataLength)) continue;
      const relocatedOffset = align(appendOffset, SECTOR_SIZE);
      if (relocatedOffset > appendOffset) await zeroRange(writer, appendOffset, relocatedOffset - appendOffset);
      await copyRange(source, writer, record.dataOffset, record.dataLength, relocatedOffset);
      await patchRecordExtent(writer, record, relocatedOffset / SECTOR_SIZE);
      relocated.push({ path, record, relocatedOffset });
      appendOffset = relocatedOffset + record.dataLength;
    }
    if (!relocated.some((entry) => entry.path === "/PSP_GAME/SYSDIR/UPDATE/EBOOT.BIN")) {
      throw invalid("확장 EBOOT와 겹치는 업데이터 EBOOT를 찾을 수 없습니다.");
    }

    const finalSize = align(appendOffset, SECTOR_SIZE);
    await writer.truncate(finalSize);
    await applySegments(writer, patchFile, gameRecord.dataOffset, ebootEntry, applyState);
    await patchRecordSize(writer, gameRecord, ebootEntry.targetSize);
    await patchVolumeSpaceSize(source, writer, finalSize / SECTOR_SIZE);
    await writer.close();
    activeWriter = null;
    progress("apply", 1, "패치 데이터를 모두 적용했습니다.");
    return relocated;
  } catch (error) {
    await writer.abort().catch(() => {});
    activeWriter = null;
    throw error;
  }
}

async function verifyOutput(outputHandle, source, entries, relocated) {
  const output = await outputHandle.getFile();
  const iso = new IsoImage(output);
  const targetTotal = entries.reduce((sum, entry) => sum + entry.targetSize, 0);
  const relocatedTotal = relocated.reduce((sum, entry) => sum + entry.record.dataLength * 2, 0);
  const total = targetTotal + relocatedTotal + output.size;
  let completed = 0;

  for (const entry of entries) {
    const record = await iso.findRecord(entry.path);
    if (record.dataLength !== entry.targetSize) throw invalid(`결과 파일 크기 검증 실패: ${entry.path}`);
    const actual = await hashRange(output, record.dataOffset, record.dataLength, (done) => {
      progress("verify", (completed + done) / total, `결과 검증: ${entry.path.split("/").at(-1)}`);
    });
    if (actual !== entry.targetSha256) throw invalid(`결과 SHA-256 검증 실패: ${entry.path}`);
    completed += entry.targetSize;
  }

  for (const item of relocated) {
    const before = await hashRange(source, item.record.dataOffset, item.record.dataLength, (done) => {
      progress("verify", (completed + done) / total, `보존 파일 검증: ${item.path.split("/").at(-1)}`);
    });
    completed += item.record.dataLength;
    const after = await hashRange(output, item.relocatedOffset, item.record.dataLength, (done) => {
      progress("verify", (completed + done) / total, `보존 파일 검증: ${item.path.split("/").at(-1)}`);
    });
    completed += item.record.dataLength;
    if (before !== after) throw invalid(`업데이트 파일 보존 검증 실패: ${item.path}`);
  }

  const sha256 = await hashRange(output, 0, output.size, (done) => {
    progress("verify", (completed + done) / total, `최종 ISO 전체 SHA-256 계산: ${Math.round((done / output.size) * 100)}%`);
  });
  progress("verify", 1, "최종 ISO의 내부 파일과 SHA-256을 검증했습니다.");
  return { output, sha256 };
}

async function run({ file, manifest, outputHandle }) {
  const expectedMagic = ENGINE_FORMATS[manifest.engine];
  if (!expectedMagic || !manifest.engineData) {
    throw invalid("지원하지 않는 패치 엔진 또는 누락된 엔진 정보입니다.");
  }
  const existingOutput = await outputHandle.getFile();
  if (
    existingOutput.name === file.name && existingOutput.size === file.size
    && existingOutput.lastModified === file.lastModified
  ) {
    throw invalid("원본 ISO와 같은 파일을 출력으로 선택할 수 없습니다.");
  }

  const validated = await validateSource(file, manifest.engineData);
  const patchFile = await ensurePatch(manifest);
  const entries = await parsePatch(patchFile, expectedMagic);
  comparePatchMetadata(entries, manifest.engineData, expectedMagic);
  const relocated = await applyPatch(file, outputHandle, patchFile, entries, validated);
  const { output, sha256 } = await verifyOutput(outputHandle, file, entries, relocated);
  return { outputName: output.name, sha256 };
}

self.addEventListener("message", async ({ data }) => {
  if (data?.type === "cancel") {
    cancelled = true;
    return;
  }
  if (data?.type !== "start") return;
  cancelled = false;
  try {
    const result = await run(data);
    postMessage({ type: "done", ...result });
  } catch (error) {
    if (activeWriter) {
      await activeWriter.abort().catch(() => {});
      activeWriter = null;
    }
    if (error instanceof CancelledError || cancelled) {
      postMessage({ type: "cancelled" });
    } else {
      console.error(error);
      postMessage({ type: "error", message: error?.message ?? String(error) });
    }
  }
});
