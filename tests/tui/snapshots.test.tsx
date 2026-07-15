import React from "react";
import { render } from "ink-testing-library";
import { App } from "../../src/tui/App.js";
import { EventBus } from "../../src/runtime/events.js";
import { initialRuntimeState, Store } from "../../src/runtime/store.js";

const NOW = new Date(2026, 0, 1, 10, 42, 11).getTime();

function seededWorld() {
  const bus = new EventBus();
  const store = new Store(initialRuntimeState({ workspace: "ollama-agent", branch: "main", model: "qwen3:30b" }));
  store.attach(bus);
  bus.publish({ type: "conversation.message", role: "user", text: "create filesystem tool" });
  bus.publish({
    type: "conversation.chunk",
    role: "assistant",
    chunk: "Analyzing project structure and existing patterns...\n- Reading package.json\n- Found TypeScript project",
  });
  bus.publish({
    type: "task.created",
    task: { id: "t1", title: "Design interface", status: "completed", dependencies: [] },
  });
  bus.publish({
    type: "task.created",
    task: { id: "t2", title: "Implement tool", status: "running", dependencies: ["t1"], progress: 0.7 },
  });
  bus.publish({
    type: "task.created",
    task: { id: "t3", title: "Write tests", status: "queued", dependencies: ["t2"] },
  });
  bus.publish({ type: "tool.started", id: "tc1", name: "edit_file", args: { path: "src/tools/fs.ts" } });
  bus.publish({ type: "context.changed", used: 48000, limit: 71000 });
  bus.publish({
    type: "git.changed",
    git: {
      branch: "main",
      ahead: 1,
      behind: 0,
      files: [
        { path: "src/tools/fs.ts", status: "modified", staged: false, additions: 128, deletions: 4 },
        { path: "src/tools/index.ts", status: "added", staged: true, additions: 12, deletions: 0 },
      ],
    },
  });
  return { bus, store };
}

describe("layout snapshots", () => {
  const sizes: [number, number][] = [
    [80, 24],
    [100, 30],
    [120, 30],
    [160, 45],
    [220, 60],
  ];

  beforeEach(() => {
    jest.spyOn(Date, "now").mockReturnValue(NOW);
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it.each(sizes)("same structure, density-only changes at %dx%d", (columns, rows) => {
    const { bus, store } = seededWorld();
    const { lastFrame, unmount } = render(<App bus={bus} store={store} columns={columns} rows={rows} now={NOW} />);
    expect(lastFrame()).toMatchSnapshot();
    unmount();
  });
});
