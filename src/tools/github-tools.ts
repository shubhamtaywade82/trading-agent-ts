import { spawn } from "node:child_process";
import { Tool } from "./tool.js";

const ALLOWED_SUBCOMMANDS = new Set(["pr", "issue", "release", "repo", "run", "api"]);

// Irreversible/destructive actions regardless of resource — blocked so the
// agent can't merge, delete, or force-push through `gh` unsupervised.
const DISALLOWED_VERBS = new Set(["merge", "delete", "close"]);

export class GitHubTool extends Tool {
  constructor(private readonly root: string) {
    super();
  }

  get name(): string {
    return "github";
  }

  get description(): string {
    return "Run a `gh` (GitHub CLI) subcommand — pr, issue, release, repo, run, api. Merge, delete, and close are blocked; ask the user to run those manually.";
  }

  get tags(): string[] {
    return ["github", "git", "pr", "issue"];
  }

  get parameters(): Record<string, unknown> {
    return {
      type: "object",
      properties: { args: { type: "array", items: { type: "string" } } },
      required: ["args"],
    };
  }

  async call(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const ghArgs = args.args as string[];
    if (!Array.isArray(ghArgs) || ghArgs.length === 0) {
      return { error: "ArgumentError", message: "args must be a non-empty string array" };
    }

    const subcommand = ghArgs[0];
    if (!ALLOWED_SUBCOMMANDS.has(subcommand)) {
      return { error: "DisallowedGitHubCommandError", message: `gh ${subcommand} is not on the allowlist` };
    }
    if (ghArgs.some((a) => DISALLOWED_VERBS.has(a))) {
      return {
        error: "DisallowedGitHubCommandError",
        message: `[${ghArgs.join(" ")}] contains a blocked verb (merge/delete/close)`,
      };
    }

    return new Promise((resolvePromise) => {
      const child = spawn("gh", ghArgs, { cwd: this.root });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (c: Buffer) => (stdout += c.toString()));
      child.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
      child.on("close", (exitCode) => {
        resolvePromise({ command: `gh ${ghArgs.join(" ")}`, exitCode: exitCode ?? -1, stdout, stderr });
      });
      child.on("error", (err) => {
        resolvePromise({ command: `gh ${ghArgs.join(" ")}`, exitCode: -1, stdout: "", stderr: err.message });
      });
    });
  }
}
