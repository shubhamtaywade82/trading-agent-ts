/* eslint-disable security/detect-non-literal-fs-filename -- target validated by resolveWorkspacePath(); backup paths derived from it + constant root */
import { mkdir, copyFile } from "node:fs/promises";
import { resolve, join, relative } from "node:path";

import { resolveWorkspacePath } from "./path-utils.js";
import { Tool } from "./tool.js";

const BACKUP_DIR = ".trading-agent/backups";

export class SnapshotBackupTool extends Tool {
  constructor(private readonly root: string) { super(); }
  get name(): string { return "snapshot_backup"; }
  get description(): string { return "Create a timestamped backup of a file before modifying it."; }
  override get parameters(): Record<string, unknown> {
    return { type: "object", properties: { path: { type: "string" } }, required: ["path"] };
  }
  async call(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const path = args["path"] as string;
    if (!path) return { error: "ArgumentError", message: "missing path" };
    const target = resolveWorkspacePath(this.root, path);
    const backupRoot = resolve(this.root, BACKUP_DIR);
    await mkdir(backupRoot, { recursive: true });
    const timestamp = Date.now();
    const backupPath = join(backupRoot, `${path.replaceAll('/', "_")}.${timestamp}.bak`);
    try {
      await copyFile(target, backupPath);
    } catch (e) {
      return { error: e instanceof Error ? e.name : "Error", message: e instanceof Error ? e.message : String(e) };
    }
    return { path, backupPath: relative(this.root, backupPath), timestamp };
  }
}
