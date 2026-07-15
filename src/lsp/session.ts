import { ChildProcess } from "node:child_process";
import { LspClient } from "./client.js";
import { LanguageProviderConfig } from "./registry.js";
import { CLIENT_CAPABILITIES, LspCapabilities, deriveCapabilities, NO_CAPABILITIES } from "./capabilities.js";
import { pathToUri } from "./protocol.js";
import type { Diagnostic, ServerCapabilities } from "vscode-languageserver-protocol";

export class LspServerSession {
  readonly workspacePath: string;
  readonly provider: LanguageProviderConfig;
  client: LspClient | null = null;
  process: ChildProcess | null = null;
  capabilities: LspCapabilities = NO_CAPABILITIES;
  status: "starting" | "running" | "stopped" | "error" = "starting";
  readonly openDocuments = new Map<string, { uri: string; version: number }>();
  readonly cachedDiagnostics = new Map<string, Diagnostic[]>();
  // Tokens with an open $/progress "begin" and no matching "end" yet — most
  // servers (ruby-lsp, typescript-language-server) report project indexing
  // this way. `status` alone can't tell "no results" from "not indexed yet".
  private readonly activeProgressTokens = new Set<string | number>();
  startTime = 0;
  lastActivity = 0;
  errorCount = 0;

  onDiagnostics?: (uri: string, diagnostics: Diagnostic[]) => void;
  onStatus?: (status: "starting" | "running" | "stopped" | "error") => void;
  onError?: (error: Error) => void;

  constructor(workspacePath: string, provider: LanguageProviderConfig) {
    this.workspacePath = workspacePath;
    this.provider = provider;
  }

  get id(): string {
    return `${this.workspacePath}:${this.provider.id}`;
  }

  async start(): Promise<void> {
    this.startTime = Date.now();
    this.status = "starting";
    this.onStatus?.("starting");

    const client = new LspClient({
      command: this.provider.serverCommand,
      args: this.provider.serverArgs,
      cwd: this.workspacePath,
    });

    client.on("error", (err: Error) => {
      this.errorCount++;
      this.onError?.(err);
    });

    client.on("exit", (code: number | null) => {
      if (this.status !== "stopped") {
        this.status = "error";
        this.errorCount++;
        this.onStatus?.("error");
        this.onError?.(new Error(`LSP server exited unexpectedly with code ${code ?? "signal"}`));
      }
    });

    client.on("notification", (method: string, params: unknown) => this.handleNotification(method, params));

    this.client = client;

    try {
      await client.start();

      const rootUri = pathToUri(this.workspacePath, ".");
      const result = (await client.initialize(rootUri, CLIENT_CAPABILITIES)) as { capabilities?: ServerCapabilities };

      if (result.capabilities) {
        this.capabilities = deriveCapabilities(result.capabilities);
      }

      client.initialized();
      this.status = "running";
      this.lastActivity = Date.now();
      this.onStatus?.("running");
    } catch (err) {
      this.status = "error";
      this.errorCount++;
      this.onStatus?.("error");
      this.onError?.(err instanceof Error ? err : new Error(String(err)));
      throw err;
    }
  }

  handleNotification(method: string, params: unknown): void {
    if (method === "textDocument/publishDiagnostics") {
      const p = params as { uri: string; diagnostics: Diagnostic[] };
      this.cachedDiagnostics.set(p.uri, p.diagnostics);
      this.onDiagnostics?.(p.uri, p.diagnostics);
    }
    if (method === "$/progress") {
      const p = params as { token: string | number; value?: { kind?: string } };
      if (p.value?.kind === "begin") this.activeProgressTokens.add(p.token);
      else if (p.value?.kind === "end") this.activeProgressTokens.delete(p.token);
    }
  }

  async stop(): Promise<void> {
    this.status = "stopped";
    this.onStatus?.("stopped");
    this.openDocuments.clear();
    this.activeProgressTokens.clear();

    if (this.client) {
      try {
        await this.client.shutdown();
      } catch {
        // ignore
      }
      this.client.exit();
      this.client = null;
    }
  }

  async openDocument(filePath: string, text: string): Promise<void> {
    if (!this.client || this.status !== "running") return;
    const uri = pathToUri(this.workspacePath, filePath);
    this.openDocuments.set(uri, { uri, version: 1 });
    // provider.id is the actual LSP-spec languageId (lowercase, e.g. "typescript");
    // provider.language is a display label ("TypeScript") — sending that instead
    // triggers "Invalid languageId" warnings on servers that validate it.
    this.client.didOpen(uri, text, this.provider.id);
    this.lastActivity = Date.now();
  }

  async changeDocument(filePath: string, text: string, version?: number): Promise<void> {
    if (!this.client || this.status !== "running") return;
    const uri = pathToUri(this.workspacePath, filePath);
    const doc = this.openDocuments.get(uri);
    const nextVersion = version ?? (doc ? doc.version + 1 : 1);
    this.openDocuments.set(uri, { uri, version: nextVersion });
    this.client.didChange(uri, nextVersion, [{ text }]);
    this.lastActivity = Date.now();
  }

  async closeDocument(filePath: string): Promise<void> {
    if (!this.client || this.status !== "running") return;
    const uri = pathToUri(this.workspacePath, filePath);
    this.openDocuments.delete(uri);
    this.cachedDiagnostics.delete(uri);
    this.client.didClose(uri);
    this.lastActivity = Date.now();
  }

  isIdle(timeoutMs: number): boolean {
    return Date.now() - this.lastActivity > timeoutMs;
  }

  // Fallback grace window: verified live that neither typescript-language-server
  // nor ruby-lsp actually emit $/progress for their startup project indexing (at
  // least in the versions tested), even though real queries return empty/
  // incomplete results for several seconds after start on a real-sized project.
  // Without this, "no results" and "not indexed yet" look identical.
  private static readonly COLD_START_GRACE_MS = 20_000;

  /** True while the server has an open $/progress span, or — for servers that
   * don't report one — during a fixed grace window right after startup. */
  get indexing(): boolean {
    if (this.activeProgressTokens.size > 0) return true;
    return this.status === "running" && Date.now() - this.startTime < LspServerSession.COLD_START_GRACE_MS;
  }

  get diagnosticsCount(): number {
    let count = 0;
    for (const diags of this.cachedDiagnostics.values()) {
      count += diags.length;
    }
    return count;
  }

  get state(): { language: string; status: string; documentsCount: number; errorCount: number; indexing: boolean } {
    return {
      language: this.provider.language,
      status: this.status,
      documentsCount: this.openDocuments.size,
      errorCount: this.errorCount,
      indexing: this.indexing,
    };
  }
}
