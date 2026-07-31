export type AgentState =
  | "IDLE"
  | "FETCH_DATA"
  | "EVALUATE_RULES"
  | "RISK_CHECK"
  | "EXECUTE"
  | "RECONCILE"
  | "ERROR"
  | "HALTED";

type Handler = () => Promise<AgentState>;

export class AgentMachine {
  private state: AgentState = "IDLE";

  constructor(
    private readonly handlers: Record<Exclude<AgentState, "IDLE">, Handler>,
    private readonly onTransition: (from: AgentState, to: AgentState) => void,
  ) {}

  current(): AgentState {
    return this.state;
  }

  async step(): Promise<AgentState> {
    if (this.state === "HALTED") return this.state;
    try {
      const next = this.state === "IDLE"
        ? "FETCH_DATA"
        : await this.handlers[this.state as Exclude<AgentState, "IDLE">]();
      this.onTransition(this.state, next);
      this.state = next;
      return next;
    } catch {
      this.onTransition(this.state, "ERROR");
      this.state = "ERROR";
      return "ERROR";
    }
  }
}
