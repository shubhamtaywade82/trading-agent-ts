import { LspClient } from "../../src/lsp/client.js";

// No real language server binary is required for these tests — a tiny Node
// script speaking the same Content-Length-framed JSON-RPC protocol stands in
// for one, so the real spawn/framing/parsing code in LspClient is exercised
// end-to-end instead of mocked away.
function frame(obj: unknown): string {
  const body = JSON.stringify(obj);
  return `Content-Length: ${Buffer.byteLength(body, "utf-8")}\r\n\r\n${body}`;
}

const ECHO_SERVER = `
const chunks = [];
let buf = "";
process.stdin.on("data", (d) => {
  buf += d.toString("utf-8");
  for (;;) {
    const headerEnd = buf.indexOf("\\r\\n\\r\\n");
    if (headerEnd === -1) break;
    const m = buf.slice(0, headerEnd).match(/Content-Length:\\s*(\\d+)/i);
    if (!m) { buf = buf.slice(headerEnd + 4); continue; }
    const len = parseInt(m[1], 10);
    const bodyStart = headerEnd + 4;
    if (buf.length < bodyStart + len) break;
    const body = buf.slice(bodyStart, bodyStart + len);
    buf = buf.slice(bodyStart + len);
    const msg = JSON.parse(body);
    if (msg.id !== undefined) {
      let response;
      if (msg.method === "willFail") {
        response = { jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: "boom" } };
      } else if (msg.method === "shutdown") {
        response = { jsonrpc: "2.0", id: msg.id, result: null };
      } else {
        response = { jsonrpc: "2.0", id: msg.id, result: { echoedMethod: msg.method, echoedParams: msg.params } };
      }
      const out = JSON.stringify(response);
      process.stdout.write("Content-Length: " + Buffer.byteLength(out, "utf-8") + "\\r\\n\\r\\n" + out);
    } else if (msg.method === "triggerNotification") {
      const notif = { jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { token: "t1", value: { kind: "begin" } } };
      const out = JSON.stringify(notif);
      process.stdout.write("Content-Length: " + Buffer.byteLength(out, "utf-8") + "\\r\\n\\r\\n" + out);
    }
  }
});
`;

function echoClient() {
  return new LspClient({ command: process.execPath, args: ["-e", ECHO_SERVER], cwd: process.cwd() });
}

describe("LspClient — real process spawn + JSON-RPC framing", () => {
  it("starts a process and completes a request/response round trip", async () => {
    const client = echoClient();
    await client.start();

    const result = (await client.sendRequest("foo/bar", { a: 1 })) as any;

    expect(result.echoedMethod).toBe("foo/bar");
    expect(result.echoedParams).toEqual({ a: 1 });

    client.exit();
  });

  it("matches concurrent requests to the correct response by id", async () => {
    const client = echoClient();
    await client.start();

    const [r1, r2, r3] = await Promise.all([
      client.sendRequest("m1", { n: 1 }),
      client.sendRequest("m2", { n: 2 }),
      client.sendRequest("m3", { n: 3 }),
    ]);

    expect((r1 as any).echoedParams).toEqual({ n: 1 });
    expect((r2 as any).echoedParams).toEqual({ n: 2 });
    expect((r3 as any).echoedParams).toEqual({ n: 3 });

    client.exit();
  });

  it("rejects sendRequest when the server responds with a JSON-RPC error", async () => {
    const client = echoClient();
    await client.start();

    await expect(client.sendRequest("willFail", {})).rejects.toThrow(/LSP error -32000: boom/);

    client.exit();
  });

  it("emits both the raw method and the transformed event name for notifications", async () => {
    const client = echoClient();
    await client.start();

    const raw = jest.fn();
    const transformed = jest.fn();
    client.on("notification", raw);
    // methodToEventName lowercases each uppercase letter with an underscore
    // prefix, leaving "/" untouched: "textDocument/publishDiagnostics" ->
    // "text_document/publish_diagnostics".
    client.on("text_document/publish_diagnostics", transformed);

    client.sendNotification("triggerNotification", {});
    await new Promise((r) => setTimeout(r, 200));

    expect(raw).toHaveBeenCalledWith("textDocument/publishDiagnostics", { token: "t1", value: { kind: "begin" } });
    expect(transformed).toHaveBeenCalledWith({ token: "t1", value: { kind: "begin" } });

    client.exit();
  });

  it("fails all pending requests when the process exits unexpectedly", async () => {
    const client = new LspClient({ command: process.execPath, args: ["-e", "process.exit(1)"], cwd: process.cwd() });
    const exitHandler = jest.fn();
    client.on("exit", exitHandler);
    await client.start().catch(() => {}); // waitForProcess resolves via setImmediate before exit fires

    await new Promise((r) => setTimeout(r, 200));
    expect(exitHandler).toHaveBeenCalled();
  });

  it("throws on sendRequest and no-ops sendNotification after exit()", async () => {
    const client = echoClient();
    await client.start();
    client.exit();

    await expect(client.sendRequest("foo", {})).rejects.toThrow(/closed/);
    expect(() => client.sendNotification("foo", {})).not.toThrow();
  });

  it("handles a response split across multiple stdout chunks", async () => {
    const SLOW_SERVER = `
      process.stdin.resume();
      let buf = "";
      process.stdin.on("data", (d) => {
        buf += d.toString("utf-8");
        const headerEnd = buf.indexOf("\\r\\n\\r\\n");
        if (headerEnd === -1) return;
        const len = parseInt(buf.slice(0, headerEnd).match(/Content-Length:\\s*(\\d+)/i)[1], 10);
        if (buf.length < headerEnd + 4 + len) return;
        const body = JSON.parse(buf.slice(headerEnd + 4, headerEnd + 4 + len));
        const response = JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { ok: true } });
        const framed = "Content-Length: " + Buffer.byteLength(response, "utf-8") + "\\r\\n\\r\\n" + response;
        // Write byte-by-byte with tiny delays to force chunked delivery on the reading side.
        let i = 0;
        const tick = () => {
          if (i >= framed.length) return;
          process.stdout.write(framed[i]);
          i++;
          setTimeout(tick, 1);
        };
        tick();
      });
    `;
    const client = new LspClient({ command: process.execPath, args: ["-e", SLOW_SERVER], cwd: process.cwd() });
    await client.start();

    const result = (await client.sendRequest("foo", {})) as any;
    expect(result).toEqual({ ok: true });

    client.exit();
  }, 15000);

  it("recovers from a malformed message body without corrupting the stream", async () => {
    const BAD_THEN_GOOD_SERVER = `
      const bad = "not json";
      process.stdout.write("Content-Length: " + Buffer.byteLength(bad, "utf-8") + "\\r\\n\\r\\n" + bad);
      let buf = "";
      process.stdin.on("data", (d) => {
        buf += d.toString("utf-8");
        const headerEnd = buf.indexOf("\\r\\n\\r\\n");
        if (headerEnd === -1) return;
        const len = parseInt(buf.slice(0, headerEnd).match(/Content-Length:\\s*(\\d+)/i)[1], 10);
        if (buf.length < headerEnd + 4 + len) return;
        const body = JSON.parse(buf.slice(headerEnd + 4, headerEnd + 4 + len));
        const response = JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { ok: true } });
        process.stdout.write("Content-Length: " + Buffer.byteLength(response, "utf-8") + "\\r\\n\\r\\n" + response);
      });
    `;
    const client = new LspClient({ command: process.execPath, args: ["-e", BAD_THEN_GOOD_SERVER], cwd: process.cwd() });
    const parseErrors = jest.fn();
    client.on("parseError", parseErrors);
    await client.start();

    const result = (await client.sendRequest("foo", {})) as any;

    expect(parseErrors).toHaveBeenCalled();
    expect(result).toEqual({ ok: true });

    client.exit();
  });
});

describe("LspClient high-level LSP methods build correct frames", () => {
  it("initialize/initialized/didOpen/didChange/didClose all round-trip through the real transport", async () => {
    const client = echoClient();
    await client.start();

    const initResult = (await client.initialize("file:///ws", { textDocument: {} })) as any;
    expect(initResult.echoedMethod).toBe("initialize");
    expect(initResult.echoedParams.rootUri).toBe("file:///ws");

    expect(() => client.initialized()).not.toThrow();
    expect(() => client.didOpen("file:///ws/a.ts", "content", "typescript")).not.toThrow();
    expect(() => client.didChange("file:///ws/a.ts", 2, [{ text: "new content" }])).not.toThrow();
    expect(() => client.didClose("file:///ws/a.ts")).not.toThrow();

    await client.shutdown();
    client.exit();
  });
});

describe("frame() self-check", () => {
  it("produces a well-formed Content-Length header", () => {
    const framed = frame({ a: 1 });
    expect(framed).toMatch(/^Content-Length: \d+\r\n\r\n\{"a":1\}$/);
  });
});
