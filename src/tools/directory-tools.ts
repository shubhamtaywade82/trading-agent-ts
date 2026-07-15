import { readdir, stat, rm, mkdir, copyFile, rename } from "node:fs/promises";
import { resolve, relative } from "node:path";
import { Tool } from "./tool.js";
import { resolveWorkspacePath } from "./path-utils.js";

export class ListDirectoryTool extends Tool {
  constructor(private readonly root: string) { super(); }
  get name(): string { return "list_directory"; }
  get description(): string { return "List files and directories at a path relative to the workspace root. Defaults to workspace root if no path given."; }
  get parameters(): Record<string, unknown> {
    return { type: "object", properties: { path: { type: "string", description: "Directory path relative to workspace root (defaults to root)" } } };
  }
  async call(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const path = (args.path as string) || ".";
    const target = resolveWorkspacePath(this.root, path);
    const entries: { name: string; path: string; type: "file" | "directory" }[] = [];
    try {
      for (const name of await readdir(target)) {
        const item = resolve(target, name);
        const rel = relative(this.root, item);
        let type: "file" | "directory" = "file";
        try { const s = await stat(item); type = s.isDirectory() ? "directory" : "file"; } catch { /* stat failed */ }
        entries.push({ name, path: rel, type });
      }
    } catch (e) {
      return { error: e instanceof Error ? e.name : "Error", message: e instanceof Error ? e.message : String(e) };
    }
    return { path, entries };
  }
}

export class DeleteFileTool extends Tool {
  constructor(private readonly root: string) { super(); }
  get name(): string { return "delete_file"; }
  get description(): string { return "Remove a file or directory recursively."; }
  get parameters(): Record<string, unknown> {
    return { type: "object", properties: { path: { type: "string" } }, required: ["path"] };
  }
  async call(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const path = args.path as string;
    if (!path) return { error: "ArgumentError", message: "missing path" };
    const target = resolveWorkspacePath(this.root, path);
    try {
      await rm(target, { recursive: true, force: true });
    } catch (e) {
      return { error: e instanceof Error ? e.name : "Error", message: e instanceof Error ? e.message : String(e) };
    }
    return { path, removed: true };
  }
}

export class MakeDirectoryTool extends Tool {
  constructor(private readonly root: string) { super(); }
  get name(): string { return "make_directory"; }
  get description(): string { return "Create a directory within the workspace, including parents."; }
  get parameters(): Record<string, unknown> {
    return { type: "object", properties: { path: { type: "string" } }, required: ["path"] };
  }
  async call(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const path = args.path as string;
    if (!path) return { error: "ArgumentError", message: "missing path" };
    const target = resolveWorkspacePath(this.root, path);
    try {
      await mkdir(target, { recursive: true });
    } catch (e) {
      return { error: e instanceof Error ? e.name : "Error", message: e instanceof Error ? e.message : String(e) };
    }
    return { path, created: true };
  }
}

export class CopyFileTool extends Tool {
  constructor(private readonly root: string) { super(); }
  get name(): string { return "copy_file"; }
  get description(): string { return "Copy a file or directory within the workspace."; }
  get parameters(): Record<string, unknown> {
    return { type: "object", properties: { source: { type: "string" }, destination: { type: "string" } }, required: ["source", "destination"] };
  }
  async call(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const source = args.source as string;
    const destination = args.destination as string;
    if (!source || !destination) return { error: "ArgumentError", message: "source and destination are required" };
    const src = resolveWorkspacePath(this.root, source);
    const dest = resolveWorkspacePath(this.root, destination);
    try {
      await copyFile(src, dest);
    } catch (e) {
      return { error: e instanceof Error ? e.name : "Error", message: e instanceof Error ? e.message : String(e) };
    }
    return { source, destination, copied: true };
  }
}

export class MoveFileTool extends Tool {
  constructor(private readonly root: string) { super(); }
  get name(): string { return "move_file"; }
  get description(): string { return "Move or rename a file within the workspace."; }
  get parameters(): Record<string, unknown> {
    return { type: "object", properties: { source: { type: "string" }, destination: { type: "string" } }, required: ["source", "destination"] };
  }
  async call(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const source = args.source as string;
    const destination = args.destination as string;
    if (!source || !destination) return { error: "ArgumentError", message: "source and destination are required" };
    const src = resolveWorkspacePath(this.root, source);
    const dest = resolveWorkspacePath(this.root, destination);
    try {
      await rename(src, dest);
    } catch (e) {
      return { error: e instanceof Error ? e.name : "Error", message: e instanceof Error ? e.message : String(e) };
    }
    return { source, destination, moved: true };
  }
}
