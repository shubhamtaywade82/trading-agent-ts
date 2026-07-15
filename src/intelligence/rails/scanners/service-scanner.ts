/**
 * Service scanner — indexes app/services classes: public methods, the
 * `.call` convention, and references to models (`User.create!`), jobs
 * (`FooJob.perform_later`), mailers (`UserMailer.welcome`), and other
 * services.
 */

import { RelationshipIntent, Scanner, ScannerResult, ServiceEntity, SourceFile } from "../types.js";
import { logicalLines } from "./ruby-source.js";

export class ServiceScanner implements Scanner {
  readonly name = "service";

  appliesTo(relPath: string): boolean {
    return /(?:^|\/)app\/services\/.+\.rb$/.test(relPath);
  }

  scan(files: SourceFile[]): ScannerResult {
    const entities: ServiceEntity[] = [];
    const intents: RelationshipIntent[] = [];

    for (const file of files) {
      let service: ServiceEntity | null = null;
      let visibility: "public" | "private" | "protected" = "public";
      const referenced = new Set<string>();

      for (const line of logicalLines(file.content)) {
        const classDef = /^class\s+([A-Z][A-Za-z0-9_:]*)/.exec(line.text);
        if (classDef) {
          const name = line.namespace.length && !classDef[1].includes("::")
            ? `${line.namespace.join("::")}::${classDef[1]}`
            : classDef[1];
          service = {
            id: `service:${name}`,
            type: "service",
            name,
            file: file.relPath,
            line: line.line,
            publicMethods: [],
            hasCallInterface: false,
          };
          entities.push(service);
          visibility = "public";
          continue;
        }
        if (!service) continue;

        if (/^(private|protected)\s*$/.test(line.text)) {
          visibility = line.text.startsWith("private") ? "private" : "protected";
          continue;
        }

        const def = /^def\s+(?:self\.)?([a-z_][a-z0-9_?!]*)/.exec(line.text);
        if (def && visibility === "public") {
          service.publicMethods.push(def[1]);
          if (def[1] === "call") service.hasCallInterface = true;
        }

        // Constant receivers used inside the service body.
        for (const m of line.text.matchAll(/\b([A-Z][A-Za-z0-9]*(?:::[A-Z][A-Za-z0-9]*)*)\.([a-z_][a-z0-9_!?]*)/g)) {
          const constant = m[1];
          const method = m[2];
          const key = `${constant}.${method}`;
          if (referenced.has(key)) continue;
          referenced.add(key);

          if (/Job$/.test(constant) && /^perform_(?:later|now|async)$/.test(method)) {
            intents.push({ fromId: service.id, relationship: "enqueues", toType: "job", toName: constant });
          } else if (/Mailer$/.test(constant)) {
            intents.push({ fromId: service.id, relationship: "delivers", toType: "mailer", toName: constant });
          } else if (/^(?:create|create!|find|find_by|find_by!|where|new|update|update!|destroy|delete|upsert|insert_all|transaction)$/.test(method)) {
            intents.push({ fromId: service.id, relationship: "calls", toType: "model", toName: constant });
          } else if (method === "call") {
            intents.push({ fromId: service.id, relationship: "calls", toType: "service", toName: constant });
          }
        }
      }
    }

    return { entities, intents };
  }
}
