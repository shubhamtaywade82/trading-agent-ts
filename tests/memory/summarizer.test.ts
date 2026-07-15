import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "../../src/memory/store.js";
import { generateSummary } from "../../src/memory/summarizer.js";
import { Provider } from "../../src/provider/provider.js";

describe("generateSummary", () => {
  it("prompts the provider with recent messages and stores the resulting bullet summary", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mem-"));
    const store = new MemoryStore(join(dir, "devagent.db"));
    store.appendMessage("user", "add a CommandRegistry");
    store.appendMessage("assistant", "done, created CommandRegistry.ts");

    const fakeProvider = {
      chat: jest.fn().mockResolvedValue({
        message: { role: "assistant", content: "- Added CommandRegistry\n- Wired auto-discovery" },
        done: true,
      }),
    } as unknown as Provider;

    const summary = await generateSummary(store, fakeProvider);

    expect(summary).toBe("- Added CommandRegistry\n- Wired auto-discovery");
    expect(store.getProjectNote("summary")).toBe(summary);
    expect(fakeProvider.chat).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ role: "user", content: "add a CommandRegistry" })]),
      expect.anything(),
    );
    store.close();
  });
});
