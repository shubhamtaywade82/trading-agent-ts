export type AslTaskKind =
  | "implementation"
  | "bugfix"
  | "refactor"
  | "review"
  | "testing"
  | "documentation"
  | "migration"
  | "research"
  | "architecture"
  | "performance"
  | "security"
  | "release"
  | "deployment"
  | "prototype"
  | "spike";

export type AslTaskStatus =
  | "pending"
  | "analyzing"
  | "planning"
  | "implementing"
  | "testing"
  | "reviewing"
  | "completed"
  | "blocked"
  | "paused"
  | "cancelled"
  | "rejected"
  | "failed"
  | "rolledback";

export interface AslTaskSpec {
  id: string;
  title: string;
  kind: AslTaskKind;
  status: AslTaskStatus;
  priority?: "low" | "medium" | "high" | "critical";
  owner?: string;
  goal: string;
  why?: string;
  labels?: string[];
  depends_on?: string[];
  blocks?: string[];
  inputs?: string[];
  outputs?: string[];
  allowed_paths?: string[];
  forbidden_paths?: string[];
  files_to_read?: string[];
  files_to_modify?: string[];
  files_to_create?: string[];
  implementation_notes?: string;
  constraints?: string[];
  risks?: string[];
  acceptance_tests?: string[];
  completion_criteria?: string[];
  review_checklist?: string[];
  rollback_plan?: string;
  targets?: Array<{ entity: string }>;
  skills?: string[];
}

export interface WorkspaceSpec {
  language: string;
  frameworks?: string[];
  package_manager?: string;
  build_system?: string;
  test_framework?: string;
  formatter?: string;
  linter?: string;
  ci?: string;
  deployment?: string;
  architecture?: string;
  repository_type?: string;
}

export interface RoleSpec {
  name: string;
  description: string;
  responsibilities?: string[];
}

export interface SkillSpec {
  name: string;
  category?: string;
  proficiency?: string;
}

export interface PolicySpec {
  name: string;
  description: string;
  enforced: boolean;
}

export interface ResultContract {
  status: AslTaskStatus;
  started_at?: string;
  finished_at?: string;
  duration?: number;
  files_created?: string[];
  files_modified?: string[];
  files_deleted?: string[];
  tests_added?: number;
  tests_updated?: number;
  coverage?: string;
  benchmarks?: string[];
  breaking_changes?: string[];
  migrations?: string[];
  follow_up_tasks?: string[];
  assumptions?: string[];
  risks?: string[];
  warnings?: string[];
  review_required?: boolean;
  summary: string;
}

export interface ReviewContract {
  reviewer: string;
  outcome: "approved" | "changes_requested" | "commented";
  issues?: string[];
  severity?: "low" | "medium" | "high";
  suggestions?: string[];
  approved: boolean;
  follow_up?: string[];
}

export interface AslDocument<T = any> {
  filePath: string;
  frontmatter: T;
  content: string;
}
