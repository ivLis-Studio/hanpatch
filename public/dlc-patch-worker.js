"use strict";

importScripts("sha256.js", "dlc-patch-core.js");

const IO_CHUNK_SIZE = 1024 * 1024;
const PHASE_RANGES = {
  validate: [0, 0.25],
  download: [0.25, 0.4],
  copy: [0.4, 0.45],
  apply: [0.45, 0.85],
  verify: [0.85, 1],
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

function invalid(message) {
  const error = new Error(message);
  error.name = "InvalidDataError";
  return error;
}

function progress(phase, fraction, message) {
  const [start, end] = PHASE_RANGES[phase];
  const local = Math.max(0, Math.min(1, Number(fraction) || 0));
  postMessage({ type: "progress", phase, fraction: start + (end - start) * local, message });
}

async function hashFile(file, onProgress = null) {
  const hasher = new Sha256();
  let offset = 0;
  while (offset < file.size) {
    checkCancelled();
    const end = Math.min(offset + IO_CHUNK_SIZE, file.size);
    hasher.update(new Uint8Array(await file.slice(offset, end).arrayBuffer()));
    offset = end;
    onProgress?.(offset, file.size);
  }
  return hasher.hex();
}

function hashBytes(bytes) {
  return new Sha256().update(bytes).hex();
}

async function verifyCachedPatch(file, manifest) {
  if (file.size !== manifest.patch.size) return false;
  const actual = await hashFile(file, (done, total) => {
    progress("download", done / total, "저장된 DLC 패치 데이터를 확인하고 있습니다.");
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
    progress("download", 1, "검증된 DLC 패치 데이터를 사용합니다.");
    return cached;
  }
  if (cached.size > 0) {
    await directory.removeEntry(cacheName);
    handle = await directory.getFileHandle(cacheName, { create: true });
  }

  progress("download", 0, "DLC 패치 데이터를 다운로드하고 있습니다.");
  const response = await fetch(manifest.patch.url, { cache: "no-store" });
  if (!response.ok || !response.body) throw new Error(`DLC 패치 다운로드 실패: HTTP ${response.status}`);
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength !== manifest.patch.size) {
    throw invalid("서버 DLC 패치 크기가 매니페스트와 다릅니다.");
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
      progress("download", received / manifest.patch.size, `DLC 패치 다운로드: ${Math.round((received / manifest.patch.size) * 100)}%`);
    }
    if (received !== manifest.patch.size || hasher.hex() !== manifest.patch.sha256) {
      throw invalid("다운로드한 DLC 패치 데이터의 SHA-256이 올바르지 않습니다.");
    }
    await writer.close();
  } catch (error) {
    await reader.cancel().catch(() => {});
    await writer.abort().catch(() => {});
    await directory.removeEntry(cacheName).catch(() => {});
    throw error;
  }
  cached = await handle.getFile();
  progress("download", 1, "DLC 패치 데이터를 다운로드하고 검증했습니다.");
  return cached;
}

async function validateSources(files, engineData) {
  const fileMap = new Map();
  for (const file of files) {
    if (fileMap.has(file.name)) throw invalid(`DLC 폴더에 같은 이름의 파일이 중복됩니다: ${file.name}`);
    fileMap.set(file.name, file);
  }
  const total = engineData.entries.reduce((sum, entry) => sum + entry.sourceSize, 0);
  let completed = 0;
  for (const entry of engineData.entries) {
    checkCancelled();
    const file = fileMap.get(entry.name);
    if (!file) throw invalid(`DLC 폴더에 필수 파일이 없습니다: ${entry.name}`);
    if (file.size !== entry.sourceSize) throw invalid(`지원하지 않는 DLC 원본입니다: ${entry.name} 크기가 다릅니다.`);
    const actual = await hashFile(file, (done) => {
      progress("validate", (completed + done) / total, `DLC 원본 검증: ${entry.name}`);
    });
    if (actual !== entry.sourceSha256) throw invalid(`지원하지 않는 DLC 원본입니다: ${entry.name} 내용이 다릅니다.`);
    completed += entry.sourceSize;
  }
  progress("validate", 1, `${engineData.entries.length}개 DLC 원본 파일을 모두 확인했습니다.`);
  return fileMap;
}

async function writeOutput(directory, name, bytes) {
  const handle = await directory.getFileHandle(name, { create: true });
  const writer = await handle.createWritable();
  activeWriter = writer;
  try {
    await writer.write(bytes);
    await writer.close();
    activeWriter = null;
  } catch (error) {
    await writer.abort().catch(() => {});
    activeWriter = null;
    throw error;
  }
  return handle;
}

async function run({ files, manifest, outputDirectory, outputName }) {
  if (manifest.engine !== "psp-file-set-delta-v1" || !manifest.engineData) {
    throw invalid("지원하지 않는 DLC 패치 엔진 또는 누락된 엔진 정보입니다.");
  }
  if (!Array.isArray(files) || !outputDirectory || typeof outputDirectory.getFileHandle !== "function") {
    throw invalid("DLC 입력 또는 결과 폴더 정보가 올바르지 않습니다.");
  }

  const sourceMap = await validateSources(files, manifest.engineData);
  const patchFile = await ensurePatch(manifest);
  const entries = await HanpatchDlcCore.parsePatch(patchFile);
  HanpatchDlcCore.compareMetadata(entries, manifest.engineData);
  progress("copy", 1, `새 결과 폴더 ${outputName}을 준비했습니다.`);

  const targetTotal = entries.reduce((sum, entry) => sum + entry.targetSize, 0);
  let applied = 0;
  const outputHandles = new Map();
  for (const entry of entries) {
    checkCancelled();
    const source = new Uint8Array(await sourceMap.get(entry.name).arrayBuffer());
    const output = await HanpatchDlcCore.applyEntry(source, entry);
    if (hashBytes(output) !== entry.targetSha256) throw invalid(`${entry.name} DLC 패치 결과 검증에 실패했습니다.`);
    outputHandles.set(entry.name, await writeOutput(outputDirectory, entry.name, output));
    applied += entry.targetSize;
    progress("apply", applied / targetTotal, `DLC 패치 적용: ${entry.name}`);
  }
  progress("apply", 1, "DLC 파일을 모두 생성했습니다.");

  let verified = 0;
  for (const entry of entries) {
    checkCancelled();
    const output = await outputHandles.get(entry.name).getFile();
    if (output.size !== entry.targetSize) throw invalid(`결과 DLC 크기 검증 실패: ${entry.name}`);
    const actual = await hashFile(output, (done) => {
      progress("verify", (verified + done) / targetTotal, `결과 DLC 검증: ${entry.name}`);
    });
    if (actual !== entry.targetSha256) throw invalid(`결과 DLC SHA-256 검증 실패: ${entry.name}`);
    verified += entry.targetSize;
  }
  progress("verify", 1, `${entries.length}개 DLC 결과 파일의 SHA-256을 모두 검증했습니다.`);
  return {
    outputName,
    summary: `${entries.length}개 파일 · 개별 SHA-256 검증 완료`,
  };
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
    if (error instanceof CancelledError || cancelled) postMessage({ type: "cancelled" });
    else {
      console.error(error);
      postMessage({ type: "error", message: error?.message ?? String(error) });
    }
  }
});
