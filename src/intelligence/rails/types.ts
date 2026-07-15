/**
 * Rails Semantic Index (RSI) — shared types.
 *
 * The RSI models a Rails application as a graph of typed entities connected
 * by typed relationships. Scanners emit entities plus name-based
 * "relationship intents"; the indexer resolves intents into concrete edges
 * after every scanner has run, so scanner ordering never matters.
 */

export type EntityType =
  | "model"
  | "controller"
  | "route"
  | "table"
  | "gem"
  | "service"
  | "job"
  | "mailer"
  | "policy"
  | "concern"
  | "spec"
  | "migration"
  | "view"
  | "component";

export type RelationshipType =
  | "belongs_to"
  | "has_many"
  | "has_one"
  | "has_and_belongs_to_many"
  | "routes_to"
  | "backed_by_table"
  | "includes_concern"
  | "tested_by"
  | "calls"
  | "enqueues"
  | "delivers"
  | "authorizes"
  | "defined_in_migration"
  | "depends_on_gem"
  | "renders_view"
  | "renders_partial"
  | "references_model"
  | "renders_component";

/** Base shape shared by every node in the knowledge graph. */
export interface RsiEntity {
  /** Stable id: `${type}:${qualifiedName}` (e.g. `model:User`). */
  id: string;
  type: EntityType;
  /** Qualified constant name (`Admin::UsersController`) or natural key (route pattern, table name). */
  name: string;
  /** Workspace-relative file path the entity was extracted from. */
  file: string;
  /** 1-based line where the entity is declared. */
  line: number;
}

export interface Association {
  kind: "belongs_to" | "has_many" | "has_one" | "has_and_belongs_to_many";
  name: string;
  /** Resolved target class name (respects `class_name:` when present). */
  className: string;
  through?: string;
  polymorphic?: boolean;
  dependent?: string;
  line: number;
}

export interface Validation {
  attributes: string[];
  rules: string[];
  line: number;
}

export interface Callback {
  kind: string;
  handler: string;
  line: number;
}

export interface Scope {
  name: string;
  line: number;
}

export interface ModelEntity extends RsiEntity {
  type: "model";
  superclass?: string;
  table?: string;
  associations: Association[];
  validations: Validation[];
  callbacks: Callback[];
  scopes: Scope[];
  concerns: string[];
}

export interface ControllerAction {
  name: string;
  line: number;
}

export interface BeforeAction {
  handler: string;
  only?: string[];
  except?: string[];
  line: number;
}

export interface RescueHandler {
  exception: string;
  handler?: string;
  line: number;
}

export interface ControllerEntity extends RsiEntity {
  type: "controller";
  actions: ControllerAction[];
  beforeActions: BeforeAction[];
  rescueHandlers: RescueHandler[];
  concerns: string[];
}

export interface RouteEntity extends RsiEntity {
  type: "route";
  verb: string;
  path: string;
  /** Controller in route notation (`admin/users`), no `Controller` suffix. */
  controller: string;
  action: string;
  routeName?: string;
}

export interface Column {
  name: string;
  columnType: string;
  nullable: boolean;
  default?: string;
}

export interface TableIndex {
  columns: string[];
  unique: boolean;
}

export interface TableEntity extends RsiEntity {
  type: "table";
  columns: Column[];
  indexes: TableIndex[];
}

export interface GemEntity extends RsiEntity {
  type: "gem";
  version: string;
  dependencies: string[];
  source: "gem" | "path" | "git";
}

export interface ServiceEntity extends RsiEntity {
  type: "service";
  publicMethods: string[];
  hasCallInterface: boolean;
}

export interface JobEntity extends RsiEntity {
  type: "job";
  queue?: string;
  performArgs: string[];
}

export interface MailerEntity extends RsiEntity {
  type: "mailer";
  actions: string[];
  defaultFrom?: string;
}

export interface PolicyEntity extends RsiEntity {
  type: "policy";
  permissions: string[];
}

export interface ConcernEntity extends RsiEntity {
  type: "concern";
  macros: string[];
}

export type SpecType = "model" | "controller" | "request" | "service" | "job" | "mailer" | "policy" | "feature" | "system" | "other";

export interface SpecEntity extends RsiEntity {
  type: "spec";
  subjectName?: string;
  specType: SpecType;
  exampleCount: number;
}

export interface MigrationEntity extends RsiEntity {
  type: "migration";
  timestamp: string;
  operations: string[];
}

export type ViewFormat = "erb" | "haml" | "slim" | "builder" | "view_component" | "phlex";

export interface ViewEntity extends RsiEntity {
  type: "view" | "component";
  viewFormat: ViewFormat;
  /** Response format (html, json, xml, text, js, css). */
  format: string;
  /** Inferred controller name (CamelCase, e.g. `Users`), undefined for layouts/partials. */
  controller?: string;
  /** Inferred action name, undefined for partials. */
  action?: string;
  /** Partial template names referenced via `render`. */
  referencedPartials: string[];
  /** Component class names referenced via `render XxxComponent.new(...)`. */
  referencedComponents: string[];
  /** Model names referenced via `@user`, `User.all`, etc. */
  referencedModels: string[];
  /** Helper method names called in the template. */
  referencedHelpers: string[];
  /** For component files: the component class name. */
  componentClass?: string;
  /** For component files: conventional template path. */
  template?: string;
}

/**
 * A relationship expressed by name before the target entity is known to
 * exist. Resolved to an Edge by the indexer once all scanners have run.
 */
export interface RelationshipIntent {
  fromId: string;
  relationship: RelationshipType;
  /** Target entity type to resolve `toName` against. */
  toType: EntityType;
  /** Target entity name (resolved case/underscore-insensitively). */
  toName: string;
  meta?: Record<string, unknown>;
}

export interface Edge {
  from: string;
  to: string;
  type: RelationshipType;
  meta?: Record<string, unknown>;
}

export interface SourceFile {
  /** Workspace-relative path. */
  relPath: string;
  content: string;
}

export interface ScannerResult {
  entities: RsiEntity[];
  intents: RelationshipIntent[];
}

export interface Scanner {
  name: string;
  /** Whether a changed file belongs to this scanner (incremental updates). */
  appliesTo(relPath: string): boolean;
  scan(files: SourceFile[]): ScannerResult;
  /**
   * Optional executor that shells out to a Rails command (e.g.
   * `bin/rails routes`) for higher-fidelity results. Only called when
   * `RsiOptions.execRoutes` is true. Return null to indicate no-op.
   */
  exec?(root: string): Promise<ScannerResult | null>;
}

export interface EngineInfo {
  name: string;
  path: string;
}

export interface WorkspaceInfo {
  root: string;
  isRails: boolean;
  isRuby: boolean;
  railsVersion?: string;
  rubyVersion?: string;
  bundlerVersion?: string;
  usesZeitwerk: boolean;
  apiOnly: boolean;
  testFramework: "rspec" | "minitest" | "unknown";
  engines: EngineInfo[];
}

export interface ManifestFile {
  relPath: string;
  mtimeMs: number;
  size: number;
}

export interface WorkspaceManifest {
  root: string;
  workspace: WorkspaceInfo;
  /** Every indexable file, keyed by category. */
  categories: Record<ManifestCategory, ManifestFile[]>;
  /** Flat list of every file in the manifest (all categories). */
  files: ManifestFile[];
}

export type ManifestCategory =
  | "models"
  | "controllers"
  | "services"
  | "jobs"
  | "mailers"
  | "policies"
  | "concerns"
  | "specs"
  | "migrations"
  | "routes"
  | "schema"
  | "gemfileLock"
  | "views"
  | "components";

export interface ScannerError {
  scanner: string;
  error: string;
}

export interface IndexStatus {
  enabled: boolean;
  reason?: string;
  state: "idle" | "building" | "ready" | "error";
  entityCount: number;
  edgeCount: number;
  danglingIntents: number;
  scannerErrors: ScannerError[];
  lastBuiltAt?: number;
  lastBuildMs?: number;
  loadedFromCache: boolean;
  railsVersion?: string;
  rubyVersion?: string;
  testFramework?: string;
  byType?: Record<string, number>;
}

export interface RsiOptions {
  /** Attempt `bin/rails routes` for higher-fidelity routes (off by default). */
  execRoutes?: boolean;
  /** Path to the sqlite cache file; omit to disable persistence. */
  cachePath?: string;
}
