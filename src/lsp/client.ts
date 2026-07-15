import { spawn, ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";

const PARSE_TIMEOUT_MS = 60_000;

export interface LspClientOptions {
  command: string;
  args: string[];
  cwd: string;
}

export class LspClient extends EventEmitter {
  private process: ChildProcess | null = null;
  private buffer = "";
  private pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }
  >();
  private nextId = 1;
  private closed = false;

  constructor(private readonly options: LspClientOptions) {
    super();
  }

  async start(): Promise<void> {
    this.closed = false;

    this.process = spawn(this.options.command, this.options.args, {
      cwd: this.options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.process.on("error", (err) => {
      if (!this.closed) {
        this.emit("error", err);
      }
    });

    this.process.on("exit", (code) => {
      if (!this.closed) {
        this.closed = true;
        this.emit("exit", code);
        this.failPendingRequests(new Error(`LSP server exited with code ${code ?? "signal"}`));
      }
    });

    this.process.stdout?.on("data", (data: Buffer) => {
      this.buffer += data.toString("utf-8");
      this.processBuffer();
    });

    this.process.stderr?.on("data", (data: Buffer) => {
      this.emit("stderr", data.toString("utf-8"));
    });

    await this.waitForProcess();
  }

  async initialize(
    rootUri: string,
    capabilities: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    return this.sendRequest("initialize", {
      processId: process.pid,
      rootUri,
      capabilities,
      workspaceFolders: [{ uri: rootUri, name: "workspace" }],
      clientInfo: { name: "devagent", version: "0.1.0" },
    }) as Promise<Record<string, unknown>>;
  }

  initialized(): void {
    this.sendNotification("initialized", {});
  }

  async shutdown(): Promise<void> {
    if (this.closed) return;
    try {
      await this.sendRequest("shutdown", null);
    } catch {
      // ignore shutdown errors
    }
  }

  exit(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.process?.stdin?.end();
      this.process?.stdin?.destroy();
    } catch {
      // ignore
    }
    this.process?.kill("SIGTERM");
  }

  async kill(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.failPendingRequests(new Error("LSP client killed"));

    if (this.process) {
      this.process.kill("SIGKILL");
      const pid = this.process.pid;
      if (pid) {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          // ignore
        }
      }
    }
  }

  didOpen(uri: string, text: string, languageId: string): void {
    this.sendNotification("textDocument/didOpen", {
      textDocument: { uri, languageId, version: 1, text },
    });
  }

  didChange(uri: string, version: number, changes: { range?: unknown; rangeLength?: number; text: string }[]): void {
    this.sendNotification("textDocument/didChange", {
      textDocument: { uri, version },
      contentChanges: changes,
    });
  }

  didClose(uri: string): void {
    this.sendNotification("textDocument/didClose", {
      textDocument: { uri },
    });
  }

  async sendRequest(method: string, params: unknown): Promise<unknown> {
    if (this.closed) throw new Error("LSP client is closed");
    const id = this.nextId++;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`LSP request "${method}" timed out after ${PARSE_TIMEOUT_MS}ms`));
      }, PARSE_TIMEOUT_MS);

      this.pending.set(id, { resolve, reject, timer });

      const message = JSON.stringify({ jsonrpc: "2.0", id, method, params });
      const header = `Content-Length: ${Buffer.byteLength(message, "utf-8")}\r\n\r\n`;
      this.process?.stdin?.write(header + message);
    });
  }

  sendNotification(method: string, params: unknown): void {
    if (this.closed) return;
    const message = JSON.stringify({ jsonrpc: "2.0", method, params });
    const header = `Content-Length: ${Buffer.byteLength(message, "utf-8")}\r\n\r\n`;
    try {
      this.process?.stdin?.write(header + message);
    } catch {
      // ignore write errors
    }
  }

  private processBuffer(): void {
    for (;;) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) break;

      const header = this.buffer.slice(0, headerEnd);
      const contentLengthMatch = header.match(/Content-Length:\s*(\d+)/i);
      if (!contentLengthMatch) {
        this.buffer = this.buffer.slice(headerEnd + 4);
        continue;
      }

      const contentLength = parseInt(contentLengthMatch[1], 10);
      const bodyStart = headerEnd + 4;
      if (this.buffer.length < bodyStart + contentLength) break;

      const body = this.buffer.slice(bodyStart, bodyStart + contentLength);
      this.buffer = this.buffer.slice(bodyStart + contentLength);

      try {
        const message = JSON.parse(body) as Record<string, unknown>;

        if (message.id !== undefined && message.id !== null) {
          const pending = this.pending.get(message.id as number);
          if (pending) {
            clearTimeout(pending.timer);
            this.pending.delete(message.id as number);

            if (message.error) {
              const err = message.error as { code: number; message: string };
              pending.reject(new Error(`LSP error ${err.code}: ${err.message}`));
            } else {
              pending.resolve(message.result);
            }
          }
        } else {
          this.emit("notification", message.method as string, message.params);
          this.emit(methodToEventName(message.method as string), message.params);
        }
      } catch (err) {
        this.emit("parseError", err);
      }
    }
  }

  private failPendingRequests(err: Error): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.pending.clear();
  }

  private waitForProcess(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.process) return reject(new Error("No process"));

      const onError = (err: Error) => reject(err);
      const onExit = (code: number | null) => {
        if (code !== 0 && code !== null) {
          reject(new Error(`LSP server exited with code ${code}`));
        }
      };

      this.process.on("error", onError);
      this.process.on("exit", onExit);

      setImmediate(() => {
        this.process?.removeListener("error", onError);
        this.process?.removeListener("exit", onExit);
        resolve();
      });
    });
  }
}

function methodToEventName(method: string): string {
  return method.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}
