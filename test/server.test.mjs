import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createZipPackage } from "../lib/zip-package.mjs";
import { buildPatchData } from "../scripts/build-patch-data.mjs";
import { createAppServer } from "../server.mjs";

let fixture;

async function makeFixture() {
  const root = await mkdtemp(join(tmpdir(), "psp-web-patcher-fixture-"));
  const patchersDir = join(root, "patchers");
  const patcherDir = join(patchersDir, "example-game");
  const filesDir = join(patcherDir, "files");
  const sourceDir = join(root, "build");
  const sourcePath = join(sourceDir, "original.bin");
  const targetPath = join(sourceDir, "translated.bin");
  const specPath = join(sourceDir, "build.json");
  const patchPath = join(filesDir, "example-game-v1.p2kp");
  const metadataPath = join(root, "generated-metadata.json");
  const packagePath = join(root, "example-game-v1.0.0.zip");
  await Promise.all([
    mkdir(filesDir, { recursive: true }),
    mkdir(sourceDir, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(sourcePath, Buffer.from("AAAA1111BBBB2222", "ascii")),
    writeFile(targetPath, Buffer.from("AAAAxxxxBBBB2222", "ascii")),
    writeFile(specPath, `${JSON.stringify({
      discId: "ULJM00000",
      entries: [{
        path: "/PSP_GAME/USRDIR/example.bin",
        strategy: 0,
        sourceFiles: ["./original.bin"],
        targetFile: "./translated.bin",
      }],
    }, null, 2)}\n`),
  ]);
  const generated = await buildPatchData(specPath, patchPath, metadataPath);
  const config = {
    schemaVersion: 1,
    slug: "example-game",
    title: "예시 게임 한국어 패치",
    shortTitle: "예시 게임 패치",
    version: "1.0.0",
    engine: "psp-iso-delta-v2",
    description: "자동 테스트용 가상 패치입니다.",
    input: {
      label: "원본 테스트 ISO",
      extensions: [".iso"],
      discId: "ULJM00000",
      supportedVariants: ["자동 테스트 원본"],
    },
    output: { suggestedName: "Example Game [KO].iso" },
    patch: generated.patch,
    notices: ["실제 게임 데이터가 아닌 자동 테스트용입니다."],
    engineData: generated.engineData,
  };
  await writeFile(join(patcherDir, "config.json"), `${JSON.stringify(config, null, 2)}\n`);
  await createZipPackage(patcherDir, packagePath);
  return {
    root,
    patchersDir,
    patchPath,
    patchSize: generated.patch.size,
    patchSha256: generated.patch.sha256,
    packagePath,
  };
}

async function withServer(callback, options = {}) {
  const server = await createAppServer(options);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  try {
    await callback(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test.before(async () => {
  fixture = await makeFixture();
});

test.after(async () => {
  await rm(fixture.root, { recursive: true, force: true });
});

test("serves the public catalog and protects the admin API", async () => {
  await withServer(async (base) => {
    const catalog = await fetch(`${base}/`);
    assert.equal(catalog.status, 200);
    assert.match(await catalog.text(), /PSP 한패치/);

    const publicList = await fetch(`${base}/api/patchers`).then((response) => response.json());
    assert.ok(publicList.patchers.some((patcher) => patcher.slug === "example-game"));

    const admin = await fetch(`${base}/admin/`);
    assert.equal(admin.status, 200);
    assert.match(await admin.text(), /관리자 인증/);

    const unauthorized = await fetch(`${base}/api/admin/patchers`);
    assert.equal(unauthorized.status, 401);
  }, { patchersDir: fixture.patchersDir, adminToken: "test-admin-token" });
});

test("serves a generic patcher app and client-safe manifest", async () => {
  await withServer(async (base) => {
    const page = await fetch(`${base}/example-game/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-security-policy"), /worker-src 'self'/);
    assert.match(await page.text(), /이 브라우저 안에서만 처리/);

    const manifestResponse = await fetch(`${base}/example-game/manifest.json`);
    assert.equal(manifestResponse.status, 200);
    const manifest = await manifestResponse.json();
    assert.equal(manifest.slug, "example-game");
    assert.equal(manifest.version, "1.0.0");
    assert.equal(manifest.engine, "psp-iso-delta-v2");
    assert.equal(manifest.engineData.entries.length, 1);
    assert.equal(manifest.patch.url, "files/example-game-v1.p2kp");
    assert.equal("file" in manifest.patch, false);
  }, { patchersDir: fixture.patchersDir });
});

test("serves the patch payload with byte ranges", async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/example-game/files/example-game-v1.p2kp`, {
      headers: { Range: "bytes=0-7" },
    });
    assert.equal(response.status, 206);
    assert.equal(response.headers.get("accept-ranges"), "bytes");
    assert.equal(response.headers.get("content-range"), `bytes 0-7/${fixture.patchSize}`);
    assert.equal(Buffer.from(await response.arrayBuffer()).toString("ascii"), "PSPDELTA");

    const invalid = await fetch(`${base}/example-game/files/example-game-v1.p2kp`, {
      headers: { Range: "bytes=999999999-1000000000" },
    });
    assert.equal(invalid.status, 416);
  }, { patchersDir: fixture.patchersDir });
});

test("generated payload matches its public manifest SHA-256", async () => {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(fixture.patchPath)) digest.update(chunk);
  assert.equal(digest.digest("hex"), fixture.patchSha256);
});

test("installs, hides, restores, and removes a compatible generic patch ZIP", async () => {
  const patchersDir = await mkdtemp(join(tmpdir(), "psp-web-patchers-test-"));
  const packageStat = await stat(fixture.packagePath);
  const token = "integration-admin-token";
  try {
    await withServer(async (base) => {
      const install = await fetch(`${base}/api/admin/packages`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${token}`,
          "Content-Length": String(packageStat.size),
          "Content-Type": "application/zip",
        },
        body: createReadStream(fixture.packagePath),
        duplex: "half",
      });
      const installed = await install.json();
      assert.equal(install.status, 201, JSON.stringify(installed));
      assert.equal(installed.patcher.slug, "example-game");
      assert.equal(installed.patcher.enabled, true);

      assert.equal((await fetch(`${base}/example-game/manifest.json`)).status, 200);

      const hide = await fetch(`${base}/api/admin/patchers/example-game`, {
        method: "PATCH",
        headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: false }),
      });
      assert.equal(hide.status, 200);
      assert.equal((await fetch(`${base}/example-game/manifest.json`)).status, 404);
      const publicWhileHidden = await fetch(`${base}/api/patchers`).then((response) => response.json());
      assert.equal(publicWhileHidden.patchers.length, 0);

      const show = await fetch(`${base}/api/admin/patchers/example-game`, {
        method: "PATCH",
        headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: true }),
      });
      assert.equal(show.status, 200);
      assert.equal((await fetch(`${base}/example-game/manifest.json`)).status, 200);

      const remove = await fetch(`${base}/api/admin/patchers/example-game`, {
        method: "DELETE",
        headers: { "Authorization": `Bearer ${token}` },
      });
      assert.equal(remove.status, 200);
      assert.equal((await fetch(`${base}/example-game/manifest.json`)).status, 404);
      assert.ok((await readdir(join(patchersDir, ".trash"))).length > 0);
    }, { patchersDir, adminToken: token, maximumUpload: 10 * 1024 * 1024 });
  } finally {
    await rm(patchersDir, { recursive: true, force: true });
  }
});

test("fixture metadata is portable and contains no game assets", async () => {
  const metadata = JSON.parse(await readFile(join(fixture.root, "generated-metadata.json"), "utf8"));
  assert.equal(metadata.engineData.discId, "ULJM00000");
  assert.equal(metadata.engineData.entries[0].path, "/PSP_GAME/USRDIR/example.bin");
});
