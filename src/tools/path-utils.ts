import { existsSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { ToolError } from "./tool.js";

export class PathEscapeError extends ToolError {}

export function resolveWorkspacePath(root: string, relativePath: string): string {
  const absoluteRoot = realpathSync(resolve(root));
  const full = resolve(join(absoluteRoot, relativePath));

  let probe = full;
  while (!existsSync(probe)) {
    const parent = dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }

  const real = resolve(realpathSync(probe), relative(probe, full));
  const rel = relative(absoluteRoot, real);
  if (rel === ".." || rel.startsWith(`..${sep}`)) {
    throw new PathEscapeError(`${relativePath} escapes workspace root`);
  }
  return full;
}
