/**
 * Job scanner — indexes app/jobs: queue_as, perform signature, and the
 * models/mailers the job touches.
 */

import { JobEntity, RelationshipIntent, Scanner, ScannerResult, SourceFile } from "../types.js";
import { logicalLines, parseSymbolList } from "./ruby-source.js";

export class JobScanner implements Scanner {
  readonly name = "job";

  appliesTo(relPath: string): boolean {
    return /(?:^|\/)app\/jobs\/.+\.rb$/.test(relPath);
  }

  scan(files: SourceFile[]): ScannerResult {
    const entities: JobEntity[] = [];
    const intents: RelationshipIntent[] = [];

    for (const file of files) {
      let job: JobEntity | null = null;
      const referenced = new Set<string>();

      for (const line of logicalLines(file.content)) {
        const classDef = /^class\s+([A-Z][A-Za-z0-9_:]*)/.exec(line.text);
        if (classDef) {
          const name = line.namespace.length && !classDef[1].includes("::")
            ? `${line.namespace.join("::")}::${classDef[1]}`
            : classDef[1];
          job = {
            id: `job:${name}`,
            type: "job",
            name,
            file: file.relPath,
            line: line.line,
            performArgs: [],
          };
          entities.push(job);
          continue;
        }
        if (!job) continue;

        const queue = /^queue_as\s+(.+)$/.exec(line.text);
        if (queue) {
          job.queue = parseSymbolList(queue[1])[0] ?? queue[1].replace(/["':]/g, "");
          continue;
        }

        const perform = /^def\s+perform\(([^)]*)\)/.exec(line.text) ?? /^def\s+perform\s*$/.exec(line.text);
        if (perform) {
          job.performArgs = (perform[1] ?? "")
            .split(",")
            .map((a) => a.trim())
            .filter(Boolean);
          continue;
        }

        for (const m of line.text.matchAll(/\b([A-Z][A-Za-z0-9]*(?:::[A-Z][A-Za-z0-9]*)*)\.([a-z_][a-z0-9_!?]*)/g)) {
          const constant = m[1];
          const method = m[2];
          const key = `${constant}.${method}`;
          if (referenced.has(key)) continue;
          referenced.add(key);
          if (/Mailer$/.test(constant)) {
            intents.push({ fromId: job.id, relationship: "delivers", toType: "mailer", toName: constant });
          } else if (/^(?:create|create!|find|find_by|find_by!|where|update|update!|destroy)$/.test(method)) {
            intents.push({ fromId: job.id, relationship: "calls", toType: "model", toName: constant });
          }
        }
      }
    }

    return { entities, intents };
  }
}
