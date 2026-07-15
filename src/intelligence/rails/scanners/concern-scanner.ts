/**
 * Concern scanner — indexes app/models/concerns and app/controllers/concerns:
 * ActiveSupport::Concern modules and the macros their `included do` blocks add.
 */

import { ConcernEntity, Scanner, ScannerResult, SourceFile } from "../types.js";
import { logicalLines } from "./ruby-source.js";

const TRACKED_MACROS =
  /^(?:has_many|has_one|belongs_to|has_and_belongs_to_many|validates?|scope|before_\w+|after_\w+|around_\w+)\b/;

export class ConcernScanner implements Scanner {
  readonly name = "concern";

  appliesTo(relPath: string): boolean {
    return /(?:^|\/)app\/(?:models|controllers)\/concerns\/.+\.rb$/.test(relPath);
  }

  scan(files: SourceFile[]): ScannerResult {
    const entities: ConcernEntity[] = [];

    for (const file of files) {
      let concern: ConcernEntity | null = null;

      for (const line of logicalLines(file.content)) {
        const moduleDef = /^module\s+([A-Z][A-Za-z0-9_:]*)/.exec(line.text);
        if (moduleDef) {
          const name = line.namespace.length && !moduleDef[1].includes("::")
            ? `${line.namespace.join("::")}::${moduleDef[1]}`
            : moduleDef[1];
          concern = {
            id: `concern:${name}`,
            type: "concern",
            name,
            file: file.relPath,
            line: line.line,
            macros: [],
          };
          entities.push(concern);
          continue;
        }
        if (!concern) continue;

        const macro = TRACKED_MACROS.exec(line.text);
        if (macro) concern.macros.push(line.text);
      }
    }

    return { entities, intents: [] };
  }
}
