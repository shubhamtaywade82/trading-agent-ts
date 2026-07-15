import * as fs from "node:fs";
import * as path from "node:path";

import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
const __dirname = dirname(fileURLToPath(import.meta.url));
import {
  parseAslFile,
  validateTaskSpec,
  validateWorkspaceSpec,
  validateRoleSpec,
  validatePolicySpec,
} from "../../src/asl/parser.js";

describe("ASL Parser & Validators", () => {
  const tempDir = path.join(__dirname, "../fixtures/asl-temp");

  beforeAll(() => {
    fs.mkdirSync(tempDir, { recursive: true });
  });

  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("should parse a valid task specification file", () => {
    const filePath = path.join(tempDir, "task-valid.md");
    const mdContent = `---
id: task.auth.jwt
title: JWT Authentication
kind: implementation
status: pending
priority: high
goal: Implement JWT authentication
depends_on:
  - task.db.users
targets:
  - entity: UserService
---
# Overview
Some rich body content here.
`;
    fs.writeFileSync(filePath, mdContent, "utf8");

    const parsed = parseAslFile(filePath);
    expect(parsed.frontmatter.id).toBe("task.auth.jwt");
    expect(parsed.frontmatter.title).toBe("JWT Authentication");
    expect(parsed.frontmatter.kind).toBe("implementation");
    expect(parsed.frontmatter.status).toBe("pending");
    expect(parsed.frontmatter.priority).toBe("high");
    expect(parsed.content.trim()).toBe("# Overview\nSome rich body content here.");

    const errors = validateTaskSpec(parsed.frontmatter, filePath);
    expect(errors).toHaveLength(0);
  });

  it("should validate and report invalid fields in a task specification", () => {
    const invalidSpec = {
      id: "",
      title: 123, // invalid type
      kind: "invalid-kind",
      status: "invalid-status",
      priority: "super-high",
      goal: "",
      depends_on: "not-an-array",
      targets: [
        { entity: "" }, // invalid empty entity name
      ],
    };

    const errors = validateTaskSpec(invalidSpec, "dummy-path.md");
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.includes("'id' is required"))).toBe(true);
    expect(errors.some((e) => e.includes("'title' is required"))).toBe(true);
    expect(errors.some((e) => e.includes("'kind' must be one of"))).toBe(true);
    expect(errors.some((e) => e.includes("'status' must be one of"))).toBe(true);
    expect(errors.some((e) => e.includes("'priority' must be one of"))).toBe(true);
    expect(errors.some((e) => e.includes("'depends_on' must be an array"))).toBe(true);
    expect(errors.some((e) => e.includes("'targets[0].entity' must be a non-empty string"))).toBe(true);
  });

  it("should validate and report invalid fields in workspace specification", () => {
    const invalidSpec = {
      language: "",
      frameworks: "react",
    };
    const errors = validateWorkspaceSpec(invalidSpec, "workspace.md");
    expect(errors).toHaveLength(2);
  });

  it("should validate and report invalid fields in role specification", () => {
    const invalidSpec = {
      name: "",
      description: 123,
    };
    const errors = validateRoleSpec(invalidSpec, "role.md");
    expect(errors).toHaveLength(2);
  });

  it("should validate and report invalid fields in policy specification", () => {
    const invalidSpec = {
      name: "Security",
      description: "Must run safety scan",
      enforced: "yes", // should be boolean
    };
    const errors = validatePolicySpec(invalidSpec, "policy.md");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("'enforced' is required and must be a boolean");
  });
});
