import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, open, stat } from "node:fs/promises";
import { basename, dirname, join, normalize, sep } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createInflateRaw } from "node:zlib";
import { loadPatcherDirectory } from "./patcher-config.mjs";

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const UTF8_FLAG = 0x0800;
const DEFAULT_LIMITS = {
  entries: 256,
  compressedBytes: 2 * 1024 * 1024 * 1024,
  uncompressedBytes: 3 * 1024 * 1024 * 1024,
};

const CRC_TABLE = new Uint32Array(256);
for (let index = 0; index < 256; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  CRC_TABLE[index] = value >>> 0;
}

function crc32Update(crc, bytes) {
  let value = crc;
  for (const byte of bytes) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return value >>> 0;
}

class ExactSize extends Transform {
  constructor(expected, name) {
    super();
    this.expected = expected;
    this.name = name;
    this.received = 0;
  }

  _transform(chunk, encoding, callback) {
    this.received += chunk.length;
    if (this.received > this.expected) callback(new Error(`ZIP 항목이 선언된 크기를 넘었습니다: ${this.name}`));
    else callback(null, chunk);
  }

  _flush(callback) {
    if (this.received !== this.expected) callback(new Error(`ZIP 항목 크기가 선언과 다릅니다: ${this.name}`));
    else callback();
  }
}

async function crcAndSize(path) {
  let crc = 0xffffffff;
  let size = 0;
  for await (const chunk of createReadStream(path)) {
    crc = crc32Update(crc, chunk);
    size += chunk.length;
  }
  return { crc: (crc ^ 0xffffffff) >>> 0, size };
}

function safePackageName(value) {
  if (!value || value.includes("\\") || value.includes("\0") || value.startsWith("/") || value.includes("//")) {
    throw new Error(`ZIP 내부 경로가 올바르지 않습니다: ${JSON.stringify(value)}`);
  }
  const parts = value.split("/").filter(Boolean);
  if (parts.some((part) => part === "." || part === "..")) {
    throw new Error(`ZIP 내부 경로가 안전하지 않습니다: ${value}`);
  }
  return parts.join("/") + (value.endsWith("/") ? "/" : "");
}

function safeJoin(root, relativePath) {
  const result = normalize(join(root, relativePath));
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  if (!result.startsWith(prefix)) throw new Error(`ZIP 경로가 대상 폴더를 벗어납니다: ${relativePath}`);
  return result;
}

async function readRange(handle, position, length) {
  const value = Buffer.alloc(length);
  const { bytesRead } = await handle.read(value, 0, length, position);
  if (bytesRead !== length) throw new Error("ZIP 파일을 끝까지 읽지 못했습니다.");
  return value;
}

function decodeName(buffer, flags) {
  if (!(flags & UTF8_FLAG) && [...buffer].some((byte) => byte > 0x7f)) {
    throw new Error("ZIP 내부 파일 이름은 UTF-8이어야 합니다.");
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
}

function stripWrapper(entries) {
  if (entries.some((entry) => entry.name === "config.json")) return entries;
  const files = entries.filter((entry) => !entry.isDirectory);
  const first = files[0]?.name.split("/")[0];
  if (!first || !files.every((entry) => entry.name.startsWith(`${first}/`))) {
    throw new Error("ZIP 루트에서 config.json을 찾을 수 없습니다.");
  }
  const prefix = `${first}/`;
  const stripped = entries
    .filter((entry) => entry.name !== prefix)
    .map((entry) => ({ ...entry, name: entry.name.slice(prefix.length) }));
  if (!stripped.some((entry) => entry.name === "config.json")) {
    throw new Error("ZIP 루트에서 config.json을 찾을 수 없습니다.");
  }
  return stripped;
}

export async function inspectZipPackage(zipPath, customLimits = {}) {
  const limits = { ...DEFAULT_LIMITS, ...customLimits };
  const info = await stat(zipPath);
  if (!info.isFile() || info.size < 22) throw new Error("올바른 ZIP 파일이 아닙니다.");
  if (info.size > limits.compressedBytes) throw new Error("패치 ZIP이 서버 허용 크기를 넘었습니다.");
  const handle = await open(zipPath, "r");
  try {
    const tailLength = Math.min(info.size, 22 + 0xffff);
    const tailOffset = info.size - tailLength;
    const tail = await readRange(handle, tailOffset, tailLength);
    let eocdOffset = -1;
    for (let index = tail.length - 22; index >= 0; index -= 1) {
      if (tail.readUInt32LE(index) === EOCD_SIGNATURE) {
        eocdOffset = index;
        break;
      }
    }
    if (eocdOffset < 0) throw new Error("ZIP 중앙 디렉터리를 찾을 수 없습니다.");
    const eocd = tail.subarray(eocdOffset);
    const disk = eocd.readUInt16LE(4);
    const centralDisk = eocd.readUInt16LE(6);
    const diskEntries = eocd.readUInt16LE(8);
    const totalEntries = eocd.readUInt16LE(10);
    const centralSize = eocd.readUInt32LE(12);
    const centralOffset = eocd.readUInt32LE(16);
    if (disk !== 0 || centralDisk !== 0 || diskEntries !== totalEntries) throw new Error("분할 ZIP은 지원하지 않습니다.");
    if (totalEntries === 0 || totalEntries === 0xffff || totalEntries > limits.entries) {
      throw new Error("ZIP 파일 항목 수가 올바르지 않습니다.");
    }
    if (centralSize === 0xffffffff || centralOffset === 0xffffffff || centralOffset + centralSize > info.size) {
      throw new Error("ZIP64 또는 손상된 ZIP은 지원하지 않습니다.");
    }
    const central = await readRange(handle, centralOffset, centralSize);
    const entries = [];
    let cursor = 0;
    let uncompressedTotal = 0;
    for (let index = 0; index < totalEntries; index += 1) {
      if (cursor + 46 > central.length || central.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) {
        throw new Error("ZIP 중앙 디렉터리가 손상됐습니다.");
      }
      const madeBy = central.readUInt16LE(cursor + 4);
      const flags = central.readUInt16LE(cursor + 8);
      const method = central.readUInt16LE(cursor + 10);
      const crc = central.readUInt32LE(cursor + 16);
      const compressedSize = central.readUInt32LE(cursor + 20);
      const uncompressedSize = central.readUInt32LE(cursor + 24);
      const nameLength = central.readUInt16LE(cursor + 28);
      const extraLength = central.readUInt16LE(cursor + 30);
      const commentLength = central.readUInt16LE(cursor + 32);
      const diskStart = central.readUInt16LE(cursor + 34);
      const externalAttributes = central.readUInt32LE(cursor + 38);
      const localOffset = central.readUInt32LE(cursor + 42);
      const end = cursor + 46 + nameLength + extraLength + commentLength;
      if (end > central.length || diskStart !== 0 || [compressedSize, uncompressedSize, localOffset].includes(0xffffffff)) {
        throw new Error("ZIP 항목 정보가 손상됐습니다.");
      }
      if (flags & 0x0001) throw new Error("암호화 ZIP은 지원하지 않습니다.");
      if (![0, 8].includes(method)) throw new Error(`지원하지 않는 ZIP 압축 방식입니다: ${method}`);
      const name = safePackageName(decodeName(central.subarray(cursor + 46, cursor + 46 + nameLength), flags));
      const isDirectory = name.endsWith("/");
      const unixType = (madeBy >>> 8) === 3 ? ((externalAttributes >>> 16) & 0o170000) : 0;
      if (unixType === 0o120000) throw new Error("ZIP 심볼릭 링크는 허용하지 않습니다.");
      if (!isDirectory) uncompressedTotal += uncompressedSize;
      if (uncompressedTotal > limits.uncompressedBytes) throw new Error("압축 해제 크기가 서버 허용량을 넘었습니다.");
      entries.push({
        name,
        isDirectory,
        flags,
        method,
        crc,
        compressedSize,
        uncompressedSize,
        localOffset,
      });
      cursor = end;
    }
    if (cursor !== central.length) throw new Error("ZIP 중앙 디렉터리 뒤에 예상하지 못한 데이터가 있습니다.");
    const stripped = stripWrapper(entries);
    const names = new Set();
    for (const entry of stripped) {
      if (!entry.name) continue;
      if (names.has(entry.name)) throw new Error(`ZIP 내부 경로가 중복됩니다: ${entry.name}`);
      names.add(entry.name);
      if (entry.isDirectory) {
        if (entry.name !== "files/") throw new Error(`허용하지 않은 ZIP 폴더입니다: ${entry.name}`);
      } else if (entry.name !== "config.json" && !(entry.name.startsWith("files/") && basename(entry.name) === entry.name.slice(6))) {
        throw new Error(`패치 패키지에 허용하지 않은 파일이 있습니다: ${entry.name}`);
      }
    }
    return { entries: stripped.filter((entry) => entry.name), size: info.size };
  } finally {
    await handle.close();
  }
}

async function entryDataOffset(handle, entry) {
  const header = await readRange(handle, entry.localOffset, 30);
  if (header.readUInt32LE(0) !== LOCAL_SIGNATURE) throw new Error(`ZIP 로컬 헤더가 손상됐습니다: ${entry.name}`);
  if (header.readUInt16LE(8) !== entry.method || header.readUInt16LE(6) & 0x0001) {
    throw new Error(`ZIP 로컬 헤더와 중앙 디렉터리가 다릅니다: ${entry.name}`);
  }
  const nameLength = header.readUInt16LE(26);
  const extraLength = header.readUInt16LE(28);
  return entry.localOffset + 30 + nameLength + extraLength;
}

export async function extractZipPackage(zipPath, targetDirectory, customLimits = {}) {
  const inspected = await inspectZipPackage(zipPath, customLimits);
  await mkdir(targetDirectory, { recursive: true });
  const handle = await open(zipPath, "r");
  try {
    for (const entry of inspected.entries) {
      const outputPath = safeJoin(targetDirectory, entry.name.replace(/\/$/, ""));
      if (entry.isDirectory) {
        await mkdir(outputPath, { recursive: true });
        continue;
      }
      await mkdir(dirname(outputPath), { recursive: true });
      const dataOffset = await entryDataOffset(handle, entry);
      if (dataOffset + entry.compressedSize > inspected.size) throw new Error(`ZIP 항목 범위가 잘못됐습니다: ${entry.name}`);
      const source = createReadStream(zipPath, {
        start: dataOffset,
        end: dataOffset + entry.compressedSize - 1,
      });
      const exactSize = new ExactSize(entry.uncompressedSize, entry.name);
      if (entry.method === 0) await pipeline(source, exactSize, createWriteStream(outputPath, { flags: "wx" }));
      else await pipeline(source, createInflateRaw(), exactSize, createWriteStream(outputPath, { flags: "wx" }));
      const actual = await crcAndSize(outputPath);
      if (actual.size !== entry.uncompressedSize || actual.crc !== entry.crc) {
        throw new Error(`ZIP 항목 검증에 실패했습니다: ${entry.name}`);
      }
    }
  } finally {
    await handle.close();
  }
  const patcher = await loadPatcherDirectory(targetDirectory, null, { verifyHash: true });
  const expectedFiles = new Set(["config.json", `files/${patcher.config.patch.file}`]);
  const actualFiles = new Set(inspected.entries.filter((entry) => !entry.isDirectory).map((entry) => entry.name));
  if (actualFiles.size !== expectedFiles.size || [...actualFiles].some((name) => !expectedFiles.has(name))) {
    throw new Error("ZIP에는 config.json과 config에서 지정한 패치 파일 하나만 포함할 수 있습니다.");
  }
  return patcher;
}

async function packageFiles(sourceDirectory) {
  const patcher = await loadPatcherDirectory(sourceDirectory, null, { verifyHash: true });
  return {
    patcher,
    files: [
      { name: "config.json", path: join(sourceDirectory, "config.json") },
      { name: `files/${patcher.config.patch.file}`, path: patcher.patchPath },
    ],
  };
}

function localHeader(name, size, crc) {
  const nameBytes = Buffer.from(name, "utf8");
  const header = Buffer.alloc(30 + nameBytes.length);
  header.writeUInt32LE(LOCAL_SIGNATURE, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(UTF8_FLAG, 6);
  header.writeUInt16LE(0, 8);
  header.writeUInt32LE(crc, 14);
  header.writeUInt32LE(size, 18);
  header.writeUInt32LE(size, 22);
  header.writeUInt16LE(nameBytes.length, 26);
  nameBytes.copy(header, 30);
  return header;
}

function centralHeader(entry) {
  const nameBytes = Buffer.from(entry.name, "utf8");
  const header = Buffer.alloc(46 + nameBytes.length);
  header.writeUInt32LE(CENTRAL_SIGNATURE, 0);
  header.writeUInt16LE(0x0314, 4);
  header.writeUInt16LE(20, 6);
  header.writeUInt16LE(UTF8_FLAG, 8);
  header.writeUInt16LE(0, 10);
  header.writeUInt32LE(entry.crc, 16);
  header.writeUInt32LE(entry.size, 20);
  header.writeUInt32LE(entry.size, 24);
  header.writeUInt16LE(nameBytes.length, 28);
  header.writeUInt32LE((0o100644 << 16) >>> 0, 38);
  header.writeUInt32LE(entry.offset, 42);
  nameBytes.copy(header, 46);
  return header;
}

export async function createZipPackage(sourceDirectory, outputPath) {
  const { patcher, files } = await packageFiles(sourceDirectory);
  const output = await open(outputPath, "w");
  let offset = 0;
  const write = async (chunk) => {
    let cursor = 0;
    while (cursor < chunk.length) {
      const { bytesWritten } = await output.write(chunk, cursor, chunk.length - cursor, offset);
      if (bytesWritten === 0) throw new Error("ZIP 출력 파일에 쓰지 못했습니다.");
      cursor += bytesWritten;
      offset += bytesWritten;
    }
  };
  const entries = [];
  try {
    for (const file of files) {
      const details = await crcAndSize(file.path);
      if (details.size > 0xffffffff || offset > 0xffffffff) throw new Error("ZIP32 크기 제한을 넘었습니다.");
      const entry = { ...file, ...details, offset };
      await write(localHeader(file.name, details.size, details.crc));
      for await (const chunk of createReadStream(file.path)) await write(chunk);
      entries.push(entry);
    }
    const centralOffset = offset;
    for (const entry of entries) await write(centralHeader(entry));
    const centralSize = offset - centralOffset;
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(EOCD_SIGNATURE, 0);
    eocd.writeUInt16LE(entries.length, 8);
    eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(centralSize, 12);
    eocd.writeUInt32LE(centralOffset, 16);
    await write(eocd);
    await output.sync();
  } finally {
    await output.close();
  }
  return { slug: patcher.config.slug, version: patcher.config.version, size: offset, outputPath };
}
