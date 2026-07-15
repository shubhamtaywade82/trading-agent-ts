import { PlanStep, StepRunner, Planner, HistoryEntry, StepStatus } from "./types.js";
import { CheckpointStore } from "../runtime/checkpoint.js";

export class OrchestratorError extends Error {}

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_MAX_REPLANS = 5;

const VALID_TRANSITIONS: Record<StepStatus, readonly StepStatus[]> = {
  pending: ["analyzing", "blocked", "cancelled", "running", "skipped"],
  analyzing: ["planning", "blocked", "cancelled", "failed"],
  planning: ["implementing", "blocked", "cancelled", "failed"],
  implementing: ["testing", "blocked", "cancelled", "failed"],
  testing: ["reviewing", "blocked", "cancelled", "failed"],
  reviewing: ["completed", "rejected", "blocked", "cancelled", "failed"],
  completed: ["rolledback"],
  failed: ["pending", "rolledback"],
  rejected: ["pending", "planning", "implementing"],
  blocked: ["pending", "analyzing", "planning", "implementing", "testing", "reviewing", "cancelled", "skipped"],
  paused: ["pending", "analyzing", "planning", "implementing", "testing", "reviewing", "skipped"],
  cancelled: [],
  rolledback: [],
  skipped: ["pending"],
  running: ["completed", "failed", "blocked", "cancelled", "testing"],
};

export interface OrchestratorOptions {
  steps: PlanStep[];
  runner: StepRunner;
  planner: Planner;
  runRollback: (command: string) => Promise<void>;
  maxRetries?: number;
  maxReplans?: number;
  logger?: Pick<Console, "info" | "warn" | "error">;
  onStepChange?: (step: PlanStep) => void;
  checkpoint?: CheckpointStore;
}

export class Orchestrator {
  private steps: Map<string, PlanStep>;
  private readonly runner: StepRunner;
  private readonly planner: Planner;
  private readonly runRollback: (command: string) => Promise<void>;
  private readonly maxRetries: number;
  private readonly maxReplans: number;
  private readonly logger: Pick<Console, "info" | "warn" | "error">;
  private readonly executedOrder: PlanStep[] = [];
  private readonly history: HistoryEntry[] = [];
  private replanCount = 0;
  private readonly onStepChange?: (step: PlanStep) => void;
  private readonly checkpoint?: CheckpointStore;

  constructor(opts: OrchestratorOptions) {
    this.steps = new Map(opts.steps.map((s) => [s.id, s]));
    this.runner = opts.runner;
    this.planner = opts.planner;
    this.runRollback = opts.runRollback;
    this.maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.maxReplans = opts.maxReplans ?? DEFAULT_MAX_REPLANS;
    this.logger = opts.logger ?? console;
    this.onStepChange = opts.onStepChange;
    this.checkpoint = opts.checkpoint;
  }

  private saveCheckpoint(): void {
    this.checkpoint?.save({
      steps: [...this.steps.values()],
      history: this.history,
      replanCount: this.replanCount,
    });
  }

  async run(): Promise<PlanStep[]> {
    let order = this.topologicalOrder();

    for (;;) {
      // All steps whose dependencies are already satisfied run concurrently —
      // e.g. independent coder/reviewer/tester steps fan out in one round
      // instead of executing one at a time. Steps that only become ready
      // because this round completed are picked up in the next round.
      const ready = order.filter((s) => s.status === "pending" && this.dependenciesSatisfied(s));
      if (!ready.length) break;

      const results = await Promise.all(ready.map((s) => this.runStep(s)));
      const replanNeeded = results.some(Boolean);
      if (!replanNeeded) continue;

      this.replanCount += 1;
      if (this.replanCount > this.maxReplans) {
        throw new OrchestratorError(`exceeded ${this.maxReplans} re-plans — aborting to avoid an unbounded loop`);
      }

      const remaining = order.filter((s) => s.status !== "completed" && s.status !== "failed");
      const revised = await this.planner.replan(remaining, this.history);
      this.applyReplan(revised);
      order = this.topologicalOrder();
    }

    if ([...this.steps.values()].some((s) => s.status === "failed")) {
      await this.rollbackAll();
    }

    this.checkpoint?.clear();
    return [...this.steps.values()];
  }

  private dependenciesSatisfied(step: PlanStep): boolean {
    return step.dependencies.every((depId) => this.steps.get(depId)?.status === "completed");
  }

  private transitionStatus(step: PlanStep, to: StepStatus): void {
    const from = step.status;
    if (from === to) return;
    const allowed = VALID_TRANSITIONS[from];
    if (!allowed || !allowed.includes(to)) {
      this.logger.warn(`[Orchestrator] Invalid ASL transition from '${from}' to '${to}' for step ${step.id}`);
      // Do not perform invalid transition; keep current status.
      return;
    }
    step.status = to;
    this.onStepChange?.(step);
    this.saveCheckpoint();
  }

  private async runStep(step: PlanStep): Promise<boolean> {
    this.transitionStatus(step, "analyzing");
    this.transitionStatus(step, "planning");
    this.transitionStatus(step, "implementing");

    const outcome = await this.runner.run(step);
    this.history.push({ stepId: step.id, outcome, at: Date.now() });

    if (outcome.kind === "success") {
      this.transitionStatus(step, "testing");
      this.transitionStatus(step, "reviewing");
      this.transitionStatus(step, "completed");
      this.executedOrder.push(step);
      return false;
    }

    if (outcome.kind === "retryable" && step.retryCount < this.maxRetries) {
      step.retryCount += 1;
      this.transitionStatus(step, "failed");
      this.transitionStatus(step, "pending");
      this.logger.warn(`[Orchestrator] ${step.id} retry ${step.retryCount}/${this.maxRetries}: ${outcome.error}`);
      return false;
    }

    this.transitionStatus(step, "failed");
    this.cascadeFailure(step.id);
    this.logger.warn(`[Orchestrator] ${step.id} failed — triggering RE_PLAN: ${outcome.error}`);
    return true;
  }

  private cascadeFailure(failedId: string): void {
    for (const step of this.steps.values()) {
      if (step.status === "pending" && step.dependencies.includes(failedId)) {
        this.transitionStatus(step, "skipped");
        this.cascadeFailure(step.id);
      }
    }
  }

  private applyReplan(revised: PlanStep[]): void {
    for (const step of revised) {
      this.steps.set(step.id, step);
    }
    this.saveCheckpoint();
  }

  private topologicalOrder(): PlanStep[] {
    const visited = new Set<string>();
    const order: PlanStep[] = [];

    const visit = (step: PlanStep, stack: Set<string>) => {
      if (visited.has(step.id)) return;
      if (stack.has(step.id)) throw new OrchestratorError(`dependency cycle detected at ${step.id}`);

      stack.add(step.id);
      for (const depId of step.dependencies) {
        const dep = this.steps.get(depId);
        if (!dep) throw new OrchestratorError(`${step.id} depends on unknown step ${depId}`);
        visit(dep, stack);
      }
      stack.delete(step.id);
      visited.add(step.id);
      order.push(step);
    };

    for (const step of this.steps.values()) visit(step, new Set());
    return order;
  }

  private async rollbackAll(): Promise<void> {
    for (const step of [...this.executedOrder].reverse()) {
      if (!step.rollbackCommand) continue;
      this.logger.info(`[Orchestrator] rolling back ${step.id}: ${step.rollbackCommand}`);
      try {
        await this.runRollback(step.rollbackCommand);
      } catch (e) {
        this.logger.error(`[Orchestrator] rollback for ${step.id} failed: ${e instanceof Error ? e.message : e}`);
      }
    }
  }
}
