import { LspPool } from "../../src/lsp/pool.js";
import { LspServerSession } from "../../src/lsp/session.js";
import { LanguageProviderConfig } from "../../src/lsp/registry.js";

const CONFIG = { idleTimeoutMs: 60_000, maxServers: 2, prewarm: [] as string[] };

function provider(id: string): LanguageProviderConfig {
  return { id, language: id, extensions: [`.${id}`], serverCommand: "fake-lsp", serverArgs: [] };
}

// Real start()/stop() spawn a real process over stdio — stub them so pool
// logic (eviction, idle sweep, reuse) is exercised without a real server.
let startSpy: jest.SpyInstance;
let stopSpy: jest.SpyInstance;

beforeEach(() => {
  startSpy = jest.spyOn(LspServerSession.prototype, "start").mockImplementation(async function (this: LspServerSession) {
    this.status = "running";
  });
  stopSpy = jest.spyOn(LspServerSession.prototype, "stop").mockImplementation(async function (this: LspServerSession) {
    this.status = "stopped";
  });
});

afterEach(() => {
  startSpy.mockRestore();
  stopSpy.mockRestore();
});

describe("LspPool.acquire", () => {
  it("creates and starts a new session for a fresh workspace+provider", async () => {
    const pool = new LspPool(CONFIG);
    const session = await pool.acquire("/ws", provider("ruby"));

    expect(session.status).toBe("running");
    expect(startSpy).toHaveBeenCalledTimes(1);
    expect(pool.getSession("/ws", "ruby")).toBe(session);
  });

  it("reuses an existing running session instead of starting a new one", async () => {
    const pool = new LspPool(CONFIG);
    const first = await pool.acquire("/ws", provider("ruby"));
    const second = await pool.acquire("/ws", provider("ruby"));

    expect(second).toBe(first);
    expect(startSpy).toHaveBeenCalledTimes(1);
  });

  it("discards and restarts a session that previously errored", async () => {
    const pool = new LspPool(CONFIG);
    const first = await pool.acquire("/ws", provider("ruby"));
    (first as any).status = "error";

    const second = await pool.acquire("/ws", provider("ruby"));

    expect(second).not.toBe(first);
    expect(startSpy).toHaveBeenCalledTimes(2);
  });

  it("removes the session from the pool and rethrows if start() fails", async () => {
    startSpy.mockImplementation(async () => {
      throw new Error("spawn failed");
    });
    const pool = new LspPool(CONFIG);

    await expect(pool.acquire("/ws", provider("ruby"))).rejects.toThrow("spawn failed");
    expect(pool.getSession("/ws", "ruby")).toBeUndefined();
  });

  it("evicts the oldest idle session when at capacity", async () => {
    const pool = new LspPool(CONFIG); // maxServers: 2
    const a = await pool.acquire("/ws", provider("a"));
    a.lastActivity = 1000;
    const b = await pool.acquire("/ws", provider("b"));
    b.lastActivity = 2000;

    await pool.acquire("/ws", provider("c")); // triggers eviction — pool is full

    expect(pool.getSession("/ws", "a")).toBeUndefined(); // oldest, evicted
    expect(pool.getSession("/ws", "b")).toBeDefined();
    expect(pool.getSession("/ws", "c")).toBeDefined();
  });

  it("does not evict a session that still has open documents", async () => {
    const pool = new LspPool(CONFIG);
    const a = await pool.acquire("/ws", provider("a"));
    a.lastActivity = 1000;
    a.openDocuments.set("file:///ws/a.rb", { uri: "file:///ws/a.rb", version: 1 });
    const b = await pool.acquire("/ws", provider("b"));
    b.lastActivity = 2000;

    await pool.acquire("/ws", provider("c"));

    // "a" has an open document, so "b" (idle, no docs) is evicted instead.
    expect(pool.getSession("/ws", "a")).toBeDefined();
    expect(pool.getSession("/ws", "b")).toBeUndefined();
  });
});

describe("LspPool.release", () => {
  it("stops and removes a session", async () => {
    const pool = new LspPool(CONFIG);
    await pool.acquire("/ws", provider("ruby"));

    await pool.release("/ws", "ruby");

    expect(pool.getSession("/ws", "ruby")).toBeUndefined();
    expect(stopSpy).toHaveBeenCalledTimes(1);
  });

  it("is a no-op for a session that doesn't exist", async () => {
    const pool = new LspPool(CONFIG);
    await expect(pool.release("/ws", "nonexistent")).resolves.toBeUndefined();
    expect(stopSpy).not.toHaveBeenCalled();
  });
});

describe("LspPool queries", () => {
  it("getSessionsForWorkspace only returns sessions for that workspace", async () => {
    const pool = new LspPool(CONFIG);
    await pool.acquire("/ws-a", provider("ruby"));
    await pool.acquire("/ws-b", provider("ruby"));

    const sessions = pool.getSessionsForWorkspace("/ws-a");
    expect(sessions).toHaveLength(1);
  });

  it("runningSessions excludes non-running sessions", async () => {
    const pool = new LspPool(CONFIG);
    const a = await pool.acquire("/ws", provider("a"));
    await pool.acquire("/ws", provider("b"));
    a.status = "error";

    expect(pool.runningSessions()).toHaveLength(1);
    expect(pool.allSessions()).toHaveLength(2);
  });

  it("activeCount reflects only running sessions", async () => {
    const pool = new LspPool(CONFIG);
    await pool.acquire("/ws", provider("a"));
    expect(pool.activeCount()).toBe(1);
  });
});

describe("LspPool.stopAll", () => {
  it("stops every session and clears the pool", async () => {
    const pool = new LspPool(CONFIG);
    await pool.acquire("/ws", provider("a"));
    await pool.acquire("/ws", provider("b"));

    await pool.stopAll();

    expect(pool.allSessions()).toHaveLength(0);
    expect(stopSpy).toHaveBeenCalledTimes(2);
  });

  it("tolerates a session throwing on stop", async () => {
    stopSpy.mockImplementation(async () => {
      throw new Error("stop failed");
    });
    const pool = new LspPool(CONFIG);
    await pool.acquire("/ws", provider("a"));

    await expect(pool.stopAll()).resolves.toBeUndefined();
    expect(pool.allSessions()).toHaveLength(0);
  });
});

describe("LspPool idle sweep", () => {
  it("stops running, idle, document-free sessions after the idle timeout", async () => {
    jest.useFakeTimers();
    try {
      const pool = new LspPool({ ...CONFIG, idleTimeoutMs: 1000 });
      const session = await pool.acquire("/ws", provider("ruby"));
      session.lastActivity = Date.now() - 5000; // well past the 1000ms idle timeout

      pool.startIdleCheck();
      await jest.advanceTimersByTimeAsync(60_000);

      expect(pool.getSession("/ws", "ruby")).toBeUndefined();
      pool.stopIdleCheck();
    } finally {
      jest.useRealTimers();
    }
  });

  it("does not sweep a session that has an open document, even if idle", async () => {
    jest.useFakeTimers();
    try {
      const pool = new LspPool({ ...CONFIG, idleTimeoutMs: 1000 });
      const session = await pool.acquire("/ws", provider("ruby"));
      session.lastActivity = Date.now() - 5000;
      session.openDocuments.set("file:///ws/a.rb", { uri: "file:///ws/a.rb", version: 1 });

      pool.startIdleCheck();
      await jest.advanceTimersByTimeAsync(60_000);

      expect(pool.getSession("/ws", "ruby")).toBeDefined();
      pool.stopIdleCheck();
    } finally {
      jest.useRealTimers();
    }
  });

  it("startIdleCheck is idempotent — calling it twice does not double-schedule", () => {
    const pool = new LspPool(CONFIG);
    pool.startIdleCheck();
    pool.startIdleCheck();
    pool.stopIdleCheck();
    // No assertion beyond "doesn't throw" — the guard is `if (this.idleCheckTimer) return`.
  });
});
