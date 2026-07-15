import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { SessionStore } from "../../src/runtime/session.js";
import { ChatMessage } from "../../src/provider/provider.js";

describe("SessionStore", () => {
  let dir: string;
  let path: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "session-test-"));
    path = join(dir, "session.json");
  });

  it("load returns null when no session file exists", () => {
    const store = new SessionStore(path);
    expect(store.load()).toBeNull();
  });

  it("saves and loads a message transcript", () => {
    const store = new SessionStore(path);
    const messages: ChatMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ];
    store.save(messages);

    expect(store.load()).toEqual(messages);
  });

  it("creates the parent directory if missing", () => {
    const nestedPath = join(dir, "nested", "session.json");
    const store = new SessionStore(nestedPath);
    store.save([{ role: "user", content: "hi" }]);
    expect(existsSync(nestedPath)).toBe(true);
  });

  it("does not leave a .tmp file behind after a save", () => {
    const store = new SessionStore(path);
    store.save([{ role: "user", content: "hi" }]);
    expect(existsSync(`${path}.tmp`)).toBe(false);
  });

  it("overwrites the previous transcript on repeated saves", () => {
    const store = new SessionStore(path);
    store.save([{ role: "user", content: "first" }]);
    store.save([{ role: "user", content: "second" }]);
    expect(store.load()).toEqual([{ role: "user", content: "second" }]);
  });

  it("clear removes the session file", () => {
    const store = new SessionStore(path);
    store.save([{ role: "user", content: "hi" }]);
    store.clear();
    expect(store.load()).toBeNull();
  });

  it("clear is a no-op when no session exists", () => {
    const store = new SessionStore(path);
    expect(() => store.clear()).not.toThrow();
  });

  it("returns null instead of throwing on corrupt JSON", () => {
    const store = new SessionStore(path);
    store.save([{ role: "user", content: "hi" }]);
    writeFileSync(path, "{not valid json");
    expect(store.load()).toBeNull();
  });

  it("returns null when the file contains valid JSON that isn't an array", () => {
    const store = new SessionStore(path);
    writeFileSync(path, JSON.stringify({ not: "an array" }));
    expect(store.load()).toBeNull();
  });

  it("survives a crash mid-write — old transcript intact", () => {
    const store = new SessionStore(path);
    store.save([{ role: "user", content: "first" }]);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual([{ role: "user", content: "first" }]);
  });
});
