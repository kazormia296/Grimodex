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
export const EXPECTED_SCHEMA_VERSION = 25;

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
  "attention-typed-writer": ["typed-writer"],
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

function validatePolicySchemas(repoRoot, errors) {
  const schemaContracts = [
    ["mutation-authority-routes.schema.json", "mutation-authority-routes.json"],
    ["semantic-state-vocabulary.schema.json", "semantic-state-vocabulary.json"],
    ["semantic-core-authorities.schema.json", "semantic-core-authorities.json"],
    ["retrieval-disclosure.schema.json", "retrieval-disclosure.json"],
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
  disclosurePolicyPath = "policies/narrative/retrieval-disclosure.json",
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
  const disclosurePolicy = readJson(
    repoRoot,
    disclosurePolicyPath,
    errors,
    "retrieval disclosure policy",
  );
  validateDisclosurePolicy(disclosurePolicy, errors);
  validateContractFixtures(repoRoot, errors);
  validatePolicySchemas(repoRoot, errors);
  validateArchitectureImports(repoRoot, writerManifest, errors);
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
      disclosurePolicy: errors.length === 0,
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
