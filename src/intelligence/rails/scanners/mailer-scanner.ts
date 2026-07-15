/**
 * Mailer scanner — indexes app/mailers: public mailer actions and
 * `default from:`.
 */

import { MailerEntity, Scanner, ScannerResult, SourceFile } from "../types.js";
import { logicalLines, parseMacroArgs, unquote } from "./ruby-source.js";

export class MailerScanner implements Scanner {
  readonly name = "mailer";

  appliesTo(relPath: string): boolean {
    return /(?:^|\/)app\/mailers\/.+\.rb$/.test(relPath);
  }

  scan(files: SourceFile[]): ScannerResult {
    const entities: MailerEntity[] = [];

    for (const file of files) {
      let mailer: MailerEntity | null = null;
      let visibility: "public" | "private" = "public";

      for (const line of logicalLines(file.content)) {
        const classDef = /^class\s+([A-Z][A-Za-z0-9_:]*)/.exec(line.text);
        if (classDef) {
          const name = line.namespace.length && !classDef[1].includes("::")
            ? `${line.namespace.join("::")}::${classDef[1]}`
            : classDef[1];
          mailer = {
            id: `mailer:${name}`,
            type: "mailer",
            name,
            file: file.relPath,
            line: line.line,
            actions: [],
          };
          entities.push(mailer);
          visibility = "public";
          continue;
        }
        if (!mailer) continue;

        if (/^(private|protected)\s*$/.test(line.text)) {
          visibility = "private";
          continue;
        }

        const def = /^def\s+([a-z_][a-z0-9_?!]*)/.exec(line.text);
        if (def && visibility === "public") {
          mailer.actions.push(def[1]);
          continue;
        }

        const defaults = /^default\s+(.+)$/.exec(line.text);
        if (defaults) {
          const call = parseMacroArgs(defaults[1]);
          if (call.opts.from) mailer.defaultFrom = unquote(call.opts.from);
        }
      }
    }

    return { entities, intents: [] };
  }
}
