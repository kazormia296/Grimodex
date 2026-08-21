#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";

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
  "sql-import": Object.freeze([
    "\\bfrom\\s+[\\\"'`]drizzle-orm(?:/[^\\\"'`]+)?[\\\"'`]",
    "\\bfrom\\s+[\\\"'`][^\\\"'`]*(?:sqlite|database)/(?:client|connection|repository|sql)[^\\\"'`]*[\\\"'`]",
  ]),
  "db-mutation": Object.freeze([
    "\\b(?:db|database|conn|connection|tx|transaction)\\s*\\.\\s*(?:execute|exec|run|prepare|query|insert|update|delete)\\s*\\(",
    "\\b(?:executeSql|querySql|runSql|prepareSql)\\s*\\(",
    "\\bfrom\\s+[\\\"'`][^\\\"'`]*(?:database|sqlite|db)/(?:client|connection|repository|mutation|writer|sql)[^\\\"'`]*[\\\"'`]",
  ]),
  "prepared-commit": Object.freeze([
    "\\b(?:PreparedCommit|preparedCommit|prepared_commit|prepareCommit|prepare_commit|runPreparedCommit)\\b",
    "\\bfrom\\s+[\\\"'`][^\\\"'`]*prepared[-_]?commit[^\\\"'`]*[\\\"'`]",
  ]),
  "typed-writer": Object.freeze([
    "\\b(?:TypedWriter|typedWriter|typed_writer|runTypedWriter|writeWithTypedWriter)\\b",
    "\\bfrom\\s+[\\\"'`][^\\\"'`]*typed[-_]?writer[^\\\"'`]*[\\\"'`]",
  ]),
  "agent-writer": Object.freeze([
    "\\b(?:AgentWriter|agentWriter|agent_writer|agent_writes|writeWithAgentWriter)\\b",
    "\\bfrom\\s+[\\\"'`][^\\\"'`]*(?:agent[-_/]writes|codex[-_]writes)[^\\\"'`]*[\\\"'`]",
  ]),
  "generic-mcp-sql": Object.freeze([
    "\\b(?:mcpSql|mcp_sql|genericMcpSql|generic_mcp_sql)\\b",
    "\\b(?:mcp|Mcp)[A-Za-z0-9_]*(?:sql|query|execute)\\s*\\(",
    "\\b(?:mcp|Mcp)[A-Za-z0-9_]*::(?:sql|query|execute)\\b",
    "\\bfrom\\s+[\\\"'`][^\\\"'`]*(?:mcp|model-context-protocol)[^\\\"'`]*(?:sql|query|execute)[^\\\"'`]*[\\\"'`]",
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
]);

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
      else if (/\.(?:ts|tsx|mjs|js|rs)$/.test(entry.name)) files.push(absolute);
    }
  };
  visit(absoluteRoot);
  return files;
}

function listProductionSourceFiles(repoRoot, relativeRoot) {
  return listSourceFiles(repoRoot, relativeRoot).filter((file) => {
    const normalized = file.replaceAll("\\", "/");
    return (
      !/\.(?:test|spec)\.(?:ts|tsx|mjs|js)$/.test(normalized) &&
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
