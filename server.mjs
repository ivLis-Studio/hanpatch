import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, extname, join, normalize } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { secureTokenEqual } from "./lib/patcher-config.mjs";
import { PatcherRegistry } from "./lib/patcher-registry.mjs";

const ROOT = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(ROOT, "public");
const ADMIN_DIR = join(ROOT, "admin");
const CATALOG_DIR = join(ROOT, "catalog");
const DEFAULT_PATCHERS_DIR = process.env.PATCHER_DATA_DIR
  ? normalize(process.env.PATCHER_DATA_DIR)
  : join(ROOT, "patchers");
const PORT = Number.parseInt(process.env.PORT ?? "3000", 10);
const HOST = process.env.HOST ?? "127.0.0.1";
const DEFAULT_MAX_UPLOAD = Number.parseInt(process.env.MAX_PACKAGE_BYTES ?? String(2 * 1024 * 1024 * 1024), 10);

const MIME = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".md", "text/markdown; charset=utf-8"],
]);

const SECURITY_HEADERS = {
  "Content-Security-Policy": [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "connect-src 'self'",
    "worker-src 'self'",
    "manifest-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; "),
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
};

function send(res, status, body, headers = {}) {
  const value = typeof body === "string" || Buffer.isBuffer(body) ? body : `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    "Content-Length": Buffer.byteLength(value),
    ...headers,
  });
  res.end(value);
}

function sendJson(res, status, body, headers = {}) {
  send(res, status, body, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers });
}

function redirect(res, location) {
  res.writeHead(308, { ...SECURITY_HEADERS, "Location": location, "Cache-Control": "no-store" });
  res.end();
}

function clientManifest(config) {
  return {
    schemaVersion: config.schemaVersion,
    slug: config.slug,
    title: config.title,
    shortTitle: config.shortTitle,
    version: config.version,
    engine: config.engine,
    engineData: config.engineData,
    description: config.description,
    input: config.input,
    output: config.output,
    notices: config.notices,
    patch: {
      url: `files/${encodeURIComponent(config.patch.file)}`,
      size: config.patch.size,
      sha256: config.patch.sha256,
    },
  };
}

function publicSummary(patcher) {
  const { config } = patcher;
  return {
    slug: config.slug,
    title: config.title,
    shortTitle: config.shortTitle,
    version: config.version,
    description: config.description,
    engine: config.engine,
    input: {
      label: config.input.label,
      discId: config.input.discId,
      supportedVariants: config.input.supportedVariants,
    },
    url: `/${config.slug}/`,
  };
}

function adminSummary(patcher) {
  return {
    ...publicSummary(patcher),
    enabled: patcher.enabled,
    installedAt: patcher.installedAt,
    patch: {
      file: patcher.config.patch.file,
      size: patcher.config.patch.size,
      sha256: patcher.config.patch.sha256,
    },
  };
}

async function serveStatic(req, res, path, cacheControl = "no-cache") {
  const info = await stat(path).catch(() => null);
  if (!info?.isFile()) {
    sendJson(res, 404, { error: "not_found" });
    return;
  }
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    "Cache-Control": cacheControl,
    "Content-Length": info.size,
    "Content-Type": MIME.get(extname(path).toLowerCase()) ?? "application/octet-stream",
  });
  if (req.method === "HEAD") res.end();
  else createReadStream(path).pipe(res);
}

async function servePatch(req, res, patcher) {
  const info = patcher.patchStat ?? await stat(patcher.patchPath).catch(() => null);
  if (!info?.isFile()) {
    sendJson(res, 503, { error: "patch_payload_missing" });
    return;
  }
  if (info.size !== patcher.config.patch.size) {
    sendJson(res, 503, { error: "patch_payload_size_mismatch" });
    return;
  }
  const range = req.headers.range;
  let start = 0;
  let end = info.size - 1;
  let statusCode = 200;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match || (!match[1] && !match[2])) {
      res.writeHead(416, { ...SECURITY_HEADERS, "Content-Range": `bytes */${info.size}` });
      res.end();
      return;
    }
    if (!match[1]) {
      const suffix = Math.min(Number(match[2]), info.size);
      start = info.size - suffix;
    } else {
      start = Number(match[1]);
      if (match[2]) end = Math.min(Number(match[2]), info.size - 1);
    }
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= info.size) {
      res.writeHead(416, { ...SECURITY_HEADERS, "Content-Range": `bytes */${info.size}` });
      res.end();
      return;
    }
    statusCode = 206;
  }
  res.writeHead(statusCode, {
    ...SECURITY_HEADERS,
    "Accept-Ranges": "bytes",
    "Cache-Control": "public, max-age=31536000, immutable",
    "Content-Length": end - start + 1,
    "Content-Type": "application/octet-stream",
    "Content-Disposition": `inline; filename="${patcher.config.patch.file}"`,
    ...(statusCode === 206 ? { "Content-Range": `bytes ${start}-${end}/${info.size}` } : {}),
  });
  if (req.method === "HEAD") res.end();
  else createReadStream(patcher.patchPath, { start, end }).pipe(res);
}

function isAdmin(req, adminToken) {
  if (!adminToken) return false;
  const header = req.headers.authorization ?? "";
  return header.startsWith("Bearer ") && secureTokenEqual(header.slice(7), adminToken);
}

function requireAdmin(req, res, adminToken) {
  if (!adminToken) {
    sendJson(res, 503, { error: "admin_not_configured", message: "서버에 ADMIN_TOKEN을 설정하세요." });
    return false;
  }
  if (!isAdmin(req, adminToken)) {
    sendJson(res, 401, { error: "unauthorized", message: "관리자 토큰이 올바르지 않습니다." }, {
      "WWW-Authenticate": "Bearer",
    });
    return false;
  }
  return true;
}

async function readJson(req, maximum = 16 * 1024) {
  const chunks = [];
  let received = 0;
  for await (const chunk of req) {
    received += chunk.length;
    if (received > maximum) throw Object.assign(new Error("요청 본문이 너무 큽니다."), { statusCode: 413 });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(new Error("JSON 요청 본문이 올바르지 않습니다."), { statusCode: 400 });
  }
}

class UploadLimit extends Transform {
  constructor(maximum) {
    super();
    this.maximum = maximum;
    this.received = 0;
  }

  _transform(chunk, encoding, callback) {
    this.received += chunk.length;
    if (this.received > this.maximum) {
      callback(Object.assign(new Error("패치 ZIP이 서버 허용 크기를 넘었습니다."), { statusCode: 413 }));
    } else {
      callback(null, chunk);
    }
  }
}

async function receivePackage(req, uploadDirectory, maximum) {
  const declared = Number(req.headers["content-length"] ?? 0);
  if (Number.isFinite(declared) && declared > maximum) {
    throw Object.assign(new Error("패치 ZIP이 서버 허용 크기를 넘었습니다."), { statusCode: 413 });
  }
  await mkdir(uploadDirectory, { recursive: true });
  const path = join(uploadDirectory, `${randomUUID()}.zip`);
  const limiter = new UploadLimit(maximum);
  try {
    await pipeline(req, limiter, createWriteStream(path, { flags: "wx", mode: 0o600 }));
    if (limiter.received === 0) throw Object.assign(new Error("빈 업로드입니다."), { statusCode: 400 });
    return path;
  } catch (error) {
    await rm(path, { force: true });
    throw error;
  }
}

function methodAllowed(req, res, methods) {
  if (methods.includes(req.method ?? "")) return true;
  sendJson(res, 405, { error: "method_not_allowed" }, { "Allow": methods.join(", ") });
  return false;
}

export async function createAppServer(options = {}) {
  const patchersDir = options.patchersDir ?? DEFAULT_PATCHERS_DIR;
  const adminToken = options.adminToken ?? process.env.ADMIN_TOKEN ?? "";
  const maximumUpload = options.maximumUpload ?? DEFAULT_MAX_UPLOAD;
  const registry = await new PatcherRegistry(patchersDir, {
    packageLimits: { compressedBytes: maximumUpload },
  }).initialize();
  const uploadDirectory = join(patchersDir, ".uploads");

  const server = createServer(async (req, res) => {
    try {
      if (!req.url) {
        sendJson(res, 400, { error: "bad_request" });
        return;
      }
      const url = new URL(req.url, "http://localhost");
      let pathname;
      try {
        pathname = decodeURIComponent(url.pathname);
      } catch {
        sendJson(res, 400, { error: "bad_path" });
        return;
      }

      if (pathname === "/healthz") {
        if (!methodAllowed(req, res, ["GET", "HEAD"])) return;
        sendJson(res, 200, {
          ok: true,
          patchers: registry.list().length,
          registered: registry.list({ includeDisabled: true }).length,
          adminConfigured: Boolean(adminToken),
        });
        return;
      }
      if (pathname === "/api/patchers") {
        if (!methodAllowed(req, res, ["GET", "HEAD"])) return;
        sendJson(res, 200, { patchers: registry.list().map(publicSummary) });
        return;
      }
      if (pathname === "/api/admin/session") {
        if (!methodAllowed(req, res, ["GET"])) return;
        if (!requireAdmin(req, res, adminToken)) return;
        sendJson(res, 200, { ok: true });
        return;
      }
      if (pathname === "/api/admin/patchers") {
        if (!methodAllowed(req, res, ["GET"])) return;
        if (!requireAdmin(req, res, adminToken)) return;
        sendJson(res, 200, { patchers: registry.list({ includeDisabled: true }).map(adminSummary) });
        return;
      }
      if (pathname === "/api/admin/packages") {
        if (!methodAllowed(req, res, ["POST"])) return;
        if (!requireAdmin(req, res, adminToken)) return;
        const zipPath = await receivePackage(req, uploadDirectory, maximumUpload);
        try {
          const patcher = await registry.install(zipPath, { replace: url.searchParams.get("replace") === "1" });
          sendJson(res, 201, { ok: true, patcher: adminSummary(patcher) });
        } finally {
          await rm(zipPath, { force: true });
        }
        return;
      }

      const adminMatch = /^\/api\/admin\/patchers\/([a-z0-9-]+)$/.exec(pathname);
      if (adminMatch) {
        if (!requireAdmin(req, res, adminToken)) return;
        const slug = adminMatch[1];
        if (req.method === "PATCH") {
          const body = await readJson(req);
          if (typeof body.enabled !== "boolean") {
            sendJson(res, 400, { error: "invalid_request", message: "enabled 값은 true 또는 false여야 합니다." });
            return;
          }
          const patcher = await registry.setEnabled(slug, body.enabled);
          if (!patcher) sendJson(res, 404, { error: "patcher_not_found" });
          else sendJson(res, 200, { ok: true, patcher: adminSummary(patcher) });
          return;
        }
        if (req.method === "DELETE") {
          const removed = await registry.remove(slug);
          if (!removed) sendJson(res, 404, { error: "patcher_not_found" });
          else sendJson(res, 200, { ok: true, slug: removed.slug, recoverable: true });
          return;
        }
        methodAllowed(req, res, ["PATCH", "DELETE"]);
        return;
      }

      if (pathname === "/" || pathname === "/index.html") {
        if (!methodAllowed(req, res, ["GET", "HEAD"])) return;
        await serveStatic(req, res, join(CATALOG_DIR, "index.html"));
        return;
      }
      if (pathname === "/admin") {
        if (!methodAllowed(req, res, ["GET", "HEAD"])) return;
        redirect(res, "/admin/");
        return;
      }
      if (pathname === "/admin/") {
        if (!methodAllowed(req, res, ["GET", "HEAD"])) return;
        await serveStatic(req, res, join(ADMIN_DIR, "index.html"));
        return;
      }
      if (pathname === "/docs/PATCH_PACKAGE_KO.md") {
        if (!methodAllowed(req, res, ["GET", "HEAD"])) return;
        await serveStatic(req, res, join(ROOT, "docs", "PATCH_PACKAGE_KO.md"));
        return;
      }
      const sharedAsset = /^\/(admin|catalog)\/assets\/([a-z0-9.-]+)$/.exec(pathname);
      if (sharedAsset) {
        if (!methodAllowed(req, res, ["GET", "HEAD"])) return;
        const allowed = sharedAsset[1] === "admin"
          ? new Set(["admin.css", "admin.js"])
          : new Set(["catalog.css", "catalog.js"]);
        if (!allowed.has(sharedAsset[2])) {
          sendJson(res, 404, { error: "asset_not_found" });
          return;
        }
        await serveStatic(req, res, join(sharedAsset[1] === "admin" ? ADMIN_DIR : CATALOG_DIR, sharedAsset[2]));
        return;
      }

      const parts = pathname.split("/").filter(Boolean);
      const patcher = registry.get(parts[0]);
      if (!patcher) {
        sendJson(res, 404, { error: "patcher_not_found" });
        return;
      }
      if (!methodAllowed(req, res, ["GET", "HEAD"])) return;
      if (parts.length === 1 && !pathname.endsWith("/")) {
        redirect(res, `/${patcher.config.slug}/`);
        return;
      }
      if (parts.length === 1) {
        await serveStatic(req, res, join(PUBLIC_DIR, "index.html"));
        return;
      }
      if (parts.length === 2 && parts[1] === "manifest.json") {
        sendJson(res, 200, clientManifest(patcher.config));
        return;
      }
      if (parts.length === 3 && parts[1] === "assets") {
        const allowed = new Set(["app.css", "app.js", "patch-worker.js", "sha256.js"]);
        if (!allowed.has(parts[2])) {
          sendJson(res, 404, { error: "asset_not_found" });
          return;
        }
        await serveStatic(req, res, join(PUBLIC_DIR, parts[2]));
        return;
      }
      if (parts.length === 3 && parts[1] === "files" && parts[2] === patcher.config.patch.file) {
        await servePatch(req, res, patcher);
        return;
      }
      sendJson(res, 404, { error: "not_found" });
    } catch (error) {
      console.error(error);
      if (!res.headersSent) {
        const statusCode = error.statusCode ?? (error.code === "PATCHER_EXISTS" ? 409 : 400);
        sendJson(res, statusCode, {
          error: error.code === "PATCHER_EXISTS" ? "patcher_exists" : "request_failed",
          message: error.message ?? "요청을 처리하지 못했습니다.",
        });
      } else {
        res.destroy(error);
      }
    }
  });
  server.patcherRegistry = registry;
  return server;
}

if (process.argv[1] && normalize(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = await createAppServer();
  server.listen(PORT, HOST, () => {
    console.log(`PSP 웹 한글패쳐: http://${HOST}:${PORT}/`);
    console.log(`관리자 페이지: http://${HOST}:${PORT}/admin/`);
    if (!process.env.ADMIN_TOKEN) console.warn("ADMIN_TOKEN이 없어 관리자 API가 비활성화됐습니다.");
  });
}
