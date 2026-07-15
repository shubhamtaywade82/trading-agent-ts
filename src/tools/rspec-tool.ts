import { spawn } from "node:child_process";
import { Tool } from "./tool.js";

export class RunRSpecTool extends Tool {
  constructor(private readonly root: string) {
    super();
  }

  get name(): string {
    return "run_rspec";
  }

  get description(): string {
    return "Run RSpec tests. Optionally target a specific file, directory, or line number.";
  }

  get parameters(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Relative path to a spec file or directory. Omit to run the full suite.",
        },
        line: {
          type: "number",
          description: "Line number for focused run (appended as `:line` to path).",
        },
        format: {
          type: "string",
          enum: ["progress", "documentation", "json", "junit"],
          description: "Output format (default: documentation).",
        },
      },
    };
  }

  async call(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const target = args.path as string | undefined;
    const line = args.line as number | undefined;
    const format = (args.format as string) || "documentation";

    const rspecArgs = ["exec", "rspec", "--format", format];
    if (target) {
      rspecArgs.push(line ? `${target}:${line}` : target);
    }

    return new Promise((resolvePromise) => {
      const child = spawn("bundle", rspecArgs, {
        cwd: this.root,
        timeout: 120_000,
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (c: Buffer) => (stdout += c.toString()));
      child.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
      child.on("close", (exitCode) => {
        const summary = parseRSpecSummary(stdout, stderr);
        resolvePromise({
          command: `bundle exec rspec --format ${format}${target ? ` ${target}${line ? `:${line}` : ""}` : ""}`,
          exitCode: exitCode ?? -1,
          stdout,
          stderr,
          ...summary,
        });
      });
      child.on("error", (err) =>
        resolvePromise({
          exitCode: -1,
          stdout: "",
          stderr: err.message,
          examples: 0,
          failures: 0,
          pending: 0,
          duration: 0,
        }),
      );
    });
  }
}

interface RSpecSummary {
  examples: number;
  failures: number;
  pending: number;
  duration: number;
}

function parseRSpecSummary(stdout: string, stderr: string): RSpecSummary {
  const combined = stdout + "\n" + stderr;
  // "X examples, Y failures, Z pending"
  const summary = /(\d+)\s+examples?,\s*(\d+)\s+failures?(?:,\s*(\d+)\s+pending?)?/.exec(combined);
  // "Finished in X.Y seconds"
  const finished = /Finished\s+in\s+([\d.]+)\s+seconds?/.exec(combined);

  return {
    examples: summary ? parseInt(summary[1], 10) : 0,
    failures: summary ? parseInt(summary[2], 10) : 0,
    pending: summary ? (summary[3] ? parseInt(summary[3], 10) : 0) : 0,
    duration: finished ? parseFloat(finished[1]) : 0,
  };
}
