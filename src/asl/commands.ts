import * as fs from "node:fs";
import * as path from "node:path";
import {
  parseAslFile,
  validateTaskSpec,
  validateWorkspaceSpec,
  validateRoleSpec,
  validateSkillSpec,
  validatePolicySpec,
  validateResultContract,
  validateReviewContract,
} from "./parser.js";
import { AslTaskSpec } from "./types.js";

export function getAslFiles(dir: string): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;

  const list = fs.readdirSync(dir);
  for (const file of list) {
    const fullPath = path.join(dir, file);
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      results.push(...getAslFiles(fullPath));
    } else if (file.endsWith(".md")) {
      results.push(fullPath);
    }
  }
  return results;
}

export async function validateAsl(workspaceRoot: string): Promise<boolean> {
  const devagentDir = path.join(workspaceRoot, ".devagent");
  if (!fs.existsSync(devagentDir)) {
    console.error(`Error: .devagent directory does not exist at ${workspaceRoot}`);
    return false;
  }

  const files = getAslFiles(devagentDir);
  let hasErrors = false;
  const allTasks: AslTaskSpec[] = [];

  for (const file of files) {
    const relativePath = path.relative(workspaceRoot, file);
    try {
      const parsed = parseAslFile(file);
      let errors: string[] = [];

      if (relativePath.includes("tasks/")) {
        errors = validateTaskSpec(parsed.frontmatter, relativePath);
        if (errors.length === 0) {
          allTasks.push(parsed.frontmatter as AslTaskSpec);
        }
      } else if (relativePath.includes("workspace/")) {
        errors = validateWorkspaceSpec(parsed.frontmatter, relativePath);
      } else if (relativePath.includes("roles/")) {
        errors = validateRoleSpec(parsed.frontmatter, relativePath);
      } else if (relativePath.includes("skills/")) {
        errors = validateSkillSpec(parsed.frontmatter, relativePath);
      } else if (relativePath.includes("policies/")) {
        errors = validatePolicySpec(parsed.frontmatter, relativePath);
      } else if (relativePath.includes("results/")) {
        errors = validateResultContract(parsed.frontmatter, relativePath);
      } else if (relativePath.includes("reviews/")) {
        errors = validateReviewContract(parsed.frontmatter, relativePath);
      }

      if (errors.length > 0) {
        hasErrors = true;
        for (const err of errors) {
          console.error(`\x1b[31m[VALIDATION ERROR]\x1b[0m ${err}`);
        }
      } else {
        console.log(`\x1b[32m[OK]\x1b[0m ${relativePath}`);
      }
    } catch (e: any) {
      hasErrors = true;
      console.error(`\x1b[31m[PARSING ERROR]\x1b[0m ${relativePath}: ${e.message}`);
    }
  }

  // Validate task dependency existence
  const taskIds = new Set(allTasks.map((t) => t.id));
  for (const task of allTasks) {
    if (task.depends_on) {
      for (const dep of task.depends_on) {
        if (!taskIds.has(dep)) {
          hasErrors = true;
          console.error(
            `\x1b[31m[DEPENDENCY ERROR]\x1b[0m Task '${task.id}' depends on unknown task '${dep}'`
          );
        }
      }
    }
  }

  // Check for dependency cycles
  if (detectCycle(allTasks)) {
    hasErrors = true;
    console.error(`\x1b[31m[CYCLE ERROR]\x1b[0m Dependency cycle detected in task graph!`);
  }

  return !hasErrors;
}

export async function generateAslGraph(workspaceRoot: string): Promise<void> {
  const devagentDir = path.join(workspaceRoot, ".devagent");
  const files = getAslFiles(devagentDir).filter((f) => f.includes("/tasks/"));
  const tasks: AslTaskSpec[] = [];

  for (const file of files) {
    try {
      const parsed = parseAslFile<AslTaskSpec>(file);
      if (validateTaskSpec(parsed.frontmatter, file).length === 0) {
        tasks.push(parsed.frontmatter);
      }
    } catch {
      // Skip unparseable files
    }
  }

  if (tasks.length === 0) {
    console.log("No valid tasks found under .devagent/tasks/");
    return;
  }

  // Build adjacency list and inDegree
  const adjacencyList = new Map<string, string[]>();
  const inDegree = new Map<string, number>();
  const tasksById = new Map<string, AslTaskSpec>();

  for (const t of tasks) {
    tasksById.set(t.id, t);
    inDegree.set(t.id, 0);
    adjacencyList.set(t.id, []);
  }

  for (const t of tasks) {
    const deps = t.depends_on || [];
    for (const dep of deps) {
      if (tasksById.has(dep)) {
        // dep is a dependency, so when dep completes, t can run.
        // Thus dep -> t is the edge in execution order.
        const list = adjacencyList.get(dep) || [];
        list.push(t.id);
        adjacencyList.set(dep, list);
        inDegree.set(t.id, (inDegree.get(t.id) || 0) + 1);
      }
    }
  }

  if (detectCycle(tasks)) {
    console.error("\x1b[31mError: Cannot render graph due to a dependency cycle.\x1b[0m");
    return;
  }

  console.log("\n\x1b[1;36mASL Task Execution DAG\x1b[0m");
  console.log("=======================\n");

  const roots = tasks.filter((t) => (inDegree.get(t.id) || 0) === 0);
  const visited = new Set<string>();

  function getStatusColor(status: string): string {
    switch (status.toLowerCase()) {
      case "completed":
        return "\x1b[32mcompleted\x1b[0m";
      case "implementing":
      case "testing":
      case "reviewing":
      case "running":
        return "\x1b[33m" + status + "\x1b[0m";
      case "failed":
        return "\x1b[31mfailed\x1b[0m";
      case "blocked":
        return "\x1b[35mblocked\x1b[0m";
      default:
        return "\x1b[90m" + status + "\x1b[0m";
    }
  }

  function printNode(taskId: string, indent: string, isLast: boolean) {
    const spec = tasksById.get(taskId);
    if (!spec) return;

    const prefix = indent + (isLast ? "└── " : "├── ");
    console.log(`${prefix}${taskId} [${getStatusColor(spec.status)}]`);

    const children = adjacencyList.get(taskId) || [];
    if (visited.has(taskId)) {
      if (children.length > 0) {
        console.log(`${indent}${isLast ? "    " : "│   "}└── (already listed above)`);
      }
      return;
    }
    visited.add(taskId);

    const nextIndent = indent + (isLast ? "    " : "│   ");
    for (let i = 0; i < children.length; i++) {
      printNode(children[i], nextIndent, i === children.length - 1);
    }
  }

  for (let i = 0; i < roots.length; i++) {
    printNode(roots[i].id, "", i === roots.length - 1);
  }
  console.log("");
}

function detectCycle(tasks: AslTaskSpec[]): boolean {
  const adj = new Map<string, string[]>();
  for (const t of tasks) {
    adj.set(t.id, t.depends_on || []);
  }

  const visited = new Map<string, number>(); // 0 = unvisited, 1 = visiting, 2 = visited

  function hasCycle(id: string): boolean {
    visited.set(id, 1);
    const neighbors = adj.get(id) || [];
    for (const n of neighbors) {
      const state = visited.get(n) || 0;
      if (state === 1) return true;
      if (state === 0 && hasCycle(n)) return true;
    }
    visited.set(id, 2);
    return false;
  }

  for (const t of tasks) {
    if ((visited.get(t.id) || 0) === 0) {
      if (hasCycle(t.id)) return true;
    }
  }
  return false;
}
