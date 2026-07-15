/**
 * Migration scanner — indexes db/migrate: timestamp + class name from the
 * filename, schema operations, and links to the tables they define/alter.
 */

import { MigrationEntity, RelationshipIntent, Scanner, ScannerResult, SourceFile } from "../types.js";
import { logicalLines, unquote } from "./ruby-source.js";

const TABLE_OPS =
  /^(create_table|drop_table|rename_table|add_column|remove_column|rename_column|change_column|add_index|remove_index|add_reference|remove_reference|add_foreign_key|remove_foreign_key|create_join_table)\s+(.+)$/;

export class MigrationScanner implements Scanner {
  readonly name = "migration";

  appliesTo(relPath: string): boolean {
    return /(?:^|\/)db\/migrate\/\d+_.+\.rb$/.test(relPath);
  }

  scan(files: SourceFile[]): ScannerResult {
    const entities: MigrationEntity[] = [];
    const intents: RelationshipIntent[] = [];

    for (const file of files) {
      const fileMatch = /(\d+)_([a-z0-9_]+)\.rb$/.exec(file.relPath);
      if (!fileMatch) continue;
      const migration: MigrationEntity = {
        id: `migration:${fileMatch[1]}`,
        type: "migration",
        name: fileMatch[2],
        file: file.relPath,
        line: 1,
        timestamp: fileMatch[1],
        operations: [],
      };
      entities.push(migration);
      const linkedTables = new Set<string>();

      for (const line of logicalLines(file.content)) {
        const op = TABLE_OPS.exec(line.text);
        if (!op) continue;
        migration.operations.push(op[1]);
        const tableArg = /^[:"']?([a-z_0-9]+)/.exec(unquote(op[2].split(",")[0] ?? ""));
        if (tableArg && !linkedTables.has(tableArg[1])) {
          linkedTables.add(tableArg[1]);
          intents.push({
            fromId: migration.id,
            relationship: "defined_in_migration",
            toType: "table",
            toName: tableArg[1],
            meta: { operation: op[1], inverted: true },
          });
        }
      }
    }

    return { entities, intents };
  }
}
