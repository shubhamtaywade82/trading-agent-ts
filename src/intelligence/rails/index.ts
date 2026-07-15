/** Rails Semantic Index — public API. */

export * from "./types.js";
export { discoverWorkspace } from "./workspace-discovery.js";
export { buildManifest, manifestHash } from "./manifest.js";
export { KnowledgeGraph } from "./graph/graph.js";
export type { TraverseOptions, TraversalNode, GraphStats } from "./graph/graph.js";
export { SemanticIndex } from "./indexer.js";
export { GraphStore } from "./graph/graph-store.js";
export { QueryEngine } from "./query-engine.js";
export type { DependencyTrace } from "./query-engine.js";
export { RailsContextBuilder, extractCandidates } from "./context-builder.js";
export type { RailsContext } from "./context-builder.js";
export { createRailsTools } from "./tools/semantic-tools.js";
