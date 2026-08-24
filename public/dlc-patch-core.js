(() => {
  "use strict";

  const MAGIC = "P2KODLC1";
  const FORMAT_VERSION = 1;
  const MAX_ENTRY_BYTES = 128 * 1024 * 1024;
  const MAX_COMMAND_BYTES = 256 * 1024 * 1024;
  const OP_COPY = 0;
  const OP_ADD = 1;

  function invalid(message) {
    const error = new Error(message);
    error.name = "InvalidDataError";
    return error;
  }

  function ascii(bytes) {
    let value = "";
    for (const byte of bytes) value += String.fromCharCode(byte);
    return value;
  }

  function hex(bytes) {
    return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  function safeInteger(value, label) {
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw invalid(`${label} 값이 브라우저 범위를 넘었습니다.`);
    return Number(value);
  }

  async function parsePatch(file) {
    if (!file || typeof file.arrayBuffer !== "function") throw invalid("DLC 패치 파일이 올바르지 않습니다.");
    const bytes = new Uint8Array(await file.arrayBuffer());
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let cursor = 0;
    const take = (length) => {
      if (!Number.isSafeInteger(length) || length < 0 || cursor + length > bytes.length) {
        throw invalid("DLC 패치 데이터가 중간에서 잘렸습니다.");
      }
      const result = bytes.subarray(cursor, cursor + length);
      cursor += length;
      return result;
    };
    const u16 = () => {
      const offset = cursor;
      take(2);
      return view.getUint16(offset, true);
    };
    const u32 = () => {
      const offset = cursor;
      take(4);
      return view.getUint32(offset, true);
    };
    const u64 = (label) => {
      const offset = cursor;
      take(8);
      return safeInteger(view.getBigUint64(offset, true), label);
    };

    if (ascii(take(8)) !== MAGIC) throw invalid("DLC 패치 데이터의 형식이 올바르지 않습니다.");
    const version = u32();
    if (version !== FORMAT_VERSION) throw invalid(`지원하지 않는 DLC 패치 데이터 버전입니다: ${version}`);
    const count = u32();
    if (count === 0 || count > 32) throw invalid("DLC 패치 항목 수가 올바르지 않습니다.");
    const entries = [];
    const names = new Set();

    for (let index = 0; index < count; index += 1) {
      const nameLength = u16();
      if (nameLength === 0 || nameLength > 255) throw invalid("DLC 파일 이름 길이가 올바르지 않습니다.");
      const name = new TextDecoder("utf-8", { fatal: true }).decode(take(nameLength));
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/.test(name) || names.has(name)) {
        throw invalid("안전하지 않거나 중복된 DLC 파일 이름입니다.");
      }
      names.add(name);
      const sourceSize = u64(`${name} 원본 크기`);
      const targetSize = u64(`${name} 결과 크기`);
      const sourceSha256 = hex(take(32));
      const targetSha256 = hex(take(32));
      const rawLength = u64(`${name} 명령 크기`);
      const storedLength = u64(`${name} 압축 크기`);
      if (
        sourceSize === 0 || sourceSize > MAX_ENTRY_BYTES
        || targetSize === 0 || targetSize > MAX_ENTRY_BYTES
        || rawLength === 0 || rawLength > MAX_COMMAND_BYTES
        || storedLength === 0 || storedLength > bytes.length - cursor
      ) {
        throw invalid(`${name} DLC 패치 항목 크기가 올바르지 않습니다.`);
      }
      entries.push({
        name,
        sourceSize,
        targetSize,
        sourceSha256,
        targetSha256,
        rawLength,
        stored: take(storedLength).slice(),
      });
    }
    if (cursor !== bytes.length) throw invalid("DLC 패치 데이터 뒤에 알 수 없는 바이트가 있습니다.");
    return entries;
  }

  function compareMetadata(entries, engineData) {
    if (engineData?.format !== MAGIC || engineData?.formatVersion !== FORMAT_VERSION) {
      throw invalid("DLC 웹 매니페스트 형식이 올바르지 않습니다.");
    }
    if (!Array.isArray(engineData.entries) || entries.length !== engineData.entries.length) {
      throw invalid("DLC 패치 파일과 웹 매니페스트의 항목 수가 다릅니다.");
    }
    for (const expected of engineData.entries) {
      const actual = entries.find((entry) => entry.name === expected.name);
      if (
        !actual || actual.sourceSize !== expected.sourceSize || actual.targetSize !== expected.targetSize
        || actual.sourceSha256 !== expected.sourceSha256 || actual.targetSha256 !== expected.targetSha256
      ) {
        throw invalid(`DLC 패치 파일과 웹 매니페스트가 다릅니다: ${expected.name}`);
      }
    }
  }

  async function decodeCommands(entry) {
    const stream = new Blob([entry.stored]).stream().pipeThrough(new DecompressionStream("deflate"));
    const raw = new Uint8Array(await new Response(stream).arrayBuffer());
    if (raw.length !== entry.rawLength) throw invalid(`${entry.name} 패치 명령 크기가 올바르지 않습니다.`);
    return raw;
  }

  async function applyEntry(source, entry) {
    if (!(source instanceof Uint8Array) || source.length !== entry.sourceSize) {
      throw invalid(`${entry.name} 원본 크기가 올바르지 않습니다.`);
    }
    const raw = await decodeCommands(entry);
    const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    let cursor = 0;
    let outputSize = 0;
    const chunks = [];
    const take = (length) => {
      if (!Number.isSafeInteger(length) || length < 0 || cursor + length > raw.length) {
        throw invalid(`${entry.name} 패치 명령이 중간에서 잘렸습니다.`);
      }
      const result = raw.subarray(cursor, cursor + length);
      cursor += length;
      return result;
    };
    const u8 = () => take(1)[0];
    const u64 = (label) => {
      const offset = cursor;
      take(8);
      return safeInteger(view.getBigUint64(offset, true), label);
    };

    while (cursor < raw.length) {
      const opcode = u8();
      let chunk;
      if (opcode === OP_COPY) {
        const offset = u64(`${entry.name} 복사 오프셋`);
        const length = u64(`${entry.name} 복사 길이`);
        if (length === 0 || offset + length > source.length) throw invalid(`${entry.name} 복사 명령이 원본 범위를 벗어났습니다.`);
        chunk = source.subarray(offset, offset + length);
      } else if (opcode === OP_ADD) {
        const length = u64(`${entry.name} 추가 길이`);
        if (length === 0 || length > entry.targetSize) throw invalid(`${entry.name} 추가 명령 크기가 올바르지 않습니다.`);
        chunk = take(length);
      } else {
        throw invalid(`${entry.name}에 알 수 없는 DLC 패치 명령이 있습니다.`);
      }
      outputSize += chunk.length;
      if (outputSize > entry.targetSize) throw invalid(`${entry.name} 패치 결과가 예상 크기를 넘었습니다.`);
      chunks.push(chunk);
    }
    if (outputSize !== entry.targetSize) throw invalid(`${entry.name} 패치 결과 크기가 올바르지 않습니다.`);
    const output = new Uint8Array(outputSize);
    let outputOffset = 0;
    for (const chunk of chunks) {
      output.set(chunk, outputOffset);
      outputOffset += chunk.length;
    }
    return output;
  }

  globalThis.HanpatchDlcCore = Object.freeze({ parsePatch, compareMetadata, applyEntry });
})();
