import { LspServerSession } from "../../src/lsp/session.js";

function makeSession(): LspServerSession {
  return new LspServerSession("/workspace", {
    id: "ruby",
    language: "Ruby",
    serverCommand: "ruby-lsp",
    serverArgs: [],
  } as any);
}

describe("LspServerSession.handleNotification — $/progress indexing tracking", () => {
  it("is not indexing before any progress notification arrives", () => {
    const session = makeSession();
    expect(session.indexing).toBe(false);
  });

  it("becomes indexing on a begin and clears on the matching end", () => {
    const session = makeSession();

    session.handleNotification("$/progress", { token: "t1", value: { kind: "begin", title: "Indexing" } });
    expect(session.indexing).toBe(true);

    session.handleNotification("$/progress", { token: "t1", value: { kind: "report", percentage: 50 } });
    expect(session.indexing).toBe(true);

    session.handleNotification("$/progress", { token: "t1", value: { kind: "end" } });
    expect(session.indexing).toBe(false);
  });

  it("stays indexing while any of several concurrent tokens is still open", () => {
    const session = makeSession();

    session.handleNotification("$/progress", { token: "a", value: { kind: "begin" } });
    session.handleNotification("$/progress", { token: "b", value: { kind: "begin" } });
    expect(session.indexing).toBe(true);

    session.handleNotification("$/progress", { token: "a", value: { kind: "end" } });
    expect(session.indexing).toBe(true); // "b" still open

    session.handleNotification("$/progress", { token: "b", value: { kind: "end" } });
    expect(session.indexing).toBe(false);
  });

  it("clears all in-flight progress tokens on stop", async () => {
    const session = makeSession();
    session.handleNotification("$/progress", { token: "a", value: { kind: "begin" } });
    expect(session.indexing).toBe(true);

    await session.stop();

    expect(session.indexing).toBe(false);
  });

  it("still caches diagnostics from publishDiagnostics alongside progress handling", () => {
    const session = makeSession();
    session.handleNotification("textDocument/publishDiagnostics", {
      uri: "file:///workspace/foo.rb",
      diagnostics: [{ message: "boom" }],
    });
    expect(session.cachedDiagnostics.get("file:///workspace/foo.rb")).toEqual([{ message: "boom" }]);
  });

  it("ignores unrelated notification methods without throwing", () => {
    const session = makeSession();
    expect(() => session.handleNotification("window/logMessage", { message: "hi" })).not.toThrow();
    expect(session.indexing).toBe(false);
  });
});

describe("LspServerSession.indexing — cold-start grace window fallback", () => {
  // Not every server reports $/progress (verified live: neither
  // typescript-language-server nor ruby-lsp do). Without a fallback, a
  // server that never reports progress would report indexing=false forever,
  // even though it's genuinely still warming up.

  it("is not indexing before the server has started (status stays 'starting')", () => {
    const session = makeSession();
    expect(session.status).toBe("starting");
    expect(session.indexing).toBe(false);
  });

  it("treats a freshly-started server as indexing even with no progress tokens", () => {
    const session = makeSession();
    (session as any).status = "running";
    (session as any).startTime = Date.now();

    expect(session.indexing).toBe(true);
  });

  it("stops treating it as indexing once the grace window has elapsed", () => {
    const session = makeSession();
    (session as any).status = "running";
    (session as any).startTime = Date.now() - 25_000; // older than the 20s grace window

    expect(session.indexing).toBe(false);
  });

  it("a real $/progress end does not truncate the grace-window fallback", () => {
    // The fallback and token tracking are independent signals — closing a
    // progress span doesn't mean the server is fully warmed up.
    const session = makeSession();
    (session as any).status = "running";
    (session as any).startTime = Date.now();
    session.handleNotification("$/progress", { token: "a", value: { kind: "begin" } });
    session.handleNotification("$/progress", { token: "a", value: { kind: "end" } });

    expect(session.indexing).toBe(true); // still within the grace window
  });
});

describe("LspServerSession.state", () => {
  it("includes the indexing flag", () => {
    const session = makeSession();
    expect(session.state).toMatchObject({ language: "Ruby", indexing: false });

    session.handleNotification("$/progress", { token: "a", value: { kind: "begin" } });
    expect(session.state.indexing).toBe(true);
  });
});
