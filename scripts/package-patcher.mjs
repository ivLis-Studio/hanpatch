import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createZipPackage } from "../lib/zip-package.mjs";

const [sourceArgument, outputArgument] = process.argv.slice(2);
if (!sourceArgument || !outputArgument) {
  console.error("사용법: node scripts/package-patcher.mjs <패처 폴더> <출력.zip>");
  process.exitCode = 2;
} else {
  const source = resolve(sourceArgument);
  const output = resolve(outputArgument);
  await mkdir(dirname(output), { recursive: true });
  const result = await createZipPackage(source, output);
  console.log(`패치 패키지 생성 완료: ${result.outputPath}`);
  console.log(`slug    ${result.slug}`);
  console.log(`version ${result.version}`);
  console.log(`size    ${result.size}`);
}
