import { readFileSync } from "node:fs";
import matter from "gray-matter";
import {
  AslTaskKind,
  AslTaskStatus,
  AslDocument,
} from "./types.js";

const VALID_TASK_KINDS: AslTaskKind[] = [
  "implementation",
  "bugfix",
  "refactor",
  "review",
  "testing",
  "documentation",
  "migration",
  "research",
  "architecture",
  "performance",
  "security",
  "release",
  "deployment",
  "prototype",
  "spike",
];

const VALID_TASK_STATUSES: AslTaskStatus[] = [
  "pending",
  "analyzing",
  "planning",
  "implementing",
  "testing",
  "reviewing",
  "completed",
  "blocked",
  "paused",
  "cancelled",
  "rejected",
  "failed",
  "rolledback",
];

export function parseAslFile<T = any>(filePath: string): AslDocument<T> {
  const fileContent = readFileSync(filePath, "utf8");
  const parsed = matter(fileContent);
  return {
    filePath,
    frontmatter: parsed.data as T,
    content: parsed.content,
  };
}

export function validateTaskSpec(spec: any, filePath: string): string[] {
  const errors: string[] = [];
  if (!spec) {
    errors.push(`${filePath}: Frontmatter is empty or missing`);
    return errors;
  }

  if (typeof spec.id !== "string" || !spec.id.trim()) {
    errors.push(`${filePath}: 'id' is required and must be a non-empty string`);
  }
  if (typeof spec.title !== "string" || !spec.title.trim()) {
    errors.push(`${filePath}: 'title' is required and must be a non-empty string`);
  }
  if (typeof spec.goal !== "string" || !spec.goal.trim()) {
    errors.push(`${filePath}: 'goal' is required and must be a non-empty string`);
  }

  if (typeof spec.kind !== "string" || !VALID_TASK_KINDS.includes(spec.kind.toLowerCase() as AslTaskKind)) {
    errors.push(
      `${filePath}: 'kind' must be one of: ${VALID_TASK_KINDS.join(", ")} (got: ${spec.kind})`
    );
  }

  if (typeof spec.status !== "string" || !VALID_TASK_STATUSES.includes(spec.status.toLowerCase() as AslTaskStatus)) {
    errors.push(
      `${filePath}: 'status' must be one of: ${VALID_TASK_STATUSES.join(", ")} (got: ${spec.status})`
    );
  }

  if (spec.priority && !["low", "medium", "high", "critical"].includes(spec.priority.toLowerCase())) {
    errors.push(`${filePath}: 'priority' must be one of: low, medium, high, critical (got: ${spec.priority})`);
  }

  // Validate array fields
  const arrayFields = [
    "labels",
    "depends_on",
    "blocks",
    "inputs",
    "outputs",
    "allowed_paths",
    "forbidden_paths",
    "files_to_read",
    "files_to_modify",
    "files_to_create",
    "acceptance_tests",
    "completion_criteria",
    "review_checklist",
    "skills",
  ];

  for (const field of arrayFields) {
    if (spec[field] !== undefined && !Array.isArray(spec[field])) {
      errors.push(`${filePath}: '${field}' must be an array of strings`);
    } else if (Array.isArray(spec[field])) {
      for (let i = 0; i < spec[field].length; i++) {
        if (typeof spec[field][i] !== "string") {
          errors.push(`${filePath}: '${field}[${i}]' must be a string`);
        }
      }
    }
  }

  if (spec.targets !== undefined && !Array.isArray(spec.targets)) {
    errors.push(`${filePath}: 'targets' must be an array of entity objects`);
  } else if (Array.isArray(spec.targets)) {
    for (let i = 0; i < spec.targets.length; i++) {
      const tgt = spec.targets[i];
      if (!tgt || typeof tgt.entity !== "string" || !tgt.entity.trim()) {
        errors.push(`${filePath}: 'targets[${i}].entity' must be a non-empty string`);
      }
    }
  }

  return errors;
}

export function validateWorkspaceSpec(spec: any, filePath: string): string[] {
  const errors: string[] = [];
  if (!spec) {
    errors.push(`${filePath}: Frontmatter is empty or missing`);
    return errors;
  }
  if (typeof spec.language !== "string" || !spec.language.trim()) {
    errors.push(`${filePath}: 'language' is required and must be a non-empty string`);
  }
  if (spec.frameworks !== undefined && !Array.isArray(spec.frameworks)) {
    errors.push(`${filePath}: 'frameworks' must be an array of strings`);
  }
  return errors;
}

export function validateRoleSpec(spec: any, filePath: string): string[] {
  const errors: string[] = [];
  if (!spec) {
    errors.push(`${filePath}: Frontmatter is empty or missing`);
    return errors;
  }
  if (typeof spec.name !== "string" || !spec.name.trim()) {
    errors.push(`${filePath}: 'name' is required and must be a non-empty string`);
  }
  if (typeof spec.description !== "string" || !spec.description.trim()) {
    errors.push(`${filePath}: 'description' is required and must be a non-empty string`);
  }
  if (spec.responsibilities !== undefined && !Array.isArray(spec.responsibilities)) {
    errors.push(`${filePath}: 'responsibilities' must be an array of strings`);
  }
  return errors;
}

export function validateSkillSpec(spec: any, filePath: string): string[] {
  const errors: string[] = [];
  if (!spec) {
    errors.push(`${filePath}: Frontmatter is empty or missing`);
    return errors;
  }
  if (typeof spec.name !== "string" || !spec.name.trim()) {
    errors.push(`${filePath}: 'name' is required and must be a non-empty string`);
  }
  return errors;
}

export function validatePolicySpec(spec: any, filePath: string): string[] {
  const errors: string[] = [];
  if (!spec) {
    errors.push(`${filePath}: Frontmatter is empty or missing`);
    return errors;
  }
  if (typeof spec.name !== "string" || !spec.name.trim()) {
    errors.push(`${filePath}: 'name' is required and must be a non-empty string`);
  }
  if (typeof spec.description !== "string" || !spec.description.trim()) {
    errors.push(`${filePath}: 'description' is required and must be a non-empty string`);
  }
  if (typeof spec.enforced !== "boolean") {
    errors.push(`${filePath}: 'enforced' is required and must be a boolean`);
  }
  return errors;
}

export function validateResultContract(spec: any, filePath: string): string[] {
  const errors: string[] = [];
  if (!spec) {
    errors.push(`${filePath}: Frontmatter is empty or missing`);
    return errors;
  }
  if (typeof spec.status !== "string" || !VALID_TASK_STATUSES.includes(spec.status.toLowerCase() as AslTaskStatus)) {
    errors.push(
      `${filePath}: 'status' must be one of: ${VALID_TASK_STATUSES.join(", ")} (got: ${spec.status})`
    );
  }
  if (typeof spec.summary !== "string" || !spec.summary.trim()) {
    errors.push(`${filePath}: 'summary' is required and must be a non-empty string`);
  }
  return errors;
}

export function validateReviewContract(spec: any, filePath: string): string[] {
  const errors: string[] = [];
  if (!spec) {
    errors.push(`${filePath}: Frontmatter is empty or missing`);
    return errors;
  }
  if (typeof spec.reviewer !== "string" || !spec.reviewer.trim()) {
    errors.push(`${filePath}: 'reviewer' is required and must be a non-empty string`);
  }
  if (typeof spec.approved !== "boolean") {
    errors.push(`${filePath}: 'approved' is required and must be a boolean`);
  }
  if (spec.outcome && !["approved", "changes_requested", "commented"].includes(spec.outcome)) {
    errors.push(`${filePath}: 'outcome' must be: approved, changes_requested, or commented`);
  }
  return errors;
}
