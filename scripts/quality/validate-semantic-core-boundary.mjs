#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import ts from "typescript";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

// SCHEMA_VERSION 24 (Gate C2 Run Kind Policy) reviewed: the new
// narrative_semantic_index_metadata table's columns match
// semantic-core-authorities.json's existing "search-generation" concern
// and semanticIndexAllowedFields verbatim; narrative_maintenance_repair_leases
// is operational lock state (like task_leases/workspace_lease), not semantic
// content, so it stays outside this authority matrix by the same convention.
// Neither warranted a concern-matrix change.
// SCHEMA_VERSION 25 (Attention OCC / request identity / actor) reviewed:
// narrative_maintenance_attention's new version / request_id /
// payload_digest / actor_id / reason columns are concurrency control and
// provenance, not semantic content. Attention remains durable user state
// with backflowPolicy forbid and stays registered under EXCLUSION_REASONS
// as non-backflow-invariant, so it is still not a Freshness or semantic
// authority and the concern matrix is unchanged. The dropped nullable
// set_by is superseded by the NOT NULL actor_id, which narrows rather than
// widens what may be written.
// SCHEMA 28 rewrites narrative_application_contributions.target_object_identity
// into the ratified Object Addressing vocabulary. It is a data-only migration:
// no table, column, or authority changes, so the concern matrix below is
// unchanged.
export const EXPECTED_SCHEMA_VERSION = 31;

// The manifest may add narrower roots as the architecture evolves, but it
// may not remove the roots that currently contain semantic interpreters,
// maintenance callers, or the typed Native boundary. Keeping this minimum
// set in code prevents a data-only manifest edit from silently shrinking the
// boundary that CI audits.
export const REQUIRED_SEMANTIC_BOUNDARY_SCAN_ROOTS = Object.freeze([
  "src/features/narrative-semantic-core",
  "src/features/narrative-extraction",
  "src/features/semantic-search",
  "src/application/narrative-extraction",
  "src-tauri/crates/grimodex-db/src/narrative_extraction",
  "src-tauri/crates/grimodex-semantic/src",
  "electron/main",
  "electron/preload",
]);

export const AUTHORITY_ROUTE_IDS = Object.freeze([
  "human-direct",
  "interactive-agent-command",
  "interpreter-projection",
  "import-apply",
  "history-replay",
  "restore-or-migration",
  "attention-typed-writer",
]);

const REQUIRED_ROUTE_CONTROLS = Object.freeze({
  "human-direct": [
    "runtime-policy",
    "actor-context",
    "typed-writer",
    "occ",
    "change-event",
    "change-feed",
  ],
  "interactive-agent-command": [
    "knowledge-write-policy",
    "stable-request-id",
    "agent-provenance",
    "field-authority",
    "typed-writer",
    "occ",
    "undo-journal",
    "change-event",
    "change-feed",
  ],
  "interpreter-projection": [
    "proposal-revision",
    "decision",
    "prepared-commit",
    "application-id",
    "source-basis-occ",
    "field-authority",
    "typed-writer",
  ],
  "import-apply": [
    "import-policy",
    "source-package-evidence",
    "typed-writer",
    "occ",
    "change-event",
    "change-feed",
  ],
  "history-replay": [
    "original-transaction",
    "journal-lineage",
    "typed-writer",
    "occ",
    "change-event",
    "change-feed",
  ],
  "restore-or-migration": [
    "exclusive-system-operation",
    "semantic-epoch-event",
    "full-rebuild-marker",
  ],
  // Staying out of the Change Feed says nothing about whether two windows
  // may silently overwrite each other's decision. SCHEMA 25 gave this route
  // real concurrency control, and these entries stop it being narrowed back
  // to a bare typed-writer without the gate noticing.
  "attention-typed-writer": [
    "typed-writer",
    "occ",
    "stable-request-id",
    "actor-context",
  ],
});

const REQUIRED_STATE_FIELDS = Object.freeze([
  "reviewStates",
  "evidenceFreshness",
  "reconciliationSignals",
  "buildActions",
  "componentCompatibility",
  "projectionApplicationStates",
]);

// Gate C2 Lane L: Application field-contribution bookkeeping
// (`ContributionTargetState` in
// `src-tauri/crates/grimodex-db/src/narrative_extraction/application_contributions.rs`)
// and the not-yet-implemented Maintenance ownership axis. These are
// deliberately NOT folded into REQUIRED_STATE_FIELDS above: that constant
// drives the review/build/reconciliation overlap map in
// `validateStateVocabulary`, and mixing Lane L's axes into it would let a
// rename on either side silently change what the original six-axis overlap
// check tolerates. Lane L gets its own required-values check and its own
// overlap check, see `validateContributionAxes`.
const REQUIRED_CONTRIBUTION_TARGET_STATES = Object.freeze([
  "unchanged",
  "modified",
  "missing",
  "superseded",
  "undone",
  "not-applicable",
]);

const REQUIRED_MAINTENANCE_OWNERSHIP_STATES = Object.freeze([
  "maintained",
  "user-owned",
  "detached",
]);

const REQUIRED_DISCLOSURE_RULES = Object.freeze([
  "disclosure-context-unresolved",
  "invalid-candidate",
  "future-phase",
  "future-story-time",
  "secret-before-reveal",
  "knowledge-holder-mismatch",
  "reader-knowledge-not-character",
  "audience-mismatch",
  "scene-scope-mismatch",
  "worldline-mismatch",
  "timeline-mismatch",
  "narrative-layer-mismatch",
  "unresolved-scope",
]);

const REQUIRED_DISCLOSURE_FIXTURES = Object.freeze([
  "missing-disclosure-context-rejected",
  "malformed-candidate-rejected",
  "reading-future-phase-rejected",
  "story-future-time-rejected",
  "auto-matches-adr-002",
  "auto-incomplete-reading",
  "auto-complete-story",
  "secret-before-reveal-rejected",
  "knowledge-holder-mismatch-rejected",
  "reader-knowledge-is-not-character-knowledge",
  "audience-mismatch-rejected",
  "unresolved-scope-rejected",
  "worldline-mismatch-rejected",
]);

const REQUIRED_SCOPE_AXIS_IDS = Object.freeze([
  "timeline",
  "worldline",
  "scene",
  "viewpoint",
  "knowledgeHolder",
  "audience",
  "narrativeLayer",
  "storyTime",
  "readingOrder",
]);

const REQUIRED_SCOPE_RELATION_FIXTURES = Object.freeze([
  "any-vs-any-is-equal",
  "any-vs-exact-is-contains",
  "any-vs-unresolved-is-contains",
  "unresolved-vs-any-is-contained-by",
  "same-unresolved-reason-is-not-identity",
  "same-unresolved-constraint-id-is-equal",
]);

const REQUIRED_DEPENDENCY_ROLE_IDS = Object.freeze([
  "direct-evidence",
  "opaque-model-context",
  "entity-resolution",
  "temporal-resolution",
  "scope-resolution",
  "projection-match",
  "author-correction",
  "component-contract",
  "quality-context",
  "ranking-only",
]);

const REQUIRED_DEPENDENCY_CONTRACT_FIXTURES = Object.freeze([
  "catalog-content-change-is-stale-not-unknown",
  "quality-context-remains-fresh-with-advisory-action",
  "ranking-input-recompiles-semantic-index",
  "incomplete-v2-does-not-hide-v1",
  "utf16-range-rejects-surrogate-interior",
]);

const REQUIRED_DEPENDENCY_ROLE_FIXTURE_CASES = Object.freeze([
  "direct-evidence-content-changed",
  "catalog-content-change-is-stale-not-unknown",
  "quality-context-remains-fresh-with-advisory-action",
  "ranking-input-recompiles-semantic-index",
  "unknown-role-fails-closed",
  "unknown-effect-combination-fails-closed",
  "unknown-selector-fails-closed",
  "utf16-range-rejects-surrogate-interior",
  "whole-source-dependency-key-golden",
  "mixed-actions-stay-independent",
  "utf16-range-rejects-whitespace-normalizer",
]);

const REQUIRED_ARTIFACT_IDS = Object.freeze([
  "source-snapshot",
  "stage-execution",
  "raw-model-response",
  "response-digest",
  "extraction-artifact",
  "narrative-ir-revision",
  "review-decision",
  "consumer-freshness",
  "projection-application",
  "application-contribution",
  "semantic-index",
  "renderer-state",
]);

const REQUIRED_ARTIFACT_AUTHORITY_KINDS = Object.freeze([
  "source-identity",
  "immutable-interpretation",
  "review",
  "evidence-freshness",
  "projection-execution",
  "application-contribution",
  "rebuildable-acceleration",
  "none",
]);

// G1 is a ratified authority matrix, not a free-form vocabulary. Keep the
// complete row classification in validator-owned code so a policy edit cannot
// silently turn a durable interpretation into a non-authoritative cache (or
// move any other required artifact to a different authority).
const REQUIRED_ARTIFACT_AUTHORITY_ROWS = Object.freeze([
  Object.freeze({
    id: "source-snapshot",
    lifecycle: "durable",
    authority: "source-identity",
    authoritative: true,
    storage: "source-revision-and-canonical-text",
    retentionDefault: "retained",
    retentionScope: "project-scoped",
  }),
  Object.freeze({
    id: "stage-execution",
    lifecycle: "durable",
    authority: "none",
    authoritative: false,
    storage: "narrative-extraction-run-task-stage-identity",
    retentionDefault: "retained",
    retentionScope: "project-scoped",
  }),
  Object.freeze({
    id: "raw-model-response",
    lifecycle: "ephemeral",
    authority: "none",
    authoritative: false,
    storage: "provider-response-buffer",
    retentionDefault: "not-retained",
    retentionScope: "request-scoped",
  }),
  Object.freeze({
    id: "response-digest",
    lifecycle: "durable",
    authority: "none",
    authoritative: false,
    storage: "stage-execution-response-digest",
    retentionDefault: "retained",
    retentionScope: "project-scoped",
  }),
  Object.freeze({
    id: "extraction-artifact",
    lifecycle: "durable",
    authority: "none",
    authoritative: false,
    storage: "narrative_extraction_artifacts",
    retentionDefault: "retained",
    retentionScope: "project-scoped",
  }),
  Object.freeze({
    id: "narrative-ir-revision",
    lifecycle: "durable",
    authority: "immutable-interpretation",
    authoritative: true,
    storage: "narrative_proposal_revisions",
    retentionDefault: "retained",
    retentionScope: "while-project-exists",
  }),
  Object.freeze({
    id: "review-decision",
    lifecycle: "durable",
    authority: "review",
    authoritative: true,
    storage: "decision-ledger",
    retentionDefault: "retained",
    retentionScope: "project-scoped",
  }),
  Object.freeze({
    id: "consumer-freshness",
    lifecycle: "durable",
    authority: "evidence-freshness",
    authoritative: true,
    storage: "narrative_consumer_freshness",
    retentionDefault: "retained",
    retentionScope: "project-scoped",
  }),
  Object.freeze({
    id: "projection-application",
    lifecycle: "durable",
    authority: "projection-execution",
    authoritative: true,
    storage: "application-and-commit-ledger",
    retentionDefault: "retained",
    retentionScope: "project-scoped",
  }),
  Object.freeze({
    id: "application-contribution",
    lifecycle: "durable",
    authority: "application-contribution",
    authoritative: true,
    storage: "narrative_application_contributions",
    retentionDefault: "retained",
    retentionScope: "project-scoped",
  }),
  Object.freeze({
    id: "semantic-index",
    lifecycle: "rebuildable",
    authority: "rebuildable-acceleration",
    authoritative: false,
    storage: "semantic-index-and-metadata",
    retentionDefault: "reconstructable",
    retentionScope: "project-scoped",
  }),
  Object.freeze({
    id: "renderer-state",
    lifecycle: "ephemeral",
    authority: "none",
    authoritative: false,
    storage: "renderer-memory",
    retentionDefault: "not-retained",
    retentionScope: "window-scoped",
  }),
]);

const REQUIRED_INTERPRETER_DEPENDENCY_RULES = Object.freeze([
  "non-literal-dynamic-import",
  "sql-import",
  "db-mutation",
  "prepared-commit",
  "typed-writer",
  "agent-writer",
  "generic-mcp-sql",
]);

const REQUIRED_FRESHNESS_AUTHORITY_RULES = Object.freeze([
  "freshness-store",
  "freshness-authority",
  "stale-store",
]);

// These patterns are the ratified G2 deny semantics. They intentionally live
// in the validator rather than being derived from the policy being scanned:
// replacing a policy rule with a valid no-op regex must fail closed.
const REQUIRED_INTERPRETER_BOUNDARY_ROOTS = Object.freeze([
  "src/features/narrative-semantic-core",
  "src/features/narrative-extraction/ir",
  "src/features/narrative-extraction/proposals",
  "src/features/narrative-extraction/reconciler",
  "src/application/narrative-extraction/aiTasks",
]);

const REQUIRED_INTERPRETER_ALLOWLIST_FILES = Object.freeze([]);
const REQUIRED_INTERPRETER_ALLOWLIST_IMPORTS = Object.freeze([
  Object.freeze({
    id: "type-only-domain-vocabulary",
    pattern: "@/db/schema",
    mode: "type-only",
  }),
]);

const REQUIRED_INTERPRETER_DEPENDENCY_PATTERNS = Object.freeze({
  "non-literal-dynamic-import": Object.freeze([
    "\\b(?:import|require)\\s*\\(\\s*(?!(?:\\x22(?:\\\\.|[^\\x22\\\\])*\\x22|\\x27(?:\\\\.|[^\\x27\\\\])*\\x27|\\x60(?:\\\\.|(?!\\$\\{)[^\\x60\\\\])*\\x60)\\s*\\))[^)]*\\)",
  ]),
  "sql-import": Object.freeze([
    "\\b(?:from\\s+|(?:import|require)\\s*\\(\\s*)[\\\"'`]drizzle-orm(?:/[^\\\"'`]+)?[\\\"'`]",
    "\\b(?:from\\s+|(?:import|require)\\s*\\(\\s*)[\\\"'`][^\\\"'`]*(?:sqlite|database)/(?:client|connection|repository|sql)[^\\\"'`]*[\\\"'`]",
  ]),
  "db-mutation": Object.freeze([
    "\\b(?:db|database|conn|connection|tx|transaction)\\s*(?:\\.|\\?\\.)\\s*(?:execute|exec|run|prepare|query|insert|update|delete)\\s*(?:\\?\\.)?\\s*\\(",
    "\\b(?:executeSql|querySql|runSql|prepareSql)\\s*\\(",
    "\\b(?:from\\s+|(?:import|require)\\s*\\(\\s*)[\\\"'`][^\\\"'`]*(?:database|sqlite|db)/(?:client|connection|repository|mutation|writer|sql)[^\\\"'`]*[\\\"'`]",
    "\\[\\s*[\\x22\\x27\\x60](?:execute|exec|run|prepare|query|insert|update|delete)[\\x22\\x27\\x60]\\s*\\]\\s*(?:\\?\\.)?\\s*\\(",
  ]),
  "prepared-commit": Object.freeze([
    "\\b(?:PreparedCommit|preparedCommit|prepared_commit|prepareCommit|prepare_commit|runPreparedCommit)\\b",
    "\\b(?:from\\s+|(?:import|require)\\s*\\(\\s*)[\\\"'`][^\\\"'`]*prepared[-_]?commit[^\\\"'`]*[\\\"'`]",
  ]),
  "typed-writer": Object.freeze([
    "\\b(?:TypedWriter|typedWriter|typed_writer|runTypedWriter|writeWithTypedWriter)\\b",
    "\\b(?:from\\s+|(?:import|require)\\s*\\(\\s*)[\\\"'`][^\\\"'`]*typed[-_]?writer[^\\\"'`]*[\\\"'`]",
  ]),
  "agent-writer": Object.freeze([
    "\\b(?:AgentWriter|agentWriter|agent_writer|agent_writes|writeWithAgentWriter)\\b",
    "\\b(?:from\\s+|(?:import|require)\\s*\\(\\s*)[\\\"'`][^\\\"'`]*(?:agent[-_/]writes|codex[-_]writes)[^\\\"'`]*[\\\"'`]",
  ]),
  "generic-mcp-sql": Object.freeze([
    "\\b(?:mcpSql|mcp_sql|genericMcpSql|generic_mcp_sql)\\b",
    "\\b(?:mcp|Mcp)[A-Za-z0-9_]*(?:sql|query|execute)\\s*\\(",
    "\\b(?:mcp|Mcp)[A-Za-z0-9_]*::(?:sql|query|execute)\\b",
    "\\b(?:from\\s+|(?:import|require)\\s*\\(\\s*)[\\\"'`][^\\\"'`]*(?:mcp|model-context-protocol)[^\\\"'`]*(?:sql|query|execute)[^\\\"'`]*[\\\"'`]",
  ]),
});

const REQUIRED_INTERPRETER_FRESHNESS_PATTERNS = Object.freeze({
  "freshness-store":
    "\\b(?:[A-Za-z_$][A-Za-z0-9_$]*Freshness(?:Store|Cache|ReadModel|Flag|State|Map|Index)|freshness(?:Store|Cache|ReadModel|Flag|State|Map|Index))\\b",
  "freshness-authority":
    "\\b(?:[A-Za-z_$][A-Za-z0-9_$]*FreshnessAuthority|freshnessAuthority|isAuthoritativeFresh|assertionFresh|isFresh|hasFreshness|semanticTruth)\\b",
  "stale-store":
    "\\b(?:[A-Za-z_$][A-Za-z0-9_$]*Stale(?:Store|Cache|ReadModel|Flag|State|Map|Index)|stale(?:Store|Cache|ReadModel|Flag|State|Map|Index))\\b",
});

const REQUIRED_ARTIFACT_FIXTURES = Object.freeze([
  "raw-model-response-durable-rejected",
  "raw-model-response-retained-rejected",
  "semantic-index-authority-rejected",
  "interpreter-sql-import-rejected",
  "interpreter-typed-writer-rejected",
  "interpreter-freshness-store-rejected",
  "interpreter-type-only-vocabulary-allowed",
  "interpreter-malformed-source-rejected",
]);

// The fixture file is evidence, not the oracle. Keep the required case
// identity, target, claim/source semantics, rule, and disposition ratified in
// validator-owned data so a fixture cannot rewrite itself into a passing case.
const REQUIRED_ARTIFACT_FIXTURE_ORACLES = Object.freeze({
  "raw-model-response-durable-rejected": Object.freeze({
    kind: "artifact-lifecycle",
    target: "raw-model-response",
    claim: Object.freeze({ lifecycle: "durable" }),
    expected: "reject",
  }),
  "raw-model-response-retained-rejected": Object.freeze({
    kind: "artifact-retention",
    target: "raw-model-response",
    claim: Object.freeze({ retention: "retained" }),
    expected: "reject",
  }),
  "semantic-index-authority-rejected": Object.freeze({
    kind: "authority-classification",
    target: "semantic-index",
    claim: Object.freeze({ authoritative: true }),
    expected: "reject",
  }),
  "interpreter-sql-import-rejected": Object.freeze({
    kind: "interpreter-boundary",
    rule: "sql-import",
    source: 'import { sql } from "drizzle-orm";',
    expected: "reject",
  }),
  "interpreter-typed-writer-rejected": Object.freeze({
    kind: "interpreter-boundary",
    rule: "typed-writer",
    source: "typedWriter.commit({});",
    expected: "reject",
  }),
  "interpreter-freshness-store-rejected": Object.freeze({
    kind: "interpreter-boundary",
    rule: "freshness-store",
    source: "const localFreshnessStore = new Map();",
    expected: "reject",
  }),
  "interpreter-type-only-vocabulary-allowed": Object.freeze({
    kind: "interpreter-boundary",
    rule: "type-only-domain-vocabulary",
    source: 'import type { PlotPhaseType } from "@/db/schema";',
    expected: "accept",
  }),
  "interpreter-malformed-source-rejected": Object.freeze({
    kind: "interpreter-boundary",
    rule: "parse-diagnostics",
    source: "const broken = ;",
    expected: "reject",
  }),
});

const EXPECTED_ALLOWED_CALLERS = Object.freeze({
  "human-direct": ["human-ui", "manual-wrapper", "typed-domain-api"],
  "interactive-agent-command": [
    "chat-tool-executor",
    "manual-wrapper",
    "registered-agent-surface",
  ],
  "interpreter-projection": [
    "interpreter",
    "reconciler",
    "proposal-review",
    "prepared-commit-runner",
  ],
  "import-apply": ["import-session", "import-review"],
  "history-replay": ["history-controller", "undo-redo-command"],
  "restore-or-migration": [
    "restore-controller",
    "migration-runner",
    "integrity-repair",
  ],
  "attention-typed-writer": ["human-ui"],
});

const EXPECTED_CONDITIONAL_CONTROLS = Object.freeze({
  "human-direct": [
    { control: "field-authority", when: "writes-authority-protected-field" },
  ],
  "interactive-agent-command": [],
  "interpreter-projection": [],
  "import-apply": [],
  "history-replay": [],
  "restore-or-migration": [],
  "attention-typed-writer": [],
});

// These are the small Native typed-writer bridges that intentionally call
// shared writer helpers. New Interpreter/Maintenance Rust modules must use the
// canonical bridge instead of adding another direct dependency.
const ALLOWED_RUST_TYPED_WRITER_BRIDGES = new Set([
  "src-tauri/crates/grimodex-db/src/narrative_extraction/chronicle_operations.rs",
  "src-tauri/crates/grimodex-db/src/narrative_extraction/codex_operations.rs",
  "src-tauri/crates/grimodex-db/src/narrative_extraction/codex_snapshots.rs",
  "src-tauri/crates/grimodex-db/src/narrative_extraction/undo.rs",
]);

const FORBIDDEN_DIRECT_BOUNDARY_IMPORTS = [
  /\bfrom\s+["'`][^"'`]*features\/agent-writes\/(?:codex|event|foreshadow|snippet|bundle)(?:["'`/]|$)/,
  /\b(?:import|require)\s*\(\s*["'`][^"'`]*features\/agent-writes\/(?:codex|event|foreshadow|snippet|bundle)(?:["'`/]|$)/,
  /\bfrom\s+["'`][^"'`]*features\/(?:codex|chronicle|foreshadow|plot-threads|snippets)\/(?:api|detailApi|relationApi|sceneCodexPinsApi|tagApi|phaseApi|codexRelationApi|typeApi|codexQuickPinApi)(?:["'`]|$)/,
  /\b(?:import|require)\s*\(\s*["'`][^"'`]*features\/(?:codex|chronicle|foreshadow|plot-threads|snippets)\/(?:api|detailApi|relationApi|sceneCodexPinsApi|tagApi|phaseApi|codexRelationApi|typeApi|codexQuickPinApi)(?:["'`]|$)/,
];

const FORBIDDEN_DIRECT_AGENT_COMMAND_CALLEE =
  /\b(?:invoke\w*|call\w*|execute\w*|dispatch\w*)\s*\(/gi;
const FORBIDDEN_DIRECT_AGENT_COMMAND_LITERAL =
  /["'`](?:agent_[a-z0-9_]+|ai_tree_plan_[a-z0-9_]+)["'`]/i;

const FORBIDDEN_DIRECT_RUST_BOUNDARY_IMPORTS = [
  /\buse\s+(?:crate|grimodex_db)::agent_writes(?:::|\s*;)/,
  /\buse\s+(?:crate|grimodex_db)::codex_writes(?:::|\s*;)/,
  /\b(?:agent_writes|codex_writes)::[A-Za-z_][A-Za-z0-9_]*\s*\(/,
];

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function readJson(repoRoot, relativePath, errors, label) {
  const absolute = path.join(repoRoot, relativePath);
  if (!existsSync(absolute)) {
    errors.push(`${label} is missing: ${relativePath}`);
    return null;
  }
  try {
    return JSON.parse(readFileSync(absolute, "utf8"));
  } catch (error) {
    errors.push(
      `${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

function listSourceFiles(repoRoot, relativeRoot) {
  const absoluteRoot = path.join(repoRoot, relativeRoot);
  if (!existsSync(absoluteRoot)) return [];
  if (statSync(absoluteRoot).isFile()) return [absoluteRoot];
  const files = [];
  const visit = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (/\.(?:ts|tsx|mts|cts|mjs|cjs|js|jsx|rs)$/.test(entry.name)) files.push(absolute);
    }
  };
  visit(absoluteRoot);
  return files;
}

function listProductionSourceFiles(repoRoot, relativeRoot) {
  return listSourceFiles(repoRoot, relativeRoot).filter((file) => {
    const normalized = file.replaceAll("\\", "/");
    return (
      !/\.(?:test|spec)\.(?:ts|tsx|mts|cts|mjs|cjs|js|jsx)$/.test(normalized) &&
      !normalized.includes("/__tests__/") &&
      !normalized.includes("/tests/")
    );
  });
}

function sameStringSet(actual, expected) {
  if (!Array.isArray(actual) || actual.length !== expected.length) return false;
  return (
    new Set(actual).size === actual.length &&
    expected.every((value) => actual.includes(value))
  );
}

function sameAllowlistImports(actual, expected) {
  if (!Array.isArray(actual) || actual.length !== expected.length) return false;
  const normalize = (entries) =>
    entries
      .map((entry) => ({
        id: entry?.id,
        pattern: entry?.pattern,
        mode: entry?.mode,
      }))
      .sort((left, right) => String(left.id).localeCompare(String(right.id)));
  return JSON.stringify(normalize(actual)) === JSON.stringify(normalize(expected));
}

function validateImplementationStatus(repoRoot, label, status, errors) {
  if (!isObject(status)) {
    errors.push(`${label} implementationStatus must be an object`);
    return;
  }
  const state = status.state;
  if (!new Set(["declared", "shadow", "wired"]).has(state)) {
    errors.push(
      `${label} implementationStatus has unknown state: ${String(state)}`,
    );
    return;
  }

  const entryPoints = Array.isArray(status.productionEntryPoints)
    ? status.productionEntryPoints
    : [];
  if (state === "declared" && entryPoints.length > 0) {
    errors.push(`${label} is declared but lists productionEntryPoints`);
  }
  if (state !== "declared" && entryPoints.length === 0) {
    errors.push(`${label} is ${state} but lists no productionEntryPoints`);
  }
  for (const entryPoint of entryPoints) {
    if (!isNonEmptyString(entryPoint) || path.isAbsolute(entryPoint)) {
      errors.push(
        `${label} production entry point must be repository-relative`,
      );
      continue;
    }
    const absolute = path.resolve(repoRoot, entryPoint);
    const relative = path.relative(repoRoot, absolute);
    if (
      relative.startsWith("..") ||
      path.isAbsolute(relative) ||
      !existsSync(absolute)
    ) {
      errors.push(`${label} production entry point is missing: ${entryPoint}`);
    }
  }

  const roots = Array.isArray(status.scanRoots) ? status.scanRoots : [];
  const markers = Array.isArray(status.productionMarkers)
    ? status.productionMarkers.filter(isNonEmptyString)
    : [];
  const markerHits = [];
  for (const relativeRoot of roots) {
    if (!isNonEmptyString(relativeRoot) || path.isAbsolute(relativeRoot)) {
      errors.push(
        `${label} implementation scan root must be repository-relative`,
      );
      continue;
    }
    const absoluteRoot = path.resolve(repoRoot, relativeRoot);
    const relative = path.relative(repoRoot, absoluteRoot);
    if (
      relative.startsWith("..") ||
      path.isAbsolute(relative) ||
      !existsSync(absoluteRoot)
    ) {
      errors.push(
        `${label} implementation scan root is missing: ${relativeRoot}`,
      );
      continue;
    }
    for (const file of listProductionSourceFiles(repoRoot, relativeRoot)) {
      const source = readFileSync(file, "utf8");
      for (const marker of markers) {
        if (source.includes(marker)) {
          markerHits.push(`${path.relative(repoRoot, file)}:${marker}`);
        }
      }
    }
  }

  if (state === "declared" && markerHits.length > 0) {
    errors.push(
      `${label} is declared but production markers are wired: ${markerHits.join(", ")}`,
    );
  }
  if (state !== "declared" && markerHits.length === 0) {
    errors.push(`${label} is ${state} but no production marker is present`);
  }
}

function containsForbiddenDirectAgentCommandCall(source) {
  for (const match of source.matchAll(FORBIDDEN_DIRECT_AGENT_COMMAND_CALLEE)) {
    const openIndex = (match.index ?? 0) + match[0].length - 1;
    let depth = 1;
    let quote = null;
    let escaped = false;
    let lineComment = false;
    let blockComment = false;

    for (let index = openIndex + 1; index < source.length; index += 1) {
      const char = source[index];
      const next = source[index + 1];

      if (lineComment) {
        if (char === "\n") lineComment = false;
        continue;
      }
      if (blockComment) {
        if (char === "*" && next === "/") {
          blockComment = false;
          index += 1;
        }
        continue;
      }
      if (quote !== null) {
        if (escaped) {
          escaped = false;
        } else if (char === "\\") {
          escaped = true;
        } else if (char === quote) {
          quote = null;
        }
        continue;
      }
      if (char === "/" && next === "/") {
        lineComment = true;
        index += 1;
        continue;
      }
      if (char === "/" && next === "*") {
        blockComment = true;
        index += 1;
        continue;
      }
      if (char === "'" || char === '"' || char === "`") {
        quote = char;
        continue;
      }
      if (char === "(") {
        depth += 1;
      } else if (char === ")") {
        depth -= 1;
        if (depth === 0) {
          if (
            FORBIDDEN_DIRECT_AGENT_COMMAND_LITERAL.test(
              source.slice(openIndex + 1, index),
            )
          ) {
            return true;
          }
          break;
        }
      }
    }
  }
  return false;
}

function validateRouteRegistry(registry, errors) {
  if (!isObject(registry) || registry.schemaVersion !== 1) {
    errors.push("mutation authority route registry schemaVersion must be 1");
    return new Map();
  }
  if (
    !Array.isArray(registry.routes) ||
    registry.routes.length !== AUTHORITY_ROUTE_IDS.length
  ) {
    errors.push(
      `mutation authority route registry must define exactly ${AUTHORITY_ROUTE_IDS.length} routes`,
    );
    return new Map();
  }
  if (registry.callerAuthorizationPolicy !== "positive-allowlist-fail-closed") {
    errors.push(
      "mutation authority callers must use a positive allowlist and fail closed",
    );
  }
  if (registry.forbiddenCallersSemantics !== "diagnostic-only") {
    errors.push(
      "forbiddenCallers must be diagnostic-only and never grant access",
    );
  }

  const routes = new Map();
  for (const [index, route] of registry.routes.entries()) {
    const label = `mutation authority route ${index}`;
    if (!isObject(route) || !isNonEmptyString(route.id)) {
      errors.push(`${label} must have a non-empty id`);
      continue;
    }
    if (!AUTHORITY_ROUTE_IDS.includes(route.id)) {
      errors.push(`${label} has unknown route: ${route.id}`);
      continue;
    }
    if (routes.has(route.id))
      errors.push(`duplicate mutation authority route: ${route.id}`);
    routes.set(route.id, route);
    const required = REQUIRED_ROUTE_CONTROLS[route.id] ?? [];
    if (!Array.isArray(route.requiredControls)) {
      errors.push(`${label} requiredControls must be an array`);
    } else {
      for (const control of required) {
        if (!route.requiredControls.includes(control)) {
          errors.push(
            `${route.id} route is missing required control: ${control}`,
          );
        }
      }
    }
    if (!Array.isArray(route.forbiddenCallers)) {
      errors.push(`${label} forbiddenCallers must be an array`);
    } else if (
      new Set(route.forbiddenCallers).size !== route.forbiddenCallers.length
    ) {
      errors.push(`${route.id} forbiddenCallers must be unique`);
    }
    const expectedCallers = EXPECTED_ALLOWED_CALLERS[route.id] ?? [];
    if (
      !Array.isArray(route.allowedCallers) ||
      route.allowedCallers.length === 0
    ) {
      errors.push(`${label} allowedCallers must be a non-empty allowlist`);
    } else {
      if (new Set(route.allowedCallers).size !== route.allowedCallers.length) {
        errors.push(`${route.id} allowedCallers must be unique`);
      }
      if (
        JSON.stringify(route.allowedCallers) !== JSON.stringify(expectedCallers)
      ) {
        errors.push(
          `${route.id} allowedCallers do not match the canonical allowlist`,
        );
      }
      const forbidden = new Set(route.forbiddenCallers ?? []);
      const overlap = route.allowedCallers.filter((caller) =>
        forbidden.has(caller),
      );
      if (overlap.length > 0) {
        errors.push(
          `${route.id} allowedCallers and forbiddenCallers must be disjoint: ${overlap.join(", ")}`,
        );
      }
    }
    const requiredControls = new Set(route.requiredControls ?? []);
    const conditionalControls = Array.isArray(route.conditionalControls)
      ? route.conditionalControls.map((entry) => entry?.control)
      : [];
    const controlOverlap = conditionalControls.filter((control) =>
      requiredControls.has(control),
    );
    if (controlOverlap.length > 0) {
      errors.push(
        `${route.id} controls cannot be both required and conditional: ${controlOverlap.join(", ")}`,
      );
    }
    const expectedConditional = EXPECTED_CONDITIONAL_CONTROLS[route.id] ?? [];
    if (
      JSON.stringify(route.conditionalControls ?? []) !==
      JSON.stringify(expectedConditional)
    ) {
      errors.push(
        `${route.id} conditionalControls do not match the canonical contract`,
      );
    }
  }
  for (const routeId of AUTHORITY_ROUTE_IDS) {
    if (!routes.has(routeId))
      errors.push(`missing mutation authority route: ${routeId}`);
  }
  if (registry.unknownRoutePolicy !== "fail-closed") {
    errors.push("unknown mutation authority routes must fail closed");
  }
  return routes;
}

function validateWriterRoutes(manifest, routes, errors) {
  if (!isObject(manifest) || !Array.isArray(manifest.operations)) {
    errors.push("change-feed writer manifest operations must be an array");
    return 0;
  }
  const routeCounts = Object.fromEntries(
    AUTHORITY_ROUTE_IDS.map((id) => [id, 0]),
  );
  for (const [index, operation] of manifest.operations.entries()) {
    const label = `change-feed operation ${operation?.id ?? index}`;
    if (!isObject(operation)) {
      errors.push(`${label} must be an object`);
      continue;
    }
    const variants = Array.isArray(operation.authorityVariants)
      ? operation.authorityVariants
      : [
          {
            authorityRoute: operation.authorityRoute,
            controls: operation.controls,
          },
        ];
    if (variants.length === 0) {
      errors.push(`${label} must declare at least one authority route variant`);
      continue;
    }
    if (
      Array.isArray(operation.authorityVariants) &&
      isNonEmptyString(operation.authorityRoute) &&
      operation.authorityRoute !== variants[0]?.authorityRoute
    ) {
      errors.push(
        `${label} authorityRoute must match the first authority variant`,
      );
    }
    const untrustedExcluded =
      operation.feedPolicy === "excluded" &&
      operation.exclusionReason === "untrusted-generic-sql";
    for (const [variantIndex, variant] of variants.entries()) {
      const variantLabel = `${label} authority variant ${variantIndex}`;
      if (!isObject(variant) || !isNonEmptyString(variant.authorityRoute)) {
        errors.push(`${variantLabel} must declare authorityRoute`);
        continue;
      }
      const route = routes.get(variant.authorityRoute);
      if (!route) {
        errors.push(
          `${variantLabel} has unknown authority route: ${variant.authorityRoute}`,
        );
        continue;
      }
      routeCounts[variant.authorityRoute] += 1;
      if (!Array.isArray(variant.controls)) {
        errors.push(`${variantLabel} must declare route controls`);
        continue;
      }
      if (variant.allowedCallers !== undefined) {
        const expectedCallers = route.allowedCallers ?? [];
        if (
          JSON.stringify(variant.allowedCallers) !==
          JSON.stringify(expectedCallers)
        ) {
          errors.push(
            `${variantLabel} allowedCallers do not match the route allowlist`,
          );
        }
      }
      if (untrustedExcluded) {
        if (variant.controls.length > 0) {
          errors.push(
            `${label} untrusted generic SQL must not self-report runtime controls`,
          );
        }
        continue;
      }
      const required = Array.isArray(route.requiredControls)
        ? route.requiredControls
        : (REQUIRED_ROUTE_CONTROLS[variant.authorityRoute] ?? []);
      for (const control of required) {
        if (!variant.controls.includes(control)) {
          errors.push(
            `${variantLabel} is missing required control '${control}' for ${variant.authorityRoute}`,
          );
        }
      }
    }
    if (
      untrustedExcluded &&
      (!isObject(operation.runtimeEvidence) ||
        operation.runtimeEvidence.status !== "excluded" ||
        operation.runtimeEvidence.reason !== "untrusted-generic-sql")
    ) {
      errors.push(
        `${label} must declare excluded runtimeEvidence for untrusted generic SQL`,
      );
    }
  }
  return { operationCount: manifest.operations.length, routeCounts };
}

function validateStateVocabulary(vocabulary, errors) {
  if (!isObject(vocabulary) || vocabulary.schemaVersion !== 1) {
    errors.push("semantic state vocabulary schemaVersion must be 1");
    return;
  }
  for (const field of REQUIRED_STATE_FIELDS) {
    if (!Array.isArray(vocabulary[field]) || vocabulary[field].length === 0) {
      errors.push(
        `semantic state vocabulary ${field} must be a non-empty array`,
      );
    }
  }
  const values = new Map();
  for (const field of REQUIRED_STATE_FIELDS) {
    for (const value of vocabulary[field] ?? []) {
      if (!isNonEmptyString(value))
        errors.push(`${field} contains an empty state value`);
      const fields = values.get(value) ?? [];
      fields.push(field);
      values.set(value, fields);
    }
  }
  const allowedOverlap = new Set([
    "evidenceFreshness|projectionApplicationStates:stale",
  ]);
  for (const [value, fields] of values) {
    if (fields.length > 1) {
      const key = [...fields].sort().join("|") + `:${value}`;
      if (!allowedOverlap.has(key)) {
        errors.push(
          `state vocabulary value '${value}' is mixed across axes: ${fields.join(", ")}`,
        );
      }
    }
  }
  const forbiddenPairs = [
    ["reviewStates", "stale"],
    ["projectionApplicationStates", "accepted"],
    ["buildActions", "needs-reconciliation"],
    ["evidenceFreshness", "rebuild-required"],
  ];
  for (const [field, value] of forbiddenPairs) {
    if ((vocabulary[field] ?? []).includes(value)) {
      errors.push(`state vocabulary '${value}' is in forbidden axis ${field}`);
    }
  }
  if (!vocabulary.reconciliationSignals?.includes("needs-reconciliation")) {
    errors.push("reconciliationSignals must contain needs-reconciliation");
  }
}

// Gate C2 Lane L: validates the two Application-contribution / Maintenance-
// ownership axes registered alongside (but independent of) the original six
// REQUIRED_STATE_FIELDS axes above. This intentionally does not reuse
// `validateStateVocabulary`'s `values` map / `allowedOverlap` set — that
// machinery stays scoped to the original six axes so a Lane L edit can never
// silently widen or narrow what counts as an allowed overlap there. Instead
// this runs its own lightweight required-values check plus a dedicated
// cross-axis overlap check against the six existing axes.
function validateContributionAxes(vocabulary, errors) {
  if (!isObject(vocabulary)) return;

  const checkRequiredValues = (field, required) => {
    if (!Array.isArray(vocabulary[field]) || vocabulary[field].length === 0) {
      errors.push(
        `semantic state vocabulary ${field} must be a non-empty array`,
      );
      return;
    }
    for (const value of vocabulary[field]) {
      if (!isNonEmptyString(value)) {
        errors.push(`${field} contains an empty state value`);
      }
    }
    const missing = required.filter(
      (value) => !vocabulary[field].includes(value),
    );
    const extra = vocabulary[field].filter(
      (value) => !required.includes(value),
    );
    if (missing.length > 0 || extra.length > 0) {
      errors.push(
        `semantic state vocabulary ${field} must contain exactly [${required.join(", ")}]` +
          (missing.length > 0 ? `; missing: ${missing.join(", ")}` : "") +
          (extra.length > 0 ? `; unexpected: ${extra.join(", ")}` : ""),
      );
    }
  };

  checkRequiredValues(
    "contributionTargetStates",
    REQUIRED_CONTRIBUTION_TARGET_STATES,
  );
  checkRequiredValues(
    "maintenanceOwnershipStates",
    REQUIRED_MAINTENANCE_OWNERSHIP_STATES,
  );

  // Cross-axis overlap check against the original six REQUIRED_STATE_FIELDS
  // axes only (not against each other -- contributionTargetStates and
  // maintenanceOwnershipStates share no values today).
  const existingValues = new Map();
  for (const field of REQUIRED_STATE_FIELDS) {
    for (const value of vocabulary[field] ?? []) {
      const fields = existingValues.get(value) ?? [];
      fields.push(field);
      existingValues.set(value, fields);
    }
  }

  // Same word, deliberately different axis -- allowed the same way the
  // pre-existing evidenceFreshness/projectionApplicationStates 'stale'
  // overlap is allowed above:
  //   - reviewStates/contributionTargetStates 'superseded': a Proposal being
  //     superseded by a later one (review lifecycle) vs. a field write being
  //     superseded by a later Application (contribution bookkeeping). See
  //     the "distinct axis" doc comment on ContributionTargetState in
  //     application_contributions.rs.
  //   - contributionTargetStates/projectionApplicationStates 'undone' and
  //     'not-applicable': Undo/Redo and Prepared Commit applicability are
  //     one mechanism described from two different bookkeeping vantage
  //     points (the projection row vs. the field-level contribution row for
  //     the same Application), so the same terms recur by design.
  // Any other collision is a real naming clash and must fail closed.
  const allowedContributionOverlap = new Set([
    "contributionTargetStates|reviewStates:superseded",
    "contributionTargetStates|projectionApplicationStates:undone",
    "contributionTargetStates|projectionApplicationStates:not-applicable",
  ]);

  for (const axis of [
    "contributionTargetStates",
    "maintenanceOwnershipStates",
  ]) {
    for (const value of vocabulary[axis] ?? []) {
      const collidingFields = existingValues.get(value);
      if (!collidingFields || collidingFields.length === 0) continue;
      const key = [...collidingFields, axis].sort().join("|") + `:${value}`;
      if (!allowedContributionOverlap.has(key)) {
        errors.push(
          `state vocabulary value '${value}' is mixed across axes: ${[...collidingFields, axis].join(", ")}`,
        );
      }
    }
  }
}

function validateAuthorityMatrix(matrix, errors) {
  if (!isObject(matrix) || matrix.schemaVersion !== 1) {
    errors.push("semantic authority matrix schemaVersion must be 1");
    return;
  }
  if (!Array.isArray(matrix.authorities) || matrix.authorities.length === 0) {
    errors.push("semantic authority matrix authorities must be non-empty");
  } else {
    const concerns = new Set();
    for (const authority of matrix.authorities) {
      if (!isObject(authority) || !isNonEmptyString(authority.concern)) {
        errors.push("semantic authority entry must have a concern");
        continue;
      }
      if (concerns.has(authority.concern))
        errors.push(
          `duplicate semantic authority concern: ${authority.concern}`,
        );
      concerns.add(authority.concern);
      if (!isNonEmptyString(authority.canonicalAuthority)) {
        errors.push(`${authority.concern} must declare canonicalAuthority`);
      }
      if (
        authority.concern === "evidence-freshness" &&
        /index/i.test(authority.canonicalAuthority)
      ) {
        errors.push(
          "Semantic Index cannot be the Evidence Freshness authority",
        );
      }
    }
  }
  const allowedFields = [
    "generation",
    "builtAt",
    "sourceDigest",
    "dependencySetDigest",
    "dirtyCacheFlag",
  ];
  if (
    JSON.stringify(matrix.semanticIndexAllowedFields) !==
    JSON.stringify(allowedFields)
  ) {
    errors.push(
      "semantic index allowed fields must be generation/build metadata only",
    );
  }
  if (matrix.secondaryFreshnessAuthorityPolicy !== "forbid") {
    errors.push("secondary freshness authorities must be forbidden");
  }
  for (const claim of [
    "assertion-is-authoritative-fresh",
    "assertionFresh",
    "isAuthoritativeFresh",
  ]) {
    if (!matrix.forbiddenFreshnessClaims?.includes(claim)) {
      errors.push(
        `semantic authority matrix must forbid freshness claim: ${claim}`,
      );
    }
  }
}

function validateRegexRule(rule, label, errors) {
  if (!isObject(rule) || !isNonEmptyString(rule.id)) {
    errors.push(`${label} must declare a non-empty id`);
    return false;
  }
  const patterns = Array.isArray(rule.patterns)
    ? rule.patterns
    : [rule.pattern];
  if (patterns.length === 0 || patterns.some((pattern) => !isNonEmptyString(pattern))) {
    errors.push(`${label} must declare non-empty regex patterns`);
    return false;
  }
  let valid = true;
  for (const [index, pattern] of patterns.entries()) {
    try {
      // Compile every policy-owned expression before scanning any source. A
      // malformed deny rule must fail closed instead of silently shrinking
      // the boundary scan.
      new RegExp(pattern);
    } catch (error) {
      errors.push(
        `${label} pattern ${index} is invalid: ${error instanceof Error ? error.message : String(error)}`,
      );
      valid = false;
    }
  }
  return valid;
}

function normalizedFixtureClaim(claim) {
  if (!isObject(claim)) return undefined;
  return Object.fromEntries(
    Object.entries(claim).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function validateArtifactAuthorityFixtureOracle(fixtureCase, oracle, errors) {
  const fixtureId = String(fixtureCase?.id);
  for (const field of ["kind", "target", "expected"]) {
    if (fixtureCase?.[field] !== oracle[field]) {
      errors.push(
        `narrative artifact authority fixture ${fixtureId} ${field} does not match ratified semantics: expected ${String(oracle[field])}, got ${String(fixtureCase?.[field])}`,
      );
    }
  }
  const expectedClaim = normalizedFixtureClaim(oracle.claim);
  const actualClaim = normalizedFixtureClaim(fixtureCase?.claim);
  if (JSON.stringify(actualClaim) !== JSON.stringify(expectedClaim)) {
    errors.push(
      `narrative artifact authority fixture ${fixtureId} claim does not match ratified semantics`,
    );
  }
  if (oracle.source !== undefined) {
    if (fixtureCase?.source !== oracle.source) {
      errors.push(
        `narrative artifact authority fixture ${fixtureId} source does not match ratified semantics`,
      );
    }
    if (fixtureCase?.rule !== oracle.rule) {
      errors.push(
        `narrative artifact authority fixture ${fixtureId} rule does not match ratified semantics: expected ${String(oracle.rule)}, got ${String(fixtureCase?.rule)}`,
      );
    }
  } else {
    if (Object.prototype.hasOwnProperty.call(fixtureCase ?? {}, "source")) {
      errors.push(
        `narrative artifact authority fixture ${fixtureId} must remain a claim case`,
      );
    }
    if (Object.prototype.hasOwnProperty.call(fixtureCase ?? {}, "rule")) {
      errors.push(
        `narrative artifact authority fixture ${fixtureId} must not declare a source rule`,
      );
    }
  }
}

function evaluateArtifactAuthorityFixtureClaim(contract, fixtureCase, errors) {
  const fixtureId = String(fixtureCase?.id);
  const target = fixtureCase?.target;
  const claim = fixtureCase?.claim;
  const artifact = Array.isArray(contract?.artifacts)
    ? contract.artifacts.find((candidate) => candidate?.id === target)
    : undefined;
  if (!isNonEmptyString(target) || !artifact) {
    errors.push(
      `narrative artifact authority fixture ${fixtureId} targets an unknown artifact: ${String(target)}`,
    );
    return;
  }
  if (!isObject(claim) || Object.keys(claim).length === 0) {
    errors.push(
      `narrative artifact authority fixture ${fixtureId} must declare a non-empty claim`,
    );
    return;
  }

  const mismatches = [];
  for (const [field, expected] of Object.entries(claim)) {
    let actual;
    if (field === "retention") {
      actual = artifact.retention?.default;
    } else if (Object.prototype.hasOwnProperty.call(artifact, field)) {
      actual = artifact[field];
    } else {
      mismatches.push(`unknown claim field ${field}`);
      continue;
    }
    if (actual !== expected) {
      mismatches.push(`${field} expected ${String(expected)} got ${String(actual)}`);
    }
  }

  const actual = mismatches.length === 0 ? "accept" : "reject";
  if (actual !== fixtureCase.expected) {
    errors.push(
      `narrative artifact authority fixture ${fixtureId} expected ${String(fixtureCase.expected)} but got ${actual}: ${mismatches.join(", ")}`,
    );
  }
}

function evaluateArtifactAuthorityFixtureSource(contract, fixtureCase, errors) {
  const source = fixtureCase?.source;
  const fixtureId = String(fixtureCase?.id);
  if (!isNonEmptyString(source)) {
    errors.push(
      `narrative artifact authority fixture ${fixtureId} must declare a non-empty source`,
    );
    return;
  }

  const boundary = isObject(contract?.interpreterBoundary)
    ? contract.interpreterBoundary
    : {};
  const sourceFile = `artifact-authority-fixture-${String(fixtureCase.id)}.ts`;
  const parsed = scanInterpreterSourceWithAst(sourceFile, source);
  const dependencySource = removeAllowlistedTypeOnlyImports(
    source,
    Array.isArray(boundary.allowlist?.imports)
      ? boundary.allowlist.imports
      : [],
  );
  const dependencyScan = scanInterpreterSourceWithAst(
    sourceFile,
    dependencySource,
  );
  const actualRules = new Set([
    ...dependencyScan.findings,
    ...(dependencyScan.freshnessFindings ?? []),
  ]);
  if (
    parsed.parseDiagnostics.length > 0 ||
    dependencyScan.parseDiagnostics.length > 0
  ) {
    actualRules.add("parse-diagnostics");
  }
  for (const rule of Array.isArray(boundary.forbiddenDependencies)
    ? boundary.forbiddenDependencies
    : []) {
    for (const pattern of Array.isArray(rule?.patterns) ? rule.patterns : []) {
      try {
        if (new RegExp(pattern).test(dependencySource)) {
          actualRules.add(rule.id);
        }
      } catch (error) {
        errors.push(
          `narrative artifact authority fixture ${String(fixtureCase.id)} could not evaluate dependency rule ${String(rule?.id)}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
  for (const rule of Array.isArray(boundary.forbiddenFreshnessAuthorityPatterns)
    ? boundary.forbiddenFreshnessAuthorityPatterns
    : []) {
    try {
      if (new RegExp(rule.pattern).test(source)) {
        actualRules.add(rule.id);
      }
    } catch (error) {
      errors.push(
        `narrative artifact authority fixture ${String(fixtureCase.id)} could not evaluate Freshness rule ${String(rule?.id)}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  if (
    actualRules.size === 0 &&
    dependencySource !== source &&
    dependencySource.trim() === ""
  ) {
    actualRules.add("type-only-domain-vocabulary");
  }

  const declaredRule = fixtureCase?.rule;
  if (
    !isNonEmptyString(declaredRule) ||
    actualRules.size !== 1 ||
    !actualRules.has(declaredRule)
  ) {
    errors.push(
      `narrative artifact authority fixture ${fixtureId} declared rule ${String(declaredRule)} does not match evaluated source rule(s): ${[...actualRules].join(", ") || "none"}`,
    );
  }

  const actual =
    actualRules.size === 0 ||
    (actualRules.size === 1 && actualRules.has("type-only-domain-vocabulary"))
      ? "accept"
      : "reject";
  if (actual !== fixtureCase.expected) {
    errors.push(
      `narrative artifact authority fixture ${fixtureId} expected ${String(fixtureCase.expected)} but got ${actual}`,
    );
  }
}

function validateArtifactAuthorityFixtures(repoRoot, contract, errors) {
  const fixturePaths = Array.isArray(contract?.fixtures)
    ? contract.fixtures
    : [];
  if (fixturePaths.length === 0) {
    errors.push("narrative artifact authority contract must declare fixtures");
    return;
  }
  const fixturePath = fixturePaths.find((entry) =>
    entry.endsWith("policies/narrative/fixtures/artifact-authority.json"),
  );
  if (!fixturePath) {
    errors.push(
      "narrative artifact authority contract must reference artifact-authority.json",
    );
    return;
  }
  const fixture = readJson(
    repoRoot,
    fixturePath,
    errors,
    "narrative artifact authority fixtures",
  );
  if (
    !fixture ||
    fixture.schemaVersion !== 1 ||
    fixture.fixtureKind !== "narrative-artifact-authority-negative-and-positive" ||
    !Array.isArray(fixture.cases)
  ) {
    errors.push(
      "narrative artifact authority fixtures must declare schemaVersion 1, fixtureKind, and cases",
    );
    return;
  }
  const cases = new Map(
    fixture.cases.map((fixtureCase) => [fixtureCase?.id, fixtureCase]),
  );
  const seenCaseIds = new Set();
  for (const fixtureCase of fixture.cases) {
    const fixtureId = fixtureCase?.id;
    if (!isNonEmptyString(fixtureId)) {
      errors.push("narrative artifact authority fixture cases must have unique non-empty ids");
      continue;
    }
    if (seenCaseIds.has(fixtureId)) {
      errors.push(`duplicate narrative artifact authority fixture case: ${fixtureId}`);
      continue;
    }
    seenCaseIds.add(fixtureId);
    const oracle = REQUIRED_ARTIFACT_FIXTURE_ORACLES[fixtureId];
    if (oracle) {
      validateArtifactAuthorityFixtureOracle(fixtureCase, oracle, errors);
    }
  }
  for (const fixtureId of REQUIRED_ARTIFACT_FIXTURES) {
    const fixtureCase = cases.get(fixtureId);
    if (!fixtureCase) {
      errors.push(
        `narrative artifact authority fixtures are missing case: ${fixtureId}`,
      );
      continue;
    }
    if (!new Set(["accept", "reject"]).has(fixtureCase.expected)) {
      errors.push(
        `narrative artifact authority fixture ${fixtureId} must declare accept or reject`,
      );
    }
  }
  for (const fixtureCase of fixture.cases) {
    if (Object.prototype.hasOwnProperty.call(fixtureCase ?? {}, "source")) {
      evaluateArtifactAuthorityFixtureSource(contract, fixtureCase, errors);
    } else {
      evaluateArtifactAuthorityFixtureClaim(contract, fixtureCase, errors);
    }
  }
  if (
    !fixture.cases.some((fixtureCase) => fixtureCase?.expected === "accept") ||
    !fixture.cases.some((fixtureCase) => fixtureCase?.expected === "reject")
  ) {
    errors.push(
      "narrative artifact authority fixtures must contain both accept and reject cases",
    );
  }
}

export function validateArtifactAuthorityContract(repoRoot, contract, errors) {
  if (!isObject(contract) || contract.schemaVersion !== 1) {
    errors.push("narrative artifact authority contract schemaVersion must be 1");
    return;
  }
  if (contract.contract !== "narrative-artifact-authority") {
    errors.push("narrative artifact authority contract id is invalid");
  }
  if (
    !sameStringSet(contract.requirementIds, [
      "GDX-NARR-SEMANTIC-CONTRACT-001",
      "GDX-ARTIFACT-001",
      "GDX-TRACE-001",
    ])
  ) {
    errors.push(
      "narrative artifact authority contract must retain GDX-NARR-SEMANTIC-CONTRACT-001, GDX-ARTIFACT-001, and GDX-TRACE-001 traceability",
    );
  }
  if (
    !sameStringSet(contract.lifecycleClasses, [
      "durable",
      "ephemeral",
      "rebuildable",
    ])
  ) {
    errors.push(
      "narrative artifact authority lifecycle classes must be durable, ephemeral, and rebuildable",
    );
  }
  if (!sameStringSet(contract.authorityKinds, REQUIRED_ARTIFACT_AUTHORITY_KINDS)) {
    errors.push(
      `narrative artifact authority kinds must match ratified set: ${REQUIRED_ARTIFACT_AUTHORITY_KINDS.join(", ")}`,
    );
  }
  const authorityKinds = new Set(
    Array.isArray(contract.authorityKinds) ? contract.authorityKinds : [],
  );
  const artifacts = Array.isArray(contract.artifacts)
    ? contract.artifacts
    : [];
  if (artifacts.length === 0) {
    errors.push("narrative artifact authority contract must list artifacts");
    return;
  }
  if (
    !sameStringSet(
      artifacts.map((artifact) => artifact?.id),
      REQUIRED_ARTIFACT_IDS,
    )
  ) {
    errors.push(
      `narrative artifact authority artifact IDs must match ratified set: ${REQUIRED_ARTIFACT_IDS.join(", ")}`,
    );
  }
  const artifactById = new Map();
  for (const artifact of artifacts) {
    if (!isObject(artifact) || !isNonEmptyString(artifact.id)) {
      errors.push("narrative artifact authority entry must have an id");
      continue;
    }
    if (artifactById.has(artifact.id)) {
      errors.push(`duplicate narrative artifact authority entry: ${artifact.id}`);
    }
    artifactById.set(artifact.id, artifact);
    if (!new Set(["durable", "ephemeral", "rebuildable"]).has(artifact.lifecycle)) {
      errors.push(`narrative artifact ${artifact.id} has unknown lifecycle: ${String(artifact.lifecycle)}`);
    }
    if (!authorityKinds.has(artifact.authority)) {
      errors.push(`narrative artifact ${artifact.id} has unknown authority: ${String(artifact.authority)}`);
    }
    if (!isObject(artifact.retention) || !isNonEmptyString(artifact.retention.default)) {
      errors.push(`narrative artifact ${artifact.id} must declare retention.default`);
    }
    if (!isNonEmptyString(artifact.storage)) {
      errors.push(`narrative artifact ${artifact.id} must declare storage`);
    }
    if (artifact.lifecycle === "durable" && artifact.retention?.default !== "retained") {
      errors.push(`durable narrative artifact ${artifact.id} must be retained`);
    }
    if (artifact.lifecycle === "ephemeral" && artifact.retention?.default === "reconstructable") {
      errors.push(`ephemeral narrative artifact ${artifact.id} cannot be reconstructable`);
    }
    if (artifact.lifecycle === "rebuildable" && artifact.authoritative !== false) {
      errors.push(`rebuildable narrative artifact ${artifact.id} must not be authoritative`);
    }
    if (artifact.authoritative === true && artifact.lifecycle === "ephemeral") {
      errors.push(`ephemeral narrative artifact ${artifact.id} cannot be authoritative`);
    }
  }
  for (const artifactId of REQUIRED_ARTIFACT_IDS) {
    if (!artifactById.has(artifactId)) {
      errors.push(`narrative artifact authority contract is missing artifact: ${artifactId}`);
    }
  }
  const expectedArtifactRows = new Map(
    REQUIRED_ARTIFACT_AUTHORITY_ROWS.map((row) => [row.id, row]),
  );
  for (const artifactId of REQUIRED_ARTIFACT_IDS) {
    const artifact = artifactById.get(artifactId);
    const expected = expectedArtifactRows.get(artifactId);
    if (!artifact || !expected) continue;
    for (const [field, actual, ratified] of [
      ["lifecycle", artifact.lifecycle, expected.lifecycle],
      ["authority", artifact.authority, expected.authority],
      ["authoritative", artifact.authoritative, expected.authoritative],
      ["storage", artifact.storage, expected.storage],
      [
        "retention.default",
        artifact.retention?.default,
        expected.retentionDefault,
      ],
      [
        "retention.scope",
        artifact.retention?.scope,
        expected.retentionScope,
      ],
    ]) {
      if (actual !== ratified) {
        errors.push(
          `narrative artifact ${artifactId} ${field} does not match ratified classification: expected ${String(ratified)}, got ${String(actual)}`,
        );
      }
    }
  }

  const rawResponse = artifactById.get("raw-model-response");
  if (rawResponse?.lifecycle === "durable") {
    errors.push("raw-model-response must not be durable");
  }
  if (rawResponse?.retention?.default !== "not-retained") {
    errors.push("raw-model-response default retention must be not-retained");
  }
  const digest = artifactById.get("response-digest");
  if (digest?.retention?.default !== "retained") {
    errors.push("response-digest must be retained");
  }
  const extractionArtifact = artifactById.get("extraction-artifact");
  if (extractionArtifact?.retention?.default !== "retained") {
    errors.push("extraction-artifact must be retained");
  }
  const freshnessAuthorities = artifacts.filter(
    (artifact) => artifact.authority === "evidence-freshness",
  );
  if (
    freshnessAuthorities.length !== 1 ||
    freshnessAuthorities[0]?.id !== "consumer-freshness" ||
    freshnessAuthorities[0]?.storage !== "narrative_consumer_freshness"
  ) {
    errors.push(
      "narrative artifact authority must have exactly one canonical consumer-freshness authority",
    );
  }
  const semanticIndex = artifactById.get("semantic-index");
  if (
    semanticIndex?.authoritative !== false ||
    semanticIndex?.authority !== "rebuildable-acceleration"
  ) {
    errors.push(
      "semantic-index must remain rebuildable-acceleration-only and non-authoritative",
    );
  }
  const rendererState = artifactById.get("renderer-state");
  if (rendererState?.authority === "evidence-freshness" || rendererState?.authoritative === true) {
    errors.push("renderer-state must not claim Freshness or semantic authority");
  }
  const rawResponsePolicy = contract.rawResponsePolicy;
  if (
    !isObject(rawResponsePolicy) ||
    rawResponsePolicy.artifactId !== "raw-model-response" ||
    rawResponsePolicy.defaultLifecycle !== "ephemeral" ||
    rawResponsePolicy.defaultRetention !== "not-retained" ||
    rawResponsePolicy.digestArtifactId !== "response-digest" ||
    rawResponsePolicy.parsedResultArtifactId !== "extraction-artifact" ||
    !isNonEmptyString(rawResponsePolicy.fullRetentionRequiresContract)
  ) {
    errors.push(
      "raw response policy must make ephemeral/non-retained default and name digest and parsed result artifacts",
    );
  }
  const authorityRules = contract.authorityRules;
  if (
    !isObject(authorityRules) ||
    authorityRules.secondaryFreshnessAuthority !== "forbid" ||
    authorityRules.rendererFreshnessAuthority !== "forbid" ||
    authorityRules.featureLocalFreshnessAuthority !== "forbid" ||
    authorityRules.semanticIndexAuthority !== "rebuildable-acceleration-only" ||
    authorityRules.interpreterDomainMutation !== "forbid"
  ) {
    errors.push(
      "narrative artifact authority rules must forbid secondary/renderer/feature-local Freshness and Interpreter mutation",
    );
  }
  validateArtifactAuthorityFixtures(repoRoot, contract, errors);
  validateImplementationStatus(
    repoRoot,
    "narrative artifact authority contract",
    contract.implementationStatus,
    errors,
  );
}

function allowlistedSourcePath(repoRoot, file, allowlistedFiles) {
  const relativeFile = path.relative(repoRoot, file).replaceAll("\\", "/");
  return allowlistedFiles.has(relativeFile);
}

function removeAllowlistedTypeOnlyImports(source, allowlistedImports) {
  const compiled = allowlistedImports.flatMap((entry) => {
    if (entry?.mode !== "type-only" || !isNonEmptyString(entry.pattern)) {
      return [];
    }
    try {
      return [new RegExp(entry.pattern)];
    } catch {
      return [];
    }
  });
  return source.replace(
    /^\s*import\s+type[\s\S]*?from\s+["']([^"']+)["']\s*;?\s*$/gm,
    (statement, moduleSpecifier) =>
      compiled.some((pattern) => pattern.test(moduleSpecifier)) ? "" : statement,
  );
}

const INTERPRETER_AST_SOURCE_EXTENSIONS = /\.(?:ts|tsx|mts|cts|mjs|cjs|js|jsx)$/;
const REQUIRED_DB_MUTATION_METHODS = new Set([
  "execute",
  "exec",
  "run",
  "prepare",
  "query",
  "insert",
  "update",
  "delete",
]);

function unwrapExpression(expression) {
  let current = expression;
  while (
    current &&
    (ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isTypeAssertionExpression(current) ||
      ts.isNonNullExpression(current))
  ) {
    current = current.expression;
  }
  return current;
}

function isFunctionScopeNode(node) {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isConstructorDeclaration(node)
  );
}

function isLexicalScopeNode(node) {
  return (
    ts.isBlock(node) ||
    ts.isModuleBlock(node) ||
    ts.isCaseBlock(node) ||
    ts.isCatchClause(node) ||
    ts.isForStatement(node) ||
    ts.isForInStatement(node) ||
    ts.isForOfStatement(node) ||
    ts.isClassStaticBlockDeclaration(node)
  );
}

function collectBindingIdentifiers(name, callback) {
  if (!name) return;
  if (ts.isIdentifier(name)) {
    callback(name);
    return;
  }
  if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
    for (const element of name.elements) {
      if (ts.isBindingElement(element)) {
        collectBindingIdentifiers(element.name, callback);
      }
    }
  }
}

function createStaticStringResolver(sourceFile) {
  const rootScope = { node: sourceFile, parent: null, bindings: new Map() };
  const scopeByNode = new WeakMap();

  const visitScopes = (node, parentScope) => {
    let scope = parentScope;
    if (
      node !== sourceFile &&
      (isFunctionScopeNode(node) || isLexicalScopeNode(node))
    ) {
      scope = { node, parent: parentScope, bindings: new Map() };
    }
    scopeByNode.set(node, scope);
    ts.forEachChild(node, (child) => visitScopes(child, scope));
  };
  visitScopes(sourceFile, rootScope);

  const bindingIdentifierNodes = new WeakSet();

  const registerBinding = (scope, identifier, kind, declaration) => {
    if (!scope || !ts.isIdentifier(identifier)) return;
    bindingIdentifierNodes.add(identifier);
    const binding = {
      name: identifier.text,
      kind,
      declaration,
      reassigned: false,
    };
    const bindings = scope.bindings.get(identifier.text) ?? [];
    bindings.push(binding);
    scope.bindings.set(identifier.text, bindings);
  };

  const nearestVariableScope = (scope) => {
    let current = scope;
    while (current && current.node !== sourceFile) {
      if (isFunctionScopeNode(current.node)) return current;
      current = current.parent;
    }
    return rootScope;
  };

  const registerDeclarationBindings = (node) => {
    if (ts.isVariableDeclaration(node)) {
      const variableList = ts.isVariableDeclarationList(node.parent)
        ? node.parent
        : undefined;
      const isConst =
        variableList && (variableList.flags & ts.NodeFlags.Const) !== 0;
      const isLet =
        variableList && (variableList.flags & ts.NodeFlags.Let) !== 0;
      const kind = isConst ? "const" : "mutable";
      const lexicalScope = scopeByNode.get(node);
      const scope =
        !isConst && !isLet
          ? nearestVariableScope(lexicalScope)
          : lexicalScope;
      collectBindingIdentifiers(node.name, (identifier) =>
        registerBinding(scope, identifier, kind, node),
      );
      return;
    }
    if (ts.isParameter(node)) {
      const scope = scopeByNode.get(node);
      collectBindingIdentifiers(node.name, (identifier) =>
        registerBinding(scope, identifier, "parameter", node),
      );
      return;
    }
    if (ts.isImportDeclaration(node)) {
      const scope = scopeByNode.get(node);
      const clause = node.importClause;
      if (!clause) return;
      if (clause.name) {
        registerBinding(scope, clause.name, "other", node);
      }
      if (clause.namedBindings) {
        if (ts.isNamespaceImport(clause.namedBindings)) {
          registerBinding(scope, clause.namedBindings.name, "other", node);
        } else {
          for (const specifier of clause.namedBindings.elements) {
            registerBinding(scope, specifier.name, "other", node);
          }
        }
      }
      return;
    }
    if (ts.isImportEqualsDeclaration(node)) {
      registerBinding(scopeByNode.get(node), node.name, "other", node);
      return;
    }
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isClassDeclaration(node) ||
      ts.isEnumDeclaration(node) ||
      ts.isModuleDeclaration(node)
    ) {
      if (node.name) {
        registerBinding(
          scopeByNode.get(node.parent),
          node.name,
          "other",
          node,
        );
      }
      return;
    }
    if (ts.isFunctionExpression(node) && node.name) {
      registerBinding(scopeByNode.get(node), node.name, "other", node);
    }
  };
  const collectBindings = (node) => {
    registerDeclarationBindings(node);
    ts.forEachChild(node, collectBindings);
  };
  collectBindings(sourceFile);

  const lookupBinding = (identifier) => {
    let scope = scopeByNode.get(identifier);
    while (scope) {
      const bindings = scope.bindings.get(identifier.text);
      if (bindings) {
        return bindings.length === 1
          ? { binding: bindings[0], ambiguous: false }
          : { binding: undefined, bindings, ambiguous: true };
      }
      scope = scope.parent;
    }
    return undefined;
  };

  const markWriteTarget = (target) => {
    if (!target) return;
    const unwrapped = unwrapExpression(target);
    if (ts.isIdentifier(unwrapped)) {
      if (bindingIdentifierNodes.has(unwrapped)) return;
      const result = lookupBinding(unwrapped);
      if (!result) return;
      if (result.ambiguous) {
        for (const binding of result.bindings) binding.reassigned = true;
      } else {
        result.binding.reassigned = true;
      }
      return;
    }
    if (ts.isObjectLiteralExpression(unwrapped)) {
      for (const property of unwrapped.properties) {
        if (ts.isShorthandPropertyAssignment(property)) {
          markWriteTarget(property.name);
        } else if (ts.isPropertyAssignment(property)) {
          markWriteTarget(property.initializer);
        } else if (ts.isSpreadAssignment(property)) {
          markWriteTarget(property.expression);
        }
      }
      return;
    }
    if (ts.isArrayLiteralExpression(unwrapped)) {
      for (const element of unwrapped.elements) {
        if (!ts.isOmittedExpression(element)) markWriteTarget(element);
      }
      return;
    }
    if (ts.isObjectBindingPattern(unwrapped) || ts.isArrayBindingPattern(unwrapped)) {
      for (const element of unwrapped.elements) {
        if (ts.isBindingElement(element)) markWriteTarget(element.name);
      }
    }
  };

  const markWrites = (node) => {
    if (ts.isBinaryExpression(node) && ts.isAssignmentOperator(node.operatorToken.kind)) {
      markWriteTarget(node.left);
    }
    if (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) {
      if (
        node.operator === ts.SyntaxKind.PlusPlusToken ||
        node.operator === ts.SyntaxKind.MinusMinusToken
      ) {
        markWriteTarget(node.operand);
      }
    }
    if (ts.isForInStatement(node) || ts.isForOfStatement(node)) {
      if (!ts.isVariableDeclarationList(node.initializer)) {
        markWriteTarget(node.initializer);
      }
    }
    ts.forEachChild(node, markWrites);
  };
  markWrites(sourceFile);

  const resolveIdentifier = (identifier, seenBindings) => {
    const result = lookupBinding(identifier);
    if (
      !result ||
      result.ambiguous ||
      result.binding.kind !== "const" ||
      result.binding.reassigned ||
      !result.binding.declaration.initializer
    ) {
      return undefined;
    }
    if (seenBindings.has(result.binding)) return undefined;
    const nextSeenBindings = new Set(seenBindings);
    nextSeenBindings.add(result.binding);
    return foldStaticStringExpression(
      result.binding.declaration.initializer,
      resolveIdentifier,
      nextSeenBindings,
    );
  };

  const fold = (expression) =>
    foldStaticStringExpression(expression, resolveIdentifier, new Set());
  const invocationTaintResolver = createInvocationTaintResolver(
    sourceFile,
    lookupBinding,
    fold,
  );

  return {
    fold,
    isInvocationTainted(expression) {
      return invocationTaintResolver.isInvocationTainted(expression);
    },
    isReflectInvocationTainted(node) {
      return invocationTaintResolver.isReflectInvocationTainted(node);
    },
    isLocalCallTainted(node) {
      return invocationTaintResolver.isLocalCallTainted(node);
    },
  };
}

const INVOCATION_ALIAS_METHODS = new Set(["call", "apply", "bind"]);
const REFLECT_CAPABILITY_METHODS = new Set(["apply", "construct", "get"]);

function cleanInvocationValue(defined = true) {
  return {
    tainted: false,
    source: undefined,
    defined,
    capability: undefined,
    container: undefined,
    callables: new Set(),
    localCall: undefined,
    classConstructor: undefined,
    classConstructors: new Set(),
    accessor: undefined,
    accessors: new Set(),
  };
}

function taintedInvocationValue(source = "computed", defined = undefined) {
  return {
    tainted: true,
    source,
    defined,
    capability: undefined,
    container: undefined,
    callables: new Set(),
    localCall: undefined,
    classConstructor: undefined,
    classConstructors: new Set(),
    accessor: undefined,
    accessors: new Set(),
  };
}

function callableInvocationValue(node) {
  return {
    tainted: false,
    source: undefined,
    defined: true,
    capability: undefined,
    container: undefined,
    callables: new Set([node]),
    localCall: undefined,
    classConstructor: undefined,
    classConstructors: new Set(),
    accessor: undefined,
    accessors: new Set(),
  };
}

function getterInvocationValue(node) {
  return {
    tainted: false,
    source: undefined,
    defined: true,
    capability: undefined,
    container: undefined,
    callables: new Set(),
    localCall: undefined,
    classConstructor: undefined,
    classConstructors: new Set(),
    accessor: { kind: "get", node },
    accessors: new Set([{ kind: "get", node }]),
  };
}

function localCallableMethodValue(
  callables,
  method,
  thisArgument = undefined,
  boundArguments = undefined,
  thisValue = undefined,
  boundInvocation = undefined,
) {
  const callableSet = new Set(callables ?? []);
  return {
    tainted: false,
    source: undefined,
    defined: true,
    capability: undefined,
    container: undefined,
    callables: callableSet,
    localCall: {
      method,
      callables: callableSet,
      thisArgument,
      boundArguments,
      thisValue,
      boundInvocation,
    },
    classConstructor: undefined,
    classConstructors: new Set(),
    accessor: undefined,
    accessors: new Set(),
  };
}

function localBoundCallableValue(
  callables,
  thisArgument,
  boundArguments,
  thisValue = undefined,
  boundInvocation = undefined,
) {
  const callableSet = new Set(callables ?? []);
  return {
    tainted: false,
    source: undefined,
    defined: true,
    capability: undefined,
    container: undefined,
    callables: callableSet,
    localCall: {
      method: "bound",
      callables: callableSet,
      thisArgument,
      boundArguments: Array.isArray(boundArguments) ? boundArguments : [],
      thisValue,
      boundInvocation,
    },
    classConstructor: undefined,
    classConstructors: new Set(),
    accessor: undefined,
    accessors: new Set(),
  };
}

function reflectCapabilityValue(
  method,
  via = undefined,
  mode = undefined,
  boundArguments = undefined,
  ambiguous = false,
  boundCapability = undefined,
) {
  return {
    tainted: false,
    source: undefined,
    defined: true,
    capability: {
      kind: "reflect",
      method,
      via,
      mode,
      boundArguments,
      ambiguous,
      boundCapability,
    },
    container: undefined,
    callables: new Set(),
    localCall: undefined,
    classConstructor: undefined,
    classConstructors: new Set(),
    accessor: undefined,
    accessors: new Set(),
  };
}

function invocationArgumentListsEqual(left, right) {
  if (left === right) return true;
  if (!Array.isArray(left) || !Array.isArray(right)) return false;
  return (
    left.length === right.length &&
    left.every((argument, index) => argument === right[index])
  );
}

function reflectCapabilityMetadataEqual(left, right, seen = new WeakMap()) {
  if (left === right) return true;
  if (!left || !right) return false;
  if (
    left.kind !== right.kind ||
    left.method !== right.method ||
    left.via !== right.via ||
    left.mode !== right.mode ||
    left.ambiguous !== right.ambiguous ||
    !invocationArgumentListsEqual(left.boundArguments, right.boundArguments)
  ) {
    return false;
  }
  if (left.boundCapability === right.boundCapability) return true;
  if (!left.boundCapability || !right.boundCapability) return false;
  const seenRights = seen.get(left.boundCapability);
  if (seenRights?.has(right.boundCapability)) return true;
  if (seenRights) {
    seenRights.add(right.boundCapability);
  } else {
    seen.set(left.boundCapability, new WeakSet([right.boundCapability]));
  }
  return reflectCapabilityMetadataEqual(
    left.boundCapability,
    right.boundCapability,
    seen,
  );
}

function createInvocationContainer(kind) {
  return {
    kind,
    entries: new Map(),
    unknown: undefined,
    length: kind === "array" ? 0 : undefined,
    uncertain: false,
  };
}

function reflectGlobalValue() {
  const container = createInvocationContainer("object");
  for (const method of REFLECT_CAPABILITY_METHODS) {
    container.entries.set(method, reflectCapabilityValue(method));
  }
  return {
    tainted: false,
    defined: true,
    container,
    callables: new Set(),
    localCall: undefined,
    classConstructor: undefined,
    classConstructors: new Set(),
    accessor: undefined,
    accessors: new Set(),
  };
}

function invocationMetadataAlternatives(value, pluralKey, singularKey) {
  const alternatives = [];
  const seen = new Set();
  for (const metadata of value?.[pluralKey] ?? []) {
    const identity = metadata?.node ?? metadata;
    if (seen.has(identity)) continue;
    seen.add(identity);
    alternatives.push(metadata);
  }
  if (value?.[singularKey] !== undefined) {
    const metadata = value[singularKey];
    const identity = metadata?.node ?? metadata;
    if (!seen.has(identity)) alternatives.push(metadata);
  }
  return alternatives;
}

function invocationMetadataSetsEqual(
  left,
  right,
  pluralKey,
  singularKey,
) {
  const leftAlternatives = invocationMetadataAlternatives(
    left,
    pluralKey,
    singularKey,
  );
  const rightAlternatives = invocationMetadataAlternatives(
    right,
    pluralKey,
    singularKey,
  );
  if (leftAlternatives.length !== rightAlternatives.length) return false;
  const rightIdentities = new Set(
    rightAlternatives.map((metadata) => metadata?.node ?? metadata),
  );
  return leftAlternatives.every((metadata) =>
    rightIdentities.has(metadata?.node ?? metadata),
  );
}

function localCallMetadataEqual(left, right) {
  if (left === right) return true;
  if (!left || !right || left.method !== right.method) return false;
  if (left.thisArgument !== right.thisArgument) return false;
  if (
    left.thisValue !== undefined &&
    right.thisValue !== undefined &&
    left.thisValue !== right.thisValue
  ) {
    return false;
  }
  if (!invocationArgumentListsEqual(left.boundArguments, right.boundArguments)) {
    return false;
  }
  if (left.boundInvocation !== undefined || right.boundInvocation !== undefined) {
    if (
      left.boundInvocation === undefined ||
      right.boundInvocation === undefined ||
      !localCallMetadataEqual(left.boundInvocation, right.boundInvocation)
    ) {
      return false;
    }
  }
  const leftCallables = left.callables ?? new Set();
  const rightCallables = right.callables ?? new Set();
  return (
    leftCallables.size === rightCallables.size &&
    [...leftCallables].every((callable) => rightCallables.has(callable))
  );
}

function localCallMetadataAlternatives(value) {
  const alternatives = [];
  const addAlternative = (metadata) => {
    if (
      metadata !== undefined &&
      !alternatives.some((candidate) =>
        localCallMetadataEqual(candidate, metadata),
      )
    ) {
      alternatives.push(metadata);
    }
  };
  for (const metadata of value?.localCallAlternatives ?? []) {
    addAlternative(metadata);
  }
  addAlternative(value?.localCall);
  return alternatives;
}

function localCallMetadataSetsEqual(left, right) {
  const leftAlternatives = localCallMetadataAlternatives(left);
  const rightAlternatives = localCallMetadataAlternatives(right);
  return (
    leftAlternatives.length === rightAlternatives.length &&
    leftAlternatives.every((leftMetadata) =>
      rightAlternatives.some((rightMetadata) =>
        localCallMetadataEqual(leftMetadata, rightMetadata),
      ),
    )
  );
}

function mergeLocalCallMetadataAlternatives(left, right) {
  const alternatives = [];
  for (const metadata of [
    ...localCallMetadataAlternatives(left),
    ...localCallMetadataAlternatives(right),
  ]) {
    if (
      !alternatives.some((candidate) =>
        localCallMetadataEqual(candidate, metadata),
      )
    ) {
      alternatives.push(metadata);
    }
  }
  return alternatives;
}

function mergeLocalCallMetadata(left, right) {
  if (!left) return right;
  if (!right) return left;
  if (
    left.method !== right.method ||
    left.thisArgument !== right.thisArgument ||
    left.thisValue !== undefined &&
    right.thisValue !== undefined &&
    left.thisValue !== right.thisValue ||
    !invocationArgumentListsEqual(left.boundArguments, right.boundArguments)
  ) {
    return undefined;
  }
  if (left.boundInvocation !== undefined || right.boundInvocation !== undefined) {
    if (
      left.boundInvocation === undefined ||
      right.boundInvocation === undefined ||
      !localCallMetadataEqual(left.boundInvocation, right.boundInvocation)
    ) {
      return undefined;
    }
  }
  return {
    method: left.method,
    thisArgument: left.thisArgument,
    thisValue: left.thisValue ?? right.thisValue,
    boundArguments: left.boundArguments ?? right.boundArguments,
    boundInvocation: left.boundInvocation ?? right.boundInvocation,
    callables: new Set([
      ...(left.callables ?? []),
      ...(right.callables ?? []),
    ]),
  };
}

function mergeInvocationCapabilities(left, right) {
  if (!left) return right;
  if (!right) return left;
  const metadataMatches = reflectCapabilityMetadataEqual(left, right);
  const ambiguous = left.ambiguous === true || right.ambiguous === true;
  if (
    metadataMatches &&
    !ambiguous
  ) {
    return left;
  }
  if (left.kind === "reflect" && right.kind === "reflect") {
    return {
      kind: "reflect",
      method:
        left.method === right.method ? left.method : undefined,
      via: left.via === right.via ? left.via : undefined,
      mode: left.mode === right.mode ? left.mode : undefined,
      boundArguments: invocationArgumentListsEqual(
        left.boundArguments,
        right.boundArguments,
      )
        ? left.boundArguments
        : undefined,
      ambiguous: ambiguous || !metadataMatches,
      boundCapability: reflectCapabilityMetadataEqual(
        left.boundCapability,
        right.boundCapability,
      )
        ? left.boundCapability
        : undefined,
    };
  }
  return undefined;
}

function invocationContainerAlternatives(value) {
  if (!value) return [];
  if (value.containerAlternatives?.size) {
    return [...value.containerAlternatives];
  }
  return value.container ? [value.container] : [];
}

function invocationArrayIndex(key) {
  if (typeof key === "number") {
    return Number.isInteger(key) && key >= 0 && key <= 0xffffffff - 2
      ? key
      : undefined;
  }
  if (typeof key !== "string" || key.length === 0) return undefined;
  const numericKey = Number(key);
  if (
    !Number.isInteger(numericKey) ||
    numericKey < 0 ||
    numericKey > 0xffffffff - 2 ||
    String(numericKey) !== key
  ) {
    return undefined;
  }
  return numericKey;
}

function cloneInvocationContainer(container) {
  if (!container) return undefined;
  return {
    kind: container.kind,
    entries: new Map(container.entries),
    unknown: container.unknown,
    length: container.length,
    uncertain: container.uncertain,
  };
}

function mergeInvocationValues(left, right) {
  if (!left) return right ?? cleanInvocationValue();
  if (!right) return left;
  if (left === right) return left;
  const leftIsNeutral =
    left.defined === true &&
    !left.tainted &&
    !left.capability &&
    !left.container &&
    !left.callables?.size &&
    localCallMetadataAlternatives(left).length === 0 &&
    invocationMetadataAlternatives(
      left,
      "classConstructors",
      "classConstructor",
    ).length === 0 &&
    invocationMetadataAlternatives(left, "accessors", "accessor").length === 0;
  const rightIsNeutral =
    right.defined === true &&
    !right.tainted &&
    !right.capability &&
    !right.container &&
    !right.callables?.size &&
    localCallMetadataAlternatives(right).length === 0 &&
    invocationMetadataAlternatives(
      right,
      "classConstructors",
      "classConstructor",
    ).length === 0 &&
    invocationMetadataAlternatives(right, "accessors", "accessor").length === 0;
  const callables = new Set([
    ...(left.callables ?? []),
    ...(right.callables ?? []),
  ]);
  const classConstructors = new Set([
    ...invocationMetadataAlternatives(
      left,
      "classConstructors",
      "classConstructor",
    ),
    ...invocationMetadataAlternatives(
      right,
      "classConstructors",
      "classConstructor",
    ),
  ]);
  const accessors = new Set([
    ...invocationMetadataAlternatives(left, "accessors", "accessor"),
    ...invocationMetadataAlternatives(right, "accessors", "accessor"),
  ]);
  const classConstructor =
    classConstructors.size === 1 ? [...classConstructors][0] : undefined;
  const accessor = accessors.size === 1 ? [...accessors][0] : undefined;
  const localCallAlternatives = mergeLocalCallMetadataAlternatives(left, right);
  const mergedLocalCall = mergeLocalCallMetadata(left.localCall, right.localCall);
  const localCall =
    localCallAlternatives.length === 1
      ? mergedLocalCall ?? localCallAlternatives[0]
      : undefined;
  const localCallAlternativeSet =
    localCallAlternatives.length > 1
      ? new Set(localCallAlternatives)
      : undefined;
  if (leftIsNeutral) return right;
  if (rightIsNeutral) return left;
  if (left.container && left.container === right.container) {
    const alternatives = new Set([
      ...invocationContainerAlternatives(left),
      ...invocationContainerAlternatives(right),
    ]);
    return {
      tainted: left.tainted || right.tainted,
      source: left.tainted ? left.source : right.source,
      defined:
        left.defined === right.defined ? left.defined : undefined,
      capability: mergeInvocationCapabilities(
        left.capability,
        right.capability,
      ),
      container: left.container,
      callables,
      localCall,
      localCallAlternatives: localCallAlternativeSet,
      classConstructor,
      classConstructors,
      accessor,
      accessors,
      containerAlternatives:
        alternatives.size > 0 && !alternatives.has(left.container)
          ? alternatives
          : undefined,
    };
  }
  const leftContainer = left.container;
  const rightContainer = right.container;
  const alternatives = new Set([
    ...invocationContainerAlternatives(left),
    ...invocationContainerAlternatives(right),
  ]);
  let container;
  if (leftContainer || rightContainer) {
    container = createInvocationContainer(
      leftContainer?.kind ?? rightContainer?.kind ?? "object",
    );
    for (const [key, value] of leftContainer?.entries ?? []) {
      container.entries.set(key, value);
    }
    for (const [key, value] of rightContainer?.entries ?? []) {
      container.entries.set(
        key,
        mergeInvocationValues(container.entries.get(key), value),
      );
    }
    container.unknown = mergeInvocationValues(
      leftContainer?.unknown,
      rightContainer?.unknown,
    );
    if (!leftContainer?.unknown && !rightContainer?.unknown) {
      container.unknown = undefined;
    }
    container.length =
      leftContainer?.length === rightContainer?.length
        ? leftContainer?.length
        : undefined;
    container.uncertain =
      Boolean(leftContainer?.uncertain) || Boolean(rightContainer?.uncertain);
  }
  return {
    tainted: left.tainted || right.tainted,
    source: left.tainted ? left.source : right.source,
    defined: left.defined === right.defined ? left.defined : undefined,
    capability: mergeInvocationCapabilities(
      left.capability,
      right.capability,
    ),
    container,
    callables,
    localCall,
    localCallAlternatives: localCallAlternativeSet,
    classConstructor,
    classConstructors,
    accessor,
    accessors,
    containerAlternatives:
      alternatives.size > 0 && !alternatives.has(container)
        ? alternatives
        : undefined,
  };
}

function invocationValuesEqual(left, right, seen = new WeakMap()) {
  if (left === right) return true;
  if (
    !left ||
    !right ||
    left.tainted !== right.tainted ||
    left.source !== right.source ||
    left.defined !== right.defined ||
    !reflectCapabilityMetadataEqual(left.capability, right.capability) ||
    !localCallMetadataSetsEqual(left, right) ||
    !invocationMetadataSetsEqual(
      left,
      right,
      "classConstructors",
      "classConstructor",
    ) ||
    !invocationMetadataSetsEqual(left, right, "accessors", "accessor")
  ) {
    return false;
  }
  const leftCallables = left.callables ?? new Set();
  const rightCallables = right.callables ?? new Set();
  if (
    leftCallables.size !== rightCallables.size ||
    [...leftCallables].some((callable) => !rightCallables.has(callable))
  ) {
    return false;
  }
  const leftAlternatives = invocationContainerAlternatives(left);
  const rightAlternatives = invocationContainerAlternatives(right);
  if (
    leftAlternatives.length !== rightAlternatives.length ||
    leftAlternatives.some((container) => !rightAlternatives.includes(container))
  ) {
    return false;
  }
  if (left.container === right.container) return true;
  if (!left.container || !right.container) return false;
  if (left.container.kind !== right.container.kind) return false;
  if (
    left.container.length !== right.container.length ||
    left.container.uncertain !== right.container.uncertain
  ) {
    return false;
  }
  const seenRights = seen.get(left.container);
  if (seenRights?.has(right.container)) return true;
  if (seenRights) {
    seenRights.add(right.container);
  } else {
    seen.set(left.container, new WeakSet([right.container]));
  }
  if (
    !invocationValuesEqual(left.container.unknown, right.container.unknown, seen)
  ) {
    return false;
  }
  const keys = new Set([
    ...left.container.entries.keys(),
    ...right.container.entries.keys(),
  ]);
  for (const key of keys) {
    if (
      !invocationValuesEqual(
        left.container.entries.get(key),
        right.container.entries.get(key),
        seen,
      )
    ) {
      return false;
    }
  }
  return true;
}

function createInvocationTaintResolver(sourceFile, lookupBinding, foldStaticString) {
  const bindingValues = new Map();
  const literalContainers = new WeakMap();
  const classValues = new WeakMap();
  const LOCAL_THIS_KEY = Symbol("local-this");
  const globalReflectValue = reflectGlobalValue();
  const globalThisContainer = createInvocationContainer("object");
  const globalThisValue = {
    tainted: false,
    source: undefined,
    defined: true,
    capability: undefined,
    container: globalThisContainer,
    callables: new Set(),
    localCall: undefined,
    classConstructor: undefined,
    classConstructors: new Set(),
    accessor: undefined,
    accessors: new Set(),
  };
  const globalFunctionValue = taintedInvocationValue("global-function");
  const globalEvalValue = taintedInvocationValue("global-eval");
  globalThisContainer.entries.set("Reflect", globalReflectValue);
  globalThisContainer.entries.set("Function", globalFunctionValue);
  globalThisContainer.entries.set("eval", globalEvalValue);
  globalThisContainer.entries.set("undefined", cleanInvocationValue(false));
  globalThisContainer.entries.set("globalThis", globalThisValue);

  const functionLikeNodeForBinding = (binding) => {
    const declaration = binding?.declaration;
    if (!declaration) return undefined;
    if (
      ts.isFunctionDeclaration(declaration) ||
      ts.isFunctionExpression(declaration) ||
      ts.isArrowFunction(declaration) ||
      ts.isMethodDeclaration(declaration) ||
      ts.isGetAccessorDeclaration(declaration) ||
      ts.isSetAccessorDeclaration(declaration)
    ) {
      return declaration;
    }
    if (ts.isVariableDeclaration(declaration)) {
      const initializer = unwrapExpression(declaration.initializer);
      if (
        initializer &&
        (ts.isFunctionExpression(initializer) ||
          ts.isArrowFunction(initializer))
      ) {
        return initializer;
      }
    }
    return undefined;
  };

  const classNodeForBinding = (binding) => {
    const declaration = binding?.declaration;
    return declaration &&
      (ts.isClassDeclaration(declaration) || ts.isClassExpression(declaration))
      ? declaration
      : undefined;
  };

  const valueForBinding = (binding) => {
    const existing = bindingValues.get(binding);
    if (existing) return existing;
    const functionNode = functionLikeNodeForBinding(binding);
    if (functionNode) return callableInvocationValue(functionNode);
    const classNode = classNodeForBinding(binding);
    if (classNode) return classValueForNode(classNode);
    return cleanInvocationValue();
  };

  const assignBinding = (binding, value) => {
    if (!binding || !value) return false;
    const merged = mergeInvocationValues(valueForBinding(binding), value);
    if (invocationValuesEqual(valueForBinding(binding), merged)) return false;
    bindingValues.set(binding, merged);
    return true;
  };

  const assignIdentifier = (identifier, value) => {
    if (!identifier || !ts.isIdentifier(identifier)) return false;
    const result = lookupBinding(identifier);
    if (!result) return false;
    if (result.ambiguous) {
      return result.bindings.reduce(
        (changed, binding) => assignBinding(binding, value) || changed,
        false,
      );
    }
    return assignBinding(result.binding, value);
  };

  const staticPropertyKey = (expression) => {
    if (!expression) return undefined;
    if (ts.isComputedPropertyName(expression)) {
      return staticElementAccessKey(expression.expression);
    }
    if (ts.isIdentifier(expression)) return expression.text;
    if (
      ts.isStringLiteral(expression) ||
      ts.isNoSubstitutionTemplateLiteral(expression)
    ) {
      return expression.text;
    }
    if (ts.isNumericLiteral(expression)) return expression.text;
    return foldStaticString(expression);
  };

  const staticElementAccessKey = (expression) => {
    if (!expression) return undefined;
    if (
      ts.isStringLiteral(expression) ||
      ts.isNoSubstitutionTemplateLiteral(expression) ||
      ts.isNumericLiteral(expression)
    ) {
      return expression.text;
    }
    return foldStaticString(expression);
  };

  const propertyKeyForAccess = (node) => {
    if (ts.isPropertyAccessExpression(node)) return node.name.text;
    if (ts.isElementAccessExpression(node)) {
      return staticElementAccessKey(node.argumentExpression);
    }
    return undefined;
  };

  const isStaticClassMember = (member) =>
    member?.modifiers?.some(
      (modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword,
    ) ?? false;

  const classInstanceValueForClass = (
    classMetadata,
    environment = undefined,
    activeFunctions = new Set(),
    depth = 0,
  ) => {
    const container = cloneInvocationContainer(classMetadata.instanceContainer);
    const instanceValue = {
      tainted: false,
      source: undefined,
      defined: true,
      capability: undefined,
      container,
      callables: new Set(),
      localCall: undefined,
      classConstructor: undefined,
      classConstructors: new Set(),
      accessor: undefined,
      accessors: new Set(),
      instanceInitializers: classMetadata.instanceInitializers,
    };
    if (environment && classMetadata.instanceInitializers?.size) {
      const instanceEnvironment = new Map(environment);
      instanceEnvironment.set(LOCAL_THIS_KEY, instanceValue);
      for (const [key, initializer] of classMetadata.instanceInitializers) {
        const initializerResult = evaluateLocalExpression(
          initializer,
          instanceEnvironment,
          activeFunctions,
          depth + 1,
        );
        container.entries.set(key, initializerResult.returnValue);
      }
    }
    return instanceValue;
  };

  const classMetadataAlternatives = (value) =>
    invocationMetadataAlternatives(
      value,
      "classConstructors",
      "classConstructor",
    );

  const classInstanceValueForAlternatives = (
    classMetadataList,
    environment = undefined,
    activeFunctions = new Set(),
    depth = 0,
  ) => {
    let result;
    for (const classMetadata of classMetadataList ?? []) {
      result = mergeInvocationValues(
        result,
        classInstanceValueForClass(
          classMetadata,
          environment,
          activeFunctions,
          depth + 1,
        ),
      );
    }
    return result ?? cleanInvocationValue();
  };

  const classValueForNode = (classNode) => {
    const existing = classValues.get(classNode);
    if (existing) return existing;
    const staticContainer = createInvocationContainer("object");
    const instanceContainer = createInvocationContainer("object");
    const classMetadata = {
      node: classNode,
      constructorNode: classNode.members.find((member) =>
        ts.isConstructorDeclaration(member),
      ),
      instanceContainer,
      instanceInitializers: new Map(),
    };
    const classValue = {
      tainted: false,
      source: undefined,
      defined: true,
      capability: undefined,
      container: staticContainer,
      callables: new Set(),
      localCall: undefined,
      classConstructor: classMetadata,
      classConstructors: new Set([classMetadata]),
      accessor: undefined,
      accessors: new Set(),
    };
    classValues.set(classNode, classValue);
    const extendsClause = classNode.heritageClauses?.find(
      (clause) => clause.token === ts.SyntaxKind.ExtendsKeyword,
    );
    const baseExpression = extendsClause?.types[0]?.expression;
    if (baseExpression) {
      const baseValue = expressionValue(baseExpression);
      for (const baseMetadata of classMetadataAlternatives(baseValue)) {
        for (const [key, memberValue] of baseMetadata.instanceContainer.entries) {
          instanceContainer.entries.set(
            key,
            mergeInvocationValues(instanceContainer.entries.get(key), memberValue),
          );
        }
        for (const [key, initializer] of baseMetadata.instanceInitializers ?? []) {
          classMetadata.instanceInitializers.set(key, initializer);
        }
      }
    }
    for (const member of classNode.members) {
      if (ts.isConstructorDeclaration(member)) continue;
      const key = staticPropertyKey(member.name);
      const target = isStaticClassMember(member)
        ? staticContainer
        : instanceContainer;
      let memberValue;
      if (ts.isMethodDeclaration(member)) {
        memberValue = callableInvocationValue(member);
      } else if (ts.isGetAccessorDeclaration(member)) {
        memberValue = getterInvocationValue(member);
      } else if (ts.isSetAccessorDeclaration(member)) {
        continue;
      } else if (ts.isPropertyDeclaration(member)) {
        if (!isStaticClassMember(member) && member.initializer) {
          classMetadata.instanceInitializers.set(key, member.initializer);
          continue;
        }
        memberValue = member.initializer
          ? expressionValue(member.initializer)
          : cleanInvocationValue(false);
      } else {
        continue;
      }
      if (key === undefined) {
        target.unknown = mergeInvocationValues(target.unknown, memberValue);
      } else {
        target.entries.set(
          key,
          mergeInvocationValues(target.entries.get(key), memberValue),
        );
      }
    }
    return classValue;
  };

  const reflectCapabilityForAccess = (node) => {
    const receiver = unwrapExpression(node.expression);
    const key = propertyKeyForAccess(node);
    if (
      !receiver ||
      !ts.isIdentifier(receiver) ||
      receiver.text !== "Reflect" ||
      lookupBinding(receiver) ||
      !REFLECT_CAPABILITY_METHODS.has(key)
    ) {
      return undefined;
    }
    return reflectCapabilityValue(key);
  };

  const globalThisReflectForAccess = (node) => {
    const receiver = unwrapExpression(node.expression);
    const key = propertyKeyForAccess(node);
    if (
      !receiver ||
      !ts.isIdentifier(receiver) ||
      receiver.text !== "globalThis" ||
      lookupBinding(receiver) ||
      key !== "Reflect"
    ) {
      return undefined;
    }
    return globalReflectValue;
  };

  const unknownContainerValue = (value) => {
    if (!value) return cleanInvocationValue();
    const containers = invocationContainerAlternatives(value);
    if (value.tainted && containers.length === 0) {
      return taintedInvocationValue(value.source ?? "computed");
    }
    let result;
    for (const container of containers) {
      result = mergeInvocationValues(result, container.unknown);
      for (const entry of container.entries.values()) {
        result = mergeInvocationValues(result, entry);
      }
    }
    if (value.tainted) {
      result = mergeInvocationValues(
        result,
        taintedInvocationValue(value.source ?? "computed"),
      );
    }
    return result ?? cleanInvocationValue();
  };

  const readContainerProperty = (value, key) => {
    if (!value) return { found: false, value: cleanInvocationValue() };
    const containers = invocationContainerAlternatives(value);
    if (value.tainted && containers.length === 0) {
      return {
        found: true,
        value: taintedInvocationValue(value.source ?? "computed"),
      };
    }
    if (containers.length === 0) {
      return { found: false, value: cleanInvocationValue() };
    }
    let found = true;
    let selectedValue;
    for (const container of containers) {
      if (container.entries.has(key)) {
        selectedValue = mergeInvocationValues(
          selectedValue,
          mergeInvocationValues(
            container.entries.get(key),
            container.unknown,
          ),
        );
      } else if (container.unknown !== undefined) {
        found = false;
        selectedValue = mergeInvocationValues(
          selectedValue,
          container.unknown,
        );
      } else {
        found = false;
      }
    }
    if (selectedValue !== undefined) return { found, value: selectedValue };
    if (value.tainted) {
      return {
        found: true,
        value: taintedInvocationValue(value.source ?? "computed"),
      };
    }
    return {
      found: false,
      value: cleanInvocationValue(),
    };
  };

  const writeContainerProperty = (value, key, propertyValue) => {
    const container = value?.container ?? createInvocationContainer("object");
    const alternatives = invocationContainerAlternatives(value);
    const targets = new Set(alternatives);
    targets.add(container);
    for (const target of targets) {
      if (key === undefined) {
        target.unknown = mergeInvocationValues(
          target.unknown,
          propertyValue,
        );
        if (target.kind === "array") {
          target.length = undefined;
          target.uncertain = true;
        }
      } else {
        target.entries.set(
          key,
          mergeInvocationValues(target.entries.get(key), propertyValue),
        );
        const arrayIndex =
          target.kind === "array" ? invocationArrayIndex(key) : undefined;
        if (arrayIndex !== undefined && !target.uncertain) {
          target.length = Math.max(target.length ?? 0, arrayIndex + 1);
        }
      }
    }
    return {
      tainted: value?.tainted ?? false,
      source: value?.source,
      defined: value?.defined ?? true,
      capability: value?.capability,
      container,
      callables: new Set(value?.callables ?? []),
      localCall: value?.localCall,
      localCallAlternatives:
        value?.localCallAlternatives?.size > 0
          ? new Set(value.localCallAlternatives)
          : undefined,
      classConstructor: value?.classConstructor,
      classConstructors: new Set(
        invocationMetadataAlternatives(
          value,
          "classConstructors",
          "classConstructor",
        ),
      ),
      accessor: value?.accessor,
      accessors: new Set(
        invocationMetadataAlternatives(value, "accessors", "accessor"),
      ),
      containerAlternatives:
        value?.containerAlternatives?.size > 0
          ? value.containerAlternatives
          : undefined,
    };
  };

  const mergeContainer = (target, source, indexOffset = 0) => {
    if (!source) return target;
    if (source.tainted) {
      target.unknown = mergeInvocationValues(
        target.unknown,
        taintedInvocationValue(source.source ?? "computed"),
      );
    }
    for (const sourceContainer of invocationContainerAlternatives(source)) {
      for (const [key, value] of sourceContainer.entries) {
        const numericKey = invocationArrayIndex(key);
        const shiftedKey =
          target.kind === "array" &&
          sourceContainer.kind === "array" &&
          numericKey !== undefined
            ? String(numericKey + indexOffset)
            : key;
        target.entries.set(
          shiftedKey,
          mergeInvocationValues(target.entries.get(shiftedKey), value),
        );
      }
      if (sourceContainer.unknown !== undefined) {
        target.unknown = mergeInvocationValues(
          target.unknown,
          sourceContainer.unknown,
        );
      }
      target.uncertain ||= Boolean(sourceContainer.uncertain);
    }
    return target;
  };

  const knownArrayLength = (value) => {
    const containers = invocationContainerAlternatives(value);
    if (containers.length === 0) return undefined;
    let length;
    for (const container of containers) {
      if (
        container.kind !== "array" ||
        container.unknown ||
        container.uncertain
      ) {
        return undefined;
      }
      const currentLength = container.length ?? 0;
      if (length === undefined) {
        length = currentLength;
      } else if (length !== currentLength) {
        return undefined;
      }
    }
    return length;
  };

  const restContainerValue = (value, excludedKeys, arrayStart) => {
    if (!value) return cleanInvocationValue();
    if (value.tainted) {
      return taintedInvocationValue(value.source ?? "computed");
    }
    const sourceContainers = invocationContainerAlternatives(value);
    if (sourceContainers.length === 0) return cleanInvocationValue();
    const container = createInvocationContainer(sourceContainers[0].kind);
    const excluded = new Set(excludedKeys ?? []);
    for (const sourceContainer of sourceContainers) {
      for (const [key, entry] of sourceContainer.entries) {
        if (arrayStart !== undefined) {
          const numericKey = invocationArrayIndex(key);
          if (numericKey !== undefined && numericKey >= arrayStart) {
            const restKey = String(numericKey - arrayStart);
            container.entries.set(
              restKey,
              mergeInvocationValues(container.entries.get(restKey), entry),
            );
          }
          continue;
        }
        if (!excluded.has(key)) {
          container.entries.set(
            key,
            mergeInvocationValues(container.entries.get(key), entry),
          );
        }
      }
      if (sourceContainer.unknown !== undefined) {
        container.unknown = mergeInvocationValues(
          container.unknown,
          sourceContainer.unknown,
        );
      }
      container.uncertain ||= Boolean(sourceContainer.uncertain);
    }
    const lengths = sourceContainers.map((sourceContainer) =>
      sourceContainer.length === undefined
        ? undefined
        : arrayStart === undefined
          ? sourceContainer.length
          : Math.max(0, sourceContainer.length - arrayStart),
    );
    container.length =
      lengths.length > 0 &&
      lengths.every((length) => length !== undefined && length === lengths[0])
        ? lengths[0]
        : undefined;
    return {
      tainted: false,
      defined: true,
      container,
      callables: new Set(value.callables ?? []),
      localCall: value.localCall,
      localCallAlternatives:
        value.localCallAlternatives?.size > 0
          ? new Set(value.localCallAlternatives)
          : undefined,
      classConstructor: value.classConstructor,
      classConstructors: new Set(
        invocationMetadataAlternatives(
          value,
          "classConstructors",
          "classConstructor",
        ),
      ),
      accessor: value.accessor,
      accessors: new Set(
        invocationMetadataAlternatives(value, "accessors", "accessor"),
      ),
    };
  };

  const knownSpreadLength = (expression, value) => {
    const unwrapped = unwrapExpression(expression);
    if (
      ts.isStringLiteral(unwrapped) ||
      ts.isNoSubstitutionTemplateLiteral(unwrapped)
    ) {
      return Array.from(unwrapped.text).length;
    }
    const staticText = foldStaticString(unwrapped);
    if (staticText !== undefined) return Array.from(staticText).length;
    return knownArrayLength(value);
  };

  const reflectBoundArgument = (node, capability, index) => {
    if (capability.mode !== "bound") return node.arguments[index];
    if (!Array.isArray(capability.boundArguments)) return undefined;
    if (index < capability.boundArguments.length) {
      return capability.boundArguments[index];
    }
    return node.arguments[index - capability.boundArguments.length];
  };

  const reflectGetResult = (node, capability, seenBindings, depth) => {
    let receiverExpression;
    let keyExpression;
    if (capability.mode === "indirect") {
      if (capability.via === "call") {
        receiverExpression = node.arguments[1];
        keyExpression = node.arguments[2];
      } else if (capability.via === "apply") {
        return taintedInvocationValue("computed");
      }
    } else if (capability.mode === "bound") {
      receiverExpression = reflectBoundArgument(node, capability, 0);
      keyExpression = reflectBoundArgument(node, capability, 1);
    } else {
      receiverExpression = node.arguments[0];
      keyExpression = node.arguments[1];
    }
    const receiver = expressionValue(
      receiverExpression,
      seenBindings,
      depth + 1,
    );
    const key = staticElementAccessKey(keyExpression);
    if (receiver.tainted) {
      return taintedInvocationValue(receiver.source ?? "computed");
    }
    if (key === undefined) {
      return taintedInvocationValue("computed");
    }
    const selected = readContainerProperty(receiver, key);
    if (
      !selected.found &&
      invocationContainerAlternatives(receiver).length === 0 &&
      REQUIRED_DB_MUTATION_METHODS.has(key)
    ) {
      return taintedInvocationValue("sensitive");
    }
    return selected.value;
  };

  const expressionValue = (expression, seenBindings = new Set(), depth = 0) => {
    if (!expression) return cleanInvocationValue();
    if (depth > 24) return taintedInvocationValue("analysis-depth");
    const unwrapped = unwrapExpression(expression);
    if (!unwrapped) return cleanInvocationValue();
    if (unwrapped !== expression) {
      return expressionValue(unwrapped, seenBindings, depth + 1);
    }
    if (ts.isSatisfiesExpression(unwrapped)) {
      return expressionValue(unwrapped.expression, seenBindings, depth + 1);
    }
    if (
      ts.isFunctionDeclaration(unwrapped) ||
      ts.isFunctionExpression(unwrapped) ||
      ts.isArrowFunction(unwrapped) ||
      ts.isMethodDeclaration(unwrapped) ||
      ts.isGetAccessorDeclaration(unwrapped) ||
      ts.isSetAccessorDeclaration(unwrapped)
    ) {
      return callableInvocationValue(unwrapped);
    }
    if (ts.isClassDeclaration(unwrapped) || ts.isClassExpression(unwrapped)) {
      return classValueForNode(unwrapped);
    }
    if (ts.isVoidExpression(unwrapped)) {
      return cleanInvocationValue(false);
    }
    if (ts.isIdentifier(unwrapped)) {
      const result = lookupBinding(unwrapped);
      if (!result) {
        if (unwrapped.text === "Reflect") return globalReflectValue;
        if (unwrapped.text === "globalThis") return globalThisValue;
        if (unwrapped.text === "Function") return globalFunctionValue;
        if (unwrapped.text === "eval") return globalEvalValue;
        if (unwrapped.text === "undefined") return cleanInvocationValue(false);
        return cleanInvocationValue();
      }
      if (result.ambiguous) {
        let merged;
        for (const binding of result.bindings) {
          merged = mergeInvocationValues(merged, valueForBinding(binding));
        }
        return merged ?? cleanInvocationValue();
      }
      if (seenBindings.has(result.binding)) return cleanInvocationValue();
      const nextSeenBindings = new Set(seenBindings);
      nextSeenBindings.add(result.binding);
      return valueForBinding(result.binding);
    }
    if (ts.isElementAccessExpression(unwrapped)) {
      const reflectCapability =
        reflectCapabilityForAccess(unwrapped) ??
        globalThisReflectForAccess(unwrapped);
      if (reflectCapability) return reflectCapability;
      const receiver = expressionValue(
        unwrapped.expression,
        seenBindings,
        depth + 1,
      );
      const key = staticElementAccessKey(unwrapped.argumentExpression);
      if (key !== undefined && INVOCATION_ALIAS_METHODS.has(key)) {
        const receiverLocalCalls = localCallMetadataAlternatives(receiver);
        const localCallAlternatives =
          receiverLocalCalls.length > 0 ? receiverLocalCalls : [undefined];
        let callableValue;
        for (const localCall of localCallAlternatives) {
          const boundMetadata =
            localCall?.method === "bound" ? localCall : undefined;
          const boundInvocation =
            key === "bind" &&
            (localCall?.method === "call" || localCall?.method === "apply")
              ? localCall
              : undefined;
          callableValue = mergeInvocationValues(
            callableValue,
            localCallableMethodValue(
              receiver.callables,
              key,
              boundMetadata?.thisArgument,
              boundMetadata?.boundArguments,
              boundMetadata?.thisValue,
              boundInvocation,
            ),
          );
        }
        if (callableValue?.callables.size > 0) return callableValue;
      }
      if (
        key !== undefined &&
        receiver.capability?.kind === "reflect" &&
        INVOCATION_ALIAS_METHODS.has(key)
      ) {
        return reflectCapabilityValue(
          receiver.capability.method,
          key,
          key === "bind" ? "bind-factory" : "indirect",
          receiver.capability.boundArguments,
          receiver.capability.ambiguous,
          receiver.capability,
        );
      }
      if (key === undefined) {
        const selected = readContainerProperty(receiver, key);
        if (
          invocationContainerAlternatives(receiver).some(
            (container) => container.unknown !== undefined,
          )
        ) {
          return selected.value;
        }
        return taintedInvocationValue("computed");
      }
      if (receiver.tainted) {
        if (receiver.source === "analysis-depth") {
          return taintedInvocationValue("analysis-depth");
        }
        if (invocationContainerAlternatives(receiver).length > 0) {
          const selected = readContainerProperty(receiver, key);
          if (
            selected.found ||
            invocationContainerAlternatives(receiver).some(
              (container) => container.unknown !== undefined,
            )
          ) {
            return selected.value;
          }
        }
        return INVOCATION_ALIAS_METHODS.has(key)
          ? taintedInvocationValue(receiver.source ?? "computed")
          : receiver.source === "computed"
            ? cleanInvocationValue()
            : taintedInvocationValue(receiver.source ?? "computed");
      }
      const selected = readContainerProperty(receiver, key);
      if (!selected.found && !receiver.container && REQUIRED_DB_MUTATION_METHODS.has(key)) {
        return taintedInvocationValue("sensitive");
      }
      return selected.value;
    }
    if (ts.isPropertyAccessExpression(unwrapped)) {
      const reflectCapability =
        reflectCapabilityForAccess(unwrapped) ??
        globalThisReflectForAccess(unwrapped);
      if (reflectCapability) return reflectCapability;
      const receiver = expressionValue(
        unwrapped.expression,
        seenBindings,
        depth + 1,
      );
      if (
        receiver.capability?.kind === "reflect" &&
        INVOCATION_ALIAS_METHODS.has(unwrapped.name.text)
      ) {
        return reflectCapabilityValue(
          receiver.capability.method,
          unwrapped.name.text,
          unwrapped.name.text === "bind" ? "bind-factory" : "indirect",
          receiver.capability.boundArguments,
          receiver.capability.ambiguous,
          receiver.capability,
        );
      }
      if (INVOCATION_ALIAS_METHODS.has(unwrapped.name.text)) {
        const receiverLocalCalls = localCallMetadataAlternatives(receiver);
        const localCallAlternatives =
          receiverLocalCalls.length > 0 ? receiverLocalCalls : [undefined];
        let callableValue;
        for (const localCall of localCallAlternatives) {
          const boundMetadata =
            localCall?.method === "bound" ? localCall : undefined;
          const boundInvocation =
            unwrapped.name.text === "bind" &&
            (localCall?.method === "call" || localCall?.method === "apply")
              ? localCall
              : undefined;
          callableValue = mergeInvocationValues(
            callableValue,
            localCallableMethodValue(
              receiver.callables,
              unwrapped.name.text,
              boundMetadata?.thisArgument,
              boundMetadata?.boundArguments,
              boundMetadata?.thisValue,
              boundInvocation,
            ),
          );
        }
        if (callableValue?.callables.size > 0) return callableValue;
      }
      if (receiver.tainted) {
        if (receiver.source === "analysis-depth") {
          return taintedInvocationValue("analysis-depth");
        }
        if (invocationContainerAlternatives(receiver).length > 0) {
          const selected = readContainerProperty(receiver, unwrapped.name.text);
          if (
            selected.found ||
            invocationContainerAlternatives(receiver).some(
              (container) => container.unknown !== undefined,
            )
          ) {
            return selected.value;
          }
        }
        return INVOCATION_ALIAS_METHODS.has(unwrapped.name.text)
          ? taintedInvocationValue(receiver.source ?? "computed")
          : receiver.source === "computed"
            ? cleanInvocationValue()
            : taintedInvocationValue(receiver.source ?? "computed");
      }
      return readContainerProperty(receiver, unwrapped.name.text).value;
    }
    if (ts.isArrayLiteralExpression(unwrapped)) {
      const container =
        literalContainers.get(unwrapped) ?? createInvocationContainer("array");
      literalContainers.set(unwrapped, container);
      const evaluatedContainer = createInvocationContainer("array");
      let index = 0;
      let positionKnown = true;
      for (const element of unwrapped.elements) {
        if (ts.isOmittedExpression(element)) {
          index += 1;
          continue;
        }
        if (ts.isSpreadElement(element)) {
          const spreadValue = expressionValue(
            element.expression,
            seenBindings,
            depth + 1,
          );
          const spreadLength = knownSpreadLength(
            element.expression,
            spreadValue,
          );
          mergeContainer(evaluatedContainer, spreadValue, index);
          if (spreadLength === undefined) {
            positionKnown = false;
            evaluatedContainer.uncertain = true;
            evaluatedContainer.unknown = mergeInvocationValues(
              evaluatedContainer.unknown,
              unknownContainerValue(spreadValue),
            );
            index += 1;
          } else {
            index += spreadLength;
          }
          continue;
        }
        const elementValue = expressionValue(element, seenBindings, depth + 1);
        evaluatedContainer.entries.set(String(index), elementValue);
        if (!positionKnown) {
          evaluatedContainer.unknown = mergeInvocationValues(
            evaluatedContainer.unknown,
            elementValue,
          );
        }
        index += 1;
      }
      evaluatedContainer.length = positionKnown ? index : undefined;
      mergeContainer(
        container,
        { tainted: false, container: evaluatedContainer, callables: new Set() },
        0,
      );
      if (evaluatedContainer.uncertain || evaluatedContainer.length === undefined) {
        container.length = undefined;
        container.uncertain = true;
      } else if (!container.uncertain) {
        container.length = Math.max(container.length ?? 0, evaluatedContainer.length);
      }
      return {
        tainted: false,
        defined: true,
        container,
        callables: new Set(),
        localCall: undefined,
        classConstructor: undefined,
        accessor: undefined,
      };
    }
    if (ts.isObjectLiteralExpression(unwrapped)) {
      const container =
        literalContainers.get(unwrapped) ?? createInvocationContainer("object");
      literalContainers.set(unwrapped, container);
      const evaluatedContainer = createInvocationContainer("object");
      for (const property of unwrapped.properties) {
        if (ts.isSpreadAssignment(property)) {
          mergeContainer(
            evaluatedContainer,
            expressionValue(property.expression, seenBindings, depth + 1),
          );
          continue;
        }
        if (ts.isShorthandPropertyAssignment(property)) {
          evaluatedContainer.entries.set(
            property.name.text,
            expressionValue(property.name, seenBindings, depth + 1),
          );
          continue;
        }
        if (
          ts.isMethodDeclaration(property) ||
          ts.isGetAccessorDeclaration(property)
        ) {
          const key = staticPropertyKey(property.name);
          const propertyValue = ts.isGetAccessorDeclaration(property)
            ? getterInvocationValue(property)
            : callableInvocationValue(property);
          if (key === undefined) {
            evaluatedContainer.unknown = mergeInvocationValues(
              evaluatedContainer.unknown,
              propertyValue,
            );
          } else {
            evaluatedContainer.entries.set(
              key,
              mergeInvocationValues(
                evaluatedContainer.entries.get(key),
                propertyValue,
              ),
            );
          }
          continue;
        }
        if (ts.isSetAccessorDeclaration(property)) continue;
        if (ts.isPropertyAssignment(property)) {
          const key = staticPropertyKey(property.name);
          const propertyValue = expressionValue(
            property.initializer,
            seenBindings,
            depth + 1,
          );
          if (key === undefined) {
            evaluatedContainer.unknown = mergeInvocationValues(
              evaluatedContainer.unknown,
              propertyValue,
            );
          } else {
            evaluatedContainer.entries.set(
              key,
              mergeInvocationValues(
                evaluatedContainer.entries.get(key),
                propertyValue,
              ),
            );
          }
        }
      }
      mergeContainer(container, { tainted: false, container: evaluatedContainer });
      return {
        tainted: false,
        defined: true,
        container,
        callables: new Set(),
        localCall: undefined,
        classConstructor: undefined,
        accessor: undefined,
      };
    }
    if (ts.isConditionalExpression(unwrapped)) {
      return mergeInvocationValues(
        expressionValue(unwrapped.whenTrue, seenBindings, depth + 1),
        expressionValue(unwrapped.whenFalse, seenBindings, depth + 1),
      );
    }
    if (ts.isBinaryExpression(unwrapped)) {
      if (unwrapped.operatorToken.kind === ts.SyntaxKind.CommaToken) {
        return expressionValue(unwrapped.right, seenBindings, depth + 1);
      }
      if (ts.isAssignmentOperator(unwrapped.operatorToken.kind)) {
        return expressionValue(unwrapped.right, seenBindings, depth + 1);
      }
      if (
        unwrapped.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
        unwrapped.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
        unwrapped.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
      ) {
        return mergeInvocationValues(
          expressionValue(unwrapped.left, seenBindings, depth + 1),
          expressionValue(unwrapped.right, seenBindings, depth + 1),
        );
      }
      return cleanInvocationValue();
    }
    if (ts.isCallExpression(unwrapped)) {
      const calleeValue = expressionValue(
        unwrapped.expression,
        seenBindings,
        depth + 1,
      );
      if (
        calleeValue.capability?.kind === "reflect" &&
        calleeValue.capability.ambiguous
      ) {
        return taintedInvocationValue("reflect");
      }
      if (
        calleeValue.capability?.kind === "reflect" &&
        calleeValue.capability.mode === "bind-factory"
      ) {
        const boundCapability = calleeValue.capability.boundCapability;
        const isBoundCallWrapper =
          boundCapability?.mode === "indirect" &&
          boundCapability.via === "call";
        return reflectCapabilityValue(
          calleeValue.capability.method,
          "bind",
          "bound",
          isBoundCallWrapper
            ? boundCapability.boundArguments ?? []
            : unwrapped.arguments.slice(1),
          calleeValue.capability.ambiguous,
          boundCapability,
        );
      }
      if (
        calleeValue.capability?.kind === "reflect" &&
        calleeValue.capability.method === "get"
      ) {
        return reflectGetResult(
          unwrapped,
          calleeValue.capability,
          seenBindings,
          depth,
        );
      }
      const localCallAlternatives = localCallMetadataAlternatives(calleeValue);
      if (localCallAlternatives.length > 1) {
        let localResult;
        for (const localCall of localCallAlternatives) {
          if (localCall.method === "bind") {
            const hasExistingBound =
              localCall.boundArguments !== undefined ||
              localCall.thisValue !== undefined;
            const boundThis = hasExistingBound
              ? localCall.thisArgument
              : unwrapped.arguments[0];
            const boundArguments = [
              ...(localCall.boundArguments ?? []),
              ...unwrapped.arguments.slice(1),
            ];
            localResult = mergeInvocationValues(
              localResult,
              localBoundCallableValue(
                localCall.callables,
                boundThis,
                boundArguments,
                localCall.thisValue,
                localCall.boundInvocation
                  ? {
                      ...localCall.boundInvocation,
                      thisArgument:
                        unwrapped.arguments[0] ??
                        localCall.boundInvocation.thisArgument,
                      boundArguments: [
                        ...(localCall.boundInvocation.boundArguments ?? []),
                        ...unwrapped.arguments.slice(1),
                      ],
                      thisValue: localCall.thisValue,
                    }
                  : undefined,
              ),
            );
          } else if (
            localCall.method === "call" ||
            localCall.method === "apply" ||
            localCall.method === "bound"
          ) {
            localResult = mergeInvocationValues(
              localResult,
              cleanInvocationValue(),
            );
          }
        }
        if (localResult !== undefined) return localResult;
      }
      const localCall =
        calleeValue.localCall ??
        (localCallAlternatives.length === 1
          ? localCallAlternatives[0]
          : undefined);
      if (localCall?.method === "bind") {
        const hasExistingBound =
          localCall.boundArguments !== undefined ||
          localCall.thisValue !== undefined;
        const boundThis = hasExistingBound
          ? localCall.thisArgument
          : unwrapped.arguments[0];
        const boundArguments = [
          ...(localCall.boundArguments ?? []),
          ...unwrapped.arguments.slice(1),
        ];
        return localBoundCallableValue(
          localCall.callables,
          boundThis,
          boundArguments,
          localCall.thisValue,
          localCall.boundInvocation
            ? {
                ...localCall.boundInvocation,
                thisArgument:
                  unwrapped.arguments[0] ??
                  localCall.boundInvocation.thisArgument,
                boundArguments: [
                  ...(localCall.boundInvocation.boundArguments ?? []),
                  ...unwrapped.arguments.slice(1),
                ],
                thisValue: localCall.thisValue,
              }
            : undefined,
        );
      }
      if (
        localCall?.method === "call" ||
        localCall?.method === "apply" ||
        localCall?.method === "bound"
      ) {
        return cleanInvocationValue();
      }
      return isReflectInvocationTainted(unwrapped) ||
        isInvocationTainted(unwrapped.expression)
        ? taintedInvocationValue("invocation")
        : cleanInvocationValue();
    }
    if (ts.isNewExpression(unwrapped)) {
      const constructorValue = expressionValue(
        unwrapped.expression,
        seenBindings,
        depth + 1,
      );
      const classMetadata = classMetadataAlternatives(constructorValue);
      if (classMetadata.length > 0) {
        return classInstanceValueForAlternatives(classMetadata);
      }
      return cleanInvocationValue();
    }
    if (ts.isAwaitExpression(unwrapped) || ts.isYieldExpression(unwrapped)) {
      return expressionValue(unwrapped.expression, seenBindings, depth + 1);
    }
    if (ts.isSpreadElement(unwrapped)) {
      return expressionValue(unwrapped.expression, seenBindings, depth + 1);
    }
    return cleanInvocationValue();
  };

  const taintAssignmentTarget = (target) => {
    let current = unwrapExpression(target);
    while (
      current &&
      (ts.isPropertyAccessExpression(current) ||
        ts.isElementAccessExpression(current))
    ) {
      current = unwrapExpression(current.expression);
    }
    while (
      current &&
      ts.isBinaryExpression(current) &&
      ts.isAssignmentOperator(current.operatorToken.kind)
    ) {
      current = unwrapExpression(current.left);
    }
    if (current && ts.isIdentifier(current)) {
      return assignIdentifier(current, taintedInvocationValue("analysis-depth"));
    }
    if (
      current &&
      (ts.isObjectBindingPattern(current) || ts.isArrayBindingPattern(current))
    ) {
      let changed = false;
      collectBindingIdentifiers(current, (identifier) => {
        changed =
          assignIdentifier(identifier, taintedInvocationValue("analysis-depth")) ||
          changed;
      });
      return changed;
    }
    return false;
  };

  const bindingPatternValue = (pattern, value, depth = 0) => {
    if (!pattern) return false;
    if (depth > 24) return taintAssignmentTarget(pattern);
    if (ts.isIdentifier(pattern)) return assignIdentifier(pattern, value);
    if (ts.isObjectBindingPattern(pattern)) {
      const excludedKeys = [];
      let changed = false;
      for (const element of pattern.elements) {
        if (!ts.isBindingElement(element)) continue;
        if (element.dotDotDotToken) {
          changed =
            bindingPatternValue(
              element.name,
              restContainerValue(value, excludedKeys),
              depth + 1,
            ) || changed;
          continue;
        }
        const property = element.propertyName ?? element.name;
        const key = staticPropertyKey(property);
        if (key !== undefined) excludedKeys.push(key);
        const selected =
          key === undefined
            ? { found: false, value: unknownContainerValue(value) }
            : readContainerProperty(value, key);
        let selectedValue = selected.value;
        if (
          (!selected.found || selected.value.defined !== true) &&
          element.initializer
        ) {
          selectedValue = mergeInvocationValues(
            selectedValue,
            expressionValue(element.initializer),
          );
        }
        changed =
          bindingPatternValue(element.name, selectedValue, depth + 1) || changed;
      }
      return changed;
    }
    if (ts.isArrayBindingPattern(pattern)) {
      let changed = false;
      let index = 0;
      for (const element of pattern.elements) {
        if (ts.isOmittedExpression(element)) {
          index += 1;
          continue;
        }
        if (!ts.isBindingElement(element)) continue;
        if (element.dotDotDotToken) {
          changed =
            bindingPatternValue(
              element.name,
              restContainerValue(value, [], index),
              depth + 1,
            ) || changed;
          continue;
        }
        const selected = readContainerProperty(value, String(index));
        let selectedValue = selected.value;
        if (
          (!selected.found || selected.value.defined !== true) &&
          element.initializer
        ) {
          selectedValue = mergeInvocationValues(
            selectedValue,
            expressionValue(element.initializer),
          );
        }
        changed =
          bindingPatternValue(element.name, selectedValue, depth + 1) || changed;
        index += 1;
      }
      return changed;
    }
    return false;
  };

  const assignMemberTarget = (target, value, depth = 0) => {
    if (!target) return false;
    if (depth > 24) return taintAssignmentTarget(target);
    const receiver = unwrapExpression(target.expression);
    const key = propertyKeyForAccess(target);
    if (!receiver) return false;
    if (ts.isIdentifier(receiver)) {
      const result = lookupBinding(receiver);
      if (!result) return false;
      const bindings = result.ambiguous ? result.bindings : [result.binding];
      return bindings.reduce(
        (changed, binding) =>
          assignBinding(
            binding,
            writeContainerProperty(valueForBinding(binding), key, value),
          ) || changed,
        false,
      );
    }
    if (
      ts.isPropertyAccessExpression(receiver) ||
      ts.isElementAccessExpression(receiver)
    ) {
      const receiverValue = expressionValue(receiver);
      const updatedReceiver = writeContainerProperty(
        receiverValue,
        key,
        value,
      );
      return assignMemberTarget(receiver, updatedReceiver, depth + 1);
    }
    return false;
  };

  const assignTarget = (target, value, depth = 0) => {
    if (!target) return false;
    if (depth > 24) return taintAssignmentTarget(target);
    const unwrapped = unwrapExpression(target);
    if (ts.isIdentifier(unwrapped)) return assignIdentifier(unwrapped, value);
    if (
      ts.isBinaryExpression(unwrapped) &&
      ts.isAssignmentOperator(unwrapped.operatorToken.kind)
    ) {
      return assignTarget(unwrapped.left, value, depth + 1);
    }
    if (ts.isObjectBindingPattern(unwrapped) || ts.isArrayBindingPattern(unwrapped)) {
      return bindingPatternValue(unwrapped, value, depth + 1);
    }
    if (ts.isObjectLiteralExpression(unwrapped)) {
      let changed = false;
      const excludedKeys = [];
      for (const property of unwrapped.properties) {
        if (ts.isShorthandPropertyAssignment(property)) {
          const selected = readContainerProperty(value, property.name.text);
          let selectedValue = selected.value;
          if (
            (!selected.found || selected.value.defined !== true) &&
            property.objectAssignmentInitializer
          ) {
            selectedValue = mergeInvocationValues(
              selectedValue,
              expressionValue(property.objectAssignmentInitializer),
            );
          }
          changed = assignTarget(property.name, selectedValue, depth + 1) || changed;
          excludedKeys.push(property.name.text);
        } else if (ts.isPropertyAssignment(property)) {
          const key = staticPropertyKey(property.name);
          const selectedResult =
            key === undefined
              ? { found: false, value: unknownContainerValue(value) }
              : readContainerProperty(value, key);
          let selected = selectedResult.value;
          if (
            (!selectedResult.found || selectedResult.value.defined !== true) &&
            ts.isBinaryExpression(property.initializer) &&
            ts.isAssignmentOperator(property.initializer.operatorToken.kind)
          ) {
            selected = mergeInvocationValues(
              selected,
              expressionValue(property.initializer.right),
            );
          }
          changed = assignTarget(property.initializer, selected, depth + 1) || changed;
          if (key !== undefined) excludedKeys.push(key);
        } else if (ts.isSpreadAssignment(property)) {
          changed =
            assignTarget(
              property.expression,
              restContainerValue(value, excludedKeys),
              depth + 1,
            ) || changed;
        }
      }
      return changed;
    }
    if (ts.isArrayLiteralExpression(unwrapped)) {
      let changed = false;
      let index = 0;
      for (const element of unwrapped.elements) {
        if (ts.isOmittedExpression(element)) {
          index += 1;
          continue;
        }
        if (ts.isSpreadElement(element)) {
          changed = assignTarget(element.expression, restContainerValue(value, [], index), depth + 1) || changed;
          continue;
        }
        const selected = readContainerProperty(value, String(index));
        let selectedValue = selected.value;
        if (
          (!selected.found || selected.value.defined !== true) &&
          ts.isBinaryExpression(element) &&
          ts.isAssignmentOperator(element.operatorToken.kind)
        ) {
          selectedValue = mergeInvocationValues(
            selectedValue,
            expressionValue(element.right),
          );
        }
        changed =
          assignTarget(
            element,
            selectedValue,
            depth + 1,
          ) || changed;
        index += 1;
      }
      return changed;
    }
    if (
      ts.isPropertyAccessExpression(unwrapped) ||
      ts.isElementAccessExpression(unwrapped)
    ) {
      return assignMemberTarget(unwrapped, value);
    }
    return false;
  };

  const operations = [];
  const collectOperations = (node) => {
    if (ts.isVariableDeclaration(node) && node.initializer) {
      operations.push({ position: node.pos, target: node.name, value: node.initializer });
    }
    if (ts.isParameter(node) && node.initializer) {
      operations.push({ position: node.pos, target: node.name, value: node.initializer });
    }
    if (
      ts.isBinaryExpression(node) &&
      ts.isAssignmentOperator(node.operatorToken.kind)
    ) {
      operations.push({ position: node.pos, target: node.left, value: node.right });
    }
    if (ts.isForOfStatement(node) || ts.isForInStatement(node)) {
      if (!ts.isVariableDeclarationList(node.initializer)) {
        operations.push({
          position: node.pos,
          target: node.initializer,
          value: node.expression,
          iteration: true,
          forIn: ts.isForInStatement(node),
        });
      } else {
        for (const declaration of node.initializer.declarations) {
          operations.push({
            position: declaration.pos,
            target: declaration.name,
            value: node.expression,
            iteration: true,
            forIn: ts.isForInStatement(node),
          });
        }
      }
    }
    ts.forEachChild(node, collectOperations);
  };
  collectOperations(sourceFile);
  operations.sort((left, right) => left.position - right.position);

  const iterationValue = (value, isObjectKeys) => {
    if (isObjectKeys) return cleanInvocationValue();
    if (!value) return cleanInvocationValue();
    if (value.tainted) {
      return taintedInvocationValue(value.source ?? "computed");
    }
    const containers = invocationContainerAlternatives(value);
    if (containers.length === 0) return cleanInvocationValue();
    let result;
    for (const container of containers) {
      for (const entry of container.entries.values()) {
        result = mergeInvocationValues(result, entry);
      }
      result = mergeInvocationValues(result, container.unknown);
    }
    return result ?? cleanInvocationValue();
  };

  const isBoundReflectTargetTainted = (capability) => {
    if (
      capability?.kind !== "reflect" ||
      capability.mode !== "bound" ||
      (capability.method !== "apply" && capability.method !== "construct")
    ) {
      return false;
    }
    if (!Array.isArray(capability.boundArguments)) return true;
    if (capability.boundArguments.length === 0) return false;
    return expressionValue(capability.boundArguments[0]).tainted;
  };

  const isAmbiguousReflectCapability = (capability) =>
    capability?.kind === "reflect" && capability.ambiguous === true;

  const isInvocationTainted = (expression) => {
    const value = expressionValue(expression);
    return (
      value.tainted ||
      isBoundReflectTargetTainted(value.capability) ||
      isAmbiguousReflectCapability(value.capability) ||
      isReturnedLocalCapabilityTainted(expression)
    );
  };

  const isReflectInvocationTainted = (node) => {
    if (!ts.isCallExpression(node) || node.arguments.length === 0) return false;
    const callee = expressionValue(node.expression);
    if (callee.capability?.kind !== "reflect") return false;
    if (callee.capability.ambiguous === true) return true;
    if (callee.capability.method === undefined) return true;
    if (
      callee.capability.method !== "apply" &&
      callee.capability.method !== "construct"
    ) {
      return false;
    }
    const boundArguments = Array.isArray(callee.capability.boundArguments)
      ? callee.capability.boundArguments
      : [];
    let targetExpression = node.arguments[0];
    if (callee.capability.mode === "bound") {
      targetExpression =
        boundArguments[0] ?? node.arguments[0];
    } else if (
      callee.capability.mode === "indirect" &&
      callee.capability.via === "call"
    ) {
      targetExpression = boundArguments[0] ?? node.arguments[1];
    } else if (
      callee.capability.mode === "indirect" &&
      callee.capability.via === "apply"
    ) {
      const argumentsValue = expressionValue(node.arguments[1]);
      targetExpression = boundArguments[0];
      if (targetExpression === undefined) {
        targetExpression = readContainerProperty(argumentsValue, "0").value;
        return invocationValueIsTainted(targetExpression);
      }
    }
    return isInvocationTainted(targetExpression);
  };

  const reflectCallLayerCount = (capability) => {
    let count = 0;
    const seen = new Set();
    let current = capability;
    while (
      current?.kind === "reflect" &&
      current.via === "call" &&
      !seen.has(current)
    ) {
      seen.add(current);
      count += 1;
      current = current.boundCapability;
    }
    return count;
  };

  const LOCAL_CALL_MAX_DEPTH = 64;

  const bindingsForIdentifier = (identifier) => {
    if (!ts.isIdentifier(identifier)) return [];
    const result = lookupBinding(identifier);
    if (!result) return [];
    return result.ambiguous ? result.bindings : [result.binding];
  };

  const environmentValueForIdentifier = (identifier, environment) => {
    const bindings = bindingsForIdentifier(identifier);
    let found = false;
    let value;
    for (const binding of bindings) {
      if (!environment.has(binding)) continue;
      found = true;
      value = mergeInvocationValues(value, environment.get(binding));
    }
    return found ? { found: true, value } : { found: false, value: undefined };
  };

  const invocationValueIsTainted = (value) =>
    Boolean(
      value?.tainted ||
        isBoundReflectTargetTainted(value?.capability) ||
        isAmbiguousReflectCapability(value?.capability),
    );

  const cleanLocalResult = (returnValue = cleanInvocationValue()) => ({
    consumed: false,
    returnValue,
  });

  const boundedLocalResult = () => ({
    consumed: true,
    returnValue: taintedInvocationValue("local-depth"),
  });

  const mergeLocalResults = (left, right) => ({
    consumed: Boolean(left?.consumed) || Boolean(right?.consumed),
    returnValue:
      mergeInvocationValues(left?.returnValue, right?.returnValue) ??
      cleanInvocationValue(),
  });

  const localFunctionsForCallee = (
    callee,
    environment,
    activeFunctions,
    depth,
  ) => {
    const calleeResult = evaluateLocalExpression(
      callee,
      environment,
      activeFunctions,
      depth + 1,
    );
    const value = calleeResult.returnValue;
    const unwrapped = unwrapExpression(callee);
    let receiverValue;
    if (
      ts.isPropertyAccessExpression(unwrapped) ||
      ts.isElementAccessExpression(unwrapped)
    ) {
      receiverValue = evaluateLocalExpression(
        unwrapped.expression,
        environment,
        activeFunctions,
        depth + 1,
      ).returnValue;
    }
    const localCall = value?.localCall;
    const callableNodes = new Set(
      localCall?.callables?.size ? localCall.callables : value?.callables ?? [],
    );
    if (callableNodes.size > 0) {
      return [...callableNodes].map((node) => ({
        node,
        mode: localCall?.method ?? "direct",
        receiverValue:
          localCall?.method && localCall.method !== "direct"
            ? undefined
            : receiverValue,
        boundThis: localCall?.thisArgument,
        boundArguments: localCall?.boundArguments,
      }));
    }
    return classMetadataAlternatives(value)
      .filter((classMetadata) => classMetadata.constructorNode)
      .map((classMetadata) => ({
        node: classMetadata.constructorNode,
        mode: "construct",
        receiverValue: classInstanceValueForClass(classMetadata),
        boundThis: undefined,
        boundArguments: undefined,
      }));
  };

  function evaluateLocalExpression(expression, environment, activeFunctions, depth) {
    if (!expression) {
      return cleanLocalResult();
    }
    if (depth > LOCAL_CALL_MAX_DEPTH) return boundedLocalResult();
    const unwrapped = unwrapExpression(expression);
    if (!unwrapped) return cleanLocalResult();
    if (ts.isSatisfiesExpression(unwrapped)) {
      return evaluateLocalExpression(
        unwrapped.expression,
        environment,
        activeFunctions,
        depth + 1,
      );
    }
    if (unwrapped.kind === ts.SyntaxKind.ThisKeyword) {
      return cleanLocalResult(
        environment.get(LOCAL_THIS_KEY) ?? cleanInvocationValue(),
      );
    }
    if (ts.isIdentifier(unwrapped)) {
      const environmentValue = environmentValueForIdentifier(
        unwrapped,
        environment,
      );
      if (environmentValue.found) return cleanLocalResult(environmentValue.value);
      return cleanLocalResult(expressionValue(unwrapped));
    }
    if (ts.isCallExpression(unwrapped)) {
      const calleeResult = evaluateLocalExpression(
        unwrapped.expression,
        environment,
        activeFunctions,
        depth + 1,
      );
      const callee = unwrapExpression(unwrapped.expression);
      let taintedCallee = invocationValueIsTainted(calleeResult.returnValue);
      if (
        taintedCallee &&
        (ts.isPropertyAccessExpression(callee) ||
          ts.isElementAccessExpression(callee))
      ) {
        const receiverResult = evaluateLocalExpression(
          callee.expression,
          environment,
          activeFunctions,
          depth + 1,
        );
        const key = propertyKeyForAccess(callee);
        if (invocationValueIsTainted(receiverResult.returnValue)) {
          taintedCallee = key === "call" || key === "apply";
        }
      }
      const localResult = evaluateLocalCall(
        unwrapped,
        environment,
        activeFunctions,
        depth + 1,
      );
      const fallbackValue = expressionValue(unwrapped);
      if (localResult !== undefined) {
        return mergeLocalResults(
          {
          consumed:
              calleeResult.consumed ||
              taintedCallee,
            returnValue: fallbackValue,
          },
          localResult,
        );
      }
      return {
        consumed:
          calleeResult.consumed ||
          taintedCallee,
        returnValue: fallbackValue,
      };
    }
    if (ts.isConditionalExpression(unwrapped)) {
      return mergeLocalResults(
        evaluateLocalExpression(
          unwrapped.whenTrue,
          environment,
          activeFunctions,
          depth + 1,
        ),
        evaluateLocalExpression(
          unwrapped.whenFalse,
          environment,
          activeFunctions,
          depth + 1,
        ),
      );
    }
    if (ts.isBinaryExpression(unwrapped)) {
      if (unwrapped.operatorToken.kind === ts.SyntaxKind.CommaToken) {
        return mergeLocalResults(
          evaluateLocalExpression(
            unwrapped.left,
            environment,
            activeFunctions,
            depth + 1,
          ),
          evaluateLocalExpression(
            unwrapped.right,
            environment,
            activeFunctions,
            depth + 1,
          ),
        );
      }
      if (ts.isAssignmentOperator(unwrapped.operatorToken.kind)) {
        return evaluateLocalExpression(
          unwrapped.right,
          environment,
          activeFunctions,
          depth + 1,
        );
      }
      if (
        unwrapped.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
        unwrapped.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
        unwrapped.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
      ) {
        return mergeLocalResults(
          evaluateLocalExpression(
            unwrapped.left,
            environment,
            activeFunctions,
            depth + 1,
          ),
          evaluateLocalExpression(
            unwrapped.right,
            environment,
            activeFunctions,
            depth + 1,
          ),
        );
      }
    }
    if (
      ts.isPropertyAccessExpression(unwrapped) ||
      ts.isElementAccessExpression(unwrapped)
    ) {
      const receiver = evaluateLocalExpression(
        unwrapped.expression,
        environment,
        activeFunctions,
        depth + 1,
      );
      const key = propertyKeyForAccess(unwrapped);
      const selected =
        key === undefined
          ? { found: false, value: unknownContainerValue(receiver.returnValue) }
          : readContainerProperty(receiver.returnValue, key);
      if (key !== undefined && INVOCATION_ALIAS_METHODS.has(key)) {
        const receiverLocalCalls = localCallMetadataAlternatives(
          receiver.returnValue,
        );
        const localCallAlternatives =
          receiverLocalCalls.length > 0 ? receiverLocalCalls : [undefined];
        let callableValue;
        for (const localCall of localCallAlternatives) {
          const boundMetadata =
            localCall?.method === "bound" ? localCall : undefined;
          const boundInvocation =
            key === "bind" &&
            (localCall?.method === "call" || localCall?.method === "apply")
              ? localCall
              : undefined;
          callableValue = mergeInvocationValues(
            callableValue,
            localCallableMethodValue(
              receiver.returnValue.callables,
              key,
              boundMetadata?.thisArgument,
              boundMetadata?.boundArguments,
              boundMetadata?.thisValue,
              boundInvocation,
            ),
          );
        }
        if (callableValue?.callables.size > 0) {
          return {
            consumed: receiver.consumed,
            returnValue: callableValue,
          };
        }
      }
      const getterAlternatives = invocationMetadataAlternatives(
        selected.value,
        "accessors",
        "accessor",
      ).filter((accessor) => accessor.kind === "get");
      if (getterAlternatives.length > 0) {
        let getterResults = cleanLocalResult();
        for (const getter of getterAlternatives) {
          const getterResult = evaluateLocalFunction(
            getter.node,
            new Map([[LOCAL_THIS_KEY, receiver.returnValue]]),
            activeFunctions,
            depth + 1,
          );
          getterResults = mergeLocalResults(getterResults, getterResult);
        }
        return mergeLocalResults(
          { consumed: receiver.consumed, returnValue: cleanInvocationValue() },
          getterResults,
        );
      }
      const fallbackValue = expressionValue(unwrapped);
      return {
        consumed: receiver.consumed,
        returnValue:
          !selected.found &&
          !invocationContainerAlternatives(receiver.returnValue).some(
            (container) => container.unknown !== undefined,
          )
            ? fallbackValue
            : selected.value ?? fallbackValue,
      };
    }
    if (ts.isArrayLiteralExpression(unwrapped)) {
      const container = createInvocationContainer("array");
      let consumed = false;
      let index = 0;
      for (const element of unwrapped.elements) {
        if (ts.isOmittedExpression(element)) {
          index += 1;
          continue;
        }
        const elementResult = ts.isSpreadElement(element)
          ? evaluateLocalExpression(
              element.expression,
              environment,
              activeFunctions,
              depth + 1,
            )
          : evaluateLocalExpression(
              element,
              environment,
              activeFunctions,
              depth + 1,
            );
        consumed ||= elementResult.consumed;
        if (ts.isSpreadElement(element)) {
          mergeContainer(container, elementResult.returnValue, index);
          index += knownSpreadLength(element.expression, elementResult.returnValue) ?? 1;
        } else {
          container.entries.set(String(index), elementResult.returnValue);
          index += 1;
        }
      }
      container.length = index;
      return {
        consumed,
        returnValue: {
          tainted: false,
          defined: true,
          container,
          callables: new Set(),
          localCall: undefined,
          classConstructor: undefined,
          accessor: undefined,
        },
      };
    }
    if (ts.isObjectLiteralExpression(unwrapped)) {
      const container = createInvocationContainer("object");
      let consumed = false;
      for (const property of unwrapped.properties) {
        if (ts.isSpreadAssignment(property)) {
          const spreadResult = evaluateLocalExpression(
            property.expression,
            environment,
            activeFunctions,
            depth + 1,
          );
          consumed ||= spreadResult.consumed;
          mergeContainer(container, spreadResult.returnValue);
          continue;
        }
        if (ts.isShorthandPropertyAssignment(property)) {
          const shorthandResult = evaluateLocalExpression(
            property.name,
            environment,
            activeFunctions,
            depth + 1,
          );
          consumed ||= shorthandResult.consumed;
          container.entries.set(property.name.text, shorthandResult.returnValue);
          continue;
        }
        if (
          ts.isMethodDeclaration(property) ||
          ts.isGetAccessorDeclaration(property)
        ) {
          const key = staticPropertyKey(property.name);
          const methodValue = ts.isGetAccessorDeclaration(property)
            ? getterInvocationValue(property)
            : callableInvocationValue(property);
          if (key === undefined) {
            container.unknown = mergeInvocationValues(container.unknown, methodValue);
          } else {
            container.entries.set(
              key,
              mergeInvocationValues(container.entries.get(key), methodValue),
            );
          }
          continue;
        }
        if (ts.isSetAccessorDeclaration(property)) continue;
        if (ts.isPropertyAssignment(property)) {
          const propertyResult = evaluateLocalExpression(
            property.initializer,
            environment,
            activeFunctions,
            depth + 1,
          );
          consumed ||= propertyResult.consumed;
          const key = staticPropertyKey(property.name);
          if (key === undefined) {
            container.unknown = mergeInvocationValues(
              container.unknown,
              propertyResult.returnValue,
            );
          } else {
            container.entries.set(
              key,
              mergeInvocationValues(
                container.entries.get(key),
                propertyResult.returnValue,
              ),
            );
          }
        }
      }
      return {
        consumed,
        returnValue: {
          tainted: false,
          defined: true,
          container,
          callables: new Set(),
          localCall: undefined,
          classConstructor: undefined,
          accessor: undefined,
        },
      };
    }
    if (ts.isAwaitExpression(unwrapped) || ts.isYieldExpression(unwrapped)) {
      return evaluateLocalExpression(
        unwrapped.expression,
        environment,
        activeFunctions,
        depth + 1,
      );
    }
    if (ts.isSpreadElement(unwrapped)) {
      return evaluateLocalExpression(
        unwrapped.expression,
        environment,
        activeFunctions,
        depth + 1,
      );
    }
    if (ts.isNewExpression(unwrapped)) {
      const constructorResult = evaluateLocalExpression(
        unwrapped.expression,
        environment,
        activeFunctions,
        depth + 1,
      );
      const classMetadata = classMetadataAlternatives(
        constructorResult.returnValue,
      );
      if (classMetadata.length > 0) {
        const instanceValue = classInstanceValueForAlternatives(
          classMetadata,
          environment,
          activeFunctions,
          depth + 1,
        );
        const callResult = evaluateLocalCall(
          unwrapped,
          environment,
          activeFunctions,
          depth + 1,
        );
        return {
          consumed:
            constructorResult.consumed || Boolean(callResult?.consumed),
          returnValue: instanceValue,
        };
      }
    }
    return cleanLocalResult(expressionValue(unwrapped));
  }

  function bindLocalPattern(
    pattern,
    value,
    environment,
    activeFunctions,
    depth,
  ) {
    if (!pattern) return cleanLocalResult();
    if (depth > LOCAL_CALL_MAX_DEPTH) return boundedLocalResult();
    if (ts.isIdentifier(pattern)) {
      for (const binding of bindingsForIdentifier(pattern)) {
        environment.set(binding, value);
      }
      return cleanLocalResult();
    }
    if (ts.isObjectBindingPattern(pattern)) {
      const excludedKeys = [];
      let result = cleanLocalResult();
      for (const element of pattern.elements) {
        if (!ts.isBindingElement(element)) continue;
        if (element.dotDotDotToken) {
          result = mergeLocalResults(
            result,
            bindLocalPattern(
              element.name,
              restContainerValue(value, excludedKeys),
              environment,
              activeFunctions,
              depth + 1,
            ),
          );
          continue;
        }
        const property = element.propertyName ?? element.name;
        const key = staticPropertyKey(property);
        if (key !== undefined) excludedKeys.push(key);
        const selected =
          key === undefined
            ? { found: false, value: unknownContainerValue(value) }
            : readContainerProperty(value, key);
        let selectedValue = selected.value;
        if (
          (!selected.found || selectedValue.defined !== true) &&
          element.initializer
        ) {
          const defaultResult = evaluateLocalExpression(
            element.initializer,
            environment,
            activeFunctions,
            depth + 1,
          );
          result = mergeLocalResults(result, defaultResult);
          selectedValue = mergeInvocationValues(
            selectedValue,
            defaultResult.returnValue,
          );
        }
        result = mergeLocalResults(
          result,
          bindLocalPattern(
            element.name,
            selectedValue,
            environment,
            activeFunctions,
            depth + 1,
          ),
        );
      }
      return result;
    }
    if (ts.isArrayBindingPattern(pattern)) {
      let result = cleanLocalResult();
      let index = 0;
      for (const element of pattern.elements) {
        if (ts.isOmittedExpression(element)) {
          index += 1;
          continue;
        }
        if (!ts.isBindingElement(element)) continue;
        if (element.dotDotDotToken) {
          result = mergeLocalResults(
            result,
            bindLocalPattern(
              element.name,
              restContainerValue(value, [], index),
              environment,
              activeFunctions,
              depth + 1,
            ),
          );
          continue;
        }
        const selected = readContainerProperty(value, String(index));
        let selectedValue = selected.value;
        if (
          (!selected.found || selectedValue.defined !== true) &&
          element.initializer
        ) {
          const defaultResult = evaluateLocalExpression(
            element.initializer,
            environment,
            activeFunctions,
            depth + 1,
          );
          result = mergeLocalResults(result, defaultResult);
          selectedValue = mergeInvocationValues(
            selectedValue,
            defaultResult.returnValue,
          );
        }
        result = mergeLocalResults(
          result,
          bindLocalPattern(
            element.name,
            selectedValue,
            environment,
            activeFunctions,
            depth + 1,
          ),
        );
        index += 1;
      }
      return result;
    }
    if (ts.isObjectLiteralExpression(pattern)) {
      const excludedKeys = [];
      let result = cleanLocalResult();
      for (const property of pattern.properties) {
        if (ts.isSpreadAssignment(property)) {
          result = mergeLocalResults(
            result,
            bindLocalPattern(
              property.expression,
              restContainerValue(value, excludedKeys),
              environment,
              activeFunctions,
              depth + 1,
            ),
          );
          continue;
        }
        let key;
        let target;
        let defaultExpression;
        if (ts.isShorthandPropertyAssignment(property)) {
          key = property.name.text;
          target = property.name;
          defaultExpression = property.objectAssignmentInitializer;
        } else if (ts.isPropertyAssignment(property)) {
          key = staticPropertyKey(property.name);
          target = property.initializer;
          if (
            ts.isBinaryExpression(target) &&
            ts.isAssignmentOperator(target.operatorToken.kind)
          ) {
            defaultExpression = target.right;
            target = target.left;
          }
        }
        if (key !== undefined) excludedKeys.push(key);
        const selected =
          key === undefined
            ? { found: false, value: unknownContainerValue(value) }
            : readContainerProperty(value, key);
        let selectedValue = selected.value;
        if ((!selected.found || selectedValue.defined !== true) && defaultExpression) {
          const defaultResult = evaluateLocalExpression(
            defaultExpression,
            environment,
            activeFunctions,
            depth + 1,
          );
          result = mergeLocalResults(result, defaultResult);
          selectedValue = mergeInvocationValues(
            selectedValue,
            defaultResult.returnValue,
          );
        }
        if (target) {
          result = mergeLocalResults(
            result,
            bindLocalPattern(
              target,
              selectedValue,
              environment,
              activeFunctions,
              depth + 1,
            ),
          );
        }
      }
      return result;
    }
    if (ts.isArrayLiteralExpression(pattern)) {
      let result = cleanLocalResult();
      let index = 0;
      for (const element of pattern.elements) {
        if (ts.isOmittedExpression(element)) {
          index += 1;
          continue;
        }
        if (ts.isSpreadElement(element)) {
          result = mergeLocalResults(
            result,
            bindLocalPattern(
              element.expression,
              restContainerValue(value, [], index),
              environment,
              activeFunctions,
              depth + 1,
            ),
          );
          continue;
        }
        let target = element;
        let defaultExpression;
        if (
          ts.isBinaryExpression(target) &&
          ts.isAssignmentOperator(target.operatorToken.kind)
        ) {
          defaultExpression = target.right;
          target = target.left;
        }
        const selected = readContainerProperty(value, String(index));
        let selectedValue = selected.value;
        if ((!selected.found || selectedValue.defined !== true) && defaultExpression) {
          const defaultResult = evaluateLocalExpression(
            defaultExpression,
            environment,
            activeFunctions,
            depth + 1,
          );
          result = mergeLocalResults(result, defaultResult);
          selectedValue = mergeInvocationValues(
            selectedValue,
            defaultResult.returnValue,
          );
        }
        result = mergeLocalResults(
          result,
          bindLocalPattern(
            target,
            selectedValue,
            environment,
            activeFunctions,
            depth + 1,
          ),
        );
        index += 1;
      }
      return result;
    }
    return cleanLocalResult();
  }

  function evaluateLocalFunction(functionNode, environment, activeFunctions, depth) {
    if (!functionNode?.body) {
      return cleanLocalResult();
    }
    if (depth > LOCAL_CALL_MAX_DEPTH) return boundedLocalResult();
    const localEnvironment = new Map(environment);
    if (!ts.isBlock(functionNode.body)) {
      return evaluateLocalExpression(
        functionNode.body,
        localEnvironment,
        activeFunctions,
        depth + 1,
      );
    }
    let result = cleanLocalResult();
    const visitExecuted = (node) => {
      if (!node) return;
      if (node !== functionNode.body && isFunctionScopeNode(node)) return;
      if (ts.isVariableDeclaration(node) && node.initializer) {
        const valueResult = evaluateLocalExpression(
          node.initializer,
          localEnvironment,
          activeFunctions,
          depth + 1,
        );
        result = mergeLocalResults(result, valueResult);
        result = mergeLocalResults(
          result,
          bindLocalPattern(
            node.name,
            valueResult.returnValue,
            localEnvironment,
            activeFunctions,
            depth + 1,
          ),
        );
      }
      if (
        ts.isBinaryExpression(node) &&
        ts.isAssignmentOperator(node.operatorToken.kind)
      ) {
        const valueResult = evaluateLocalExpression(
          node.right,
          localEnvironment,
          activeFunctions,
          depth + 1,
        );
        result = mergeLocalResults(result, valueResult);
        result = mergeLocalResults(
          result,
          bindLocalPattern(
            node.left,
            valueResult.returnValue,
            localEnvironment,
            activeFunctions,
            depth + 1,
          ),
        );
      }
      if (ts.isReturnStatement(node)) {
        const returnResult = node.expression
          ? evaluateLocalExpression(
              node.expression,
              localEnvironment,
              activeFunctions,
              depth + 1,
            )
          : cleanLocalResult(cleanInvocationValue(false));
        result = mergeLocalResults(result, returnResult);
      } else if (ts.isCallExpression(node)) {
        const callResult = evaluateLocalExpression(
          node,
          localEnvironment,
          activeFunctions,
          depth + 1,
        );
        result = mergeLocalResults(result, {
          consumed: callResult.consumed,
          returnValue: callResult.returnValue,
        });
      }
      ts.forEachChild(node, visitExecuted);
    };
    visitExecuted(functionNode.body);
    return result;
  }

  const localFunctionInvokesParameter = (functionNode) => {
    if (!functionNode?.body) return false;
    const parameterBindings = new Set();
    for (const parameter of functionNode.parameters ?? []) {
      collectBindingIdentifiers(parameter.name, (identifier) => {
        const binding = lookupBinding(identifier);
        if (!binding?.ambiguous && binding?.binding) {
          parameterBindings.add(binding.binding);
        }
      });
    }
    if (parameterBindings.size === 0) return false;
    let found = false;
    const visit = (node) => {
      if (!node || found) return;
      if (node !== functionNode.body && isFunctionScopeNode(node)) return;
      if (ts.isCallExpression(node)) {
        const callee = unwrapExpression(node.expression);
        const calleeBinding = ts.isIdentifier(callee)
          ? lookupBinding(callee)
          : undefined;
        if (
          !calleeBinding?.ambiguous &&
          calleeBinding?.binding &&
          parameterBindings.has(calleeBinding.binding)
        ) {
          found = true;
          return;
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(functionNode.body);
    return found;
  };

  function evaluateLocalCall(
    node,
    environment,
    activeFunctions,
    depth,
    calleeValueOverride = undefined,
    calleeConsumedOverride = false,
  ) {
    if (!node) return undefined;
    const isConstructorCall = ts.isNewExpression(node);
    if (
      (!ts.isCallExpression(node) && !isConstructorCall) ||
      depth > LOCAL_CALL_MAX_DEPTH
    ) {
      if (depth > LOCAL_CALL_MAX_DEPTH) return boundedLocalResult();
      return undefined;
    }
    const calleeResult =
      calleeValueOverride === undefined
        ? evaluateLocalExpression(
            node.expression,
            environment,
            activeFunctions,
            depth + 1,
          )
        : {
            consumed: calleeConsumedOverride,
            returnValue: calleeValueOverride,
          };
    const calleeValue = calleeResult.returnValue;
    const localCallAlternatives = localCallMetadataAlternatives(calleeValue);
    if (
      calleeValueOverride === undefined &&
      localCallAlternatives.length > 1
    ) {
      let result;
      for (const localCallAlternative of localCallAlternatives) {
        result = mergeLocalResults(
          result,
          evaluateLocalCall(
            node,
            environment,
            activeFunctions,
            depth + 1,
            {
              ...calleeValue,
              localCall: localCallAlternative,
              localCallAlternatives: undefined,
            },
            calleeResult.consumed,
          ),
        );
      }
      return result ?? cleanLocalResult();
    }
    const localCall =
      calleeValue.localCall ??
      (localCallAlternatives.length === 1
        ? localCallAlternatives[0]
        : undefined);
    const capability = calleeValue.capability;
    let effectiveArgumentValues;
    let argumentResult = cleanLocalResult();
    let receiverValue;
    let candidates;
    let constructorReturnValue;

    const evaluateArgumentExpressions = (expressions) => {
      const values = [];
      let result = cleanLocalResult();
      for (const expression of expressions ?? []) {
        const current = evaluateLocalExpression(
          expression,
          environment,
          activeFunctions,
          depth + 1,
        );
        result = mergeLocalResults(result, current);
        values.push(current.returnValue);
      }
      return { values, result };
    };

    const argumentValuesFromContainer = (value) => {
      const length = knownArrayLength(value);
      if (length === undefined) {
        return [unknownContainerValue(value)];
      }
      return Array.from({ length }, (_, index) =>
        readContainerProperty(value, String(index)).value,
      );
    };

    const candidatesFromTarget = (
      targetExpression,
      mode,
      targetReceiver,
      targetValueOverride = undefined,
    ) => {
      const targetValue =
        targetValueOverride ??
        evaluateLocalExpression(
          targetExpression,
          environment,
          activeFunctions,
          depth + 1,
        ).returnValue;
      const targetUnwrapped = targetExpression
        ? unwrapExpression(targetExpression)
        : undefined;
      let directReceiver = targetReceiver;
      if (
        directReceiver === undefined &&
        (ts.isPropertyAccessExpression(targetUnwrapped) ||
          ts.isElementAccessExpression(targetUnwrapped))
      ) {
        directReceiver = evaluateLocalExpression(
          targetUnwrapped.expression,
          environment,
          activeFunctions,
          depth + 1,
        ).returnValue;
      }
      const targetCallables = new Set(
        targetValue?.localCall?.callables?.size
          ? targetValue.localCall.callables
          : targetValue?.callables ?? [],
      );
      if (targetCallables.size > 0) {
        return [...targetCallables].map((candidateNode) => ({
          node: candidateNode,
          mode,
          receiverValue: directReceiver,
          boundThis: undefined,
          boundArguments: undefined,
        }));
      }
      return classMetadataAlternatives(targetValue)
        .filter((classMetadata) => classMetadata.constructorNode)
        .map((classMetadata) => ({
          node: classMetadata.constructorNode,
          mode,
          receiverValue: classInstanceValueForClass(classMetadata),
          boundThis: undefined,
          boundArguments: undefined,
        }));
    };

    if (isConstructorCall) {
      const classMetadata = classMetadataAlternatives(calleeValue);
      if (!classMetadata.some((metadata) => metadata.constructorNode)) {
        return undefined;
      }
      const evaluatedArguments = evaluateArgumentExpressions(node.arguments);
      argumentResult = evaluatedArguments.result;
      effectiveArgumentValues = evaluatedArguments.values;
      constructorReturnValue = classInstanceValueForAlternatives(classMetadata);
      candidates = classMetadata
        .filter((metadata) => metadata.constructorNode)
        .map((metadata) => ({
          node: metadata.constructorNode,
          mode: "construct",
          receiverValue: classInstanceValueForClass(metadata),
          boundThis: undefined,
          boundArguments: undefined,
        }));
    } else if (capability?.kind === "reflect") {
      if (capability.ambiguous || !capability.method) return undefined;
      let targetExpression;
      let thisExpression;
      let argumentContainerExpression;
      let targetValueOverride;
      let thisValueOverride;
      let argumentContainerValueOverride;
      if (capability.mode === "bound") {
        const boundArguments = Array.isArray(capability.boundArguments)
          ? capability.boundArguments
          : [];
        targetExpression = boundArguments[0] ?? node.arguments[0];
        thisExpression = boundArguments[1] ?? node.arguments[1];
        argumentContainerExpression =
          boundArguments[2] ?? node.arguments[2];
      } else if (
        capability.mode === "indirect" &&
        capability.via === "call"
      ) {
        const callLayerCount = reflectCallLayerCount(capability);
        const outerReceiver = unwrapExpression(node.arguments[0]);
        const outerReceiverIsNullish =
          !outerReceiver ||
          outerReceiver.kind === ts.SyntaxKind.NullKeyword ||
          (ts.isIdentifier(outerReceiver) &&
            outerReceiver.text === "undefined" &&
            !lookupBinding(outerReceiver));
        if (callLayerCount > 1 && outerReceiverIsNullish) return undefined;
        const boundArguments = Array.isArray(capability.boundArguments)
          ? capability.boundArguments
          : [];
        const combinedArguments = [
          ...boundArguments,
          ...node.arguments.slice(callLayerCount > 1 ? callLayerCount : 1),
        ];
        targetExpression = combinedArguments[0];
        thisExpression = combinedArguments[1];
        argumentContainerExpression = combinedArguments[2];
      } else if (
        capability.mode === "indirect" &&
        capability.via === "apply"
      ) {
        const indirectArgumentResult = node.arguments[1]
          ? evaluateLocalExpression(
              node.arguments[1],
              environment,
              activeFunctions,
              depth + 1,
            )
          : cleanLocalResult();
        const indirectArguments = argumentValuesFromContainer(
          indirectArgumentResult.returnValue,
        );
        const boundArgumentResult = evaluateArgumentExpressions(
          Array.isArray(capability.boundArguments)
            ? capability.boundArguments
            : [],
        );
        const combinedArguments = [
          ...boundArgumentResult.values,
          ...indirectArguments,
        ];
        argumentResult = mergeLocalResults(
          mergeLocalResults(argumentResult, indirectArgumentResult),
          boundArgumentResult.result,
        );
        targetValueOverride = combinedArguments[0];
        thisValueOverride = combinedArguments[1];
        argumentContainerValueOverride = combinedArguments[2];
      } else {
        targetExpression = node.arguments[0];
        thisExpression = node.arguments[1];
        argumentContainerExpression = node.arguments[2];
      }
      if (capability.method === "construct") {
        thisExpression = undefined;
        argumentContainerExpression =
          capability.mode === "bound"
            ? capability.boundArguments?.[1] ?? node.arguments[1]
            : node.arguments[1];
      }
      const thisResult = thisExpression
        ? evaluateLocalExpression(
            thisExpression,
            environment,
            activeFunctions,
            depth + 1,
          )
        : cleanLocalResult();
      const argumentContainerResult = argumentContainerExpression
        ? evaluateLocalExpression(
            argumentContainerExpression,
            environment,
            activeFunctions,
            depth + 1,
          )
        : cleanLocalResult();
      if (thisValueOverride !== undefined) {
        argumentResult = mergeLocalResults(
          argumentResult,
          cleanLocalResult(thisValueOverride),
        );
      }
      if (argumentContainerValueOverride !== undefined) {
        argumentResult = mergeLocalResults(
          argumentResult,
          cleanLocalResult(argumentContainerValueOverride),
        );
      }
      argumentResult = mergeLocalResults(
        argumentResult,
        mergeLocalResults(thisResult, argumentContainerResult),
      );
      effectiveArgumentValues =
        argumentContainerValueOverride !== undefined
          ? argumentValuesFromContainer(argumentContainerValueOverride)
          : argumentValuesFromContainer(argumentContainerResult.returnValue);
      receiverValue =
        thisValueOverride !== undefined
          ? thisValueOverride
          : thisResult.returnValue;
      candidates = candidatesFromTarget(
        targetExpression,
        capability.method === "construct" ? "construct" : "reflect",
        receiverValue,
        targetValueOverride,
      );
    } else if (localCall?.method === "bind") {
      const hasExistingBound =
        localCall.boundArguments !== undefined ||
        localCall.thisValue !== undefined;
      const boundThis = hasExistingBound
        ? localCall.thisArgument
        : node.arguments[0];
      const boundArguments = [
        ...(localCall.boundArguments ?? []),
        ...node.arguments.slice(1),
      ];
      const boundResult = evaluateArgumentExpressions(boundArguments);
      const thisResult = boundThis
        ? evaluateLocalExpression(
            boundThis,
            environment,
            activeFunctions,
            depth + 1,
          )
        : cleanLocalResult();
      return {
        consumed: calleeResult.consumed || boundResult.result.consumed || thisResult.consumed,
        returnValue: localBoundCallableValue(
          localCall.callables,
          boundThis,
          boundArguments,
          thisResult.returnValue,
          localCall.boundInvocation
            ? {
                ...localCall.boundInvocation,
                thisArgument:
                  node.arguments[0] ?? localCall.boundInvocation.thisArgument,
                boundArguments: [
                  ...(localCall.boundInvocation.boundArguments ?? []),
                  ...node.arguments.slice(1),
                ],
                thisValue: thisResult.returnValue,
              }
            : undefined,
        ),
      };
    } else if (localCall?.method === "bound" && localCall.boundInvocation) {
      const boundInvocation = localCall.boundInvocation;
      const boundInvocationArguments = Array.isArray(
        boundInvocation.boundArguments,
      )
        ? boundInvocation.boundArguments
        : [];
      let thisExpression;
      let argumentExpressions;
      if (boundInvocation.method === "call") {
        thisExpression = boundInvocationArguments[0] ?? node.arguments[0];
        argumentExpressions =
          boundInvocationArguments.length > 0
            ? [
                ...boundInvocationArguments.slice(1),
                ...node.arguments,
              ]
            : node.arguments.slice(1);
      } else if (boundInvocation.method === "apply") {
        const combinedArguments = [
          ...boundInvocationArguments,
          ...node.arguments,
        ];
        thisExpression = combinedArguments[0];
        const argumentContainerExpression = combinedArguments[1];
        const thisResult = thisExpression
          ? evaluateLocalExpression(
              thisExpression,
              environment,
              activeFunctions,
              depth + 1,
            )
          : cleanLocalResult();
        const argumentContainerResult = argumentContainerExpression
          ? evaluateLocalExpression(
              argumentContainerExpression,
              environment,
              activeFunctions,
              depth + 1,
            )
          : cleanLocalResult();
        const boundTargetResult = boundInvocation.thisArgument
          ? evaluateLocalExpression(
              boundInvocation.thisArgument,
              environment,
              activeFunctions,
              depth + 1,
            )
          : cleanLocalResult();
        argumentResult = mergeLocalResults(
          mergeLocalResults(thisResult, argumentContainerResult),
          boundTargetResult,
        );
        effectiveArgumentValues = argumentValuesFromContainer(
          argumentContainerResult.returnValue,
        );
        receiverValue = thisResult.returnValue;
        candidates = boundInvocation.thisArgument
          ? candidatesFromTarget(
              boundInvocation.thisArgument,
              "apply",
              receiverValue,
              boundTargetResult.returnValue,
            )
          : [...(boundInvocation.callables ?? [])].map((candidateNode) => ({
              node: candidateNode,
              mode: "apply",
              receiverValue,
              boundThis: undefined,
              boundArguments: undefined,
            }));
      } else {
        argumentExpressions = node.arguments;
      }
      if (candidates === undefined) {
        const thisResult = thisExpression
          ? evaluateLocalExpression(
              thisExpression,
              environment,
              activeFunctions,
              depth + 1,
            )
          : cleanLocalResult();
        const boundReceiverResult = boundInvocation.thisArgument
          ? evaluateLocalExpression(
              boundInvocation.thisArgument,
              environment,
              activeFunctions,
              depth + 1,
            )
          : cleanLocalResult();
        const argumentResultForCall = evaluateArgumentExpressions(
          argumentExpressions ?? [],
        );
        argumentResult = mergeLocalResults(
          mergeLocalResults(thisResult, boundReceiverResult),
          argumentResultForCall.result,
        );
        effectiveArgumentValues = argumentResultForCall.values;
        receiverValue = thisResult.returnValue;
        candidates = boundInvocation.thisArgument
          ? candidatesFromTarget(
              boundInvocation.thisArgument,
              boundInvocation.method,
              receiverValue,
              boundReceiverResult.returnValue,
            )
          : [...(boundInvocation.callables ?? [])].map((candidateNode) => ({
              node: candidateNode,
              mode: boundInvocation.method,
              receiverValue,
              boundThis: undefined,
              boundArguments: undefined,
            }));
      }
      if (
        effectiveArgumentValues?.some((value) => invocationValueIsTainted(value)) &&
        candidates.some((candidate) =>
          localFunctionInvokesParameter(candidate.node),
        )
      ) {
        argumentResult.consumed = true;
      }
    } else {
      const mode = localCall?.method ?? "direct";
      let argumentExpressions = node.arguments;
      if (mode === "call") {
        const thisExpression = node.arguments[0];
        const thisResult = thisExpression
          ? evaluateLocalExpression(
              thisExpression,
              environment,
              activeFunctions,
              depth + 1,
            )
          : cleanLocalResult();
        const hasExistingBound =
          localCall.boundArguments !== undefined ||
          localCall.thisValue !== undefined;
        if (hasExistingBound) {
          const boundThisResult = localCall.thisValue
            ? cleanLocalResult(localCall.thisValue)
            : localCall.thisArgument
              ? evaluateLocalExpression(
                  localCall.thisArgument,
                  environment,
                  activeFunctions,
                  depth + 1,
                )
              : cleanLocalResult();
          const boundResult = evaluateArgumentExpressions(
            localCall.boundArguments ?? [],
          );
          const currentResult = evaluateArgumentExpressions(
            node.arguments.slice(1),
          );
          argumentResult = mergeLocalResults(
            mergeLocalResults(
              mergeLocalResults(argumentResult, thisResult),
              mergeLocalResults(boundThisResult, boundResult.result),
            ),
            currentResult.result,
          );
          receiverValue = boundThisResult.returnValue;
          effectiveArgumentValues = [
            ...boundResult.values,
            ...currentResult.values,
          ];
        } else {
          argumentResult = mergeLocalResults(argumentResult, thisResult);
          receiverValue = thisResult.returnValue;
          argumentExpressions = node.arguments.slice(1);
        }
      } else if (mode === "apply") {
        const thisExpression = node.arguments[0];
        const argumentContainerExpression = node.arguments[1];
        const thisResult = thisExpression
          ? evaluateLocalExpression(
              thisExpression,
              environment,
              activeFunctions,
              depth + 1,
            )
          : cleanLocalResult();
        const argumentContainerResult = argumentContainerExpression
          ? evaluateLocalExpression(
              argumentContainerExpression,
              environment,
              activeFunctions,
              depth + 1,
            )
          : cleanLocalResult();
        const hasExistingBound =
          localCall.boundArguments !== undefined ||
          localCall.thisValue !== undefined;
        if (hasExistingBound) {
          const boundThisResult = localCall.thisValue
            ? cleanLocalResult(localCall.thisValue)
            : localCall.thisArgument
              ? evaluateLocalExpression(
                  localCall.thisArgument,
                  environment,
                  activeFunctions,
                  depth + 1,
                )
              : cleanLocalResult();
          const boundResult = evaluateArgumentExpressions(
            localCall.boundArguments ?? [],
          );
          argumentResult = mergeLocalResults(
            mergeLocalResults(thisResult, argumentContainerResult),
            mergeLocalResults(boundThisResult, boundResult.result),
          );
          receiverValue = boundThisResult.returnValue;
          effectiveArgumentValues = [
            ...boundResult.values,
            ...argumentValuesFromContainer(argumentContainerResult.returnValue),
          ];
        } else {
          argumentResult = mergeLocalResults(thisResult, argumentContainerResult);
          receiverValue = thisResult.returnValue;
          effectiveArgumentValues = argumentValuesFromContainer(
            argumentContainerResult.returnValue,
          );
        }
      } else if (mode === "bound") {
        const boundThisResult = localCall.thisValue
          ? cleanLocalResult(localCall.thisValue)
          : localCall.thisArgument
            ? evaluateLocalExpression(
                localCall.thisArgument,
                environment,
                activeFunctions,
                depth + 1,
              )
            : cleanLocalResult();
        const boundResult = evaluateArgumentExpressions(
          localCall.boundArguments ?? [],
        );
        const currentResult = evaluateArgumentExpressions(node.arguments);
        argumentResult = mergeLocalResults(
          mergeLocalResults(boundThisResult, boundResult.result),
          currentResult.result,
        );
        receiverValue = boundThisResult.returnValue;
        effectiveArgumentValues = [
          ...boundResult.values,
          ...currentResult.values,
        ];
      }
      if (effectiveArgumentValues === undefined) {
        const evaluatedArguments = evaluateArgumentExpressions(argumentExpressions);
        argumentResult = mergeLocalResults(argumentResult, evaluatedArguments.result);
        effectiveArgumentValues = evaluatedArguments.values;
      }
      candidates = localFunctionsForCallee(
        node.expression,
        environment,
        activeFunctions,
        depth + 1,
      );
      if (receiverValue !== undefined) {
        candidates = candidates.map((candidate) => ({
          ...candidate,
          receiverValue,
        }));
      }
    }
    if (candidates.length === 0) return undefined;
    let result = cleanLocalResult();
    let evaluatedCandidate = false;
    for (const candidate of candidates) {
      if (activeFunctions.has(candidate.node)) continue;
      evaluatedCandidate = true;
      const nextActiveFunctions = new Set(activeFunctions);
      nextActiveFunctions.add(candidate.node);
      const localEnvironment = new Map(environment);
      localEnvironment.set(
        LOCAL_THIS_KEY,
        candidate.receiverValue ?? cleanInvocationValue(),
      );
      let argumentIndex = 0;
      for (const parameter of candidate.node.parameters) {
        let parameterValue;
        if (parameter.dotDotDotToken) {
          const argumentContainer = createInvocationContainer("array");
          let restIndex = 0;
          for (; argumentIndex < effectiveArgumentValues.length; argumentIndex += 1) {
            argumentContainer.entries.set(
              String(restIndex),
              effectiveArgumentValues[argumentIndex],
            );
            restIndex += 1;
          }
          argumentContainer.length = restIndex;
          parameterValue = {
            tainted: false,
            defined: true,
            container: argumentContainer,
            callables: new Set(),
            localCall: undefined,
            classConstructor: undefined,
            accessor: undefined,
          };
        } else {
          const argument = effectiveArgumentValues[argumentIndex];
          argumentIndex += 1;
          if (argument !== undefined) {
            parameterValue = argument;
          } else if (parameter.initializer) {
            const defaultResult = evaluateLocalExpression(
              parameter.initializer,
              localEnvironment,
              nextActiveFunctions,
              depth + 1,
            );
            argumentResult = mergeLocalResults(argumentResult, defaultResult);
            parameterValue = defaultResult.returnValue;
          } else {
            parameterValue = cleanInvocationValue(false);
          }
        }
        argumentResult = mergeLocalResults(
          argumentResult,
          bindLocalPattern(
            parameter.name,
            parameterValue,
            localEnvironment,
            nextActiveFunctions,
            depth + 1,
          ),
        );
      }
      const functionResult = evaluateLocalFunction(
        candidate.node,
        localEnvironment,
        nextActiveFunctions,
        depth + 1,
      );
      result = mergeLocalResults(result, argumentResult);
      result = mergeLocalResults(result, functionResult);
    }
    if (!evaluatedCandidate) return cleanLocalResult();
    if (isConstructorCall) {
      return {
        consumed: result.consumed,
        returnValue: constructorReturnValue ?? cleanInvocationValue(),
      };
    }
    return result;
  }

  const isLocalCallTainted = (node) => {
    const result = evaluateLocalCall(node, new Map(), new Set(), 0);
    return Boolean(result?.consumed);
  };

  const isReturnedLocalCapabilityTainted = (node) => {
    const result = evaluateLocalCall(node, new Map(), new Set(), 0);
    return invocationValueIsTainted(result?.returnValue);
  };

  const resolve = () => {
    const maxIterations = Math.max(8, operations.length + 4);
    for (let iteration = 0; iteration < maxIterations; iteration += 1) {
      let changed = false;
      for (const operation of operations) {
        const value = operation.iteration
          ? iterationValue(
              expressionValue(operation.value),
              operation.forIn,
            )
          : expressionValue(operation.value);
        changed = assignTarget(operation.target, value) || changed;
      }
      if (!changed) break;
    }
  };

  resolve();
  return {
    isInvocationTainted,
    isReflectInvocationTainted,
    isLocalCallTainted,
    isReturnedLocalCapabilityTainted,
  };
}

function foldStaticStringExpression(
  expression,
  resolveIdentifier = () => undefined,
  seenBindings = new Set(),
) {
  if (!expression) return undefined;
  if (
    ts.isStringLiteral(expression) ||
    ts.isNoSubstitutionTemplateLiteral(expression)
  ) {
    return expression.text;
  }
  if (ts.isParenthesizedExpression(expression)) {
    return foldStaticStringExpression(expression.expression, resolveIdentifier, seenBindings);
  }
  if (
    ts.isAsExpression(expression) ||
    ts.isTypeAssertionExpression(expression) ||
    ts.isNonNullExpression(expression)
  ) {
    return foldStaticStringExpression(expression.expression, resolveIdentifier, seenBindings);
  }
  if (ts.isSatisfiesExpression(expression)) {
    return foldStaticStringExpression(expression.expression, resolveIdentifier, seenBindings);
  }
  if (ts.isIdentifier(expression)) {
    return resolveIdentifier(expression, seenBindings);
  }
  if (
    ts.isBinaryExpression(expression) &&
    expression.operatorToken.kind === ts.SyntaxKind.PlusToken
  ) {
    const left = foldStaticStringExpression(expression.left, resolveIdentifier, seenBindings);
    const right = foldStaticStringExpression(expression.right, resolveIdentifier, seenBindings);
    return left === undefined || right === undefined ? undefined : left + right;
  }
  if (ts.isTemplateExpression(expression)) {
    let value = expression.head.text;
    for (const span of expression.templateSpans) {
      const expressionValue = foldStaticStringExpression(
        span.expression,
        resolveIdentifier,
        seenBindings,
      );
      if (expressionValue === undefined) return undefined;
      value += expressionValue + span.literal.text;
    }
    return value;
  }
  return undefined;
}

function readStaticLoaderSpecifier(expression) {
  if (
    ts.isStringLiteral(expression) ||
    ts.isNoSubstitutionTemplateLiteral(expression)
  ) {
    return expression.text;
  }
  return undefined;
}

function findRequiredImportDependencyRules(moduleSpecifier) {
  const contexts = [
    `from ${JSON.stringify(moduleSpecifier)}`,
    `import(${JSON.stringify(moduleSpecifier)})`,
    `require(${JSON.stringify(moduleSpecifier)})`,
  ];
  const matches = [];
  for (const ruleId of REQUIRED_INTERPRETER_DEPENDENCY_RULES) {
    if (ruleId === "non-literal-dynamic-import") continue;
    const patterns = REQUIRED_INTERPRETER_DEPENDENCY_PATTERNS[ruleId] ?? [];
    const matchesPattern = patterns.some((pattern) => {
      try {
        const expression = new RegExp(pattern);
        return contexts.some((context) => expression.test(context));
      } catch {
        return false;
      }
    });
    if (matchesPattern) matches.push(ruleId);
  }
  return matches;
}

function scanInterpreterSourceWithAst(file, source) {
  if (!INTERPRETER_AST_SOURCE_EXTENSIONS.test(file)) {
    return { findings: [], parseDiagnostics: [] };
  }
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.getScriptKindFromFileName(file),
  );
  const parseDiagnostics = sourceFile.parseDiagnostics ?? [];
  if (parseDiagnostics.length > 0) {
    return { findings: [], freshnessFindings: [], parseDiagnostics };
  }

  const findings = new Set();
  const freshnessFindings = new Set();
  const staticStringResolver = createStaticStringResolver(sourceFile);
  const addModuleFindings = (moduleSpecifier) => {
    for (const ruleId of findRequiredImportDependencyRules(moduleSpecifier)) {
      findings.add(ruleId);
    }
  };
  const addNormalizedIdentifierFindings = (identifier) => {
    for (const ruleId of REQUIRED_INTERPRETER_DEPENDENCY_RULES) {
      const patterns = REQUIRED_INTERPRETER_DEPENDENCY_PATTERNS[ruleId] ?? [];
      if (
        patterns.some((pattern) => {
          try {
            return new RegExp(pattern).test(identifier);
          } catch {
            return false;
          }
        })
      ) {
        findings.add(ruleId);
      }
    }
    for (const [ruleId, pattern] of Object.entries(
      REQUIRED_INTERPRETER_FRESHNESS_PATTERNS,
    )) {
      try {
        if (new RegExp(pattern).test(identifier)) {
          freshnessFindings.add(ruleId);
        }
      } catch {
        // The ratified patterns are compiled by contract validation. Keep the
        // AST scan fail-closed if a future pattern is malformed.
        freshnessFindings.add(ruleId);
      }
    }
  };
  const addStaticAuthorityKeyFindings = (expression) => {
    const key = staticStringResolver.fold(expression);
    if (key !== undefined) addNormalizedIdentifierFindings(key);
  };
  const visit = (node) => {
    if (ts.isIdentifier(node)) {
      // TypeScript resolves Unicode escapes in identifiers to their semantic
      // spelling (`typed\\u0057riter` -> `typedWriter`). Scanning the AST name
      // closes the raw-source regex bypass without treating strings/comments
      // as declarations or calls.
      addNormalizedIdentifierFindings(node.text);
    }
    if (ts.isImportDeclaration(node)) {
      if (ts.isStringLiteral(node.moduleSpecifier)) {
        addModuleFindings(node.moduleSpecifier.text);
      }
    }
    if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      addModuleFindings(node.moduleSpecifier.text);
    }
    if (ts.isComputedPropertyName(node)) {
      const parent = node.parent;
      if (
        ts.isPropertyAssignment(parent) ||
        ts.isMethodDeclaration(parent) ||
        ts.isGetAccessorDeclaration(parent) ||
        ts.isSetAccessorDeclaration(parent) ||
        ts.isPropertyDeclaration(parent)
      ) {
        addStaticAuthorityKeyFindings(node.expression);
      }
    }
    if (
      (ts.isPropertyAssignment(node) ||
        ts.isMethodDeclaration(node) ||
        ts.isGetAccessorDeclaration(node) ||
        ts.isSetAccessorDeclaration(node) ||
        ts.isPropertyDeclaration(node)) &&
      (ts.isStringLiteral(node.name) ||
        ts.isNoSubstitutionTemplateLiteral(node.name))
    ) {
      addStaticAuthorityKeyFindings(node.name);
    }
    if (ts.isPropertyAccessExpression(node)) {
      if (REQUIRED_DB_MUTATION_METHODS.has(node.name.text)) {
        findings.add("db-mutation");
      }
    }
    if (ts.isElementAccessExpression(node)) {
      addStaticAuthorityKeyFindings(node.argumentExpression);
      const method = staticStringResolver.fold(node.argumentExpression);
      if (method !== undefined && REQUIRED_DB_MUTATION_METHODS.has(method)) {
        findings.add("db-mutation");
      }
    }
    if (ts.isBindingElement(node)) {
      const propertyName = node.propertyName ?? node.name;
      let method;
      if (ts.isIdentifier(propertyName)) {
        method = propertyName.text;
      } else {
        const propertyExpression = ts.isComputedPropertyName(propertyName)
          ? propertyName.expression
          : propertyName;
        method = staticStringResolver.fold(propertyExpression);
      }
      if (
        (ts.isComputedPropertyName(propertyName) && method === undefined) ||
        (method !== undefined && REQUIRED_DB_MUTATION_METHODS.has(method))
      ) {
        findings.add("db-mutation");
      }
      if (method !== undefined) addNormalizedIdentifierFindings(method);
    }
    if (ts.isCallExpression(node)) {
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequireCall =
        ts.isIdentifier(node.expression) && node.expression.text === "require";
      if (isDynamicImport || isRequireCall) {
        const argument = node.arguments.length === 1 ? node.arguments[0] : undefined;
        const moduleSpecifier = readStaticLoaderSpecifier(argument);
        if (moduleSpecifier === undefined) {
          findings.add("non-literal-dynamic-import");
        } else {
          addModuleFindings(moduleSpecifier);
        }
      }
      const callee = unwrapExpression(node.expression);
      if (ts.isElementAccessExpression(callee)) {
        const method = staticStringResolver.fold(callee.argumentExpression);
        if (
          method === undefined ||
          REQUIRED_DB_MUTATION_METHODS.has(method)
        ) {
          findings.add("db-mutation");
        }
      }
      const invocationTainted = staticStringResolver.isInvocationTainted(
        node.expression,
      );
      const reflectTainted = staticStringResolver.isReflectInvocationTainted(
        node,
      );
      const localTainted = staticStringResolver.isLocalCallTainted(node);
      if (invocationTainted || reflectTainted || localTainted) {
        findings.add("db-mutation");
      }
    }
    if (ts.isNewExpression(node)) {
      const invocationTainted = staticStringResolver.isInvocationTainted(
        node.expression,
      );
      const localTainted = staticStringResolver.isLocalCallTainted(node);
      if (invocationTainted || localTainted) findings.add("db-mutation");
    }
    if (
      ts.isTaggedTemplateExpression(node) &&
      staticStringResolver.isInvocationTainted(node.tag)
    ) {
      findings.add("db-mutation");
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return {
    findings: [...findings],
    freshnessFindings: [...freshnessFindings],
    parseDiagnostics,
  };
}

export function validateInterpreterBoundary(repoRoot, contract, errors) {
  const boundary = contract?.interpreterBoundary;
  if (!isObject(boundary)) {
    errors.push("narrative Interpreter boundary must be an object");
    return;
  }
  const roots = Array.isArray(boundary.interpreterRoots)
    ? boundary.interpreterRoots
    : [];
  if (roots.length === 0) {
    errors.push("Interpreter boundary must declare interpreterRoots");
  } else if (!sameStringSet(roots, REQUIRED_INTERPRETER_BOUNDARY_ROOTS)) {
    errors.push(
      `Interpreter boundary roots must match ratified required roots: ${REQUIRED_INTERPRETER_BOUNDARY_ROOTS.join(", ")}`,
    );
  }
  if (!isObject(boundary.allowlist)) {
    errors.push("Interpreter boundary must declare an allowlist");
  }
  const allowlist = isObject(boundary.allowlist) ? boundary.allowlist : {};
  if (!Array.isArray(allowlist.files)) {
    errors.push("Interpreter boundary allowlist.files must be an array");
  }
  if (!Array.isArray(allowlist.imports)) {
    errors.push("Interpreter boundary allowlist.imports must be an array");
  }
  if (!sameStringSet(allowlist.files, REQUIRED_INTERPRETER_ALLOWLIST_FILES)) {
    errors.push(
      `Interpreter allowlist files do not match ratified Interpreter allowlist files: ${REQUIRED_INTERPRETER_ALLOWLIST_FILES.join(", ") || "(none)"}`,
    );
  }
  if (!sameAllowlistImports(allowlist.imports, REQUIRED_INTERPRETER_ALLOWLIST_IMPORTS)) {
    errors.push(
      `Interpreter allowlist imports do not match ratified Interpreter allowlist import entries: ${REQUIRED_INTERPRETER_ALLOWLIST_IMPORTS.map((entry) => entry.id).join(", ")}`,
    );
  }
  const allowlistedFiles = new Set(
    Array.isArray(allowlist.files)
      ? allowlist.files.filter(isNonEmptyString)
      : [],
  );
  const allowlistedImports = Array.isArray(allowlist.imports)
    ? allowlist.imports
    : [];
  if (!Array.isArray(boundary.forbiddenDependencies) || boundary.forbiddenDependencies.length === 0) {
    errors.push("Interpreter boundary must declare forbidden dependencies");
  }
  if (
    !Array.isArray(boundary.forbiddenFreshnessAuthorityPatterns) ||
    boundary.forbiddenFreshnessAuthorityPatterns.length === 0
  ) {
    errors.push("Interpreter boundary must declare freshness authority patterns");
  }
  for (const relativeFile of allowlistedFiles) {
    if (path.isAbsolute(relativeFile) || relativeFile.split(/[\\/]/).includes("..")) {
      errors.push(`Interpreter boundary allowlist file must be repository-relative: ${relativeFile}`);
    } else if (!existsSync(path.join(repoRoot, relativeFile))) {
      errors.push(`Interpreter boundary allowlist file is missing: ${relativeFile}`);
    }
  }
  for (const [index, entry] of allowlistedImports.entries()) {
    if (!isObject(entry) || !isNonEmptyString(entry.id) || !isNonEmptyString(entry.pattern)) {
      errors.push(`Interpreter boundary allowlist import ${index} must declare id and pattern`);
      continue;
    }
    if (!new Set(["type-only", "exact-file"]).has(entry.mode)) {
      errors.push(`Interpreter boundary allowlist import ${entry.id} has unknown mode: ${String(entry.mode)}`);
    }
    try {
      new RegExp(entry.pattern);
    } catch (error) {
      errors.push(
        `Interpreter boundary allowlist import ${entry.id} has invalid pattern: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const dependencyRules = Array.isArray(boundary.forbiddenDependencies)
    ? boundary.forbiddenDependencies
    : [];
  const freshnessRules = Array.isArray(boundary.forbiddenFreshnessAuthorityPatterns)
    ? boundary.forbiddenFreshnessAuthorityPatterns
    : [];
  const dependencyRuleIds = new Set();
  for (const rule of dependencyRules) {
    validateRegexRule(rule, `Interpreter forbidden dependency rule ${rule?.id ?? "unknown"}`, errors);
    if (isNonEmptyString(rule?.id)) {
      if (dependencyRuleIds.has(rule.id)) {
        errors.push(`Interpreter boundary duplicates forbidden dependency rule: ${rule.id}`);
      }
      dependencyRuleIds.add(rule.id);
    }
  }
  for (const requiredRule of REQUIRED_INTERPRETER_DEPENDENCY_RULES) {
    if (!dependencyRuleIds.has(requiredRule)) {
      errors.push(`Interpreter boundary is missing forbidden dependency rule: ${requiredRule}`);
      continue;
    }
    const rule = dependencyRules.find((candidate) => candidate?.id === requiredRule);
    const requiredPatterns = REQUIRED_INTERPRETER_DEPENDENCY_PATTERNS[requiredRule];
    if (!sameStringSet(rule?.patterns, requiredPatterns)) {
      errors.push(
        `Interpreter boundary ratified forbidden dependency patterns do not match: ${requiredRule}`,
      );
    }
  }
  const freshnessRuleIds = new Set();
  for (const rule of freshnessRules) {
    validateRegexRule(rule, `Interpreter Freshness authority rule ${rule?.id ?? "unknown"}`, errors);
    if (isNonEmptyString(rule?.id)) {
      if (freshnessRuleIds.has(rule.id)) {
        errors.push(`Interpreter boundary duplicates Freshness authority rule: ${rule.id}`);
      }
      freshnessRuleIds.add(rule.id);
    }
  }
  for (const requiredRule of REQUIRED_FRESHNESS_AUTHORITY_RULES) {
    if (!freshnessRuleIds.has(requiredRule)) {
      errors.push(`Interpreter boundary is missing freshness authority rule: ${requiredRule}`);
      continue;
    }
    const rule = freshnessRules.find((candidate) => candidate?.id === requiredRule);
    if (rule?.pattern !== REQUIRED_INTERPRETER_FRESHNESS_PATTERNS[requiredRule]) {
      errors.push(
        `Interpreter boundary ratified Freshness authority pattern does not match: ${requiredRule}`,
      );
    }
  }
  const boundaryFixtures = Array.isArray(boundary.fixtures)
    ? boundary.fixtures
    : [];
  if (boundaryFixtures.length === 0) {
    errors.push("Interpreter boundary must declare fixtures");
  }
  for (const fixture of boundaryFixtures) {
    if (!isNonEmptyString(fixture) || path.isAbsolute(fixture)) {
      errors.push(`Interpreter boundary fixture must be repository-relative: ${String(fixture)}`);
    } else if (!existsSync(path.join(repoRoot, fixture))) {
      errors.push(`Interpreter boundary fixture is missing: ${fixture}`);
    }
  }

  const compiledDependencies = dependencyRules.flatMap((rule) =>
    (Array.isArray(rule?.patterns) ? rule.patterns : []).flatMap((pattern) => {
      try {
        return [{id: rule.id, expression: new RegExp(pattern)}];
      } catch {
        return [];
      }
    }),
  );
  const compiledFreshness = freshnessRules.flatMap((rule) => {
    try {
      return [{id: rule.id, expression: new RegExp(rule.pattern)}];
    } catch {
      return [];
    }
  });
  for (const root of roots) {
    if (!isNonEmptyString(root) || path.isAbsolute(root)) {
      errors.push(`Interpreter boundary root must be repository-relative: ${String(root)}`);
      continue;
    }
    if (root.split(/[\\/]/).includes("..")) {
      errors.push(`Interpreter boundary root escapes repository: ${root}`);
      continue;
    }
    const absoluteRoot = path.resolve(repoRoot, root);
    const relativeRoot = path.relative(repoRoot, absoluteRoot);
    if (
      relativeRoot.startsWith("..") ||
      path.isAbsolute(relativeRoot) ||
      !existsSync(absoluteRoot)
    ) {
      errors.push(`Interpreter boundary root is missing: ${root}`);
      continue;
    }
    for (const file of listProductionSourceFiles(repoRoot, root)) {
      const relativeFile = path.relative(repoRoot, file).replaceAll("\\", "/");
      const source = readFileSync(file, "utf8");
      const dependencySource = allowlistedSourcePath(
        repoRoot,
        file,
        allowlistedFiles,
      )
        ? ""
        : removeAllowlistedTypeOnlyImports(source, allowlistedImports);
      const astScan = scanInterpreterSourceWithAst(
        file,
        dependencySource,
      );
      if (astScan.parseDiagnostics.length > 0) {
        const diagnostics = astScan.parseDiagnostics
          .slice(0, 3)
          .map((diagnostic) =>
            ts.flattenDiagnosticMessageText(diagnostic.messageText, " "),
          )
          .join("; ");
        errors.push(
          `Interpreter boundary AST parse diagnostics in ${relativeFile}: ${diagnostics}`,
        );
      }
      for (const ruleId of astScan.findings) {
        errors.push(
          `Interpreter boundary forbidden dependency '${ruleId}' in ${relativeFile}`,
        );
      }
      for (const ruleId of astScan.freshnessFindings ?? []) {
        errors.push(
          `Interpreter boundary detected unauthorized Freshness authority '${ruleId}' in ${relativeFile}`,
        );
      }
      for (const rule of compiledDependencies) {
        if (rule.expression.test(dependencySource)) {
          errors.push(
            `Interpreter boundary forbidden dependency '${rule.id}' in ${relativeFile}`,
          );
        }
      }
      for (const rule of compiledFreshness) {
        if (rule.expression.test(source)) {
          errors.push(
            `Interpreter boundary detected unauthorized Freshness authority '${rule.id}' in ${relativeFile}`,
          );
        }
      }
    }
  }
}

function validateDisclosurePolicy(policy, errors) {
  if (!isObject(policy) || policy.schemaVersion !== 1) {
    errors.push("retrieval disclosure policy schemaVersion must be 1");
    return;
  }
  if (policy.admissionStage !== "before-ranking-candidate-admission") {
    errors.push(
      "disclosure policy must run before candidate admission/ranking",
    );
  }
  if (
    JSON.stringify(policy.phaseResolutionModes) !==
    JSON.stringify(["reading", "story", "auto"])
  ) {
    errors.push(
      "disclosure policy phaseResolutionModes must preserve ADR 002 modes",
    );
  }
  const rules = new Set(
    (policy.rejectionRules ?? []).map((rule) =>
      isObject(rule) ? rule.id : rule,
    ),
  );
  for (const rule of REQUIRED_DISCLOSURE_RULES) {
    if (!rules.has(rule))
      errors.push(`disclosure policy is missing rejection rule: ${rule}`);
  }
  const fixtures = new Set(policy.fixtures ?? []);
  for (const fixture of REQUIRED_DISCLOSURE_FIXTURES) {
    if (!fixtures.has(fixture))
      errors.push(`disclosure policy is missing fixture: ${fixture}`);
  }
  for (const field of [
    "projectId",
    "currentSceneId",
    "phaseResolutionMode",
    "phaseResolution",
    "candidateScope",
    "temporalAnchor",
    "viewpointRef",
    "knowledgeHolderRef",
    "audienceRef",
    "allowSecrets",
  ]) {
    if (!policy.contextFields?.includes(field)) {
      errors.push(`disclosure policy context is missing: ${field}`);
    }
  }
}

function validateArchitectureImports(repoRoot, manifest, errors) {
  const boundary = manifest?.semanticBoundary;
  if (!isObject(boundary) || boundary.schemaVersion !== 1) {
    errors.push(
      "change-feed writer manifest semanticBoundary schemaVersion must be 1",
    );
    return;
  }
  if (!Array.isArray(boundary.scanRoots) || boundary.scanRoots.length === 0) {
    errors.push("semanticBoundary.scanRoots must be a non-empty array");
    return;
  }
  const declaredRoots = new Set(boundary.scanRoots);
  for (const requiredRoot of REQUIRED_SEMANTIC_BOUNDARY_SCAN_ROOTS) {
    if (!declaredRoots.has(requiredRoot)) {
      errors.push(
        `semanticBoundary.scanRoots is missing required minimum root: ${requiredRoot}`,
      );
      continue;
    }
    const absoluteRequiredRoot = path.join(repoRoot, requiredRoot);
    if (
      !existsSync(absoluteRequiredRoot) ||
      !statSync(absoluteRequiredRoot).isDirectory()
    ) {
      errors.push(
        `semanticBoundary required scan root is missing or not a directory: ${requiredRoot}`,
      );
    }
  }
  const roots = new Set();
  for (const relativeRoot of boundary.scanRoots) {
    if (!isNonEmptyString(relativeRoot) || path.isAbsolute(relativeRoot)) {
      errors.push(
        `semanticBoundary scan root is not repository-relative: ${String(relativeRoot)}`,
      );
      continue;
    }
    if (relativeRoot.split(/[\\/]/).includes("..")) {
      errors.push(
        `semanticBoundary scan root escapes the repository: ${relativeRoot}`,
      );
      continue;
    }
    if (roots.has(relativeRoot)) continue;
    roots.add(relativeRoot);
    for (const file of listSourceFiles(repoRoot, relativeRoot)) {
      const source = readFileSync(file, "utf8");
      const relativeFile = path.relative(repoRoot, file).replaceAll("\\", "/");
      const isRustBoundaryViolation =
        file.endsWith(".rs") &&
        FORBIDDEN_DIRECT_RUST_BOUNDARY_IMPORTS.some((pattern) =>
          pattern.test(source),
        ) &&
        !ALLOWED_RUST_TYPED_WRITER_BRIDGES.has(relativeFile);
      if (
        FORBIDDEN_DIRECT_BOUNDARY_IMPORTS.some((pattern) =>
          pattern.test(source),
        ) ||
        containsForbiddenDirectAgentCommandCall(source) ||
        isRustBoundaryViolation
      ) {
        errors.push(
          `Interpreter/maintenance boundary cannot call Agent Writer or Domain API directly: ${relativeFile}`,
        );
      }
    }
  }
}

function validateMutationCommandInventory(repoRoot, manifest, errors) {
  const inventory = manifest?.semanticBoundary?.commandInventory;
  if (!isObject(inventory) || inventory.schemaVersion !== 1) {
    errors.push("semanticBoundary.commandInventory schemaVersion must be 1");
    return;
  }
  if (!Array.isArray(inventory.sources) || inventory.sources.length === 0) {
    errors.push("semanticBoundary.commandInventory.sources must be non-empty");
    return;
  }
  if (
    !Array.isArray(inventory.mutationPrefixes) ||
    inventory.mutationPrefixes.some((prefix) => !isNonEmptyString(prefix))
  ) {
    errors.push(
      "semanticBoundary.commandInventory.mutationPrefixes must contain non-empty strings",
    );
    return;
  }
  const ignoredCommands = new Set(
    Array.isArray(inventory.ignoredCommands)
      ? inventory.ignoredCommands.filter(isNonEmptyString)
      : [],
  );
  const manifestRoutes = new Set(
    (manifest.operations ?? []).flatMap((operation) =>
      (operation?.routes ?? [])
        .filter((route) => route?.surface === "electron-ipc")
        .map((route) => route?.name),
    ),
  );
  const extractors = {
    "handler-keys": /^\s{2}([a-z][a-z0-9_]+):\s*\{/gm,
    "switch-cases": /\bcase\s+["']([a-z][a-z0-9_]+)["']\s*:/g,
  };
  for (const [index, sourceSpec] of inventory.sources.entries()) {
    const label = `semanticBoundary command source ${index}`;
    if (
      !isObject(sourceSpec) ||
      !isNonEmptyString(sourceSpec.path) ||
      !isNonEmptyString(sourceSpec.surface) ||
      !isNonEmptyString(sourceSpec.extractor)
    ) {
      errors.push(`${label} must declare path, surface, and extractor`);
      continue;
    }
    const sourcePath = path.join(repoRoot, sourceSpec.path);
    if (!existsSync(sourcePath)) {
      errors.push(`${label} source is missing: ${sourceSpec.path}`);
      continue;
    }
    const extractor = extractors[sourceSpec.extractor];
    if (!extractor && sourceSpec.extractor !== "browser-command-cases") {
      errors.push(`${label} has unknown extractor: ${sourceSpec.extractor}`);
      continue;
    }
    const source = readFileSync(sourcePath, "utf8");
    const commandMatches =
      sourceSpec.extractor === "browser-command-cases"
        ? (() => {
            const switchBody =
              /switch\s*\(cmd\)\s*\{([\s\S]*?)\n\s*default\s*:/m.exec(
                source,
              )?.[1];
            return switchBody?.matchAll(extractors["switch-cases"]) ?? [];
          })()
        : source.matchAll(extractor);
    for (const match of commandMatches) {
      const command = match[1];
      if (
        !inventory.mutationPrefixes.some((prefix) =>
          command.startsWith(prefix),
        ) ||
        ignoredCommands.has(command)
      ) {
        continue;
      }
      if (
        sourceSpec.surface === "electron-ipc" &&
        !manifestRoutes.has(command)
      ) {
        errors.push(
          `unregistered mutation command ${sourceSpec.surface}:${command}; add it to the Change Feed writer manifest`,
        );
      }
    }
  }
}

function validateContractFixtures(repoRoot, errors) {
  const fixtureRoot = "policies/narrative/fixtures";
  const routeFixture = readJson(
    repoRoot,
    `${fixtureRoot}/mutation-authority-routes.json`,
    errors,
    "mutation authority fixtures",
  );
  if (routeFixture) {
    if (
      routeFixture.schemaVersion !== 1 ||
      !Array.isArray(routeFixture.fixtures)
    ) {
      errors.push(
        "mutation authority fixtures must declare schemaVersion 1 and fixtures",
      );
    } else {
      for (const fixture of routeFixture.fixtures) {
        if (!AUTHORITY_ROUTE_IDS.includes(fixture?.authorityRoute)) {
          errors.push(
            `mutation authority fixture has unknown route: ${fixture?.authorityRoute}`,
          );
        }
      }
    }
    if (routeFixture.unknownRoute?.expected !== "reject") {
      errors.push("mutation authority unknown-route fixture must reject");
    }
  }

  const evidenceFixture = readJson(
    repoRoot,
    `${fixtureRoot}/evidence-policy.json`,
    errors,
    "evidence policy fixtures",
  );
  if (
    !evidenceFixture ||
    evidenceFixture.schemaVersion !== 1 ||
    !Array.isArray(evidenceFixture.fixtures) ||
    !evidenceFixture.fixtures.some(
      (fixture) => fixture?.expected === "reject",
    ) ||
    !evidenceFixture.fixtures.some((fixture) => fixture?.expected === "accept")
  ) {
    errors.push(
      "evidence policy fixtures must contain both accept and reject cases",
    );
  }

  const projectionFixture = readJson(
    repoRoot,
    `${fixtureRoot}/projection-state.json`,
    errors,
    "projection state fixtures",
  );
  if (
    !projectionFixture ||
    projectionFixture.schemaVersion !== 1 ||
    !isNonEmptyString(projectionFixture.revisionId) ||
    !Array.isArray(projectionFixture.projections) ||
    projectionFixture.projections.length < 4
  ) {
    errors.push(
      "projection state fixtures must cover multiple projections for one revision",
    );
  }
}

// The Consumer registry's semantic rules -- the ones a JSON Schema cannot
// express. `narrative-consumer-contract.schema.json` checks each entry's
// shape; nothing there stops the registry from listing one `kind` twice with
// contradictory `status` values, from losing its only `declared` entry, or
// from naming a `durableIdentitySource` on a table that does not exist.
//
// The Rust side of the same pact is `consumer_identity.rs`'s
// `every_declared_contract_kind_has_a_consumer_kind_variant_and_vice_versa`,
// which fails if `ConsumerKind` and this registry stop naming the same
// `declared` kinds. Neither check can see the other's language, so both have
// to exist.
function validateConsumerContract(repoRoot, contract, errors) {
  if (!isObject(contract)) return;
  const entries = Array.isArray(contract.consumerKinds)
    ? contract.consumerKinds
    : [];
  if (entries.length === 0) {
    errors.push("narrative consumer contract lists no consumerKinds");
    return;
  }

  const seen = new Set();
  for (const entry of entries) {
    if (!isObject(entry) || !isNonEmptyString(entry.kind)) continue;
    if (seen.has(entry.kind)) {
      errors.push(
        `narrative consumer contract registers consumer kind '${entry.kind}' more than once; ` +
          "uniqueItems only compares whole entries, so two contradictory registrations pass the schema",
      );
    }
    seen.add(entry.kind);
  }

  const declared = entries.filter((entry) => entry?.status === "declared");
  if (declared.length === 0) {
    errors.push(
      "narrative consumer contract declares no consumer kind, but production Producers write Edges today",
    );
  }

  // Every declared/reserved kind names a durable identity source; the schema
  // requires the field, this checks the table it names is real.
  const migrateSource = readSourceIfPresent(
    repoRoot,
    "src-tauri/crates/grimodex-db/src/migrate.rs",
  );
  if (migrateSource) {
    for (const entry of entries) {
      const source = entry?.durableIdentitySource;
      if (!isNonEmptyString(source)) continue;
      const table = source.split(".")[0];
      if (!migrateSource.includes(`CREATE TABLE IF NOT EXISTS ${table} (`)) {
        errors.push(
          `narrative consumer contract points consumer kind '${entry.kind}' at '${source}', ` +
            `but migrate.rs creates no table named '${table}'`,
        );
      }
    }
  }
}

export function validateScopeRelationContract(repoRoot, contract, errors) {
  if (!isObject(contract)) return;
  if (
    contract.schemaVersion !== 1 ||
    contract.contract !== "narrative-scope-relation-contract" ||
    contract.scopeSchemaVersion !== 2
  ) {
    errors.push(
      "narrative scope relation contract identity/version is invalid",
    );
    return;
  }

  const axisIds = Array.isArray(contract.axes)
    ? contract.axes.map((axis) => axis?.id)
    : [];
  if (!sameStringSet(axisIds, REQUIRED_SCOPE_AXIS_IDS)) {
    errors.push(
      `narrative scope relation axes must contain exactly [${REQUIRED_SCOPE_AXIS_IDS.join(", ")}]`,
    );
  }
  if (
    contract.relationSemantics?.classification !==
    "strongest-established-knowledge"
  ) {
    errors.push(
      "scope relations must classify the strongest established knowledge",
    );
  }
  if (
    contract.relationSemantics?.containsIsStrict !== false ||
    contract.relationSemantics?.containedByIsStrict !== false
  ) {
    errors.push(
      "scope contains/contained-by must not claim strict containment",
    );
  }
  if (
    contract.relationSemantics
      ?.overlapsRequiresEstablishedNonEmptyIntersection !== true
  ) {
    errors.push(
      "scope overlaps must require an established non-empty intersection",
    );
  }
  if (
    contract.unresolvedSemantics?.reasonAloneEstablishesIdentity !== false ||
    contract.unresolvedSemantics?.equalityPolicy !==
      "same-scope-revision-or-stable-constraint-id"
  ) {
    errors.push("an unresolved reason alone must not establish Scope identity");
  }

  const fixtures = new Map(
    (contract.basicRelationFixtures ?? []).map((fixture) => [
      fixture?.id,
      fixture,
    ]),
  );
  for (const fixtureId of REQUIRED_SCOPE_RELATION_FIXTURES) {
    if (!fixtures.has(fixtureId)) {
      errors.push(
        `narrative scope relation contract is missing fixture: ${fixtureId}`,
      );
    }
  }
  if (fixtures.get("any-vs-unresolved-is-contains")?.expected !== "contains") {
    errors.push("any versus unresolved must establish contains");
  }
  if (
    fixtures.get("unresolved-vs-any-is-contained-by")?.expected !==
    "contained-by"
  ) {
    errors.push("unresolved versus any must establish contained-by");
  }
  if (
    fixtures.get("same-unresolved-reason-is-not-identity")?.expected !==
    "unknown"
  ) {
    errors.push("matching unresolved reasons must not establish equal");
  }

  if (
    contract.oracleContract?.basisRequiredWheneverOracleOrRegistryUsed !==
      true ||
    !sameStringSet(
      contract.oracleContract?.basisRequiredRelations,
      contract.relations ?? [],
    )
  ) {
    errors.push(
      "every Oracle/Registry-derived Scope relation must carry Basis",
    );
  }
  const canonicalExcludes = new Set(contract.canonicalization?.excludes ?? []);
  for (const excluded of [
    "from-before-until-order",
    "worldline-containment-or-exclusion",
    "narrative-layer-parentage",
    "cross-reference-equivalence",
  ]) {
    if (!canonicalExcludes.has(excluded)) {
      errors.push(
        `scope structural digest must exclude Oracle fact: ${excluded}`,
      );
    }
  }
  validateImplementationStatus(
    repoRoot,
    "narrative scope relation contract",
    contract.implementationStatus,
    errors,
  );
}

export function validateDependencyRoleContract(
  repoRoot,
  contract,
  stateVocabulary,
  findingContract,
  consumerContract,
  errors,
) {
  if (!isObject(contract)) return;
  if (
    contract.schemaVersion !== 1 ||
    contract.contract !== "narrative-dependency-role-registry"
  ) {
    errors.push(
      "narrative dependency role contract identity/version is invalid",
    );
    return;
  }

  const roleIds = Array.isArray(contract.roles)
    ? contract.roles.map((role) => role?.id)
    : [];
  if (!sameStringSet(roleIds, REQUIRED_DEPENDENCY_ROLE_IDS)) {
    errors.push(
      `narrative dependency roles must contain exactly [${REQUIRED_DEPENDENCY_ROLE_IDS.join(", ")}]`,
    );
  }

  const freshnessValues = new Set(stateVocabulary?.evidenceFreshness ?? []);
  const buildActions = new Set(stateVocabulary?.buildActions ?? []);
  const reasonCodes = new Set(findingContract?.reasonCodes ?? []);
  const consumerKinds = new Set(
    (consumerContract?.consumerKinds ?? []).map((entry) => entry?.kind),
  );
  const changeClasses = new Set(contract.sourceChangeClasses ?? []);
  const rules = Array.isArray(contract.effectRules) ? contract.effectRules : [];
  const seenRuleIds = new Set();
  const seenEffectKeys = new Set();
  const coveredRoles = new Set();
  const requiredActions = new Set(
    contract.actionAggregation?.requiredActions ?? [],
  );
  const advisoryActions = new Set(
    contract.actionAggregation?.advisoryActions ?? [],
  );

  for (const rule of rules) {
    if (!isObject(rule)) continue;
    if (seenRuleIds.has(rule.id)) {
      errors.push(
        `duplicate narrative dependency effect rule id: ${String(rule.id)}`,
      );
    }
    seenRuleIds.add(rule.id);
    const effectKey = `${rule.role}|${rule.consumerKind}|${rule.changeClass}`;
    if (seenEffectKeys.has(effectKey)) {
      errors.push(`duplicate narrative dependency effect key: ${effectKey}`);
    }
    seenEffectKeys.add(effectKey);
    coveredRoles.add(rule.role);

    if (!REQUIRED_DEPENDENCY_ROLE_IDS.includes(rule.role)) {
      errors.push(
        `dependency effect rule uses unknown role: ${String(rule.role)}`,
      );
    }
    if (!consumerKinds.has(rule.consumerKind)) {
      errors.push(
        `dependency effect rule uses unregistered consumer kind: ${String(rule.consumerKind)}`,
      );
    }
    if (!changeClasses.has(rule.changeClass)) {
      errors.push(
        `dependency effect rule uses unknown change class: ${String(rule.changeClass)}`,
      );
    }
    if (!freshnessValues.has(rule.freshness)) {
      errors.push(
        `dependency effect rule uses unknown Freshness: ${String(rule.freshness)}`,
      );
    }
    if (rule.reasonCode !== null && !reasonCodes.has(rule.reasonCode)) {
      errors.push(
        `dependency effect rule uses unknown reason code: ${String(rule.reasonCode)}`,
      );
    }
    if (!buildActions.has(rule.buildAction)) {
      errors.push(
        `dependency effect rule uses unknown Build Action: ${String(rule.buildAction)}`,
      );
    }
    if (
      rule.freshness === "unknown" &&
      rule.changeClass !== "component-unavailable"
    ) {
      errors.push(
        `dependency effect rule ${String(rule.id)} uses unknown outside evaluation-unavailable input`,
      );
    }
    if (
      (requiredActions.has(rule.buildAction) &&
        rule.actionRequirement !== "required") ||
      (advisoryActions.has(rule.buildAction) &&
        rule.actionRequirement !== "advisory") ||
      (rule.buildAction === "none" && rule.actionRequirement !== "none")
    ) {
      errors.push(
        `dependency effect rule ${String(rule.id)} mismatches Build Action requirement channel`,
      );
    }
  }
  for (const role of REQUIRED_DEPENDENCY_ROLE_IDS) {
    if (!coveredRoles.has(role)) {
      errors.push(`narrative dependency role has no effect rule: ${role}`);
    }
  }

  const findRule = (id) => rules.find((rule) => rule?.id === id);
  const catalogRule = findRule("entity-resolution-input-changed");
  if (
    catalogRule?.freshness !== "stale" ||
    catalogRule?.reasonCode !== "source-revision-changed" ||
    catalogRule?.buildAction !== "resolve-only"
  ) {
    errors.push(
      "ordinary entity-resolution input changes must map to stale/resolve-only",
    );
  }
  const qualityRule = findRule("quality-context-refresh-available");
  if (
    qualityRule?.freshness !== "fresh" ||
    qualityRule?.reasonCode !== null ||
    qualityRule?.buildAction !== "refresh-available" ||
    qualityRule?.actionRequirement !== "advisory"
  ) {
    errors.push(
      "quality-context changes must remain fresh with advisory refresh-available",
    );
  }
  const rankingRule = findRule("ranking-input-changed");
  if (
    rankingRule?.consumerKind !== "semantic-index" ||
    rankingRule?.freshness !== "stale" ||
    rankingRule?.buildAction !== "recompile-only"
  ) {
    errors.push(
      "ranking-only changes must recompile the semantic-index Consumer",
    );
  }

  const selectorKinds = (contract.selectors ?? []).map(
    (selector) => selector?.kind,
  );
  if (
    !sameStringSet(selectorKinds, [
      "whole-source",
      "text-range",
      "field-path",
      "exact-object-set",
      "component-contract",
    ])
  ) {
    errors.push(
      "narrative dependency selector registry is incomplete or duplicated",
    );
  }
  const textRange = (contract.selectors ?? []).find(
    (selector) => selector?.kind === "text-range",
  );
  if (
    textRange?.unit !== "utf16" ||
    textRange?.rangeSemantics !== "half-open"
  ) {
    errors.push(
      "text-range dependency selectors must use half-open UTF-16 units",
    );
  }
  if (
    contract.selectorSafety?.catalogFallbackUntilDeterministicSlice !==
    "whole-source"
  ) {
    errors.push(
      "exact-object-set Catalog matching must fall back to whole-source until a deterministic slice exists",
    );
  }
  if (
    JSON.stringify(contract.positionMapping?.currentChangeFeedKinds) !==
    JSON.stringify(["position-map", "canonical-diff", "whole-document"])
  ) {
    errors.push(
      "Dependency contract must preserve all current Change Feed mapping kinds",
    );
  }

  if (
    JSON.stringify(contract.dependencyKey?.hashComponents) !==
      JSON.stringify(["dependency-role", "canonical-selector"]) ||
    !contract.dependencyKey?.excludedComponents?.includes(
      "role-contract-version",
    )
  ) {
    errors.push("dependencyKey must exclude the role contract version");
  }
  if (
    !sameStringSet(contract.declarationSet?.persistentStates, ["sealed"]) ||
    contract.declarationSet?.buildingState !== "transaction-or-memory-only"
  ) {
    errors.push("only sealed Dependency Declaration Sets may persist");
  }
  if (contract.v1V2Selection?.singleV2EdgeActivatesV2 !== false) {
    errors.push("one V2 Edge must never hide the active V1 dependency set");
  }

  if (
    !sameStringSet(contract.requirementIds, [
      "GDX-NARR-SEMANTIC-CONTRACT-001",
      "GDX-TRACE-001",
    ])
  ) {
    errors.push(
      "narrative dependency role contract must retain semantic-contract and traceability requirement IDs",
    );
  }
  if (
    contract.fixtureFile !==
    "policies/narrative/fixtures/dependency-role-contract.json"
  ) {
    errors.push(
      "narrative dependency role contract must point to its representative fixture file",
    );
  } else {
    validateDependencyRoleContractFixture(repoRoot, contract.fixtureFile, errors);
  }

  const fixtures = new Set(
    (contract.contractFixtures ?? []).map((fixture) => fixture?.id),
  );
  for (const fixtureId of REQUIRED_DEPENDENCY_CONTRACT_FIXTURES) {
    if (!fixtures.has(fixtureId)) {
      errors.push(
        `narrative dependency role contract is missing fixture: ${fixtureId}`,
      );
    }
  }
  validateImplementationStatus(
    repoRoot,
    "narrative dependency role contract",
    contract.implementationStatus,
    errors,
  );
}

function validateDependencyRoleContractFixture(repoRoot, fixturePath, errors) {
  const fixture = readJson(
    repoRoot,
    fixturePath,
    errors,
    "narrative dependency role contract fixture",
  );
  if (
    !fixture ||
    fixture.schemaVersion !== 1 ||
    fixture.fixtureKind !== "narrative-dependency-role-contract" ||
    !Array.isArray(fixture.cases)
  ) {
    errors.push(
      "narrative dependency role contract fixture must declare schemaVersion 1, fixtureKind, and cases",
    );
    return;
  }
  if (
    !sameStringSet(fixture.requirementIds, [
      "GDX-NARR-SEMANTIC-CONTRACT-001",
      "GDX-TRACE-001",
    ])
  ) {
    errors.push(
      "narrative dependency role contract fixture must retain semantic-contract and traceability requirement IDs",
    );
  }
  const cases = new Map();
  for (const fixtureCase of fixture.cases) {
    if (!isObject(fixtureCase) || !isNonEmptyString(fixtureCase.id)) {
      errors.push(
        "narrative dependency role contract fixture cases must have unique non-empty ids",
      );
      continue;
    }
    if (cases.has(fixtureCase.id)) {
      errors.push(
        `duplicate narrative dependency role contract fixture case: ${fixtureCase.id}`,
      );
    }
    cases.set(fixtureCase.id, fixtureCase);
  }
  for (const fixtureId of REQUIRED_DEPENDENCY_ROLE_FIXTURE_CASES) {
    if (!cases.has(fixtureId)) {
      errors.push(
        `narrative dependency role contract fixture is missing case: ${fixtureId}`,
      );
    }
  }
  const expectedEffects = new Map([
    [
      "direct-evidence-content-changed",
      {
        freshness: "stale",
        reasonCode: "source-revision-changed",
        buildAction: "rebuild-required",
        actionRequirement: "required",
      },
    ],
    [
      "catalog-content-change-is-stale-not-unknown",
      {
        freshness: "stale",
        reasonCode: "source-revision-changed",
        buildAction: "resolve-only",
        actionRequirement: "required",
      },
    ],
    [
      "quality-context-remains-fresh-with-advisory-action",
      {
        freshness: "fresh",
        reasonCode: null,
        buildAction: "refresh-available",
        actionRequirement: "advisory",
      },
    ],
    [
      "ranking-input-recompiles-semantic-index",
      {
        freshness: "stale",
        reasonCode: "source-revision-changed",
        buildAction: "recompile-only",
        actionRequirement: "required",
      },
    ],
  ]);
  for (const [fixtureId, expected] of expectedEffects) {
    const fixtureCase = cases.get(fixtureId);
    if (JSON.stringify(fixtureCase?.expected) !== JSON.stringify(expected)) {
      errors.push(
        `narrative dependency fixture ${fixtureId} must retain its ratified effect output`,
      );
    }
  }
  const rejectExpectations = new Map([
    ["unknown-role-fails-closed", "unknown-role"],
    ["unknown-effect-combination-fails-closed", "missing-effect-rule"],
    ["unknown-selector-fails-closed", "unknown-selector"],
    ["utf16-range-rejects-surrogate-interior", "surrogate-boundary"],
  ]);
  for (const [fixtureId, errorCode] of rejectExpectations) {
    const fixtureCase = cases.get(fixtureId);
    if (fixtureCase?.expected !== "reject" || fixtureCase?.error !== errorCode) {
      errors.push(
        `narrative dependency fixture ${fixtureId} must fail closed with ${errorCode}`,
      );
    }
  }
  const keyFixture = cases.get("whole-source-dependency-key-golden");
  if (
    keyFixture?.expected !== "accept" ||
    keyFixture?.canonicalSelector !== '{"kind":"whole-source"}' ||
    keyFixture?.dependencyKey !==
      "sha256:dc5ae15ade6f6ce31c7dece2a1ec161caed32628ae27e1c70f88bf035b54fc0c"
  ) {
    errors.push(
      "narrative dependency fixture must retain the whole-source dependency key golden",
    );
  }
  const mixedFixture = cases.get("mixed-actions-stay-independent");
  if (
    JSON.stringify(mixedFixture?.expected) !==
    JSON.stringify({
      requiredActions: ["resolve-only"],
      advisoryActions: ["refresh-available"],
      compatibilityPrimaryAction: "resolve-only",
    })
  ) {
    errors.push(
      "narrative dependency fixture must keep required and advisory actions independent",
    );
  }
  if (
    !fixture.cases.some((fixtureCase) => fixtureCase?.expected === "accept") ||
    !fixture.cases.some((fixtureCase) => fixtureCase?.expected === "reject")
  ) {
    errors.push(
      "narrative dependency role contract fixture must contain both accept and reject cases",
    );
  }
}

function readSourceIfPresent(repoRoot, relativePath) {
  const absolute = path.join(repoRoot, relativePath);
  return existsSync(absolute) ? readFileSync(absolute, "utf8") : null;
}

function validatePolicySchemas(repoRoot, errors) {
  const schemaContracts = [
    ["mutation-authority-routes.schema.json", "mutation-authority-routes.json"],
    ["semantic-state-vocabulary.schema.json", "semantic-state-vocabulary.json"],
    ["semantic-core-authorities.schema.json", "semantic-core-authorities.json"],
    [
      "narrative-artifact-authority.schema.json",
      "narrative-artifact-authority.json",
    ],
    ["retrieval-disclosure.schema.json", "retrieval-disclosure.json"],
    [
      "narrative-consumer-contract.schema.json",
      "narrative-consumer-contract.json",
    ],
    [
      "narrative-scope-relation-contract.schema.json",
      "narrative-scope-relation-contract.json",
    ],
    [
      "narrative-ir-contract.schema.json",
      "narrative-ir-contract.json",
    ],
    [
      "narrative-dependency-role-registry.schema.json",
      "narrative-dependency-role-registry.json",
    ],
  ];
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  for (const [schemaName, contractName] of schemaContracts) {
    const schema = readJson(
      repoRoot,
      `policies/narrative/schemas/${schemaName}`,
      errors,
      `policy JSON Schema ${schemaName}`,
    );
    if (!schema) continue;
    if (schema.$schema !== "https://json-schema.org/draft/2020-12/schema") {
      errors.push(`${schemaName} must use JSON Schema draft 2020-12`);
    }
    if (schema.type !== "object") {
      errors.push(`${schemaName} root type must be object`);
    }
    const contract = readJson(
      repoRoot,
      `policies/narrative/${contractName}`,
      errors,
      `policy contract for ${schemaName}`,
    );
    if (!contract) continue;
    try {
      const validate = ajv.compile(schema);
      if (!validate(contract)) {
        errors.push(
          `${schemaName} rejects ${contractName}: ${ajv.errorsText(validate.errors)}`,
        );
      }
    } catch (error) {
      errors.push(
        `${schemaName} could not be compiled: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

function validateSchemaVersion(repoRoot, errors) {
  const sourcePath = path.join(
    repoRoot,
    "src-tauri/crates/grimodex-core/src/lib.rs",
  );
  if (!existsSync(sourcePath)) {
    errors.push("workspace schema authority source is missing");
    return null;
  }
  const source = readFileSync(sourcePath, "utf8");
  const match = /SCHEMA_VERSION:\s*i32\s*=\s*(\d+)/.exec(source);
  const version = match ? Number(match[1]) : null;
  if (version !== EXPECTED_SCHEMA_VERSION) {
    errors.push(
      `workspace schema drifted from the version this semantic contract was last ratified against; expected SCHEMA_VERSION ${EXPECTED_SCHEMA_VERSION}, got ${version ?? "unknown"}`,
    );
  }
  return version;
}

export function validateSemanticCoreBoundary({
  repoRoot = REPO_ROOT,
  writerManifestPath = "policies/narrative/change-feed-writers.json",
  routeRegistryPath = "policies/narrative/mutation-authority-routes.json",
  stateVocabularyPath = "policies/narrative/semantic-state-vocabulary.json",
  authorityMatrixPath = "policies/narrative/semantic-core-authorities.json",
  artifactAuthorityContractPath =
    "policies/narrative/narrative-artifact-authority.json",
  disclosurePolicyPath = "policies/narrative/retrieval-disclosure.json",
  consumerContractPath = "policies/narrative/narrative-consumer-contract.json",
  findingContractPath = "policies/narrative/narrative-finding-contract.json",
  scopeRelationContractPath = "policies/narrative/narrative-scope-relation-contract.json",
  dependencyRoleContractPath = "policies/narrative/narrative-dependency-role-registry.json",
} = {}) {
  const errors = [];
  const routeRegistry = readJson(
    repoRoot,
    routeRegistryPath,
    errors,
    "mutation authority route registry",
  );
  const routes = validateRouteRegistry(routeRegistry, errors);
  const writerManifest = readJson(
    repoRoot,
    writerManifestPath,
    errors,
    "change-feed writer manifest",
  );
  const writerResult = writerManifest
    ? validateWriterRoutes(writerManifest, routes, errors)
    : { operationCount: 0, routeCounts: {} };
  const vocabulary = readJson(
    repoRoot,
    stateVocabularyPath,
    errors,
    "semantic state vocabulary",
  );
  validateStateVocabulary(vocabulary, errors);
  validateContributionAxes(vocabulary, errors);
  const authorityMatrix = readJson(
    repoRoot,
    authorityMatrixPath,
    errors,
    "semantic authority matrix",
  );
  validateAuthorityMatrix(authorityMatrix, errors);
  const artifactAuthorityContract = readJson(
    repoRoot,
    artifactAuthorityContractPath,
    errors,
    "narrative artifact authority contract",
  );
  const artifactAuthorityErrorsBefore = errors.length;
  validateArtifactAuthorityContract(
    repoRoot,
    artifactAuthorityContract,
    errors,
  );
  const artifactAuthorityContractValid =
    errors.length === artifactAuthorityErrorsBefore;
  const disclosurePolicy = readJson(
    repoRoot,
    disclosurePolicyPath,
    errors,
    "retrieval disclosure policy",
  );
  validateDisclosurePolicy(disclosurePolicy, errors);
  validateContractFixtures(repoRoot, errors);
  const consumerContract = readJson(
    repoRoot,
    consumerContractPath,
    errors,
    "narrative consumer contract",
  );
  validateConsumerContract(repoRoot, consumerContract, errors);
  const findingContract = readJson(
    repoRoot,
    findingContractPath,
    errors,
    "narrative finding contract",
  );
  const scopeRelationContract = readJson(
    repoRoot,
    scopeRelationContractPath,
    errors,
    "narrative scope relation contract",
  );
  validateScopeRelationContract(repoRoot, scopeRelationContract, errors);
  const dependencyRoleContract = readJson(
    repoRoot,
    dependencyRoleContractPath,
    errors,
    "narrative dependency role contract",
  );
  validateDependencyRoleContract(
    repoRoot,
    dependencyRoleContract,
    vocabulary,
    findingContract,
    consumerContract,
    errors,
  );
  validatePolicySchemas(repoRoot, errors);
  validateArchitectureImports(repoRoot, writerManifest, errors);
  const interpreterBoundaryErrorsBefore = errors.length;
  validateInterpreterBoundary(
    repoRoot,
    artifactAuthorityContract,
    errors,
  );
  const interpreterBoundaryValid =
    errors.length === interpreterBoundaryErrorsBefore;
  validateMutationCommandInventory(repoRoot, writerManifest, errors);
  const schemaVersion = validateSchemaVersion(repoRoot, errors);

  return {
    errors,
    operationCount: writerResult.operationCount,
    routeCounts: writerResult.routeCounts,
    schemaVersion,
    checks: {
      routeRegistry: routes.size === AUTHORITY_ROUTE_IDS.length,
      writerClassification: writerResult.operationCount > 0,
      stateVocabulary: errors.length === 0,
      authorityMatrix: errors.length === 0,
      artifactAuthorityContract: artifactAuthorityContractValid,
      interpreterBoundary: interpreterBoundaryValid,
      disclosurePolicy: errors.length === 0,
      scopeRelationContract: errors.length === 0,
      dependencyRoleContract: errors.length === 0,
    },
  };
}

function main() {
  const result = validateSemanticCoreBoundary();
  if (result.errors.length > 0) {
    for (const error of result.errors) console.error(`FAIL: ${error}`);
    process.exitCode = 1;
    return;
  }
  console.log(
    `Semantic Core boundary PASS: ${result.operationCount} writer operations classified; schema ${result.schemaVersion}`,
  );
}

if (
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  main();
}
