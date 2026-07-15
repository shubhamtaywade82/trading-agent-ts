import { LspServerSession } from "./session.js";
import { LanguageProviderConfig } from "./registry.js";
import { LspGlobalConfig } from "./config.js";

export class LspPool {
  private readonly sessions = new Map<string, LspServerSession>();
  private idleCheckTimer: NodeJS.Timeout | null = null;
  private readonly config: LspGlobalConfig;
  onStateChange?: () => void;

  constructor(config: LspGlobalConfig) {
    this.config = { ...config };
  }

  private emitStateChange(): void {
    this.onStateChange?.();
  }

  async acquire(
    workspacePath: string,
    provider: LanguageProviderConfig,
  ): Promise<LspServerSession> {
    const key = `${workspacePath}:${provider.id}`;
    let session = this.sessions.get(key);

    if (session) {
      if (session.status === "running") {
        session.lastActivity = Date.now();
        return session;
      }
      if (session.status === "error") {
        this.sessions.delete(key);
      }
    }

    if (this.sessions.size >= this.config.maxServers) {
      await this.evictOne();
    }

    session = new LspServerSession(workspacePath, provider);
    session.onStatus = () => this.emitStateChange();
    this.sessions.set(key, session);

    try {
      await session.start();
    } catch (err) {
      this.sessions.delete(key);
      throw err;
    } finally {
      this.emitStateChange();
    }

    return session;
  }

  async release(workspacePath: string, languageId: string): Promise<void> {
    const key = `${workspacePath}:${languageId}`;
    const session = this.sessions.get(key);
    if (session) {
      this.sessions.delete(key);
      await session.stop();
      this.emitStateChange();
    }
  }

  getSession(workspacePath: string, languageId: string): LspServerSession | undefined {
    return this.sessions.get(`${workspacePath}:${languageId}`);
  }

  getSessionsForWorkspace(workspacePath: string): LspServerSession[] {
    const results: LspServerSession[] = [];
    for (const [key, session] of this.sessions) {
      if (key.startsWith(workspacePath + ":")) {
        results.push(session);
      }
    }
    return results;
  }

  runningSessions(): LspServerSession[] {
    return [...this.sessions.values()].filter((s) => s.status === "running");
  }

  allSessions(): LspServerSession[] {
    return [...this.sessions.values()];
  }

  activeCount(): number {
    return this.runningSessions().length;
  }

  async stopAll(): Promise<void> {
    for (const [key, session] of this.sessions) {
      this.sessions.delete(key);
      try {
        await session.stop();
      } catch {
        // ignore stop errors during shutdown
      }
    }
    this.emitStateChange();
    this.stopIdleCheck();
  }

  startIdleCheck(): void {
    if (this.idleCheckTimer) return;
    this.idleCheckTimer = setInterval(() => {
      this.sleepIdleSessions();
    }, 60_000);
    this.idleCheckTimer.unref();
  }

  stopIdleCheck(): void {
    if (this.idleCheckTimer) {
      clearInterval(this.idleCheckTimer);
      this.idleCheckTimer = null;
    }
  }

  private async sleepIdleSessions(): Promise<void> {
    const idleTimeout = this.config.idleTimeoutMs;
    for (const [key, session] of this.sessions) {
      if (session.status === "running" && session.isIdle(idleTimeout) && session.openDocuments.size === 0) {
        this.sessions.delete(key);
        try {
          await session.stop();
        } catch {
          // ignore
        }
      }
    }
    this.emitStateChange();
  }

  private async evictOne(): Promise<void> {
    let oldest: LspServerSession | null = null;
    for (const session of this.sessions.values()) {
      if (session.openDocuments.size === 0 && session.status !== "starting") {
        if (!oldest || session.lastActivity < oldest.lastActivity) {
          oldest = session;
        }
      }
    }

    if (oldest) {
      const key = oldest.id;
      this.sessions.delete(key);
      try {
        await oldest.stop();
      } catch {
        // ignore
      }
      this.emitStateChange();
    }
  }
}
