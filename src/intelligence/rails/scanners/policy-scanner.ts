/**
 * Policy scanner — indexes app/policies (Pundit convention): permission
 * query methods and the model the policy authorizes (FooPolicy → Foo).
 */

import { PolicyEntity, RelationshipIntent, Scanner, ScannerResult, SourceFile } from "../types.js";
import { logicalLines } from "./ruby-source.js";

export class PolicyScanner implements Scanner {
  readonly name = "policy";

  appliesTo(relPath: string): boolean {
    return /(?:^|\/)app\/policies\/.+\.rb$/.test(relPath);
  }

  scan(files: SourceFile[]): ScannerResult {
    const entities: PolicyEntity[] = [];
    const intents: RelationshipIntent[] = [];

    for (const file of files) {
      let policy: PolicyEntity | null = null;

      for (const line of logicalLines(file.content)) {
        const classDef = /^class\s+([A-Z][A-Za-z0-9_:]*Policy)\b/.exec(line.text);
        if (classDef) {
          const name = line.namespace.length && !classDef[1].includes("::")
            ? `${line.namespace.join("::")}::${classDef[1]}`
            : classDef[1];
          policy = {
            id: `policy:${name}`,
            type: "policy",
            name,
            file: file.relPath,
            line: line.line,
            permissions: [],
          };
          entities.push(policy);
          const modelName = name.replace(/Policy$/, "");
          if (modelName && modelName !== "Application") {
            intents.push({ fromId: policy.id, relationship: "authorizes", toType: "model", toName: modelName });
          }
          continue;
        }
        if (!policy) continue;

        const def = /^def\s+([a-z_][a-z0-9_]*\?)/.exec(line.text);
        if (def) policy.permissions.push(def[1]);
      }
    }

    return { entities, intents };
  }
}
