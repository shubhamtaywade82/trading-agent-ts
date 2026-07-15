/**
 * Phase 2 — Workspace manifest. Enumerates every indexable file per
 * category with stat metadata (mtime/size) so the persistent cache can
 * check freshness without reading file contents.
 */

import { readdirSync, statSync } from "fs";
import { join, relative, sep } from "path";
import { ManifestCategory, ManifestFile, WorkspaceInfo, WorkspaceManifest } from "./types.js";

const SKIP_DIRS = new Set(["node_modules", "vendor", "tmp", "log", ".git", "public", "storage"]);

const VIEW_EXTS = new Set([".erb", ".haml", ".slim", ".builder"]);

function collectRubyFiles(root: string, dir: string, out: ManifestFile[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      collectRubyFiles(root, full, out);
    } else if (entry.endsWith(".rb")) {
      out.push({
        relPath: relative(root, full).split(sep).join("/"),
        mtimeMs: stat.mtimeMs,
        size: stat.size,
      });
    }
  }
}

function collectViewFiles(root: string, dir: string, out: ManifestFile[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      collectViewFiles(root, full, out);
    } else if (VIEW_EXTS.has(entry.slice(entry.lastIndexOf(".")))) {
      out.push({
        relPath: relative(root, full).split(sep).join("/"),
        mtimeMs: stat.mtimeMs,
        size: stat.size,
      });
    }
  }
}

function statFile(root: string, relPath: string): ManifestFile | null {
  try {
    const stat = statSync(join(root, relPath));
    if (!stat.isFile()) return null;
    return { relPath, mtimeMs: stat.mtimeMs, size: stat.size };
  } catch {
    return null;
  }
}

const CATEGORY_DIRS: Partial<Record<ManifestCategory, string[]>> = {
  models: ["app/models"],
  controllers: ["app/controllers"],
  services: ["app/services"],
  jobs: ["app/jobs"],
  mailers: ["app/mailers"],
  policies: ["app/policies"],
  concerns: ["app/models/concerns", "app/controllers/concerns"],
  specs: ["spec"],
  migrations: ["db/migrate"],
  views: ["app/views"],
  components: ["app/components"],
};

export function buildManifest(info: WorkspaceInfo): WorkspaceManifest {
  const categories = {} as Record<ManifestCategory, ManifestFile[]>;

  for (const category of Object.keys(CATEGORY_DIRS) as ManifestCategory[]) {
    const files: ManifestFile[] = [];
    const roots = [info.root, ...info.engines.map((e) => join(info.root, e.path))];
    for (const base of roots) {
      for (const dir of CATEGORY_DIRS[category] ?? []) {
        if (category === "views") {
          collectViewFiles(info.root, join(base, dir), files);
        } else {
          collectRubyFiles(info.root, join(base, dir), files);
        }
      }
    }
    categories[category] = files;
  }

  // Concern files also live under models/controllers globs; exclude them
  // from those categories so a file belongs to exactly one scanner domain.
  const concernPaths = new Set(categories.concerns.map((f) => f.relPath));
  categories.models = categories.models.filter((f) => !concernPaths.has(f.relPath));
  categories.controllers = categories.controllers.filter((f) => !concernPaths.has(f.relPath));

  categories.routes = [statFile(info.root, "config/routes.rb")].filter((f): f is ManifestFile => f != null);
  categories.schema = [statFile(info.root, "db/schema.rb")].filter((f): f is ManifestFile => f != null);
  categories.gemfileLock = [statFile(info.root, "Gemfile.lock")].filter((f): f is ManifestFile => f != null);

  const files = Object.values(categories).flat();
  return { root: info.root, workspace: info, categories, files };
}

/**
 * Cheap freshness fingerprint: stable hash over sorted (path, mtime, size).
 * No file contents are read.
 */
export function manifestHash(manifest: WorkspaceManifest): string {
  const parts = manifest.files
    .map((f) => `${f.relPath}|${f.mtimeMs}|${f.size}`)
    .sort()
    .join("\n");
  // FNV-1a 64-bit via two 32-bit lanes — no crypto dependency needed.
  let h1 = 0x811c9dc5;
  let h2 = 0xcbf29ce4;
  for (let i = 0; i < parts.length; i++) {
    const c = parts.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x01000197) >>> 0;
  }
  return `${h1.toString(16)}${h2.toString(16)}:${manifest.files.length}`;
}
