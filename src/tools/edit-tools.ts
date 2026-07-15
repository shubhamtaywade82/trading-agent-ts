import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { Tool, ToolError } from "./tool.js";
import { resolveWorkspacePath } from "./path-utils.js";

export class PatchTool extends Tool {
  constructor(private readonly root: string) { super(); }
  get name() { return "patch_file"; }
  get description() { return "Apply a find/replace patch to a UTF-8 file in the workspace."; }
  get parameters() { return { type: "object", properties: { path: { type: "string" }, find: { type: "string" }, replace: { type: "string" } }, required: ["path", "find", "replace"] }; }
  async call(args: Record<string, unknown>) {
    const path = args.path as string;
    const find = args.find as string;
    const replace = args.replace as string;
    const target = resolveWorkspacePath(this.root, path);
    const content = await readFile(target, "utf-8");
    if (!content.includes(find)) throw new ToolError(`search block not found in ${path}`);
    const next = content.replace(find, replace);
    await writeFile(target, next, "utf-8");
    return { path, bytesWritten: Buffer.byteLength(next, "utf-8") };
  }
}

export class AppendTool extends Tool {
  constructor(private readonly root: string) { super(); }
  get name() { return "append_file"; }
  get description() { return "Append text to a UTF-8 file in the workspace."; }
  get parameters() { return { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] }; }
  async call(args: Record<string, unknown>) {
    const path = args.path as string;
    const content = args.content as string;
    const target = resolveWorkspacePath(this.root, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, { encoding: "utf-8", flag: "a+" });
    try { const { size } = await stat(target); return { path, size }; } catch { return { path }; }
  }
}
