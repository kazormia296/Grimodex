#!/usr/bin/env node
/**
 * Validate the Gate C1 operation-level Narrative Change Feed inventory.
 *
 * This gate intentionally separates table ownership (`protected-writers.json`)
 * from operation coverage. During the C1 restack, required routes may remain
 * `declared`; `--require-runtime-coverage` is the later cutover switch that
 * requires every required/delegated operation to be `verified`.
 * `verified` requires a runtimeEvidence bundle that names the commands and
 * regression files used to exercise the Native/browser contract. The bundle
 * is evidence of the declared contract, not a claim that this static
 * validator proved runtime atomicity by itself.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const MANIFEST_PATH = path.join(
  REPO_ROOT,
  "policies/narrative/change-feed-writers.json",
);
const REGISTRY_PATH = path.join(
  REPO_ROOT,
  "policies/narrative/protected-writers.json",
);

const FEED_POLICIES = new Set(["required", "delegated", "excluded"]);
const COVERAGE_STATUSES = new Set(["declared", "implemented", "verified"]);
const SCOPES = new Set([
  "project",
  "workspace",
  "database",
  "migration",
  "test",
]);
const SURFACES = new Set(["electron-ipc", "napi", "mcp-tool", "internal"]);
const CANONICAL_ORIGINS = new Set([
  "renderer",
  "agent",
  "mcp",
  "narrative",
  "native",
]);
const EXCLUSION_REASONS = new Set([
  "authority-metadata",
  "bootstrap",
  "control-plane",
  "database-image-replacement",
  "derived-state",
  "feed-self-write",
  "migration",
  "project-deletion",
  "snapshot-capture",
  "staging-only",
  "test-fixture",
  "untrusted-generic-sql",
  "workspace-import",
]);
const TRANSACTION_IDENTITIES = [
  "projectId",
  "requestId",
  "sessionId",
  "transactionId",
];

function pairedElectronRoutes(names) {
  return names.flatMap((name) => [
    { surface: "electron-ipc", name },
    { surface: "napi", name },
  ]);
}

const ELECTRON_MUTATING_ROUTES = [
  "db_execute",
  "db_execute_batch",
  "restore_backup",
  "restore_recovery_candidate",
  "project_create",
  "project_patch",
  "project_delete",
  "import_web_editor_workspace",
  "narrative_runtime_policy_set",
  "project_snapshot_create",
  "seed_sample_workspace",
  "runtime_performance_seed",
  "authorship_replace_lane",
  "scan_staging_project_create",
  "trash_bin_create",
  "trash_bin_delete",
  "trash_bin_clear_all",
  "trash_bin_prune",
  "repair_integrity",
  "event_set_participants",
  "project_calendar_upsert",
  "entity_tags_set",
  "codex_rename_undo",
  "codex_rename_apply",
  "ai_tree_plan_apply",
  "ai_tree_plan_undo",
  "tree_node_create",
  "tree_node_delete",
  "tree_node_patch",
  "temporal_scene_patch",
  "map_write_bundle",
  "project_snapshot_apply_restore",
  "revision_scene_restore",
  "trash_bin_restore",
  "save_scene_body_bundle",
  "plot_thread_create",
  "plot_thread_update",
  "plot_thread_delete",
  "plot_thread_link_create",
  "plot_thread_link_update",
  "plot_thread_link_delete",
  "plot_thread_branch_create",
  "plot_thread_branch_update",
  "plot_thread_branch_delete",
  "plot_thread_move_marker_bundle",
  "plot_thread_restore_snapshot",
  "plot_thread_delete_snapshot",
  "foreshadow_create",
  "foreshadow_update",
  "foreshadow_delete",
  "foreshadow_update_setup",
  "foreshadow_link_codex",
  "foreshadow_unlink_codex",
  "foreshadow_set_setup_strength",
  "foreshadow_setup_create_ai",
  "foreshadow_resolve_orphan",
  "foreshadow_save_anchors_for_scene",
  "agent_codex_create",
  "agent_codex_update",
  "agent_codex_delete",
  "agent_codex_mutate",
  "codex_create",
  "codex_update",
  "codex_delete",
  "codex_mutate",
  "agent_snippet_create",
  "snippet_create",
  "snippet_update",
  "snippet_delete",
  "agent_write_bundle",
  "agent_propose_scene_body",
  "agent_accept_prose_stage",
  "agent_discard_prose_stage",
  "agent_apply_undo_journal",
  "agent_foreshadow_create",
  "agent_foreshadow_update",
  "agent_event_create",
  "agent_event_update",
  "agent_event_delete",
  "agent_chronicle_bulk_mutate",
  "agent_event_set_participants",
  "agent_scene_event_link",
  "agent_scene_event_link_batch",
  "agent_scene_event_unlink",
  "agent_event_relation_add",
  "agent_event_relation_remove",
  "event_create",
  "event_update",
  "event_delete",
  "chronicle_bulk_mutate",
  "event_participants_set",
  "scene_event_link",
  "scene_event_link_batch",
  "scene_event_unlink",
  "event_relation_add",
  "event_relation_remove",
  "narrative_extraction_create_run",
  "narrative_extraction_cancel_run",
  "narrative_extraction_claim_task",
  "narrative_extraction_finish_task",
  "narrative_extraction_fail_task",
  "narrative_extraction_save_proposal_set",
  "narrative_extraction_append_revision",
  "narrative_extraction_append_decision",
  "narrative_extraction_append_human_decision",
  "narrative_extraction_revise_and_decide",
  "narrative_extraction_revise_and_decide_as_human",
  "narrative_extraction_set_human_field_lock",
  "narrative_extraction_prepare_commit",
  "narrative_extraction_apply_commit",
  "narrative_extraction_undo_commit",
  "narrative_extraction_redo_commit",
];

const REQUIRED_RENDERER_AUTHORITY_COMMANDS = new Set([
  "codex_create",
  "codex_update",
  "codex_delete",
  "codex_mutate",
  "event_create",
  "event_update",
  "event_delete",
  "chronicle_bulk_mutate",
  "event_participants_set",
  "scene_event_link",
  "scene_event_link_batch",
  "scene_event_unlink",
  "event_relation_add",
  "event_relation_remove",
]);

const MCP_MUTATING_ROUTES = [
  "create_foreshadow",
  "update_foreshadow",
  "create_codex_entry",
  "update_codex_entry",
  "create_snippet",
  "create_event",
  "update_event",
  "delete_event",
  "stamp_scene_event",
  "unstamp_scene_event",
  "set_event_participants",
  "add_event_relation",
  "remove_event_relation",
];

const MATRIX_CAUSES = new Set(["forward", "undo", "redo"]);
const MATRIX_TEXT_IMPACTS = new Set([
  "required",
  "required-when-anchor",
  "optional",
  "none",
]);
const MATRIX_ADDRESSING = new Set(["independent-key", "aggregate-path"]);

export const KNOWN_CHANGE_FEED_ROUTES = Object.freeze([
  ...pairedElectronRoutes(ELECTRON_MUTATING_ROUTES),
  ...MCP_MUTATING_ROUTES.map((name) => ({ surface: "mcp-tool", name })),
  { surface: "internal", name: "apply_commit" },
]);

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isCanonicalChangedPath(value) {
  if (!nonEmptyString(value) || value.trim() !== value || !value.startsWith("/")) {
    return false;
  }
  if (value === "/") return true;
  const segments = value.slice(1).split("/");
  return segments.every((segment) => {
    for (let index = 0; index < segment.length; index += 1) {
      if (segment[index] !== "~") continue;
      if (segment[index + 1] !== "0" && segment[index + 1] !== "1") return false;
      index += 1;
    }
    return true;
  });
}

function safeRepoPath(repoRoot, relativePath, label, errors) {
  if (!nonEmptyString(relativePath)) {
    errors.push(`${label} must be a non-empty repository-relative path`);
    return null;
  }
  if (
    path.isAbsolute(relativePath) ||
    relativePath.split(/[\\/]/).includes("..")
  ) {
    errors.push(`${label} must stay inside the repository: ${relativePath}`);
    return null;
  }
  const resolved = path.resolve(repoRoot, relativePath);
  const relative = path.relative(repoRoot, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    errors.push(`${label} escapes the repository: ${relativePath}`);
    return null;
  }
  return resolved;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sourceContainsSymbol(source, symbol) {
  return new RegExp(`\\bfn\\s+${escapeRegExp(symbol)}\\b`).test(source);
}

function sourceContainsRoute(source, route) {
  return new RegExp(`\\b${escapeRegExp(route)}\\b`).test(source);
}

function readJson(filePath, label, errors) {
  if (!existsSync(filePath)) {
    errors.push(`${label} does not exist: ${filePath}`);
    return null;
  }
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    errors.push(`${label} is not valid JSON: ${error.message}`);
    return null;
  }
}

function validateImplementation(operation, repoRoot, errors, sourceCache) {
  const label = `operation ${operation.id}`;
  if (!isObject(operation.implementation)) {
    errors.push(`${label} implementation must be an object`);
    return;
  }
  const { module, symbol } = operation.implementation;
  const absolute = safeRepoPath(
    repoRoot,
    module,
    `${label} implementation.module`,
    errors,
  );
  if (!nonEmptyString(symbol)) {
    errors.push(`${label} implementation.symbol must be non-empty`);
    return;
  }
  if (!absolute || !existsSync(absolute)) {
    if (absolute)
      errors.push(`${label} implementation module does not exist: ${module}`);
    return;
  }
  let source = sourceCache.get(absolute);
  if (source === undefined) {
    source = readFileSync(absolute, "utf8");
    sourceCache.set(absolute, source);
  }
  if (!sourceContainsSymbol(source, symbol)) {
    errors.push(
      `${label} implementation symbol ${symbol} is missing from ${module}`,
    );
  }
}

function validateRoutes(operation, repoRoot, errors, routeOwners, sourceCache) {
  const label = `operation ${operation.id}`;
  if (!Array.isArray(operation.routes)) {
    errors.push(`${label} routes must be an array`);
    return [];
  }
  const routes = [];
  for (const [index, route] of operation.routes.entries()) {
    const routeLabel = `${label} routes[${index}]`;
    if (!isObject(route)) {
      errors.push(`${routeLabel} must be an object`);
      continue;
    }
    if (!SURFACES.has(route.surface)) {
      errors.push(`${routeLabel}.surface is invalid: ${route.surface}`);
      continue;
    }
    if (!nonEmptyString(route.name)) {
      errors.push(`${routeLabel}.name must be non-empty`);
      continue;
    }
    const key = `${route.surface}:${route.name}`;
    if (routeOwners.has(key)) {
      errors.push(
        `duplicate route ${key} in operations ${routeOwners.get(key)} and ${operation.id}`,
      );
    } else {
      routeOwners.set(key, operation.id);
    }
    routes.push({ surface: route.surface, name: route.name });

    const absolute = safeRepoPath(
      repoRoot,
      route.module,
      `${routeLabel}.module`,
      errors,
    );
    if (!absolute || !existsSync(absolute)) {
      if (absolute)
        errors.push(`${routeLabel} module does not exist: ${route.module}`);
      continue;
    }
    let source = sourceCache.get(absolute);
    if (source === undefined) {
      source = readFileSync(absolute, "utf8");
      sourceCache.set(absolute, source);
    }
    if (!sourceContainsRoute(source, route.name)) {
      errors.push(
        `${routeLabel} name ${route.name} is missing from ${route.module}`,
      );
    }
  }

  const ipcNames = new Set(
    routes
      .filter((route) => route.surface === "electron-ipc")
      .map((route) => route.name),
  );
  const napiNames = new Set(
    routes
      .filter((route) => route.surface === "napi")
      .map((route) => route.name),
  );
  for (const name of ipcNames) {
    if (!napiNames.has(name)) {
      errors.push(
        `${label} Electron IPC route ${name} has no paired N-API route`,
      );
    }
  }
  for (const name of napiNames) {
    if (!ipcNames.has(name)) {
      errors.push(
        `${label} N-API route ${name} has no paired Electron IPC route`,
      );
    }
  }
  return routes;
}

function validateRendererAuthorityParity(
  manifest,
  operation,
  repoRoot,
  errors,
  sourceCache,
) {
  if (
    !operation.id.endsWith(".renderer") ||
    operation.canonical?.origin !== "renderer"
  ) {
    return;
  }
  const label = `operation ${operation.id}`;
  const mainPath = path.join(repoRoot, "electron/main/ipc.ts");
  if (!existsSync(mainPath)) return;
  let mainSource = sourceCache.get(mainPath);
  if (mainSource === undefined) {
    mainSource = readFileSync(mainPath, "utf8");
    sourceCache.set(mainPath, mainSource);
  }
  const ipcCommands = (operation.routes ?? [])
    .filter((route) => route?.surface === "electron-ipc")
    .map((route) => route.name)
    .filter(nonEmptyString);
  if (!ipcCommands.some((command) => REQUIRED_RENDERER_AUTHORITY_COMMANDS.has(command))) {
    return;
  }
  if (ipcCommands.length === 0) {
    errors.push(`${label} must declare an Electron IPC renderer command`);
    return;
  }

  const commandSets = ["CODEX_RENDERER_COMMANDS", "RENDERER_CHRONICLE_COMMANDS"];
  for (const command of ipcCommands) {
    const declaredInMain = commandSets.some((setName) => {
      const setBlock = mainSource.match(
        new RegExp(
          `const\\s+${setName}\\s*=\\s*new\\s+Set\\(\\[([\\s\\S]*?)\\]\\);`,
        ),
      );
      return Boolean(
        setBlock?.[1] &&
          new RegExp(`\\"${escapeRegExp(command)}\\"`).test(setBlock[1]) &&
          mainSource.includes(`${setName}.has(cmd)`),
      );
    });
    if (!declaredInMain) {
      errors.push(
        `${label} renderer command ${command} is missing from Main authority route sets`,
      );
    }
  }

  const rendererBranch = mainSource.match(
    /if \(\s*CODEX_RENDERER_COMMANDS\.has\(cmd\)[\s\S]*?return authorityRouteFor(?:Unambiguous)?Origin\(payload\.origin,\s*\[([\s\S]*?)\]\)/,
  )?.[1];
  const mainRoutes = new Set(
    rendererBranch?.match(/"([a-z-]+)"/g)?.map((value) => value.slice(1, -1)) ?? [],
  );
  for (const variant of operation.authorityVariants ?? []) {
    if (!mainRoutes.has(variant?.authorityRoute)) {
      errors.push(
        `${label} authority variant ${variant?.authorityRoute} is not present in Main renderer route binding`,
      );
    }
  }

  const evidence = isObject(operation.runtimeEvidence)
    ? operation.runtimeEvidence
    : manifest.runtimeEvidence;
  const evidenceCommands = new Set(
    Array.isArray(evidence?.commands) ? evidence.commands : [],
  );
  const evidenceTests = new Set(
    Array.isArray(evidence?.testFiles) ? evidence.testFiles : [],
  );
  if (!evidenceCommands.has("pnpm electron:product-journeys")) {
    errors.push(
      `${label} runtime evidence must include the positive Electron product journey command`,
    );
  }
  if (!evidenceTests.has("scripts/electron-product-journeys.test.mjs")) {
    errors.push(
      `${label} runtime evidence must include the product journey positive test`,
    );
  }
}

function validateWriterMatrix(manifest, errors) {
  if (!Array.isArray(manifest.writerMatrix) || manifest.writerMatrix.length === 0) {
    errors.push("change feed writer manifest writerMatrix must be a non-empty array");
    return;
  }
  const writers = new Set();
  for (const [index, row] of manifest.writerMatrix.entries()) {
    const label = `writerMatrix[${index}]`;
    if (!isObject(row)) {
      errors.push(`${label} must be an object`);
      continue;
    }
    for (const field of ["writer", "objectKey"]) {
      if (!nonEmptyString(row[field])) {
        errors.push(`${label}.${field} must be non-empty`);
      }
    }
    if (!MATRIX_ADDRESSING.has(row.addressing)) {
      errors.push(
        `${label}.addressing must be independent-key or aggregate-path`,
      );
    }
    if (nonEmptyString(row.writer)) {
      if (writers.has(row.writer)) errors.push(`${label}.writer is duplicated`);
      writers.add(row.writer);
    }
    if (!Array.isArray(row.paths) || row.paths.length === 0) {
      errors.push(`${label}.paths must be a non-empty array`);
    } else {
      for (const path of row.paths) {
        if (!isCanonicalChangedPath(path)) {
          errors.push(`${label}.paths must contain canonical JSON Pointer paths`);
          break;
        }
      }
    }
    if (
      !Array.isArray(row.cause) ||
      row.cause.length === 0 ||
      row.cause.some((cause) => !MATRIX_CAUSES.has(cause))
    ) {
      errors.push(`${label}.cause must contain forward/undo/redo values`);
    }
    if (!MATRIX_TEXT_IMPACTS.has(row.textImpact)) {
      errors.push(`${label}.textImpact is invalid`);
    }
    for (const field of ["atomic", "undoRedo", "idempotent"]) {
      if (typeof row[field] !== "boolean") {
        errors.push(`${label}.${field} must be boolean`);
      }
    }
  }
}

function validateRuntimeEvidence(manifest, operation, repoRoot, errors) {
  if (operation.coverageStatus !== "verified") return;
  if (
    operation.feedPolicy === "excluded" &&
    operation.runtimeEvidence?.status === "excluded"
  ) {
    return;
  }

  const label = `operation ${operation.id}`;
  const evidence = isObject(operation.runtimeEvidence)
    ? operation.runtimeEvidence
    : manifest.runtimeEvidence;
  if (
    !isObject(evidence) ||
    evidence.schemaVersion !== 1 ||
    evidence.status !== "verified" ||
    !nonEmptyString(evidence.evidenceId)
  ) {
    errors.push(
      `${label} verified coverage requires a schemaVersion 1 runtimeEvidence bundle`,
    );
    return;
  }
  for (const field of ["commands", "testFiles", "controls"]) {
    if (
      !Array.isArray(evidence[field]) ||
      evidence[field].length === 0 ||
      evidence[field].some((value) => !nonEmptyString(value))
    ) {
      errors.push(`${label} runtimeEvidence.${field} must be a non-empty string array`);
    }
  }
  const evidenceControls = new Set(
    Array.isArray(evidence.controls) ? evidence.controls : [],
  );
  const variants = Array.isArray(operation.authorityVariants)
    ? operation.authorityVariants
    : [{ controls: operation.controls }];
  for (const [variantIndex, variant] of variants.entries()) {
    for (const control of Array.isArray(variant?.controls) ? variant.controls : []) {
      if (!evidenceControls.has(control)) {
        errors.push(
          `${label} runtimeEvidence.controls must include '${control}' for authority variant ${variantIndex}`,
        );
      }
    }
  }
  for (const [index, relativePath] of (evidence.testFiles ?? []).entries()) {
    const absolute = safeRepoPath(
      repoRoot,
      relativePath,
      `${label} runtimeEvidence.testFiles[${index}]`,
      errors,
    );
    if (absolute && !existsSync(absolute)) {
      errors.push(`${label} runtime evidence test file does not exist: ${relativePath}`);
    }
  }
}

function validateMcpAuthorityContract(manifest, repoRoot, errors) {
  const mcpOperations = (manifest.operations ?? []).filter((operation) =>
    (operation.routes ?? []).some((route) => route?.surface === "mcp-tool"),
  );
  if (mcpOperations.length === 0) return;

  const contract = manifest.mcpAuthorityContract;
  if (
    !isObject(contract) ||
    contract.schemaVersion !== 1 ||
    contract.fieldAuthority !== "native-transactional-preflight" ||
    contract.coverageStatus !== "verified" ||
    contract.executionSurface !== "mcp-tool-native"
  ) {
    errors.push(
      "MCP mutation operations require a verified native-transactional field-authority preflight contract with mcp-tool-native execution",
    );
    return;
  }

  if (
    !nonEmptyString(contract.runtimeTestCommand) ||
    !contract.runtimeTestCommand.includes("-p grimodex-db") ||
    !contract.runtimeTestCommand.includes("-p grimodex-mcp")
  ) {
    errors.push(
      "mcpAuthorityContract.runtimeTestCommand must execute both grimodex-db and grimodex-mcp tests",
    );
  }

  const evidenceTests = Array.isArray(contract.evidenceTests)
    ? contract.evidenceTests
    : [];
  if (evidenceTests.length === 0) {
    errors.push(
      "mcpAuthorityContract.evidenceTests must list executable native authority test files",
    );
  }
  const evidenceSymbols = new Set();
  for (const [index, evidence] of evidenceTests.entries()) {
    const label = `mcpAuthorityContract.evidenceTests[${index}]`;
    if (!isObject(evidence) || !nonEmptyString(evidence.file)) {
      errors.push(`${label} must declare a test file`);
      continue;
    }
    const evidencePath = safeRepoPath(
      repoRoot,
      evidence.file,
      `${label}.file`,
      errors,
    );
    if (!evidencePath || !existsSync(evidencePath)) {
      errors.push(`${label} test file does not exist: ${evidence.file}`);
      continue;
    }
    const evidenceSource = readFileSync(evidencePath, "utf8");
    if (
      !/\#\[(?:tokio::)?test\]/.test(evidenceSource) &&
      !/\b(?:describe|it|test)\s*\(/.test(evidenceSource)
    ) {
      errors.push(
        `${label} must contain executable test declarations: ${evidence.file}`,
      );
    }
    if (
      !Array.isArray(evidence.symbols) ||
      evidence.symbols.length === 0 ||
      evidence.symbols.some((symbol) => !nonEmptyString(symbol))
    ) {
      errors.push(`${label}.symbols must list executable test symbols`);
      continue;
    }
    for (const symbol of evidence.symbols) {
      const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const executableRustTest = new RegExp(
        `#\\[(?:tokio::)?test\\]\\s*(?:#\\[[^\\]\\n]+\\]\\s*)*(?:pub(?:\\([^\\)]*\\))?\\s+)?(?:async\\s+)?fn\\s+${escaped}\\b`,
      ).test(evidenceSource);
      const executableJsTest = new RegExp(
        `\\b(?:describe|it|test)\\s*\\([\\s\\S]{0,240}\\b${escaped}\\b`,
      ).test(evidenceSource);
      if (!executableRustTest && !executableJsTest) {
        errors.push(
          `mcpAuthorityContract evidence test symbol is not an executable test in ${evidence.file}: ${symbol}`,
        );
      }
      evidenceSymbols.add(symbol);
    }
  }

  const operationEvidence = Array.isArray(contract.operationEvidence)
    ? contract.operationEvidence
    : [];
  const evidenceByOperation = new Map();
  for (const entry of operationEvidence) {
    if (isObject(entry) && nonEmptyString(entry.operationId)) {
      evidenceByOperation.set(entry.operationId, entry);
    }
  }
  for (const operation of mcpOperations) {
    if (
      operation.feedPolicy !== "excluded" &&
      (!Array.isArray(operation.controls) ||
        !operation.controls.includes("field-authority"))
    ) {
      errors.push(
        `operation ${operation.id} MCP coverage must declare field-authority alongside the native preflight contract`,
      );
    }
    const evidence = evidenceByOperation.get(operation.id);
    if (!evidence || !Array.isArray(evidence.symbols) || evidence.symbols.length === 0) {
      errors.push(
        `operation ${operation.id} MCP coverage must link operation-specific executable evidence`,
      );
      continue;
    }
    for (const symbol of evidence.symbols) {
      if (!evidenceSymbols.has(symbol)) {
        errors.push(
          `operation ${operation.id} MCP evidence symbol is not linked to an executable evidence test: ${symbol}`,
        );
      }
    }
  }
  const mcpOperationIds = new Set(mcpOperations.map((operation) => operation.id));
  for (const operationId of evidenceByOperation.keys()) {
    if (!mcpOperationIds.has(operationId)) {
      errors.push(
        `mcpAuthorityContract.operationEvidence references a non-MCP operation: ${operationId}`,
      );
    }
  }
}

export function validateChangeFeedWriters({
  repoRoot = REPO_ROOT,
  manifestPath = MANIFEST_PATH,
  registryPath = REGISTRY_PATH,
  knownRoutes = KNOWN_CHANGE_FEED_ROUTES,
  requireRuntimeCoverage = false,
} = {}) {
  const errors = [];
  const manifest = readJson(
    manifestPath,
    "change feed writer manifest",
    errors,
  );
  const registry = readJson(registryPath, "protected writer registry", errors);
  const policyCounts = { required: 0, delegated: 0, excluded: 0 };
  const coverageCounts = { declared: 0, implemented: 0, verified: 0 };
  if (!manifest || !registry) {
    return {
      errors,
      operationCount: 0,
      policyCounts,
      coverageCounts,
      knownRouteCount: knownRoutes.length,
    };
  }

  if (manifest.schemaVersion !== 1) {
    errors.push("change feed writer manifest schemaVersion must be 1");
  }
  if (manifest.gateId !== "gate-c1") {
    errors.push("change feed writer manifest gateId must be gate-c1");
  }
  validateWriterMatrix(manifest, errors);
  if (!Array.isArray(manifest.operations)) {
    errors.push("change feed writer manifest operations must be an array");
    return {
      errors,
      operationCount: 0,
      policyCounts,
      coverageCounts,
      knownRouteCount: knownRoutes.length,
    };
  }
  if (!Array.isArray(registry)) {
    errors.push("protected writer registry must be an array");
    return {
      errors,
      operationCount: manifest.operations.length,
      policyCounts,
      coverageCounts,
      knownRouteCount: knownRoutes.length,
    };
  }

  const activeWriterIds = new Set(
    registry
      .filter(
        (entry) =>
          entry?.enforcement === "active" && nonEmptyString(entry.writer),
      )
      .map((entry) => entry.writer),
  );
  const coveredWriterIds = new Set();
  const operationIds = new Set();
  const routeOwners = new Map();
  const sourceCache = new Map();

  for (const [index, operation] of manifest.operations.entries()) {
    if (!isObject(operation)) {
      errors.push(`operations[${index}] must be an object`);
      continue;
    }
    if (!nonEmptyString(operation.id)) {
      errors.push(`operations[${index}].id must be non-empty`);
      continue;
    }
    if (operationIds.has(operation.id)) {
      errors.push(`duplicate operation id ${operation.id}`);
    }
    operationIds.add(operation.id);
    const label = `operation ${operation.id}`;

    if (!FEED_POLICIES.has(operation.feedPolicy)) {
      errors.push(`${label} feedPolicy is invalid: ${operation.feedPolicy}`);
    } else {
      policyCounts[operation.feedPolicy] += 1;
    }
    if (!COVERAGE_STATUSES.has(operation.coverageStatus)) {
      errors.push(
        `${label} coverageStatus is invalid: ${operation.coverageStatus}`,
      );
    } else {
      coverageCounts[operation.coverageStatus] += 1;
    }
    if (!nonEmptyString(operation.reason)) {
      errors.push(`${label} reason must be non-empty`);
    }
    if (!SCOPES.has(operation.scope)) {
      errors.push(`${label} scope is invalid: ${operation.scope}`);
    }

    if (!Array.isArray(operation.writerIds)) {
      errors.push(`${label} writerIds must be an array`);
    } else {
      const localWriters = new Set();
      for (const writerId of operation.writerIds) {
        if (!nonEmptyString(writerId)) {
          errors.push(`${label} has an invalid writer id`);
          continue;
        }
        if (localWriters.has(writerId)) {
          errors.push(`${label} has duplicate writer id ${writerId}`);
        }
        localWriters.add(writerId);
        if (!activeWriterIds.has(writerId)) {
          errors.push(`${label} references unknown writer id ${writerId}`);
        } else {
          coveredWriterIds.add(writerId);
        }
      }
    }

    if (!Array.isArray(operation.requiredIdentities)) {
      errors.push(`${label} requiredIdentities must be an array`);
    } else if (operation.feedPolicy !== "excluded") {
      for (const identity of TRANSACTION_IDENTITIES) {
        if (!operation.requiredIdentities.includes(identity)) {
          errors.push(`${label} requiredIdentities must include ${identity}`);
        }
      }
    }

    if (operation.feedPolicy === "excluded") {
      if (!EXCLUSION_REASONS.has(operation.exclusionReason)) {
        errors.push(`${label} exclusionReason is invalid or missing`);
      }
      if (operation.canonical !== null) {
        errors.push(
          `${label} canonical must be null when feedPolicy is excluded`,
        );
      }
    } else {
      if (Object.hasOwn(operation, "exclusionReason")) {
        errors.push(`${label} must not define exclusionReason unless excluded`);
      }
      if (!isObject(operation.canonical)) {
        errors.push(`${label} canonical must be an object`);
      } else {
        if (!CANONICAL_ORIGINS.has(operation.canonical.origin)) {
          errors.push(
            `${label} canonical.origin is invalid: ${operation.canonical.origin}`,
          );
        }
        if (!nonEmptyString(operation.canonical.opType)) {
          errors.push(`${label} canonical.opType must be non-empty`);
        }
      }
      if (requireRuntimeCoverage && operation.coverageStatus !== "verified") {
        errors.push(
          `${label} must have coverageStatus verified for runtime coverage`,
        );
      }
    }

    validateRuntimeEvidence(manifest, operation, repoRoot, errors);
    validateImplementation(operation, repoRoot, errors, sourceCache);
    validateRoutes(operation, repoRoot, errors, routeOwners, sourceCache);
    validateRendererAuthorityParity(
      manifest,
      operation,
      repoRoot,
      errors,
      sourceCache,
    );
  }

  validateMcpAuthorityContract(manifest, repoRoot, errors);

  for (const writerId of [...activeWriterIds].sort()) {
    if (!coveredWriterIds.has(writerId)) {
      errors.push(
        `active writer id ${writerId} is not covered by an operation policy`,
      );
    }
  }
  for (const route of knownRoutes) {
    const key = `${route.surface}:${route.name}`;
    if (!routeOwners.has(key)) {
      errors.push(
        `known route ${key} is not covered by the change feed writer manifest`,
      );
    }
  }

  return {
    errors,
    operationCount: manifest.operations.length,
    policyCounts,
    coverageCounts,
    knownRouteCount: knownRoutes.length,
  };
}

function parseArgs(argv) {
  return {
    json: argv.includes("--json"),
    requireRuntimeCoverage: argv.includes("--require-runtime-coverage"),
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = validateChangeFeedWriters({
    requireRuntimeCoverage: args.requireRuntimeCoverage,
  });
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else if (result.errors.length === 0) {
    console.log(
      `validate-change-feed-writers: ok (operations=${result.operationCount}, knownRoutes=${result.knownRouteCount}, required=${result.policyCounts.required}, delegated=${result.policyCounts.delegated}, excluded=${result.policyCounts.excluded})`,
    );
  } else {
    console.error("Gate C1 Change Feed writer inventory is invalid:");
    for (const error of result.errors) console.error(`  - ${error}`);
  }
  if (result.errors.length > 0) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}
