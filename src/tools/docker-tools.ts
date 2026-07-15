import { spawn } from "node:child_process";
import { Tool } from "./tool.js";

const ALLOWED_SUBCOMMANDS = new Set(["build", "run", "stop", "logs", "exec", "compose", "ps", "images", "inspect"]);

// ponytail: single flag blocked (container escape risk). Extend the list if
// another destructive/host-exposing flag shows up in practice.
const DISALLOWED_FLAG_PATTERNS = [/^--privileged$/];

export class DockerTool extends Tool {
  constructor(private readonly root: string) {
    super();
  }

  get name(): string {
    return "docker";
  }

  get description(): string {
    return "Run a docker subcommand (build, run, stop, logs, exec, compose, ps, images, inspect). --privileged is blocked.";
  }

  get tags(): string[] {
    return ["docker", "container", "infra"];
  }

  get parameters(): Record<string, unknown> {
    return {
      type: "object",
      properties: { args: { type: "array", items: { type: "string" } } },
      required: ["args"],
    };
  }

  async call(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const dockerArgs = args.args as string[];
    if (!Array.isArray(dockerArgs) || dockerArgs.length === 0) {
      return { error: "ArgumentError", message: "args must be a non-empty string array" };
    }

    const subcommand = dockerArgs[0];
    if (!ALLOWED_SUBCOMMANDS.has(subcommand)) {
      return { error: "DisallowedDockerCommandError", message: `docker ${subcommand} is not on the allowlist` };
    }
    if (dockerArgs.some((a) => DISALLOWED_FLAG_PATTERNS.some((p) => p.test(a)))) {
      return {
        error: "DisallowedDockerCommandError",
        message: `flags in [${dockerArgs.join(" ")}] are blocked (--privileged)`,
      };
    }

    return new Promise((resolvePromise) => {
      const child = spawn("docker", dockerArgs, { cwd: this.root });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (c: Buffer) => (stdout += c.toString()));
      child.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
      child.on("close", (exitCode) => {
        resolvePromise({ command: `docker ${dockerArgs.join(" ")}`, exitCode: exitCode ?? -1, stdout, stderr });
      });
      child.on("error", (err) => {
        resolvePromise({ command: `docker ${dockerArgs.join(" ")}`, exitCode: -1, stdout: "", stderr: err.message });
      });
    });
  }
}
