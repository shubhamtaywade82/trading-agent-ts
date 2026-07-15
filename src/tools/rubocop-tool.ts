import { spawn } from "node:child_process";
import { join } from "node:path";
import { Tool } from "./tool.js";

export class RunRubocopTool extends Tool {
  constructor(private readonly root: string) {
    super();
  }

  get name(): string {
    return "run_rubocop";
  }

  get description(): string {
    return "Run RuboCop linting on the Ruby project. Optionally target a specific file or directory.";
  }

  get parameters(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Relative path to a file or directory to lint. Omit to lint the whole project.",
        },
        autoCorrect: {
          type: "boolean",
          description: "Apply auto-correctable fixes (--auto-correct).",
        },
      },
    };
  }

  async call(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const target = args.path as string | undefined;
    const autoCorrect = args.autoCorrect === true;

    const ruboCopArgs = ["exec", "rubocop", "--format", "simple"];
    if (autoCorrect) ruboCopArgs.push("--auto-correct");
    if (target) ruboCopArgs.push(target);

    return new Promise((resolvePromise) => {
      const child = spawn("bundle", ruboCopArgs, {
        cwd: this.root,
        timeout: 60_000,
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (c: Buffer) => (stdout += c.toString()));
      child.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
      child.on("close", (exitCode) => {
        const offenseCount = parseRubocopOffenses(stdout, stderr);
        resolvePromise({
          command: `bundle exec rubocop${autoCorrect ? " --auto-correct" : ""}${target ? ` ${target}` : ""}`,
          exitCode: exitCode ?? -1,
          stdout,
          stderr,
          offenseCount,
          corrected: autoCorrect ? offenseCount.corrected : 0,
        });
      });
      child.on("error", (err) =>
        resolvePromise({ exitCode: -1, stdout: "", stderr: err.message, offenseCount: 0, corrected: 0 }),
      );
    });
  }
}

interface RubocopOffenseCount {
  total: number;
  corrected: number;
}

function parseRubocopOffenses(stdout: string, stderr: string): RubocopOffenseCount {
  const combined = stdout + "\n" + stderr;
  // RuboCop summary line: "X offenses detected, Y offenses corrected"
  const summary = /(\d+)\s+offense(?:s)?\s+detected/.exec(combined);
  const corrected = /(\d+)\s+offense(?:s)?\s+corrected/.exec(combined);
  return {
    total: summary ? parseInt(summary[1], 10) : 0,
    corrected: corrected ? parseInt(corrected[1], 10) : 0,
  };
}
