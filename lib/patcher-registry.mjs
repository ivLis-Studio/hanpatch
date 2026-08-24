import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join, normalize, sep } from "node:path";
import { loadPatcherDirectory, SLUG_PATTERN } from "./patcher-config.mjs";
import { extractZipPackage } from "./zip-package.mjs";

const STATE_SCHEMA_VERSION = 1;

function safeChild(root, name) {
  if (!SLUG_PATTERN.test(name)) throw new Error("패처 slug가 올바르지 않습니다.");
  const path = normalize(join(root, name));
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  if (!path.startsWith(prefix)) throw new Error("패처 경로가 저장소를 벗어납니다.");
  return path;
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

export class PatcherRegistry {
  constructor(root, options = {}) {
    this.root = normalize(root);
    this.statePath = join(this.root, ".registry.json");
    this.stagingRoot = join(this.root, ".staging");
    this.trashRoot = join(this.root, ".trash");
    this.packageLimits = options.packageLimits ?? {};
    this.patchers = new Map();
    this.state = { schemaVersion: STATE_SCHEMA_VERSION, patchers: {} };
  }

  async initialize() {
    await Promise.all([
      mkdir(this.root, { recursive: true }),
      mkdir(this.stagingRoot, { recursive: true }),
      mkdir(this.trashRoot, { recursive: true }),
    ]);
    await this.#loadState();
    await this.reload();
    return this;
  }

  async #loadState() {
    try {
      const value = JSON.parse(await readFile(this.statePath, "utf8"));
      if (value?.schemaVersion === STATE_SCHEMA_VERSION && value.patchers && typeof value.patchers === "object") {
        this.state = value;
      }
    } catch (error) {
      if (error.code !== "ENOENT") console.warn(`[registry] state ignored: ${error.message}`);
    }
  }

  async #saveState() {
    const temporary = `${this.statePath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(this.state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, this.statePath);
  }

  async reload() {
    const next = new Map();
    for (const entry of await readdir(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      try {
        const patcher = await loadPatcherDirectory(join(this.root, entry.name), entry.name);
        const metadata = this.state.patchers[entry.name] ?? {};
        next.set(entry.name, {
          ...patcher,
          enabled: metadata.enabled !== false,
          installedAt: metadata.installedAt ?? null,
        });
      } catch (error) {
        console.warn(`[registry] skip ${entry.name}: ${error.message}`);
      }
    }
    this.patchers = next;
    return next;
  }

  get(slug, { includeDisabled = false } = {}) {
    const patcher = this.patchers.get(slug) ?? null;
    return patcher && (includeDisabled || patcher.enabled) ? patcher : null;
  }

  list({ includeDisabled = false } = {}) {
    return [...this.patchers.values()]
      .filter((patcher) => includeDisabled || patcher.enabled)
      .sort((left, right) => left.config.title.localeCompare(right.config.title, "ko"));
  }

  async install(zipPath, { replace = false } = {}) {
    const staging = await mkdtemp(join(this.stagingRoot, "install-"));
    let installed = false;
    let backup = null;
    let target = null;
    try {
      const patcher = await extractZipPackage(zipPath, staging, this.packageLimits);
      const slug = patcher.config.slug;
      target = safeChild(this.root, slug);
      const existing = this.patchers.get(slug);
      if (existing && !replace) {
        const error = new Error(`이미 등록된 패처입니다: ${slug}`);
        error.code = "PATCHER_EXISTS";
        throw error;
      }
      if (existing) {
        backup = join(this.trashRoot, `${slug}-${timestamp()}-${randomUUID()}`);
        await rename(target, backup);
      }
      try {
        await rename(staging, target);
        installed = true;
      } catch (error) {
        if (backup) await rename(backup, target).catch(() => {});
        throw error;
      }
      const previous = this.state.patchers[slug];
      this.state.patchers[slug] = {
        enabled: previous?.enabled !== false,
        installedAt: new Date().toISOString(),
      };
      await this.#saveState();
      await this.reload();
      return this.patchers.get(slug);
    } finally {
      if (!installed) await rm(staging, { recursive: true, force: true });
    }
  }

  async setEnabled(slug, enabled) {
    const patcher = this.get(slug, { includeDisabled: true });
    if (!patcher) return null;
    const previous = this.state.patchers[slug] ?? {};
    this.state.patchers[slug] = {
      ...previous,
      enabled: Boolean(enabled),
      installedAt: previous.installedAt ?? patcher.installedAt ?? new Date().toISOString(),
    };
    await this.#saveState();
    await this.reload();
    return this.patchers.get(slug);
  }

  async remove(slug) {
    const patcher = this.get(slug, { includeDisabled: true });
    if (!patcher) return null;
    const target = safeChild(this.root, slug);
    const trash = join(this.trashRoot, `${slug}-${timestamp()}-${randomUUID()}`);
    await rename(target, trash);
    delete this.state.patchers[slug];
    await this.#saveState();
    await this.reload();
    return { slug, trash };
  }
}
