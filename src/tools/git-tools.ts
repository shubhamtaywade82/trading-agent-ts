import { spawn } from "node:child_process";
import { Tool } from "./tool.js";

const ALLOWED_SUBCOMMANDS = new Set([
  "status",
  "diff",
  "log",
  "branch",
  "add",
  "commit",
  "checkout",
  "stash",
  "show",
  "blame",
  "rev-parse",
  "cherry-pick",
]);

const DISALLOWED_FLAG_PATTERNS = [/^--hard$/, /^--force$/, /^-f$/, /^-D$/];

export class GitTool extends Tool {
  constructor(private readonly root: string) {
    super();
  }

  get name(): string {
    return "git";
  }

  get description(): string {
    return "Run a read/local-write git subcommand (status, diff, log, branch, add, commit, checkout, stash, show, blame, rev-parse, cherry-pick). Push, force operations, and hard resets are blocked — ask the user to run those manually.";
  }

  get parameters(): Record<string, unknown> {
    return {
      type: "object",
      properties: { args: { type: "array", items: { type: "string" } } },
      required: ["args"],
    };
  }

  async call(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const gitArgs = args.args as string[];
    if (!Array.isArray(gitArgs) || gitArgs.length === 0) {
      return { error: "ArgumentError", message: "args must be a non-empty string array" };
    }

    const subcommand = gitArgs[0];
    if (!ALLOWED_SUBCOMMANDS.has(subcommand)) {
      return { error: "DisallowedGitCommandError", message: `git ${subcommand} is not on the allowlist` };
    }
    if (gitArgs.some((a) => DISALLOWED_FLAG_PATTERNS.some((p) => p.test(a)))) {
      return {
        error: "DisallowedGitCommandError",
        message: `flags in [${gitArgs.join(" ")}] are blocked (force/hard operations)`,
      };
    }

    return new Promise((resolvePromise) => {
      const child = spawn("git", gitArgs, { cwd: this.root });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (c: Buffer) => (stdout += c.toString()));
      child.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
      child.on("close", (exitCode) => {
        resolvePromise({ command: `git ${gitArgs.join(" ")}`, exitCode: exitCode ?? -1, stdout, stderr });
      });
      child.on("error", (err) => {
        resolvePromise({ command: `git ${gitArgs.join(" ")}`, exitCode: -1, stdout: "", stderr: err.message });
      });
    });
  }
}
