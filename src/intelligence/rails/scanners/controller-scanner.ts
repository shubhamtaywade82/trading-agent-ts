/**
 * Controller scanner — extracts public actions (declarations above
 * private/protected), before_actions with only/except, rescue_from
 * handlers, and concern includes from app/controllers.
 */

import {
  ControllerEntity,
  RelationshipIntent,
  Scanner,
  ScannerResult,
  SourceFile,
} from "../types.js";
import { logicalLines, parseMacroArgs, parseSymbolList } from "./ruby-source.js";

export class ControllerScanner implements Scanner {
  readonly name = "controller";

  appliesTo(relPath: string): boolean {
    return /(?:^|\/)app\/controllers\/(?!concerns\/).+\.rb$/.test(relPath);
  }

  scan(files: SourceFile[]): ScannerResult {
    const entities: ControllerEntity[] = [];
    const intents: RelationshipIntent[] = [];

    for (const file of files) {
      let controller: ControllerEntity | null = null;
      let visibility: "public" | "private" | "protected" = "public";

      for (const line of logicalLines(file.content)) {
        const classDef = /^class\s+([A-Z][A-Za-z0-9_:]*Controller)\b/.exec(line.text);
        if (classDef) {
          const name = line.namespace.length && !classDef[1].includes("::")
            ? `${line.namespace.join("::")}::${classDef[1]}`
            : classDef[1];
          controller = {
            id: `controller:${name}`,
            type: "controller",
            name,
            file: file.relPath,
            line: line.line,
            actions: [],
            beforeActions: [],
            rescueHandlers: [],
            concerns: [],
          };
          entities.push(controller);
          visibility = "public";
          continue;
        }
        if (!controller) continue;

        if (/^(private|protected)\s*$/.test(line.text) && insideController(controller, line)) {
          visibility = line.text.startsWith("private") ? "private" : "protected";
          continue;
        }

        const def = /^def\s+([a-z_][a-z0-9_?!]*)/.exec(line.text);
        if (def) {
          if (visibility === "public" && insideController(controller, line)) {
            controller.actions.push({ name: def[1], line: line.line });
          }
          continue;
        }

        if (!insideController(controller, line)) continue;

        const before = /^(?:before_action|append_before_action|prepend_before_action)\s+(.+)$/.exec(line.text);
        if (before) {
          const call = parseMacroArgs(before[1]);
          for (const handler of call.args) {
            controller.beforeActions.push({
              handler,
              only: call.opts.only ? parseSymbolList(call.opts.only) : undefined,
              except: call.opts.except ? parseSymbolList(call.opts.except) : undefined,
              line: line.line,
            });
          }
          continue;
        }

        const rescueFrom = /^rescue_from\s+(.+)$/.exec(line.text);
        if (rescueFrom) {
          const call = parseMacroArgs(rescueFrom[1]);
          for (const exception of call.args) {
            controller.rescueHandlers.push({
              exception,
              handler: call.opts.with ? call.opts.with.replace(/^:/, "") : undefined,
              line: line.line,
            });
          }
          continue;
        }

        const include = /^include\s+([A-Z][A-Za-z0-9_:]*)/.exec(line.text);
        if (include) {
          controller.concerns.push(include[1]);
          intents.push({
            fromId: controller.id,
            relationship: "includes_concern",
            toType: "concern",
            toName: include[1],
          });
        }
      }
    }

    return { entities, intents };
  }
}

function insideController(controller: ControllerEntity, line: { namespace: string[] }): boolean {
  const short = controller.name.split("::").pop();
  return line.namespace[line.namespace.length - 1] === short;
}
