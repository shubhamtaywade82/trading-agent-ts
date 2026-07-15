import { spawn } from "node:child_process";
import { relative } from "node:path";
import { Tool } from "./tool.js";
import { resolveWorkspacePath } from "./path-utils.js";

export interface SearchMatch {
  path: string;
  line: number;
  text: string;
}

const DEFAULT_MAX_RESULTS = 200;

export class SearchCodeTool extends Tool {
  constructor(private readonly root: string) {
    super();
  }

  get name(): string {
    return "search_code";
  }

  get description(): string {
    return "Search the workspace for a literal string or ripgrep-compatible regex, returning file:line matches.";
  }

  get parameters(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        query: { type: "string" },
        path: { type: "string", description: "Subdirectory to scope the search to (default: workspace root)." },
        glob: { type: "string", description: "Optional ripgrep --glob filter, e.g. '*.ts'." },
        maxResults: { type: "number" },
      },
      required: ["query"],
    };
  }

  async call(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const query = args.query as string;
    const scopedPath = (args.path as string | undefined) ?? ".";
    const glob = args.glob as string | undefined;
    const maxResults = (args.maxResults as number | undefined) ?? DEFAULT_MAX_RESULTS;

    const searchRoot = resolveWorkspacePath(this.root, scopedPath);

    const rgArgs = ["--line-number", "--no-heading", "--color=never"];
    if (glob) rgArgs.push("--glob", glob);
    rgArgs.push("--", query, searchRoot);

    const output = await this.runRipgrep(rgArgs);
    const matches: SearchMatch[] = [];

    for (const line of output.split("\n")) {
      if (!line) continue;
      const firstColon = line.indexOf(":");
      const secondColon = line.indexOf(":", firstColon + 1);
      if (firstColon === -1 || secondColon === -1) continue;

      const filePath = line.slice(0, firstColon);
      const lineNo = Number(line.slice(firstColon + 1, secondColon));
      const text = line.slice(secondColon + 1);
      matches.push({ path: relative(this.root, filePath), line: lineNo, text });
      if (matches.length >= maxResults) break;
    }

    return { query, matches, truncated: matches.length >= maxResults };
  }

  private runRipgrep(args: string[]): Promise<string> {
    return new Promise((resolvePromise) => {
      const child = spawn("rg", args);
      let stdout = "";
      child.stdout.on("data", (c: Buffer) => (stdout += c.toString()));
      child.on("close", (code) => {
        if (code === 0 || code === 1) resolvePromise(stdout);
        else resolvePromise("");
      });
      child.on("error", () => resolvePromise(""));
    });
  }
}
