import { StructuredLogger } from "./logger.js";

export type AgentState =
  | "INITIALIZING"
  | "FETCHING_MARKET_DATA"
  | "EVALUATING_RULES"
  | "PLACING_TRADE"
  | "IDLE"
  | "ERROR";

const VALID_TRANSITIONS: Record<AgentState, AgentState[]> = {
  INITIALIZING: ["FETCHING_MARKET_DATA", "ERROR"],
  FETCHING_MARKET_DATA: ["EVALUATING_RULES", "IDLE", "ERROR"],
  EVALUATING_RULES: ["PLACING_TRADE", "IDLE", "ERROR"],
  PLACING_TRADE: ["IDLE", "ERROR"],
  IDLE: ["FETCHING_MARKET_DATA", "ERROR"],
  ERROR: ["INITIALIZING", "IDLE"],
};

export class AgentFSM {
  private currentState: AgentState = "INITIALIZING";

  constructor(private logger: StructuredLogger = new StructuredLogger("AgentFSM")) {}

  getState(): AgentState {
    return this.currentState;
  }

  transitionTo(nextState: AgentState, reason?: string): boolean {
    const allowed = VALID_TRANSITIONS[this.currentState];
    if (!allowed || !allowed.includes(nextState)) {
      this.logger.error(`Invalid FSM transition: ${this.currentState} -> ${nextState}`, { reason });
      return false;
    }

    const previous = this.currentState;
    this.currentState = nextState;
    this.logger.info(`FSM State Transition: ${previous} -> ${nextState}`, { reason });
    return true;
  }
}
