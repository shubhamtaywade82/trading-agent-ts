import { cp, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractCandidates } from "../../../src/intelligence/rails/context-builder.js";
import { SemanticIndex } from "../../../src/intelligence/rails/indexer.js";

import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
const __dirname = dirname(fileURLToPath(import.meta.url));

const FIXTURE = join(__dirname, "..", "..", "fixtures", "rails-app");

describe("extractCandidates", () => {
  it("extracts CamelCase constants, snake_case words, and route paths", () => {
    const { names, paths } = extractCandidates('Fix the bug in UsersController where POST /users breaks user_params for Admin::Report');
    expect(names).toEqual(expect.arrayContaining(["UsersController", "Admin::Report", "user_params"]));
    expect(paths).toContain("/users");
  });

  it("extracts quoted names", () => {
    const { names } = extractCandidates('rename "User" model');
    expect(names).toContain("User");
  });
});

describe("RailsContextBuilder", () => {
  let index: SemanticIndex;

  beforeAll(async () => {
    const dir = await mkdtemp(join(tmpdir(), "rsi-ctx-"));
    await cp(FIXTURE, dir, { recursive: true });
    index = SemanticIndex.create(dir);
    await index.build();
  });

  it("builds compact context for a model-centric request", () => {
    const context = index.contextBuilder.buildContext("Fix email normalization on the User model");

    expect(context.text).toContain("Model User");
    expect(context.text).toContain("email:string");
    expect(context.text).toContain("has_many :orders");
    expect(context.text).toContain("before_save :normalize_email");
    expect(context.entities).toContain("model:User");
  });

  it("resolves route paths to controllers", () => {
    const context = index.contextBuilder.buildContext("Why does GET `/users` return 500?");

    expect(context.text).toContain("Route GET /users");
    expect(context.text).toContain("UsersController");
  });

  it("stays within the token budget", () => {
    const context = index.contextBuilder.buildContext("Audit User Order UsersController Admin::ReportsController", 200);
    expect(context.tokenEstimate).toBeLessThanOrEqual(200);
  });

  it("includes workspace header", () => {
    const context = index.contextBuilder.buildContext("anything");
    expect(context.text).toContain("Rails 7.1.3");
    expect(context.text).toContain("rspec tests");
  });
});
