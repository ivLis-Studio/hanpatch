import { createHash, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";

export const PATCHER_SCHEMA_VERSION = 1;
export const SUPPORTED_ENGINES = new Set(["psp-iso-delta-v2", "p2kofsp1-v2"]);
export const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/;
const ENGINE_FORMATS = new Map([
  ["psp-iso-delta-v2", "PSPDELTA"],
  ["p2kofsp1-v2", "P2KOFSP1"],
]);

function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label}은(는) 객체여야 합니다.`);
  }
  return value;
}

function requireString(value, label, maximum = 200) {
  if (typeof value !== "string" || value.trim() !== value || value.length === 0 || value.length > maximum) {
    throw new Error(`${label} 문자열이 올바르지 않습니다.`);
  }
  return value;
}

function requireStringArray(value, label, maximumItems = 32, maximumLength = 300) {
  if (!Array.isArray(value) || value.length === 0 || value.length > maximumItems) {
    throw new Error(`${label} 배열이 올바르지 않습니다.`);
  }
  return value.map((item, index) => requireString(item, `${label}[${index}]`, maximumLength));
}

function requireSha256(value, label) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(`${label} SHA-256이 올바르지 않습니다.`);
  }
  return value;
}

function validateEngineData(value, expectedFormat) {
  const data = requireObject(value, "engineData");
  requireString(data.format, "engineData.format", 32);
  if (!Number.isSafeInteger(data.formatVersion) || data.formatVersion < 1) {
    throw new Error("engineData.formatVersion이 올바르지 않습니다.");
  }
  if (data.format !== expectedFormat || data.formatVersion !== 2) {
    throw new Error(`엔진 ${expectedFormat} 형식 버전 2가 필요합니다.`);
  }
  requireString(data.discId, "engineData.discId", 32);
  if (!Array.isArray(data.entries) || data.entries.length === 0 || data.entries.length > 32) {
    throw new Error("engineData.entries 배열이 올바르지 않습니다.");
  }
  const paths = new Set();
  let extendedEntries = 0;
  for (const [index, entryValue] of data.entries.entries()) {
    const entry = requireObject(entryValue, `engineData.entries[${index}]`);
    const path = requireString(entry.path, `engineData.entries[${index}].path`, 1024);
    if (!path.startsWith("/") || path.includes("\\") || path.includes("\0") || path.split("/").includes("..")) {
      throw new Error(`패치 대상 경로가 올바르지 않습니다: ${path}`);
    }
    if (paths.has(path)) throw new Error(`패치 대상 경로가 중복됩니다: ${path}`);
    paths.add(path);
    if (![0, 1, 2].includes(entry.strategy)) throw new Error(`지원하지 않는 패치 전략입니다: ${entry.strategy}`);
    for (const key of ["sourceSize", "targetSize"]) {
      if (!Number.isSafeInteger(entry[key]) || entry[key] <= 0) {
        throw new Error(`engineData.entries[${index}].${key} 값이 올바르지 않습니다.`);
      }
    }
    requireStringArray(entry.sourceSha256Variants, `engineData.entries[${index}].sourceSha256Variants`, 64, 64)
      .forEach((hash) => requireSha256(hash, "원본"));
    requireSha256(entry.targetSha256, `engineData.entries[${index}].targetSha256`);
    if (entry.strategy === 0 && entry.sourceSize !== entry.targetSize) throw new Error("전략 0은 원본과 결과 크기가 같아야 합니다.");
    if (entry.strategy === 1 && entry.targetSize > entry.sourceSize) throw new Error("전략 1의 결과는 원본보다 클 수 없습니다.");
    if (entry.strategy === 2) {
      extendedEntries += 1;
      if (path !== "/PSP_GAME/SYSDIR/EBOOT.BIN") throw new Error("전략 2는 /PSP_GAME/SYSDIR/EBOOT.BIN에만 사용할 수 있습니다.");
    }
  }
  if (extendedEntries > 1) throw new Error("확장 EBOOT 전략은 한 번만 사용할 수 있습니다.");
}

export function validatePatcherConfig(value, expectedSlug = null) {
  const config = requireObject(value, "config");
  if (config.schemaVersion !== PATCHER_SCHEMA_VERSION) {
    throw new Error(`지원하지 않는 config 스키마입니다: ${config.schemaVersion}`);
  }
  requireString(config.slug, "slug", 48);
  if (!SLUG_PATTERN.test(config.slug)) {
    throw new Error("slug는 영문 소문자, 숫자, 하이픈만 사용할 수 있습니다.");
  }
  if (expectedSlug && config.slug !== expectedSlug) {
    throw new Error(`폴더 이름과 slug가 다릅니다: ${expectedSlug} / ${config.slug}`);
  }
  requireString(config.title, "title", 100);
  requireString(config.shortTitle, "shortTitle", 60);
  requireString(config.version, "version", 32);
  requireString(config.description, "description", 500);
  requireString(config.engine, "engine", 64);
  if (!SUPPORTED_ENGINES.has(config.engine)) {
    throw new Error(`서버가 허용하지 않은 패치 엔진입니다: ${config.engine}`);
  }

  const input = requireObject(config.input, "input");
  requireString(input.label, "input.label", 100);
  const extensions = requireStringArray(input.extensions, "input.extensions", 16, 16);
  for (const extension of extensions) {
    if (!/^\.[a-z0-9]{1,10}$/.test(extension)) throw new Error(`입력 확장자가 올바르지 않습니다: ${extension}`);
  }
  requireString(input.discId, "input.discId", 32);
  requireStringArray(input.supportedVariants, "input.supportedVariants", 32, 100);

  const output = requireObject(config.output, "output");
  const suggestedName = requireString(output.suggestedName, "output.suggestedName", 180);
  if (basename(suggestedName) !== suggestedName || suggestedName.includes("\0")) {
    throw new Error("output.suggestedName은 파일 이름만 포함해야 합니다.");
  }

  const patch = requireObject(config.patch, "patch");
  const patchFile = requireString(patch.file, "patch.file", 180);
  if (basename(patchFile) !== patchFile || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,179}$/.test(patchFile)) {
    throw new Error("patch.file은 files 폴더 안의 일반 파일 이름이어야 합니다.");
  }
  if (!Number.isSafeInteger(patch.size) || patch.size <= 0) throw new Error("patch.size가 올바르지 않습니다.");
  requireSha256(patch.sha256, "patch.sha256");
  requireStringArray(config.notices, "notices", 32, 300);
  validateEngineData(config.engineData, ENGINE_FORMATS.get(config.engine));
  if (config.engineData.discId !== input.discId) {
    throw new Error("input.discId와 engineData.discId가 다릅니다.");
  }
  return config;
}

export async function sha256File(path) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest("hex");
}

export async function loadPatcherDirectory(directory, expectedSlug = null, { verifyHash = false } = {}) {
  const config = validatePatcherConfig(
    JSON.parse(await readFile(join(directory, "config.json"), "utf8")),
    expectedSlug,
  );
  const patchPath = join(directory, "files", config.patch.file);
  const patchStat = await stat(patchPath);
  if (!patchStat.isFile()) throw new Error("패치 데이터가 일반 파일이 아닙니다.");
  if (patchStat.size !== config.patch.size) throw new Error("패치 데이터 크기가 config.json과 다릅니다.");
  if (verifyHash && await sha256File(patchPath) !== config.patch.sha256) {
    throw new Error("패치 데이터 SHA-256이 config.json과 다릅니다.");
  }
  return { config, directory, patchPath, patchStat };
}

export function secureTokenEqual(actual, expected) {
  if (typeof actual !== "string" || typeof expected !== "string") return false;
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}
