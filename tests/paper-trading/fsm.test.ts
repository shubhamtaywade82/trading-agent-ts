import { AgentFSM } from "../../src/paper-trading/fsm.js";
import { StructuredLogger } from "../../src/paper-trading/logger.js";

describe("AgentFSM", () => {
  let logger: StructuredLogger;
  let fsm: AgentFSM;

  beforeEach(() => {
    logger = new StructuredLogger("TestFSM");
    fsm = new AgentFSM(logger);
  });

  test("starts in INITIALIZING state", () => {
    expect(fsm.getState()).toBe("INITIALIZING");
  });

  test("allows valid state transitions", () => {
    expect(fsm.transitionTo("FETCHING_MARKET_DATA")).toBe(true);
    expect(fsm.getState()).toBe("FETCHING_MARKET_DATA");

    expect(fsm.transitionTo("EVALUATING_RULES")).toBe(true);
    expect(fsm.getState()).toBe("EVALUATING_RULES");

    expect(fsm.transitionTo("IDLE")).toBe(true);
    expect(fsm.getState()).toBe("IDLE");
  });

  test("blocks invalid state transitions and logs error", () => {
    expect(fsm.transitionTo("PLACING_TRADE")).toBe(false);
    expect(fsm.getState()).toBe("INITIALIZING");

    const logs = logger.getLogs();
    expect(logs.some((l) => l.level === "error" && l.message.includes("Invalid FSM transition"))).toBe(true);
  });
});
