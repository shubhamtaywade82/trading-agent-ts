/**
 * RSpec scanner — indexes spec files: described subject, spec type
 * (metadata or path-inferred), and example counts. Emits `tested_by`
 * intents linking the subject entity to the spec.
 */

import { EntityType, RelationshipIntent, Scanner, ScannerResult, SourceFile, SpecEntity, SpecType } from "../types.js";
import { logicalLines } from "./ruby-source.js";

const PATH_TYPES: [RegExp, SpecType][] = [
  [/spec\/models\//, "model"],
  [/spec\/controllers\//, "controller"],
  [/spec\/requests\//, "request"],
  [/spec\/services\//, "service"],
  [/spec\/jobs\//, "job"],
  [/spec\/mailers\//, "mailer"],
  [/spec\/policies\//, "policy"],
  [/spec\/features\//, "feature"],
  [/spec\/system\//, "system"],
];

const TYPE_TO_ENTITY: Partial<Record<SpecType, EntityType>> = {
  model: "model",
  controller: "controller",
  request: "controller",
  service: "service",
  job: "job",
  mailer: "mailer",
  policy: "policy",
};

export class RspecScanner implements Scanner {
  readonly name = "rspec";

  appliesTo(relPath: string): boolean {
    return /(?:^|\/)spec\/.+_spec\.rb$/.test(relPath);
  }

  scan(files: SourceFile[]): ScannerResult {
    const entities: SpecEntity[] = [];
    const intents: RelationshipIntent[] = [];

    for (const file of files) {
      let subjectName: string | undefined;
      let specType: SpecType = "other";
      let exampleCount = 0;
      let describeLine = 1;

      for (const [pattern, type] of PATH_TYPES) {
        if (pattern.test(file.relPath)) {
          specType = type;
          break;
        }
      }

      for (const line of logicalLines(file.content)) {
        const describe = /^RSpec\.describe\s+(.+)$/.exec(line.text);
        if (describe && !subjectName) {
          describeLine = line.line;
          const arg = describe[1].replace(/\s+do\s*$/, "");
          const constant = /^([A-Z][A-Za-z0-9_:]*)/.exec(arg);
          const quoted = /^["']([^"']+)["']/.exec(arg);
          subjectName = constant?.[1] ?? quoted?.[1];
          const typeOpt = /type:\s*:([a-z_]+)/.exec(arg);
          if (typeOpt) specType = (typeOpt[1] as SpecType) ?? specType;
          continue;
        }
        if (/^(?:it|specify|scenario)[\s(]/.test(line.text)) exampleCount++;
      }

      const spec: SpecEntity = {
        id: `spec:${file.relPath}`,
        type: "spec",
        name: file.relPath,
        file: file.relPath,
        line: describeLine,
        subjectName,
        specType,
        exampleCount,
      };
      entities.push(spec);

      if (subjectName) {
        const targetType = TYPE_TO_ENTITY[specType];
        const requestSubject = specType === "request" && !subjectName.includes("Controller");
        if (targetType && !requestSubject) {
          intents.push({
            fromId: spec.id,
            relationship: "tested_by",
            toType: targetType,
            toName: subjectName,
            meta: { inverted: true },
          });
        }
      }
    }

    // `tested_by` semantically points entity → spec; scanners only know the
    // spec side, so intents are emitted spec → entity and flipped on resolve.
    return { entities, intents };
  }
}
