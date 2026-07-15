import { MemoryStore } from "../memory/store.js";
import { LearningEngine } from "../learning/index.js";
import { SkillsRegistry } from "../skills/registry.js";
import { SkillContent } from "../skills/types.js";
import { Provider } from "../provider/provider.js";

export interface AgentLearningOptions {
  workspaceRoot: string;
  provider: Provider;
  memory: MemoryStore;
  skillsHomeDir?: string;
}

export class AgentLearning {
  readonly memory: MemoryStore;
  readonly learning: LearningEngine;
  readonly skills: SkillsRegistry;
  pinnedSkillId: string | null = null;

  constructor(opts: AgentLearningOptions) {
    this.memory = opts.memory;
    this.learning = new LearningEngine({
      workspaceRoot: opts.workspaceRoot,
      provider: opts.provider,
      memory: opts.memory,
    });
    this.skills = SkillsRegistry.discover(
      { workspaceRoot: opts.workspaceRoot, homeDir: opts.skillsHomeDir },
    );
  }

  getLearnings(): Array<{ category: string; lesson: string }> {
    return this.memory.getLearnings().map((l) => ({
      category: l.category,
      lesson: l.lesson,
    }));
  }

  resolveForPrompt(userMessage: string): SkillContent[] {
    if (this.pinnedSkillId) {
      const skill = this.skills.activate(this.pinnedSkillId);
      return skill ? [skill] : [];
    }
    return this.skills.resolveForPrompt(userMessage);
  }

  pinSkill(id: string | null): void {
    this.pinnedSkillId = id;
  }

  getSkillsRegistry(): SkillsRegistry {
    return this.skills;
  }

  flushLearning(): Promise<void> {
    return this.learning.flush();
  }

  addLearning(category: string, context: string, lesson: string): void {
    this.memory.addLearning(category, context, lesson);
  }

  recordSkillUse(skillId: string, success: boolean): void {
    this.memory.recordSkillUse(skillId, success);
  }

  appendMessage(role: string, content: string): void {
    this.memory.appendMessage(role, content);
  }
}
