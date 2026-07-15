/**
 * Gem scanner — parses Gemfile.lock. GEM/PATH/GIT sections list specs at
 * 4-space indent (`name (version)`) with dependencies at 6-space indent.
 */

import { GemEntity, RelationshipIntent, Scanner, ScannerResult, SourceFile } from "../types.js";

export class GemScanner implements Scanner {
  readonly name = "gem";

  appliesTo(relPath: string): boolean {
    return relPath === "Gemfile.lock";
  }

  scan(files: SourceFile[]): ScannerResult {
    const entities: GemEntity[] = [];
    const intents: RelationshipIntent[] = [];

    for (const file of files) {
      let source: GemEntity["source"] = "gem";
      let current: GemEntity | null = null;
      let inSpecs = false;
      const lines = file.content.split(/\r?\n/);

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (/^(GEM|PATH|GIT)\s*$/.test(line)) {
          source = line.trim() === "GEM" ? "gem" : line.trim() === "PATH" ? "path" : "git";
          inSpecs = false;
          continue;
        }
        if (/^[A-Z]/.test(line)) {
          inSpecs = false;
          continue;
        }
        if (/^\s{2}specs:\s*$/.test(line)) {
          inSpecs = true;
          continue;
        }
        if (!inSpecs) continue;

        const spec = /^\s{4}([A-Za-z0-9_.-]+)\s+\(([^)]+)\)\s*$/.exec(line);
        if (spec) {
          current = {
            id: `gem:${spec[1]}`,
            type: "gem",
            name: spec[1],
            file: file.relPath,
            line: i + 1,
            version: spec[2],
            dependencies: [],
            source,
          };
          entities.push(current);
          continue;
        }

        const dep = /^\s{6}([A-Za-z0-9_.-]+)/.exec(line);
        if (dep && current) {
          current.dependencies.push(dep[1]);
          intents.push({
            fromId: current.id,
            relationship: "depends_on_gem",
            toType: "gem",
            toName: dep[1],
          });
        }
      }
    }

    return { entities, intents };
  }
}
