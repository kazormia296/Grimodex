#!/usr/bin/env node
/**
 * Validate the Gate C2 Run Kind Policy contract
 * (`policies/narrative/narrative-run-kind-policy.json`).
 *
 * This is the Lane K/N design decision ratified after C2-T1: which of
 * Legacy Backfill, Dependency Verify, Rebuild Derived State, Incremental
 * Freshness, and Repair Durable Declarations run automatically versus require
 * a human trigger, and what each is and is not allowed to write. This
 * validator checks the contract is internally consistent, matches its JSON
 * Schema, and that
 * every `existingRunKindColumnValue` it claims actually appears in the
 * real `narrative_extraction_runs.run_kind` CHECK constraint in
 * `migrate.rs` — so this policy document cannot silently drift from the
 * SQL it describes.
 *
 * It also cross-checks each Run Kind's `implementationStatus` against the
 * real Rust call graph, in both directions: a Run Kind that declares an
 * automatic trigger as `wired` must have a production caller for its
 * `triggerSymbol`, and one that declares `unwired-blocked` must have none.
 * Incremental Freshness additionally proves that Electron main creates and
 * starts its scheduler, while its main-only N-API method remains outside both
 * renderer command allowlists.
 * That check exists because this contract previously declared
 * `dependency-backfill` as `automatic-once-after-schema-upgrade` while the
 * post-open trigger had been removed from the runtime, and the validator
 * passed anyway. A machine-readable contract describing a future state as
 * if it were live is worse than no contract, so the drift now fails the
 * gate whichever side moves.
 *
 * It still does not assert that the named API operations behave correctly,
 * only that the trigger wiring the contract claims matches reality.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

const MIGRATE_RS_PATH = "src-tauri/crates/grimodex-db/src/migrate.rs";
const ELECTRON_MAIN_INDEX_PATH = "electron/main/index.ts";
const IPC_CONTRACT_PATH = "electron/shared/ipcContract.ts";
const FAILURE_POLICY_PATH = "policies/narrative/narrative-failure-policy.json";
const RUN_KIND_CHECK_PATTERN = /CHECK\(run_kind IN \(([^)]*)\)\)/g;

// Rust sources scanned for automatic trigger call sites.
const RUST_SOURCE_ROOTS = [
  "src-tauri/crates",
  "electron/native/grimodex-node/src",
];

// Most calls from the N-API boundary are the manual Admin IPC surface and must
// not count as an automatic trigger. A main-process-only automatic entrypoint
// can opt in only when its exact Rust method is both declared in
// implementationStatus.productionEntryPoints and listed in the validator-owned
// main-only allowlist below. Renderer-facing Admin methods remain excluded even
// if a policy edit starts naming their snake_case Rust implementation.
const MANUAL_IPC_FILE = "electron/native/grimodex-node/src/lib.rs";
const MAIN_ONLY_NAPI_PRODUCTION_ENTRY_POINTS = new Set([
  "run_narrative_freshness_cycle",
]);

const REQUIRED_RUN_KINDS = [
  "dependency-backfill",
  "dependency-verify",
  "dependency-rebuild-derived",
  "incremental-freshness",
  "dependency-repair",
];

const INCREMENTAL_FRESHNESS_CURSOR_CONSUMER_ID =
  "narrative-incremental-freshness/v1";
const INCREMENTAL_FRESHNESS_BATCH_SIZE = 32;
const INCREMENTAL_FRESHNESS_WRITES_ALLOWED = [
  "run-task-attempt-state",
  "narrative-change-set",
  "freshness-evaluator-cursor",
  "dependency-edge-state",
  "consumer-freshness",
  "finding-observation",
];
const INCREMENTAL_FRESHNESS_RESUME_SEMANTICS = [
  "reuse-sealed-change-set",
  "reclaim-expired-cursor-reservation",
  "resume-running-run-task-attempt",
];
const INCREMENTAL_FRESHNESS_COMPLETED_UNACKED_INVARIANT =
  "never-reuse-completed-run-and-reprocess-under-new-runtime-owned-run";
const INCREMENTAL_FRESHNESS_RETRY_POLICY = {
  maxAttemptsPerTask: 3,
  exhaustedFailureCode: "NEX_INCREMENTAL_FRESHNESS_RETRY_EXHAUSTED",
  exhaustedRetryDisposition: "terminal",
  failurePolicyVersion: "v1",
  taskAndRunStatusAfterExhaustion: "failed",
  cursorAfterExhaustion: "reserved-lease-free",
  schedulerAfterExhaustion: "idle-until-new-semantic-epoch",
  newEpochReservationRecovery: "release-and-reprocess-under-new-run",
  exhaustedRunAfterNewEpoch: "remains-terminal-failed",
};

function sameStringArray(actual, expected) {
  return (
    Array.isArray(actual) &&
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index])
  );
}

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

function readSource(repoRoot, relativePath, errors, label) {
  const absolute = path.join(repoRoot, relativePath);
  if (!existsSync(absolute)) {
    errors.push(`${label} is missing: ${relativePath}`);
    return null;
  }
  return readFileSync(absolute, "utf8");
}

function sourceSection(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  if (start < 0) return null;
  const end = source.indexOf(endMarker, start + startMarker.length);
  if (end < 0) return null;
  return source.slice(start, end);
}

function stripJavaScriptComments(source, { stripStrings = false } = {}) {
  let output = "";
  let quote = null;
  for (let index = 0; index < source.length; index += 1) {
    const current = source[index];
    const next = source[index + 1];

    if (quote !== null) {
      if (current === "\\") {
        output += stripStrings ? " " : current;
        if (next !== undefined) {
          output += stripStrings ? (next === "\n" ? "\n" : " ") : next;
          index += 1;
        }
      } else {
        output += stripStrings ? (current === "\n" ? "\n" : " ") : current;
        if (current === quote) quote = null;
      }
      continue;
    }

    if (current === "/" && next === "/") {
      output += "  ";
      index += 2;
      while (index < source.length && source[index] !== "\n") {
        output += " ";
        index += 1;
      }
      if (index < source.length) output += "\n";
      continue;
    }
    if (current === "/" && next === "*") {
      output += "  ";
      index += 2;
      while (
        index < source.length &&
        !(source[index] === "*" && source[index + 1] === "/")
      ) {
        output += source[index] === "\n" ? "\n" : " ";
        index += 1;
      }
      if (index < source.length) {
        output += "  ";
        index += 1;
      }
      continue;
    }
    if (current === '"' || current === "'" || current === "`") {
      quote = current;
      output += stripStrings ? " " : current;
      continue;
    }
    output += current;
  }
  return output;
}

function collectRustFiles(repoRoot) {
  const files = [];
  const walk = (absolute) => {
    let entries;
    try {
      entries = readdirSync(absolute, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = path.join(absolute, entry.name);
      if (entry.isDirectory()) {
        // Build output and non-production Rust targets cannot wire a shipping
        // trigger. Integration tests are compiled as standalone binaries, so
        // treating a call there as production would let a test for an unwired
        // symbol satisfy the very gate that is meant to detect the omission.
        if (
          ["target", "node_modules", "tests", "benches", "examples"].includes(
            entry.name,
          )
        ) {
          continue;
        }
        walk(child);
      } else if (entry.isFile() && entry.name.endsWith(".rs")) {
        files.push(child);
      }
    }
  };
  for (const root of RUST_SOURCE_ROOTS) {
    const absolute = path.join(repoRoot, root);
    if (existsSync(absolute) && statSync(absolute).isDirectory())
      walk(absolute);
  }
  return files;
}

/**
 * Line numbers (1-based) of `source` that are production code — outside any
 * top-level `#[cfg(test)]` item.
 *
 * Deliberately not "everything before the first `#[cfg(test)]`": `open.rs`
 * has an inline test module partway down and then continues with more
 * production code, including the workspace-maintenance worker where a
 * Backfill trigger would be wired. Cutting at the first occurrence silently
 * skipped exactly the region this check exists to watch.
 *
 * Top-level items close with a `}` in column 0, which is what ends the skip.
 */
function productionLineNumbers(source) {
  const lines = source.split("\n");
  const kept = [];
  let inTopLevelTestItem = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (inTopLevelTestItem) {
      if (line === "}") inTopLevelTestItem = false;
      continue;
    }
    // Only column-0 attributes start a top-level test item; an indented one
    // belongs to a nested item whose enclosing code is still production.
    if (line.startsWith("#[cfg(test)]")) {
      inTopLevelTestItem = true;
      continue;
    }
    kept.push(index + 1);
  }
  return kept;
}

/**
 * Production (non-test, non-comment, non-definition) call sites of `symbol`.
 * The N-API boundary is counted only for an exact declared main-only method.
 */
function nearestRustFunction(lines, lineIndex) {
  for (let index = lineIndex; index >= 0; index -= 1) {
    const match = lines[index].match(
      /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([a-zA-Z0-9_]+)\b/u,
    );
    if (match) return { name: match[1], lineIndex: index };
  }
  return null;
}

function hasNapiMethodAttribute(lines, functionLineIndex) {
  for (let index = functionLineIndex - 1; index >= 0; index -= 1) {
    const trimmed = lines[index].trim();
    if (trimmed === "") continue;
    if (!trimmed.startsWith("#[")) return false;
    if (/^#\[napi(?:\([^\]]*\))?\]$/u.test(trimmed)) return true;
  }
  return false;
}

function findAutomaticCallSites(
  rustFiles,
  repoRoot,
  symbol,
  productionEntryPoints = [],
) {
  const callSites = [];
  const declaredEntryPoints = new Set(productionEntryPoints);
  const callPattern = new RegExp(`\\b${symbol}\\s*\\(`, "u");
  const definitionPattern = new RegExp(`\\bfn\\s+${symbol}\\b`, "u");
  for (const absolute of rustFiles) {
    const relative = path
      .relative(repoRoot, absolute)
      .split(path.sep)
      .join("/");
    let source;
    try {
      source = readFileSync(absolute, "utf8");
    } catch {
      continue;
    }
    if (!source.includes(symbol)) continue;
    const lines = source.split("\n");
    for (const lineNumber of productionLineNumbers(source)) {
      const line = lines[lineNumber - 1];
      const trimmed = line.trim();
      if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;
      if (definitionPattern.test(line)) continue;
      if (!callPattern.test(line)) continue;
      if (relative === MANUAL_IPC_FILE) {
        const enclosingFunction = nearestRustFunction(lines, lineNumber - 1);
        if (
          !enclosingFunction ||
          !declaredEntryPoints.has(enclosingFunction.name) ||
          !MAIN_ONLY_NAPI_PRODUCTION_ENTRY_POINTS.has(enclosingFunction.name) ||
          !hasNapiMethodAttribute(lines, enclosingFunction.lineIndex)
        ) {
          continue;
        }
      }
      callSites.push(`${relative}:${lineNumber}`);
    }
  }
  return callSites;
}

/**
 * `state` and the blocked-* fields must agree, for every Run Kind.
 *
 * This runs before the automatic-trigger call-graph check and applies to
 * manual-only Run Kinds too. A `wired` entry that still carries a
 * `blockedOn` is the contract saying "this is live" and "this is waiting on
 * something" in the same breath — a reader has no way to tell which half is
 * current, which is exactly the drift `implementationStatus` exists to make
 * impossible.
 */
function validateStateConsistency(entry, status, errors) {
  if (status.state === "wired") {
    if (isNonEmptyString(status.blockedReason)) {
      errors.push(
        `${entry.runKind} declares implementationStatus.state 'wired' but still carries a blockedReason — a wired Run Kind is not blocked on anything; drop the field or set state to 'unwired-blocked'`,
      );
    }
    if (Array.isArray(status.blockedOn) && status.blockedOn.length > 0) {
      errors.push(
        `${entry.runKind} declares implementationStatus.state 'wired' but still carries blockedOn (${status.blockedOn.join(", ")}) — resolve the entries and drop the field, or set state to 'unwired-blocked'`,
      );
    }
    return;
  }

  if (status.state === "unwired-blocked") {
    if (!isNonEmptyString(status.blockedReason)) {
      errors.push(
        `${entry.runKind} is 'unwired-blocked' but has no blockedReason explaining why the declared trigger is not live`,
      );
    }
    if (!Array.isArray(status.blockedOn) || status.blockedOn.length === 0) {
      errors.push(
        `${entry.runKind} is 'unwired-blocked' but has no blockedOn naming what must land first`,
      );
    }
  }
}

function validateImplementationStatus(entry, rustFiles, repoRoot, errors) {
  const status = entry.implementationStatus;
  if (!isObject(status)) return;

  validateStateConsistency(entry, status, errors);

  const isAutomatic =
    typeof entry.trigger === "string" && entry.trigger.startsWith("automatic");

  if (!isAutomatic) {
    if (isNonEmptyString(status.triggerSymbol)) {
      errors.push(
        `${entry.runKind} declares implementationStatus.triggerSymbol but its trigger is '${entry.trigger}'; only automatic-* Run Kinds have an automatic trigger to wire`,
      );
    }
    return;
  }

  if (!isNonEmptyString(status.triggerSymbol)) {
    errors.push(
      `${entry.runKind} declares trigger '${entry.trigger}' but implementationStatus has no triggerSymbol, so the wiring cannot be checked`,
    );
    return;
  }

  const callSites = findAutomaticCallSites(
    rustFiles,
    repoRoot,
    status.triggerSymbol,
    status.productionEntryPoints,
  );

  if (status.state === "wired" && callSites.length === 0) {
    errors.push(
      `${entry.runKind} declares implementationStatus.state 'wired', but no production caller of '${status.triggerSymbol}' exists outside test modules (calls in ${MANUAL_IPC_FILE} count only from an exact declared productionEntryPoint) — the automatic trigger this contract promises is not actually wired`,
    );
  }

  if (status.state === "unwired-blocked" && callSites.length > 0) {
    errors.push(
      `${entry.runKind} declares implementationStatus.state 'unwired-blocked', but '${status.triggerSymbol}' now has ${callSites.length} production call site(s) (${callSites.join(", ")}) — the trigger was wired without updating this contract`,
    );
  }
}

function validateIncrementalFreshnessElectronWiring(policy, repoRoot, errors) {
  if (!isObject(policy) || !Array.isArray(policy.runKinds)) return;
  const incremental = policy.runKinds.find(
    (entry) => entry?.runKind === "incremental-freshness",
  );
  if (!isObject(incremental)) return;

  if (incremental.implementationStatus?.state === "wired") {
    const mainIndex = readSource(
      repoRoot,
      ELECTRON_MAIN_INDEX_PATH,
      errors,
      "Electron main entrypoint",
    );
    if (mainIndex !== null) {
      const mainWithoutComments = stripJavaScriptComments(mainIndex);
      const mainCode = stripJavaScriptComments(mainIndex, {
        stripStrings: true,
      });
      const importsCanonicalScheduler =
        /import\s*\{[^}]*\bcreateNarrativeFreshnessScheduler\b[^}]*\}\s*from\s*["']\.\/narrativeFreshness\.js["']/su.test(
          mainWithoutComments,
        );
      if (!importsCanonicalScheduler) {
        errors.push(
          `incremental-freshness is wired but ${ELECTRON_MAIN_INDEX_PATH} does not import createNarrativeFreshnessScheduler from './narrativeFreshness.js'`,
        );
      }

      const creations = [
        ...mainCode.matchAll(
          /\b(?:const|let)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*=\s*createNarrativeFreshnessScheduler\s*\(/gu,
        ),
      ];
      if (creations.length === 0) {
        errors.push(
          `incremental-freshness is wired but ${ELECTRON_MAIN_INDEX_PATH} does not create the Narrative Freshness scheduler`,
        );
      } else {
        const started = creations.some((creation) => {
          const variable = creation[1].replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
          return new RegExp(`\\b${variable}\\.start\\s*\\(`, "u").test(
            mainCode,
          );
        });
        if (!started) {
          errors.push(
            `incremental-freshness is wired but ${ELECTRON_MAIN_INDEX_PATH} creates its scheduler without calling start()`,
          );
        }
      }
    }
  }

  const ipcContract = readSource(
    repoRoot,
    IPC_CONTRACT_PATH,
    errors,
    "Electron IPC contract",
  );
  if (ipcContract === null) return;

  const napiCommands = sourceSection(
    stripJavaScriptComments(ipcContract),
    "export const NAPI_COMMANDS",
    "export const SHELL_COMMAND_NAMES",
  );
  if (napiCommands === null) {
    errors.push(
      `${IPC_CONTRACT_PATH} does not expose the NAPI_COMMANDS section needed to verify the main-only Freshness boundary`,
    );
  } else if (
    /\b(?:run_narrative_freshness_cycle|runNarrativeFreshnessCycle)\b/u.test(
      napiCommands,
    )
  ) {
    errors.push(
      `incremental-freshness main-only N-API method must not be registered in ${IPC_CONTRACT_PATH}'s renderer NAPI_COMMANDS`,
    );
  }

  const shellCommands = sourceSection(
    stripJavaScriptComments(ipcContract),
    "export const SHELL_COMMAND_NAMES",
    "export interface DispatchDeps",
  );
  if (shellCommands === null) {
    errors.push(
      `${IPC_CONTRACT_PATH} does not expose the renderer shell command allowlist needed to verify the main-only Freshness boundary`,
    );
  } else if (
    /["'](?:run_narrative_freshness_cycle|runNarrativeFreshnessCycle)["']/u.test(
      shellCommands,
    )
  ) {
    errors.push(
      `incremental-freshness main-only N-API method must not be registered in ${IPC_CONTRACT_PATH}'s renderer shell command allowlist`,
    );
  }
}

function validateIncrementalFreshnessFailurePolicy(policy, repoRoot, errors) {
  if (!isObject(policy) || !Array.isArray(policy.runKinds)) return;
  const incremental = policy.runKinds.find(
    (entry) => entry?.runKind === "incremental-freshness",
  );
  if (!isObject(incremental) || !isObject(incremental.retryPolicy)) return;

  const failurePolicy = readJson(
    repoRoot,
    FAILURE_POLICY_PATH,
    errors,
    "Narrative failure policy",
  );
  if (!isObject(failurePolicy) || !Array.isArray(failurePolicy.policies)) {
    return;
  }
  const registered = failurePolicy.policies.find(
    (entry) =>
      entry?.failureCode === incremental.retryPolicy.exhaustedFailureCode,
  );
  if (!isObject(registered)) {
    errors.push(
      `incremental-freshness.retryPolicy.exhaustedFailureCode '${incremental.retryPolicy.exhaustedFailureCode}' is not registered in ${FAILURE_POLICY_PATH}`,
    );
    return;
  }
  if (
    registered.retryDisposition !==
    incremental.retryPolicy.exhaustedRetryDisposition
  ) {
    errors.push(
      `incremental-freshness retry exhaustion disposition '${incremental.retryPolicy.exhaustedRetryDisposition}' disagrees with ${FAILURE_POLICY_PATH} ('${registered.retryDisposition}')`,
    );
  }
  if (
    registered.policyVersion !== incremental.retryPolicy.failurePolicyVersion
  ) {
    errors.push(
      `incremental-freshness retry failure policy version '${incremental.retryPolicy.failurePolicyVersion}' disagrees with ${FAILURE_POLICY_PATH} ('${registered.policyVersion}')`,
    );
  }
  if (registered.maxAttempts !== incremental.retryPolicy.maxAttemptsPerTask) {
    errors.push(
      `incremental-freshness retry max attempts '${incremental.retryPolicy.maxAttemptsPerTask}' disagrees with ${FAILURE_POLICY_PATH} ('${registered.maxAttempts}')`,
    );
  }
}

function validateAgainstSchema(repoRoot, schemaName, contractName, errors) {
  const schema = readJson(
    repoRoot,
    `policies/narrative/schemas/${schemaName}`,
    errors,
    `policy JSON Schema ${schemaName}`,
  );
  const contract = readJson(
    repoRoot,
    `policies/narrative/${contractName}`,
    errors,
    `policy contract ${contractName}`,
  );
  if (!schema || !contract) return contract;
  try {
    const ajv = new Ajv2020({ allErrors: true, strict: false });
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
  return contract;
}

function extractSqlRunKindValues(repoRoot, errors) {
  const absolute = path.join(repoRoot, MIGRATE_RS_PATH);
  if (!existsSync(absolute)) {
    errors.push(`migrate.rs is missing: ${MIGRATE_RS_PATH}`);
    return null;
  }
  const source = readFileSync(absolute, "utf8");
  const matches = [...source.matchAll(RUN_KIND_CHECK_PATTERN)];
  if (matches.length === 0) {
    errors.push(
      `could not find a 'CHECK(run_kind IN (...))' constraint in ${MIGRATE_RS_PATH}`,
    );
    return null;
  }
  const sets = matches.map(
    (match) =>
      new Set([...match[1].matchAll(/'([^']+)'/g)].map((entry) => entry[1])),
  );
  // migrate.rs necessarily accumulates one 'CHECK(run_kind IN (...))'
  // string per schema version that ever widened it — each earlier
  // ADD COLUMN / rebuild statement must keep its original narrower value
  // set verbatim so replaying migration history against an old workspace
  // still reproduces the exact intermediate schema shape it had at that
  // version. The canonical "what does the CHECK accept today" answer is
  // therefore the widest set present, and every other occurrence must be
  // a subset of it (Gate C2 only ever adds run_kind values, never removes
  // one) rather than identical to it.
  let canonical = sets[0];
  for (const set of sets) {
    if (set.size > canonical.size) canonical = set;
  }
  for (const [index, set] of sets.entries()) {
    const isSubset = [...set].every((value) => canonical.has(value));
    if (!isSubset) {
      errors.push(
        `migrate.rs occurrence ${index + 1} of 'CHECK(run_kind IN (...))' contains a value absent from the widest ` +
          `occurrence found (${[...canonical].join(", ")}); a narrower historical CHECK must stay a subset of the current one`,
      );
    }
  }
  return canonical;
}

function validateRunKinds(policy, sqlRunKindValues, errors, repoRoot) {
  if (!isObject(policy) || !Array.isArray(policy.runKinds)) return;
  const rustFiles = repoRoot ? collectRustFiles(repoRoot) : [];
  const seen = new Set();
  for (const entry of policy.runKinds) {
    if (!isObject(entry) || !isNonEmptyString(entry.runKind)) continue;
    if (seen.has(entry.runKind)) {
      errors.push(`duplicate runKind: ${entry.runKind}`);
    }
    seen.add(entry.runKind);

    if (repoRoot) {
      validateImplementationStatus(entry, rustFiles, repoRoot, errors);
    }

    if (entry.existingRunKindColumnValue !== null) {
      if (
        sqlRunKindValues &&
        !sqlRunKindValues.has(entry.existingRunKindColumnValue)
      ) {
        errors.push(
          `${entry.runKind}.existingRunKindColumnValue ('${entry.existingRunKindColumnValue}') is not a value the real 'run_kind' CHECK constraint in ${MIGRATE_RS_PATH} accepts`,
        );
      }
    }

    if (entry.runKind === "incremental-freshness") {
      if (entry.existingRunKindColumnValue !== "freshness-evaluation") {
        errors.push(
          "incremental-freshness.existingRunKindColumnValue must be 'freshness-evaluation'",
        );
      }
      if (entry.cursorBound !== true) {
        errors.push("incremental-freshness.cursorBound must be true");
      }
      if (entry.cursorConsumerId !== INCREMENTAL_FRESHNESS_CURSOR_CONSUMER_ID) {
        errors.push(
          `incremental-freshness.cursorConsumerId must be '${INCREMENTAL_FRESHNESS_CURSOR_CONSUMER_ID}'`,
        );
      }
      if (
        entry.maxCanonicalSequencesPerBatch !== INCREMENTAL_FRESHNESS_BATCH_SIZE
      ) {
        errors.push(
          `incremental-freshness.maxCanonicalSequencesPerBatch must be ${INCREMENTAL_FRESHNESS_BATCH_SIZE}`,
        );
      }
      if (entry.executionAuthority !== "serialized-live-workspace-authority") {
        errors.push(
          "incremental-freshness.executionAuthority must be 'serialized-live-workspace-authority'",
        );
      }
      if (
        entry.missingSemanticEpochBehavior !==
        "wait-for-canonical-epoch-authority"
      ) {
        errors.push(
          "incremental-freshness.missingSemanticEpochBehavior must be 'wait-for-canonical-epoch-authority'",
        );
      }
      for (const [field, expected] of Object.entries(
        INCREMENTAL_FRESHNESS_RETRY_POLICY,
      )) {
        if (entry.retryPolicy?.[field] !== expected) {
          errors.push(
            `incremental-freshness.retryPolicy.${field} must be '${expected}'`,
          );
        }
      }
      if (entry.writes !== "rebuildable-state-only") {
        errors.push(
          "incremental-freshness.writes must be 'rebuildable-state-only'",
        );
      }
      if (entry.sameWorkKeyReuse !== "reuse-running-only") {
        errors.push(
          "incremental-freshness.sameWorkKeyReuse must be 'reuse-running-only'",
        );
      }
      if (
        !sameStringArray(
          entry.resumeSemantics,
          INCREMENTAL_FRESHNESS_RESUME_SEMANTICS,
        )
      ) {
        errors.push(
          "incremental-freshness.resumeSemantics must pin only sealed-range reclaim and running Run/Task/Attempt resume; completed replay reuse is forbidden",
        );
      }
      if (
        entry.completedWithUnackedRangeInvariant !==
        INCREMENTAL_FRESHNESS_COMPLETED_UNACKED_INVARIANT
      ) {
        errors.push(
          `incremental-freshness.completedWithUnackedRangeInvariant must be '${INCREMENTAL_FRESHNESS_COMPLETED_UNACKED_INVARIANT}'`,
        );
      }
      if (
        !sameStringArray(
          entry.writesAllowed,
          INCREMENTAL_FRESHNESS_WRITES_ALLOWED,
        )
      ) {
        errors.push(
          "incremental-freshness.writesAllowed must contain only its declared operational and rebuildable-state writes",
        );
      }
      for (const forbiddenWrite of ["domain-state", "attention"]) {
        if (!entry.forbiddenWrites?.includes(forbiddenWrite)) {
          errors.push(
            `incremental-freshness.forbiddenWrites must include '${forbiddenWrite}'`,
          );
        }
      }
      if (
        entry.implementationStatus?.triggerSymbol !==
        "run_incremental_freshness_cycle"
      ) {
        errors.push(
          "incremental-freshness.implementationStatus.triggerSymbol must be 'run_incremental_freshness_cycle'",
        );
      }
      if (
        !sameStringArray(entry.implementationStatus?.productionEntryPoints, [
          "run_narrative_freshness_cycle",
        ])
      ) {
        errors.push(
          "incremental-freshness.implementationStatus.productionEntryPoints must name only 'run_narrative_freshness_cycle'",
        );
      }
    } else if (entry.cursorBound !== false) {
      errors.push(
        `${entry.runKind}.cursorBound must be false; only incremental-freshness may bind a Run to a Change Feed cursor`,
      );
    }

    // Every automatic trigger must say when it fires; every manual-only
    // Run Kind must say so via trigger, not bury it in prose only.
    if (
      entry.trigger === "automatic-on-trigger-event" &&
      (!Array.isArray(entry.triggerEvents) || entry.triggerEvents.length === 0)
    ) {
      errors.push(
        `${entry.runKind} declares trigger 'automatic-on-trigger-event' but has no triggerEvents`,
      );
    }
    if (
      entry.trigger === "automatic-when-derived-state-absent-or-invalid" &&
      (!Array.isArray(entry.triggerEvents) || entry.triggerEvents.length === 0)
    ) {
      errors.push(
        `${entry.runKind} declares trigger 'automatic-when-derived-state-absent-or-invalid' but has no triggerEvents`,
      );
    }

    // Only the human-triggered Repair Run Kind may declare a
    // repair-shaped precondition/allow/forbid list; every other Run Kind
    // that carries one would blur the durable-declaration boundary this
    // contract exists to keep sharp.
    const repairOnlyFields = [
      "requiredPreconditions",
      "allowedRepairs",
      "forbiddenRepairs",
      "unrecoverableDisposition",
    ];
    if (entry.runKind !== "dependency-repair") {
      for (const field of repairOnlyFields) {
        if (entry[field] !== undefined) {
          errors.push(
            `${entry.runKind} must not declare '${field}'; only dependency-repair may`,
          );
        }
      }
    } else {
      for (const field of repairOnlyFields) {
        if (entry[field] === undefined) {
          errors.push(`dependency-repair is missing required field '${field}'`);
        }
      }
    }

    // Verify is diagnostics-only and must say so explicitly, plus declare
    // it never repairs as a side effect.
    if (entry.runKind === "dependency-verify") {
      if (entry.writes !== "diagnostics-only") {
        errors.push("dependency-verify.writes must be 'diagnostics-only'");
      }
      if (entry.forbidSideEffectRepair !== true) {
        errors.push(
          "dependency-verify must declare forbidSideEffectRepair: true",
        );
      }
    }

    // Rebuild Derived State must never claim it writes the durable graph
    // or Domain data.
    if (entry.runKind === "dependency-rebuild-derived") {
      if (entry.writes !== "rebuildable-state-only") {
        errors.push(
          "dependency-rebuild-derived.writes must be 'rebuildable-state-only'",
        );
      }
      if (
        !Array.isArray(entry.forbiddenWrites) ||
        entry.forbiddenWrites.length === 0
      ) {
        errors.push(
          "dependency-rebuild-derived must declare a non-empty forbiddenWrites list",
        );
      }
    }
  }

  for (const runKind of REQUIRED_RUN_KINDS) {
    if (!seen.has(runKind)) {
      errors.push(
        `narrative-run-kind-policy.json is missing runKind: ${runKind}`,
      );
    }
  }
  for (const runKind of seen) {
    if (!REQUIRED_RUN_KINDS.includes(runKind)) {
      errors.push(
        `narrative-run-kind-policy.json declares unexpected runKind: ${runKind}`,
      );
    }
  }
}

function validateApiSplitCoversAdminCommands(policy, errors) {
  if (!isObject(policy) || !isObject(policy.apiSplit)) return;
  const declaredOperations = new Set(policy.apiSplit.operations ?? []);
  for (const entry of policy.runKinds ?? []) {
    if (!isObject(entry) || !Array.isArray(entry.adminCommands)) continue;
    for (const command of entry.adminCommands) {
      if (!declaredOperations.has(command)) {
        errors.push(
          `${entry.runKind}.adminCommands references '${command}', which is not listed in apiSplit.operations`,
        );
      }
    }
  }
}

export function validateRunKindPolicy({ repoRoot = REPO_ROOT } = {}) {
  const errors = [];

  const policy = validateAgainstSchema(
    repoRoot,
    "narrative-run-kind-policy.schema.json",
    "narrative-run-kind-policy.json",
    errors,
  );
  const sqlRunKindValues = extractSqlRunKindValues(repoRoot, errors);

  validateRunKinds(policy, sqlRunKindValues, errors, repoRoot);
  validateApiSplitCoversAdminCommands(policy, errors);
  validateIncrementalFreshnessElectronWiring(policy, repoRoot, errors);
  validateIncrementalFreshnessFailurePolicy(policy, repoRoot, errors);

  return { errors };
}

function main() {
  const result = validateRunKindPolicy();
  if (result.errors.length > 0) {
    console.error("Gate C2 Run Kind Policy is invalid:");
    for (const error of result.errors) console.error(`  - ${error}`);
    process.exitCode = 1;
    return;
  }
  console.log("validate-run-kind-policy: ok");
}

if (
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  main();
}
