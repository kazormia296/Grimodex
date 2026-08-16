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
 * SQL it describes. It does not assert that Backfill/Verify/Rebuild/Repair
 * Run creation, the bootstrap trigger, or the five named API operations
 * are implemented yet; that is C2-T2/C2-Z follow-on work.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

const MIGRATE_RS_PATH =
  "src-tauri/crates/grimodex-db/src/migrate.rs";
const RUN_KIND_CHECK_PATTERN = /CHECK\(run_kind IN \(([^)]*)\)\)/g;

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
      new Set(
        [...match[1].matchAll(/'([^']+)'/g)].map((entry) => entry[1]),
      ),
  );
  const [first, ...rest] = sets;
  for (const [index, set] of rest.entries()) {
    const same =
      set.size === first.size && [...first].every((value) => set.has(value));
    if (!same) {
      errors.push(
        `migrate.rs declares two different 'run_kind' CHECK constraints (occurrence 1 and occurrence ${index + 2}); they must stay in lockstep`,
      );
    }
  }
  return first;
}

function validateRunKinds(policy, sqlRunKindValues, errors) {
  if (!isObject(policy) || !Array.isArray(policy.runKinds)) return;
  const seen = new Set();
  for (const entry of policy.runKinds) {
    if (!isObject(entry) || !isNonEmptyString(entry.runKind)) continue;
    if (seen.has(entry.runKind)) {
      errors.push(`duplicate runKind: ${entry.runKind}`);
    }
    seen.add(entry.runKind);

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
      errors.push(`narrative-run-kind-policy.json is missing runKind: ${runKind}`);
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

  validateRunKinds(policy, sqlRunKindValues, errors);
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
