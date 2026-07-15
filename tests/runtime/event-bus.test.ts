import { EventBus, RuntimeEvent } from "../../src/runtime/events.js";

describe("EventBus", () => {
  it("delivers events to all subscribers", () => {
    const bus = new EventBus();
    const seen: RuntimeEvent[] = [];
    bus.subscribe((e) => seen.push(e));
    bus.subscribe((e) => seen.push(e));
    bus.publish({ type: "status.changed", status: "hello" });
    expect(seen).toHaveLength(2);
    expect(seen[0]).toEqual({ type: "status.changed", status: "hello" });
  });

  it("unsubscribe stops delivery", () => {
    const bus = new EventBus();
    const seen: RuntimeEvent[] = [];
    const unsub = bus.subscribe((e) => seen.push(e));
    bus.publish({ type: "status.changed", status: "a" });
    unsub();
    bus.publish({ type: "status.changed", status: "b" });
    expect(seen).toHaveLength(1);
  });

  it("a subscriber unsubscribing during publish does not break others", () => {
    const bus = new EventBus();
    const seen: string[] = [];
    const unsub = bus.subscribe(() => {
      seen.push("first");
      unsub();
    });
    bus.subscribe(() => seen.push("second"));
    bus.publish({ type: "status.changed", status: "x" });
    expect(seen).toEqual(["first", "second"]);
  });
});
