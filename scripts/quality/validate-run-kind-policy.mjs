#!/usr/bin/env node
/**
 * Validate the Gate C2 Run Kind Policy contract
 * (`policies/narrative/narrative-run-kind-policy.json`).
 *
 * This is the Lane K/N design decision ratified after C2-T1: which of
 * Legacy Backfill, Dependency Verify, Rebuild Derived State, and Repair
 * Durable Declarations run automatically versus require a human trigger,
 * and what each is and is not allowed to write. This validator checks the
 * contract is internally consistent, matches its JSON Schema, and that
 * every `existingRunKindColumnValue` it claims actually appears in the
 * real `narrative_extraction_runs.run_kind` CHECK constraint in
 * `migrate.rs` — so this policy document cannot silently drift from the
 * SQL it describes.
 *
 * It also cross-checks each Run Kind's `implementationStatus` against the
 * real Rust call graph, in both directions: a Run Kind that declares an
 * automatic trigger as `wired` must have a production caller for its
 * `triggerSymbol`, and one that declares `unwired-blocked` must have none.
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
const RUN_KIND_CHECK_PATTERN = /CHECK\(run_kind IN \(([^)]*)\)\)/g;

// Rust sources scanned for automatic trigger call sites.
const RUST_SOURCE_ROOTS = [
  "src-tauri/crates",
  "electron/native/grimodex-node/src",
];

// Calls from the N-API boundary are the *manual* Admin IPC surface by
// construction, so they never count as an automatic trigger.
const MANUAL_IPC_FILE = "electron/native/grimodex-node/src/lib.rs";

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
        // `target/` is build output, not source anyone wires a trigger in.
        if (entry.name === "target" || entry.name === "node_modules") continue;
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
 * Production (non-test, non-comment, non-definition) call sites of `symbol`,
 * excluding the manual Admin IPC boundary.
 */
function findAutomaticCallSites(rustFiles, repoRoot, symbol) {
  const callSites = [];
  const callPattern = new RegExp(`\\b${symbol}\\s*\\(`, "u");
  const definitionPattern = new RegExp(`\\bfn\\s+${symbol}\\b`, "u");
  for (const absolute of rustFiles) {
    const relative = path
      .relative(repoRoot, absolute)
      .split(path.sep)
      .join("/");
    if (relative === MANUAL_IPC_FILE) continue;
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
  );

  if (status.state === "wired" && callSites.length === 0) {
    errors.push(
      `${entry.runKind} declares implementationStatus.state 'wired', but no production caller of '${status.triggerSymbol}' exists outside ${MANUAL_IPC_FILE} and test modules — the automatic trigger this contract promises is not actually wired`,
    );
  }

  if (status.state === "unwired-blocked" && callSites.length > 0) {
    errors.push(
      `${entry.runKind} declares implementationStatus.state 'unwired-blocked', but '${status.triggerSymbol}' now has ${callSites.length} production call site(s) (${callSites.join(", ")}) — the trigger was wired without updating this contract`,
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

  const required = [
    "dependency-backfill",
    "dependency-verify",
    "dependency-rebuild-derived",
    "dependency-repair",
  ];
  for (const runKind of required) {
    if (!seen.has(runKind)) {
      errors.push(
        `narrative-run-kind-policy.json is missing runKind: ${runKind}`,
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
