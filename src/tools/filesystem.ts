import { readFile, writeFile, rename, unlink, mkdir, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { Tool } from "./tool.js";
import { resolveWorkspacePath, PathEscapeError } from "./path-utils.js";

export { PathEscapeError };

export class ReadFileTool extends Tool {
  constructor(private readonly root: string) {
    super();
  }

  get name(): string {
    return "read_file";
  }

  get description(): string {
    return "Read a UTF-8 text file relative to the workspace root.";
  }

  override get capabilities(): string[] {
    return ["File System"];
  }

  override get tags(): string[] {
    return ["read", "file", "view", "cat", "open", "show", "inspect"];
  }

  get parameters(): Record<string, unknown> {
    return { type: "object", properties: { path: { type: "string" } }, required: ["path"] };
  }

  async call(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const relPath = args.path as string;
    const path = resolveWorkspacePath(this.root, relPath);

    const content = await readFile(path, "utf-8");
    return { path: relPath, content, truncated: false };
  }
}

export class WriteFileTool extends Tool {
  constructor(private readonly root: string) {
    super();
  }

  get name(): string {
    return "write_file";
  }

  get description(): string {
    return "Write a UTF-8 text file relative to the workspace root. Overwrites atomically.";
  }

  override get capabilities(): string[] {
    return ["File System"];
  }

  override get tags(): string[] {
    return ["write", "file", "create", "save", "update", "new"];
  }

  get parameters(): Record<string, unknown> {
    return {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
    };
  }

  async call(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const relPath = args.path as string;
    const content = args.content as string;
    const path = resolveWorkspacePath(this.root, relPath);
    await mkdir(dirname(path), { recursive: true });

    const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
    try {
      await writeFile(tmp, content, "utf-8");
      await rename(tmp, path);
      return { path: relPath, bytesWritten: Buffer.byteLength(content, "utf-8") };
    } finally {
      try {
        await stat(tmp);
        await unlink(tmp);
      } catch {
        // tmp already gone (rename succeeded) — nothing to clean up
      }
    }
  }
}
