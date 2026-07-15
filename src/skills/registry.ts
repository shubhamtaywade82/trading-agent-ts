/**
 * SkillsRegistry — parallel to Tools' Registry in name only. Skills are
 * not Tool subclasses: they inject prompt content, not callable
 * functions, so this holds metadata + lazy content loading instead of
 * schemas/invoke.
 */

import { DiscoverOptions, discoverSkills, loadSkillContent } from "./loader.js";
import { resolveSkills, ResolveOptions } from "./resolver.js";
import { SkillContent, SkillMeta } from "./types.js";

export class SkillsRegistry {
  private constructor(
    private readonly catalog: SkillMeta[],
    readonly projectLanguage?: string,
  ) {}

  static discover(opts: DiscoverOptions, projectLanguage?: string): SkillsRegistry {
    return new SkillsRegistry(discoverSkills(opts), projectLanguage);
  }

  list(): SkillMeta[] {
    return [...this.catalog];
  }

  get(id: string): SkillMeta | undefined {
    return this.catalog.find((s) => s.id === id);
  }

  /** Resolve + lazily load content for the top matches for a given user prompt. */
  resolveForPrompt(prompt: string, opts?: ResolveOptions): SkillContent[] {
    return resolveSkills(prompt, this.catalog, { ...opts, projectLanguage: this.projectLanguage }).map((score) =>
      loadSkillContent(score.meta),
    );
  }

  /** Explicit pin/activate by id, bypassing scoring. */
  activate(id: string): SkillContent | undefined {
    const meta = this.get(id);
    return meta ? loadSkillContent(meta) : undefined;
  }
}
