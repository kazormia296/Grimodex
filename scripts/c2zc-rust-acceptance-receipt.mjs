#!/usr/bin/env node

import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  realpath,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  digestProductJourneyCatalog,
  NARRATIVE_C2ZC_PRODUCT_JOURNEY_CATALOG,
} from "../electron/scripts/product-journey-catalog.mjs";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

export const C2ZC_RUST_ACCEPTANCE_RECEIPT_SCHEMA =
  "grimodex.c2zc.rust-acceptance-receipt";
export const C2ZC_RUST_ACCEPTANCE_RECEIPT_VERSION = 2;
export const C2ZC_RUST_ACCEPTANCE_RECEIPT_PATH =
  ".artifacts/local-ci/c2-zc-rust-acceptance.json";
export const C2ZC_RUST_ACCEPTANCE_CATALOG_DIGEST = digestProductJourneyCatalog(
  NARRATIVE_C2ZC_PRODUCT_JOURNEY_CATALOG,
);
export const C2ZC_RUST_ACCEPTANCE_LOCAL_CI_STAGE_ID =
  "c2-zc-rust-acceptance-gate";
export const C2ZC_RUST_VERIFY_OUTCOME_GATE_ID =
  "c2-zc-production-verify-coverage";

function freezeArgv(argv) {
  return Object.freeze({
    command: argv.command,
    args: Object.freeze([...argv.args]),
    cwd: argv.cwd,
  });
}

function freezeGate(gate) {
  return Object.freeze({
    id: gate.id,
    argv: freezeArgv(gate.argv),
    contract: Object.freeze({ ...gate.contract }),
    source: gate.contract.source,
    test: gate.contract.test,
    fullTestName: gate.contract.fullTestName,
    requiresReceipt: true,
  });
}

export const C2ZC_RUST_ACCEPTANCE_GATES = Object.freeze([
  freezeGate({
    id: "c2-zc-canonical-no-legacy-fallback",
    argv: {
      command: "cargo",
      args: [
        "test",
        "--manifest-path",
        "src-tauri/Cargo.toml",
        "-p",
        "grimodex-db",
        "--test",
        "narrative_c2zc_canonical_cutover",
        "canonical_read_has_no_legacy_fallback_after_generic_cutover",
        "--",
        "--exact",
      ],
      cwd: ".",
    },
    contract: {
      source:
        "src-tauri/crates/grimodex-db/tests/narrative_c2zc_canonical_cutover.rs",
      test: "canonical_read_has_no_legacy_fallback_after_generic_cutover",
      fullTestName:
        "canonical_read_has_no_legacy_fallback_after_generic_cutover",
      readFunction: "canonical_application_freshness",
      noLegacyFallback: true,
    },
  }),
  freezeGate({
    id: "c2-zc-dml-native-owned-table-denial",
    argv: {
      command: "cargo",
      args: [
        "test",
        "--manifest-path",
        "src-tauri/Cargo.toml",
        "-p",
        "grimodex-db",
        "--lib",
        "execute::tests::c2zc_native_owned_tables_reject_all_untrusted_dml_but_allow_reads_and_trusted_writes",
        "--",
        "--exact",
      ],
      cwd: ".",
    },
    contract: {
      source: "src-tauri/crates/grimodex-db/src/execute.rs",
      test: "c2zc_native_owned_tables_reject_all_untrusted_dml_but_allow_reads_and_trusted_writes",
      fullTestName:
        "execute::tests::c2zc_native_owned_tables_reject_all_untrusted_dml_but_allow_reads_and_trusted_writes",
      origin: "SqlOrigin::McpGeneric",
    },
  }),
  freezeGate({
    id: "c2-zc-readiness-corruption-fail-closed",
    argv: {
      command: "cargo",
      args: [
        "test",
        "--manifest-path",
        "src-tauri/Cargo.toml",
        "-p",
        "grimodex-db",
        "--lib",
        "narrative_extraction::c2z_preparation::tests::rebuild_outcome_tamper_and_missing_evidence_fail_closed",
        "--",
        "--exact",
      ],
      cwd: ".",
    },
    contract: {
      source:
        "src-tauri/crates/grimodex-db/src/narrative_extraction/c2z_preparation.rs",
      test: "rebuild_outcome_tamper_and_missing_evidence_fail_closed",
      fullTestName:
        "narrative_extraction::c2z_preparation::tests::rebuild_outcome_tamper_and_missing_evidence_fail_closed",
      proof: "direct persisted Rebuild evidence corruption blocks readiness",
    },
  }),
  freezeGate({
    id: "c2-zc-liveness-restore-lock-binding",
    argv: {
      command: "cargo",
      args: [
        "test",
        "--manifest-path",
        "src-tauri/Cargo.toml",
        "-p",
        "grimodex-db",
        "--test",
        "narrative_c2zc_liveness_binding",
        "same_project_receipt_cannot_cross_database_authority",
        "--",
        "--exact",
      ],
      cwd: ".",
    },
    contract: {
      source:
        "src-tauri/crates/grimodex-db/tests/narrative_c2zc_liveness_binding.rs",
      test: "same_project_receipt_cannot_cross_database_authority",
      fullTestName: "same_project_receipt_cannot_cross_database_authority",
      proof:
        "restore-lock liveness receipt remains bound to the project Database authority",
    },
  }),
  freezeGate({
    id: "c2-zc-native-restore-lock-release",
    argv: {
      command: "cargo",
      args: [
        "test",
        "--manifest-path",
        "electron/native/grimodex-node/Cargo.toml",
        "--lib",
        "narrative_freshness_restore_lock_tests::completed_freshness_cycle_releases_authority_before_restore_quiescence",
        "--",
        "--exact",
      ],
      cwd: ".",
    },
    contract: {
      source: "electron/native/grimodex-node/src/lib.rs",
      test: "completed_freshness_cycle_releases_authority_before_restore_quiescence",
      fullTestName:
        "narrative_freshness_restore_lock_tests::completed_freshness_cycle_releases_authority_before_restore_quiescence",
      proof:
        "completed Freshness cycle releases authority before restore quiescence",
      heavy: true,
      fullCiPreflight: true,
      designImpact:
        "Runs before Full's later stages; a skipped native test is never passed in the receipt",
    },
  }),
  freezeGate({
    id: C2ZC_RUST_VERIFY_OUTCOME_GATE_ID,
    argv: {
      command: "cargo",
      args: [
        "test",
        "--manifest-path",
        "src-tauri/Cargo.toml",
        "-p",
        "grimodex-db",
        "--lib",
        "narrative_extraction::restore_rebuild::tests::a_verify_run_records_its_report_under_a_completed_run",
        "--",
        "--exact",
        "--nocapture",
      ],
      cwd: ".",
    },
    contract: {
      source:
        "src-tauri/crates/grimodex-db/src/narrative_extraction/restore_rebuild.rs",
      test: "a_verify_run_records_its_report_under_a_completed_run",
      fullTestName:
        "narrative_extraction::restore_rebuild::tests::a_verify_run_records_its_report_under_a_completed_run",
      proof:
        "production Verify persists and validates exact 13/13 check coverage",
    },
  }),
]);
export const C2ZC_RUST_ACCEPTANCE_GATE_IDS = Object.freeze(
  C2ZC_RUST_ACCEPTANCE_GATES.map((gate) => gate.id),
);
export const C2ZC_RUST_ACCEPTANCE_RUNNER_COMMAND = freezeArgv({
  command: "node",
  args: [
    "scripts/c2zc-rust-acceptance-receipt.mjs",
    "--output",
    C2ZC_RUST_ACCEPTANCE_RECEIPT_PATH,
  ],
  cwd: ".",
});

const CANDIDATE_FIELDS = [
  "requestedBase",
  "requestedHead",
  "resolvedBaseSha",
  "resolvedHeadSha",
  "resolvedHeadTreeSha",
  "currentHeadSha",
  "worktreeClean",
  "worktreeFingerprint",
  "worktreeStatusHash",
];
const SHA256 = /^sha256:[0-9a-f]{64}$/u;

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

const C2ZC_RUST_VERIFY_COVERAGE_COUNT = 13;
const C2ZC_RUST_VERIFY_OUTCOME_SENTINEL = "C2ZC_RUST_VERIFY_OUTCOME=";

function exactObjectKeys(value, expected, label) {
  if (!isPlainObject(value)) throw new Error(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const canonicalExpected = [...expected].sort();
  if (
    actual.length !== canonicalExpected.length ||
    actual.some((key, index) => key !== canonicalExpected[index])
  ) {
    throw new Error(`${label} has unexpected keys`);
  }
}

function assertVerifyCoverage(coverage) {
  exactObjectKeys(
    coverage,
    ["complete", "required", "covered", "missing"],
    "C2-ZC Rust Verify checkCoverage",
  );
  if (
    coverage.complete !== true ||
    !Array.isArray(coverage.required) ||
    !Array.isArray(coverage.covered) ||
    !Array.isArray(coverage.missing)
  ) {
    throw new Error(
      "C2-ZC Rust Verify checkCoverage must be complete with arrays",
    );
  }
  if (
    coverage.required.length !== C2ZC_RUST_VERIFY_COVERAGE_COUNT ||
    coverage.covered.length !== C2ZC_RUST_VERIFY_COVERAGE_COUNT
  ) {
    throw new Error(
      "C2-ZC Rust Verify checkCoverage must contain exactly 13 required and covered checks",
    );
  }
  if (coverage.missing.length !== 0) {
    throw new Error(
      "C2-ZC Rust Verify checkCoverage missing must be empty",
    );
  }
  for (const [label, values] of [
    ["required", coverage.required],
    ["covered", coverage.covered],
  ]) {
    if (
      values.some(
        (value) =>
          typeof value !== "string" ||
          value.length === 0 ||
          value.trim() !== value,
      )
    ) {
      throw new Error(
        `C2-ZC Rust Verify checkCoverage ${label} must contain non-empty strings`,
      );
    }
    if (new Set(values).size !== C2ZC_RUST_VERIFY_COVERAGE_COUNT) {
      throw new Error(
        `C2-ZC Rust Verify checkCoverage ${label} must not contain duplicates`,
      );
    }
  }
  if (
    canonicalJson(coverage.required) !== canonicalJson(coverage.covered)
  ) {
    throw new Error(
      "C2-ZC Rust Verify checkCoverage required and covered mismatch",
    );
  }
  return coverage;
}

function sentinelValues(value) {
  if (typeof value !== "string") return [];
  return [
    ...value.matchAll(
      /C2ZC_RUST_VERIFY_OUTCOME=([^\r\n]*)/gu,
    ),
  ].map((match) => match[1]);
}

/** Parse the Rust-owned production Verify outcome from the exact gate stdout. */
export function parseC2ZcRustVerifyOutcome(stdout, stderr = "") {
  if (typeof stdout !== "string" || typeof stderr !== "string") {
    throw new Error("C2-ZC Rust Verify sentinel streams must be strings");
  }
  const stdoutValues = sentinelValues(stdout);
  const stderrValues = sentinelValues(stderr);
  if (stderrValues.length > 0) {
    throw new Error(
      "C2-ZC Rust Verify outcome sentinel must be emitted on stdout, not stderr",
    );
  }
  if (stdoutValues.length === 0) {
    throw new Error("C2-ZC Rust Verify outcome sentinel is missing");
  }
  if (stdoutValues.length !== 1) {
    throw new Error(
      "C2-ZC Rust Verify outcome sentinel must occur exactly once",
    );
  }
  const serialized = stdoutValues[0];
  let parsed;
  try {
    parsed = JSON.parse(serialized);
  } catch (error) {
    throw new Error("C2-ZC Rust Verify outcome sentinel JSON is malformed", {
      cause: error,
    });
  }
  if (JSON.stringify(parsed) !== serialized) {
    throw new Error(
      "C2-ZC Rust Verify outcome sentinel JSON must be compact canonical JSON",
    );
  }
  exactObjectKeys(
    parsed,
    ["verifyContractVersion", "checkCoverage"],
    "C2-ZC Rust Verify outcome",
  );
  if (
    typeof parsed.verifyContractVersion !== "string" ||
    parsed.verifyContractVersion.length === 0 ||
    parsed.verifyContractVersion.trim() !== parsed.verifyContractVersion
  ) {
    throw new Error(
      "C2-ZC Rust Verify outcome verifyContractVersion must be non-empty",
    );
  }
  assertVerifyCoverage(parsed.checkCoverage);
  return parsed;
}

function requireSha256(value, label) {
  if (!SHA256.test(value ?? "")) throw new Error(`${label} must be sha256`);
  return value;
}

function normalizeRelative(root, target, label) {
  const relative = path.relative(root, target);
  if (
    relative === "" ||
    relative.startsWith(`..${path.sep}`) ||
    relative === ".." ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`${label} must stay inside the repository`);
  }
  return relative.split(path.sep).join("/");
}

async function resolveContainedPath(root, requestedPath, label) {
  if (
    typeof requestedPath !== "string" ||
    requestedPath.length === 0 ||
    requestedPath.includes("\0")
  ) {
    throw new Error(`${label} must be a non-empty path without NUL bytes`);
  }
  const rootPath = await realpath(root);
  const target = path.resolve(rootPath, requestedPath);
  normalizeRelative(rootPath, target, label);
  const parent = path.dirname(target);
  await mkdir(parent, { recursive: true });
  const parentRealPath = await realpath(parent);
  normalizeRelative(rootPath, parentRealPath, label);
  try {
    const existingRealPath = await realpath(target);
    normalizeRelative(rootPath, existingRealPath, label);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return {
    absolutePath: path.join(parentRealPath, path.basename(target)),
    relativePath: normalizeRelative(rootPath, target, label),
  };
}

async function atomicWriteContained(root, requestedPath, contents, label) {
  const resolved = await resolveContainedPath(root, requestedPath, label);
  const temporaryPath = path.join(
    path.dirname(resolved.absolutePath),
    `.${path.basename(resolved.absolutePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporaryPath, contents, { encoding: "utf8", flag: "wx" });
    await rename(temporaryPath, resolved.absolutePath);
  } catch (error) {
    try {
      await unlink(temporaryPath);
    } catch {
      // Preserve the original atomic-write error.
    }
    throw error;
  }
  return resolved;
}

async function removeExactContainedFile(root, requestedPath, label) {
  const resolved = await resolveContainedPath(root, requestedPath, label);
  try {
    await unlink(resolved.absolutePath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return resolved;
}

const C2ZC_FAILURE_OUTPUT_MAX_BYTES = 4 * 1024;
const C2ZC_FATAL_UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

function decodeUtf8Boundary(bytes, direction) {
  for (let adjustment = 0; adjustment <= 3; adjustment += 1) {
    const bounded =
      direction === "tail"
        ? bytes.subarray(Math.min(adjustment, bytes.length))
        : bytes.subarray(0, Math.max(0, bytes.length - adjustment));
    try {
      return C2ZC_FATAL_UTF8_DECODER.decode(bounded);
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
    }
  }
  throw new Error("C2-ZC failure output is not valid UTF-8");
}

function boundedText(value, maxBytes = C2ZC_FAILURE_OUTPUT_MAX_BYTES) {
  const text = typeof value === "string" ? value : String(value ?? "");
  const bytes = Buffer.from(text, "utf8");
  return decodeUtf8Boundary(
    bytes.subarray(0, Math.min(maxBytes, bytes.length)),
    "head",
  );
}

function boundedOutput(value) {
  const text = typeof value === "string" ? value : String(value ?? "");
  const bytes = Buffer.from(text, "utf8");
  const headBytes = bytes.subarray(
    0,
    Math.min(C2ZC_FAILURE_OUTPUT_MAX_BYTES, bytes.length),
  );
  const tailBytes = bytes.subarray(
    Math.max(0, bytes.length - C2ZC_FAILURE_OUTPUT_MAX_BYTES),
  );
  return {
    byteCount: bytes.length,
    sha256: sha256(text),
    head: decodeUtf8Boundary(headBytes, "head"),
    tail: decodeUtf8Boundary(tailBytes, "tail"),
  };
}

function failureGateIdentity(gate) {
  return {
    id: gate.id,
    argv: {
      command: gate.argv.command,
      args: [...gate.argv.args],
      cwd: gate.argv.cwd,
    },
    contract: { ...gate.contract },
    source: gate.source,
    test: gate.test,
    fullTestName: gate.fullTestName,
    requiresReceipt: gate.requiresReceipt,
  };
}

function summarizeFailureGate(
  gate,
  { status, execution, startedAt, finishedAt, counts = {} },
) {
  const identity = failureGateIdentity(gate);
  return {
    ...identity,
    status,
    startedAt,
    finishedAt,
    exitStatus: execution?.exitCode ?? null,
    signal: execution?.signal ?? null,
    output: {
      stdout: boundedOutput(execution?.stdout),
      stderr: boundedOutput(execution?.stderr),
    },
    ...(counts.testCount === undefined
      ? {}
      : {
          testCount: counts.testCount,
          passedCount: counts.passedCount,
          failedCount: counts.failedCount,
        }),
  };
}

function summarizeCompletedGate(gate) {
  return {
    ...failureGateIdentity(gate),
    status: "completed",
    startedAt: gate.startedAt,
    finishedAt: gate.finishedAt,
    exitStatus: gate.exitStatus,
    signal: gate.signal,
    output: {
      stdout: boundedOutput(gate.stdout),
      stderr: boundedOutput(gate.stderr),
    },
    testCount: gate.testCount,
    passedCount: gate.passedCount,
    failedCount: gate.failedCount,
  };
}

async function writeFailureEvidence(
  root,
  failureLogPath,
  {
    startedAt,
    finishedAt,
    gates,
    gate,
    gateStartedAt,
    gateFinishedAt,
    execution,
    error,
    candidate,
    catalogDigest,
    attemptId,
  },
) {
  const completedGates = gates.map(summarizeCompletedGate);
  const failedGate = gate
    ? {
        ...failureGateIdentity(gate),
        exitStatus: execution?.exitCode ?? null,
        signal: execution?.signal ?? null,
      }
    : null;
  const evidence = {
    schema: "grimodex.c2zc.rust-acceptance-failure",
    version: 1,
    attemptId,
    candidate: { ...candidate },
    candidateSha256: sha256(canonicalJson(candidate)),
    catalogDigest,
    startedAt,
    finishedAt,
    failedGate,
    gates: [
      ...completedGates,
      ...(gate
        ? [
            summarizeFailureGate(gate, {
              status: "failed",
              execution,
              startedAt: gateStartedAt,
              finishedAt: gateFinishedAt ?? finishedAt,
            }),
          ]
        : []),
    ],
    error: boundedText(
      error instanceof Error ? error.message : String(error ?? ""),
    ),
  };
  try {
    const resolved = await atomicWriteContained(
      root,
      failureLogPath,
      `${JSON.stringify(evidence, null, 2)}\n`,
      "C2-ZC Rust receipt failure log path",
    );
    return resolved.relativePath;
  } catch {
    return null;
  }
}

function failureEvidencePath(outputPath, candidate, attemptId) {
  const candidateToken = sha256(canonicalJson(candidate)).slice(
    "sha256:".length,
  );
  return path.join(
    path.dirname(outputPath),
    `${path.basename(outputPath)}.failure.${candidateToken}.${attemptId}.json`,
  );
}

function assertCandidate(candidate, label = "candidate") {
  if (!isPlainObject(candidate)) throw new Error(`${label} is required`);
  for (const field of CANDIDATE_FIELDS) {
    if (field === "worktreeClean") {
      if (typeof candidate[field] !== "boolean") {
        throw new Error(`${label}.${field} must be boolean`);
      }
    } else if (
      typeof candidate[field] !== "string" ||
      candidate[field].length === 0
    ) {
      throw new Error(`${label}.${field} must be a non-empty string`);
    }
  }
  if (candidate.worktreeClean !== true) {
    throw new Error(
      `${label}.worktreeClean must be true for an acceptance receipt`,
    );
  }
  if (candidate.currentHeadSha !== candidate.resolvedHeadSha) {
    throw new Error(`${label} must bind current HEAD to resolved head`);
  }
  return candidate;
}

function assertTimestamp(value, label) {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new Error(`${label} must be an ISO timestamp`);
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function assertExactTestExecution(stdout, stderr, fullTestName, label) {
  const output = `${stdout}\n${stderr}`;
  const testCaseMatches = [
    ...output.matchAll(
      /^\s*test\s+(.+?)\s+\.\.\.\s+(ok|FAILED|ignored)\s*$/gmu,
    ),
  ];
  const summaryMatches = [...output.matchAll(/^\s*test result:\s+(.+)$/gmu)];
  const expectedTest = new RegExp(
    `^\\s*test\\s+${escapeRegExp(fullTestName)}\\s+\\.\\.\\.\\s+ok\\s*$`,
    "mu",
  );
  const expectedSummary =
    /^\s*test result:\s+ok\.\s+1 passed;\s+0 failed;\s+0 ignored;(?:\s|$)/mu;
  if (
    testCaseMatches.length !== 1 ||
    !expectedTest.test(testCaseMatches[0][0]) ||
    summaryMatches.length !== 1 ||
    !expectedSummary.test(output)
  ) {
    throw new Error(
      `${label} requires exactly one passed test result for ${fullTestName}`,
    );
  }
  return { testCount: 1, passedCount: 1, failedCount: 0 };
}

async function defaultExecute(command, { root }) {
  const cwd = path.resolve(root, command.cwd);
  try {
    const result = await execFileAsync(command.command, command.args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    return {
      exitCode: 0,
      signal: null,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    };
  } catch (error) {
    return {
      exitCode: typeof error?.code === "number" ? error.code : null,
      signal: error?.signal ?? null,
      stdout: error?.stdout ?? "",
      stderr: error?.stderr ?? error?.message ?? "",
    };
  }
}

function assertReceiptContract(receipt, { candidate, catalogDigest }) {
  if (!isPlainObject(receipt))
    throw new Error("C2-ZC Rust receipt is required");
  if (
    receipt.schema !== C2ZC_RUST_ACCEPTANCE_RECEIPT_SCHEMA ||
    receipt.version !== C2ZC_RUST_ACCEPTANCE_RECEIPT_VERSION
  ) {
    throw new Error("C2-ZC Rust receipt schema/version is invalid");
  }
  assertCandidate(receipt.candidate, "receipt candidate");
  for (const field of CANDIDATE_FIELDS) {
    if (receipt.candidate[field] !== candidate[field]) {
      throw new Error(`C2-ZC Rust receipt candidate mismatch: ${field}`);
    }
  }
  for (const legacyField of [
    "command",
    "contract",
    "exitStatus",
    "signal",
    "stdout",
    "stderr",
    "stdoutSha256",
    "stderrSha256",
  ]) {
    if (Object.hasOwn(receipt, legacyField)) {
      throw new Error(
        `C2-ZC Rust receipt must store per-gate evidence; top-level ${legacyField} is invalid`,
      );
    }
  }
  if (receipt.catalogDigest !== catalogDigest) {
    throw new Error("C2-ZC Rust receipt catalog digest is not current");
  }
  assertTimestamp(receipt.startedAt, "C2-ZC Rust receipt startedAt");
  assertTimestamp(receipt.finishedAt, "C2-ZC Rust receipt finishedAt");
  if (Date.parse(receipt.finishedAt) < Date.parse(receipt.startedAt)) {
    throw new Error("C2-ZC Rust receipt timestamps are reversed");
  }
  if (
    !Array.isArray(receipt.gates) ||
    receipt.gates.length !== C2ZC_RUST_ACCEPTANCE_GATES.length
  ) {
    throw new Error(
      "C2-ZC Rust receipt must contain exactly the ordered acceptance gates",
    );
  }
  for (const [index, gate] of receipt.gates.entries()) {
    const expected = C2ZC_RUST_ACCEPTANCE_GATES[index];
    if (!isPlainObject(gate)) {
      throw new Error(`C2-ZC Rust receipt gate ${index} is required`);
    }
    if (
      canonicalJson({
        id: gate.id,
        argv: gate.argv,
        contract: gate.contract,
        source: gate.source,
        test: gate.test,
        fullTestName: gate.fullTestName,
        requiresReceipt: gate.requiresReceipt,
      }) !== canonicalJson(expected)
    ) {
      throw new Error(
        `C2-ZC Rust receipt gate ${index} is not the exact registered gate`,
      );
    }
    if (gate.exitStatus !== 0 || gate.signal !== null) {
      throw new Error(`C2-ZC Rust receipt gate ${gate.id} did not pass`);
    }
    assertTimestamp(
      gate.startedAt,
      `C2-ZC Rust receipt gate ${gate.id} startedAt`,
    );
    assertTimestamp(
      gate.finishedAt,
      `C2-ZC Rust receipt gate ${gate.id} finishedAt`,
    );
    if (Date.parse(gate.finishedAt) < Date.parse(gate.startedAt)) {
      throw new Error(
        `C2-ZC Rust receipt gate ${gate.id} timestamps are reversed`,
      );
    }
    if (typeof gate.stdout !== "string" || typeof gate.stderr !== "string") {
      throw new Error(
        `C2-ZC Rust receipt gate ${gate.id} stdout/stderr are required`,
      );
    }
    if (
      requireSha256(gate.stdoutSha256, `${gate.id}.stdoutSha256`) !==
        sha256(gate.stdout) ||
      requireSha256(gate.stderrSha256, `${gate.id}.stderrSha256`) !==
        sha256(gate.stderr)
    ) {
      throw new Error(
        `C2-ZC Rust receipt gate ${gate.id} output digest mismatch`,
      );
    }
    const counts = assertExactTestExecution(
      gate.stdout,
      gate.stderr,
      expected.fullTestName,
      `C2-ZC Rust receipt gate ${gate.id}`,
    );
    if (
      gate.testCount !== counts.testCount ||
      gate.passedCount !== counts.passedCount ||
      gate.failedCount !== counts.failedCount
    ) {
      throw new Error(
        `C2-ZC Rust receipt gate ${gate.id} test counts are invalid`,
      );
    }
  }
  const verifyGate =
    receipt.gates[C2ZC_RUST_ACCEPTANCE_GATES.length - 1];
  const parsedVerifyOutcome = parseC2ZcRustVerifyOutcome(
    verifyGate.stdout,
    verifyGate.stderr,
  );
  if (
    !isPlainObject(receipt.verifyOutcome) ||
    canonicalJson(receipt.verifyOutcome) !== canonicalJson(parsedVerifyOutcome)
  ) {
    throw new Error(
      "C2-ZC Rust receipt verifyOutcome does not match the production Verify gate sentinel",
    );
  }
  if (Object.hasOwn(receipt, "receiptSha256")) {
    throw new Error(
      "C2-ZC Rust receipt self hash must remain outside its payload",
    );
  }
  return receipt;
}

export async function createC2ZcRustAcceptanceReceipt({
  root = repoRoot,
  candidate,
  catalogDigest = C2ZC_RUST_ACCEPTANCE_CATALOG_DIGEST,
  outputPath = C2ZC_RUST_ACCEPTANCE_RECEIPT_PATH,
  execute = defaultExecute,
  resolveCandidate = resolveC2ZcRustAcceptanceCandidate,
  clock = () => new Date().toISOString(),
} = {}) {
  assertCandidate(candidate);
  if (typeof catalogDigest !== "string" || catalogDigest.length === 0) {
    throw new Error("C2-ZC Rust receipt catalogDigest is required");
  }
  // A prior success for this exact configured path must never be reusable if
  // the current candidate's gate attempt fails. Remove only the payload and
  // its independently-contained sidecar; failure evidence is retained.
  await removeExactContainedFile(
    root,
    outputPath,
    "C2-ZC Rust receipt output path",
  );
  await removeExactContainedFile(
    root,
    `${outputPath}.sha256`,
    "C2-ZC Rust receipt hash path",
  );
  const startedAt = clock();
  assertTimestamp(startedAt, "C2-ZC Rust receipt startedAt");
  const attemptId = randomUUID();
  const failureLogPath = failureEvidencePath(outputPath, candidate, attemptId);
  const gates = [];
  let verifyOutcome;
  for (const definition of C2ZC_RUST_ACCEPTANCE_GATES) {
    const gateStartedAt = clock();
    assertTimestamp(
      gateStartedAt,
      `C2-ZC Rust receipt gate ${definition.id} startedAt`,
    );
    let execution;
    let gateFinishedAt;
    try {
      execution = await execute(definition.argv, {
        root,
        gate: definition,
      });
      gateFinishedAt = clock();
      assertTimestamp(
        gateFinishedAt,
        `C2-ZC Rust receipt gate ${definition.id} finishedAt`,
      );
      const stdout = execution?.stdout ?? "";
      const stderr = execution?.stderr ?? "";
      if (typeof stdout !== "string" || typeof stderr !== "string") {
        throw new Error(
          `C2-ZC Rust gate ${definition.id} must return string stdout/stderr`,
        );
      }
      const counts = assertExactTestExecution(
        stdout,
        stderr,
        definition.fullTestName,
        `C2-ZC Rust gate ${definition.id}`,
      );
      if (definition.id === C2ZC_RUST_VERIFY_OUTCOME_GATE_ID) {
        verifyOutcome = parseC2ZcRustVerifyOutcome(stdout, stderr);
      }
      const gate = {
        id: definition.id,
        argv: {
          command: definition.argv.command,
          args: [...definition.argv.args],
          cwd: definition.argv.cwd,
        },
        contract: { ...definition.contract },
        source: definition.source,
        test: definition.test,
        fullTestName: definition.fullTestName,
        requiresReceipt: definition.requiresReceipt,
        exitStatus: execution?.exitCode ?? null,
        signal: execution?.signal ?? null,
        startedAt: gateStartedAt,
        finishedAt: gateFinishedAt,
        stdout,
        stderr,
        stdoutSha256: sha256(stdout),
        stderrSha256: sha256(stderr),
        ...counts,
      };
      if (gate.exitStatus !== 0 || gate.signal !== null) {
        throw new Error(`C2-ZC Rust gate ${definition.id} did not pass`);
      }
      gates.push(gate);
    } catch (error) {
      const failureLog = await writeFailureEvidence(root, failureLogPath, {
        startedAt,
        finishedAt: clock(),
        gates,
        gate: definition,
        gateStartedAt,
        gateFinishedAt,
        execution,
        error,
        candidate,
        catalogDigest,
        attemptId,
      });
      const suffix = failureLog ? ` (failure log: ${failureLog})` : "";
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}${suffix}`,
        { cause: error },
      );
    }
    let postGateCandidate;
    try {
      postGateCandidate = await resolveCandidate({
        root,
        requestedBase: candidate.requestedBase,
        requestedHead: candidate.requestedHead,
      });
    } catch (error) {
      const failureLog = await writeFailureEvidence(root, failureLogPath, {
        startedAt,
        finishedAt: clock(),
        gates,
        gate: definition,
        gateStartedAt,
        gateFinishedAt,
        execution,
        error,
        candidate,
        catalogDigest,
        attemptId,
      });
      const suffix = failureLog ? ` (failure log: ${failureLog})` : "";
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}${suffix}`,
        { cause: error },
      );
    }
    try {
      assertCandidate(postGateCandidate, `post-${definition.id} candidate`);
      for (const field of CANDIDATE_FIELDS) {
        if (postGateCandidate[field] !== candidate[field]) {
          throw new Error(
            `C2-ZC Rust acceptance candidate changed after Rust gate ${definition.id}: ${field}`,
          );
        }
      }
    } catch (error) {
      const failureLog = await writeFailureEvidence(root, failureLogPath, {
        startedAt,
        finishedAt: clock(),
        gates,
        gate: definition,
        gateStartedAt,
        gateFinishedAt,
        execution,
        error,
        candidate,
        catalogDigest,
        attemptId,
      });
      const suffix = failureLog ? ` (failure log: ${failureLog})` : "";
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}${suffix}`,
        { cause: error },
      );
    }
  }
  const finishedAt = clock();
  assertTimestamp(finishedAt, "C2-ZC Rust receipt finishedAt");
  const receipt = {
    schema: C2ZC_RUST_ACCEPTANCE_RECEIPT_SCHEMA,
    version: C2ZC_RUST_ACCEPTANCE_RECEIPT_VERSION,
    candidate: { ...candidate },
    startedAt,
    finishedAt,
    catalogDigest,
    gates,
    verifyOutcome,
  };
  assertReceiptContract(receipt, { candidate, catalogDigest });
  const payload = `${JSON.stringify(receipt, null, 2)}\n`;
  const resolved = await atomicWriteContained(
    root,
    outputPath,
    payload,
    "C2-ZC Rust receipt output path",
  );
  const receiptSha256 = sha256(payload);
  await atomicWriteContained(
    root,
    `${outputPath}.sha256`,
    `${receiptSha256}\n`,
    "C2-ZC Rust receipt hash path",
  );
  return {
    receiptPath: resolved.relativePath,
    receiptSha256,
    receipt,
  };
}

export async function verifyC2ZcRustAcceptanceReceipt({
  root = repoRoot,
  candidate,
  catalogDigest = C2ZC_RUST_ACCEPTANCE_CATALOG_DIGEST,
  receiptPath,
  receiptSha256 = null,
} = {}) {
  assertCandidate(candidate);
  const resolved = await resolveContainedPath(
    root,
    receiptPath,
    "C2-ZC Rust receipt path",
  );
  const bytes = await readFile(resolved.absolutePath);
  const actualSha256 = sha256(bytes);
  const sidecarResolved = await resolveContainedPath(
    root,
    `${receiptPath}.sha256`,
    "C2-ZC Rust receipt hash path",
  );
  const sidecarSha256 = (
    await readFile(sidecarResolved.absolutePath, "utf8")
  ).trim();
  requireSha256(sidecarSha256, "C2-ZC Rust receipt self hash sidecar");
  if (receiptSha256 !== null && receiptSha256 !== sidecarSha256) {
    throw new Error("C2-ZC Rust receipt expected hash does not match sidecar");
  }
  const expectedSha256 = receiptSha256 ?? sidecarSha256;
  if (actualSha256 !== expectedSha256) {
    throw new Error("C2-ZC Rust receipt bytes changed after gate completion");
  }
  const parsed = JSON.parse(bytes.toString("utf8"));
  assertReceiptContract(parsed, { candidate, catalogDigest });
  return {
    receiptPath: resolved.relativePath,
    receiptSha256: actualSha256,
    receipt: parsed,
  };
}

async function executeGit(args, root) {
  const { stdout } = await execFileAsync("git", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout;
}

function requireGitObjectId(value, label) {
  const normalized = value.trim();
  if (!/^[0-9a-f]{40,64}$/u.test(normalized)) {
    throw new Error(`${label} did not resolve to a Git object ID`);
  }
  return normalized;
}

export async function resolveC2ZcRustAcceptanceCandidate({
  root = repoRoot,
  requestedBase = "origin/master",
  requestedHead = "HEAD",
  git = (args) => executeGit(args, root),
} = {}) {
  const [
    base,
    head,
    currentHead,
    headTree,
    currentHeadTree,
    worktreeStatus,
    trackedDiff,
    untrackedPathsRaw,
  ] = await Promise.all([
    git(["rev-parse", "--verify", `${requestedBase}^{commit}`]),
    git(["rev-parse", "--verify", `${requestedHead}^{commit}`]),
    git(["rev-parse", "--verify", "HEAD"]),
    git(["rev-parse", "--verify", `${requestedHead}^{tree}`]),
    git(["rev-parse", "--verify", "HEAD^{tree}"]),
    git(["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
    git(["diff", "--binary", "--no-ext-diff", "HEAD", "--"]),
    git(["ls-files", "--others", "--exclude-standard", "-z"]),
  ]);
  const untrackedPaths = untrackedPathsRaw.split("\0").filter(Boolean);
  let untrackedHashes = "";
  if (untrackedPaths.length > 0) {
    const output = await git([
      "hash-object",
      "--no-filters",
      "--",
      ...untrackedPaths,
    ]);
    const hashes = output.trimEnd().split("\n");
    if (hashes.length !== untrackedPaths.length) {
      throw new Error(
        "Git did not hash every untracked C2-ZC receipt candidate file",
      );
    }
    untrackedHashes = hashes
      .map((hash, index) =>
        requireGitObjectId(hash, `untracked file ${untrackedPaths[index]}`),
      )
      .join("\n");
  }
  const resolvedHeadSha = requireGitObjectId(head, requestedHead);
  const currentHeadSha = requireGitObjectId(currentHead, "HEAD");
  const resolvedHeadTreeSha = requireGitObjectId(
    headTree,
    `${requestedHead}^{tree}`,
  );
  const currentHeadTreeSha = requireGitObjectId(currentHeadTree, "HEAD^{tree}");
  if (
    resolvedHeadSha !== currentHeadSha ||
    resolvedHeadTreeSha !== currentHeadTreeSha
  ) {
    throw new Error(
      "C2-ZC Rust acceptance candidate must bind current HEAD and tree to the requested head",
    );
  }
  const worktreeFingerprint = createHash("sha256")
    .update("tracked\0")
    .update(trackedDiff)
    .update("untracked-paths\0")
    .update(untrackedPathsRaw)
    .update("untracked-hashes\0")
    .update(untrackedHashes)
    .digest("hex");
  return {
    requestedBase,
    requestedHead,
    resolvedBaseSha: requireGitObjectId(base, requestedBase),
    resolvedHeadSha,
    resolvedHeadTreeSha,
    currentHeadSha,
    worktreeClean: worktreeStatus.length === 0,
    worktreeFingerprint,
    worktreeStatusHash: createHash("sha256")
      .update(worktreeStatus)
      .digest("hex"),
  };
}

export async function runC2ZcRustAcceptanceGate({
  root = repoRoot,
  requestedBase = process.env.GRIMODEX_C2ZC_RUST_REQUESTED_BASE ??
    "origin/master",
  requestedHead = process.env.GRIMODEX_C2ZC_RUST_REQUESTED_HEAD ?? "HEAD",
  candidateJson = process.env.GRIMODEX_C2ZC_RUST_CANDIDATE_JSON,
  outputPath = process.env.GRIMODEX_C2ZC_RUST_RECEIPT_PATH ??
    C2ZC_RUST_ACCEPTANCE_RECEIPT_PATH,
} = {}) {
  const resolvedCandidate = await resolveC2ZcRustAcceptanceCandidate({
    root,
    requestedBase,
    requestedHead,
  });
  const candidate = candidateJson
    ? JSON.parse(candidateJson)
    : resolvedCandidate;
  assertCandidate(candidate);
  if (candidateJson) {
    for (const field of CANDIDATE_FIELDS) {
      if (candidate[field] !== resolvedCandidate[field]) {
        throw new Error(
          `C2-ZC Rust acceptance candidate changed before receipt materialization: ${field}`,
        );
      }
    }
  }
  const result = await createC2ZcRustAcceptanceReceipt({
    root,
    candidate,
    outputPath,
    resolveCandidate: (options) => resolveC2ZcRustAcceptanceCandidate(options),
  });
  process.stdout.write(
    `${JSON.stringify({ receiptPath: result.receiptPath, receiptSha256: result.receiptSha256 })}\n`,
  );
  return result;
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--output") options.outputPath = argv[++index];
    else if (argument === "--base") options.requestedBase = argv[++index];
    else if (argument === "--head") options.requestedHead = argv[++index];
    else throw new Error(`Unknown C2-ZC Rust gate argument: ${argument}`);
  }
  return options;
}

if (
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  runC2ZcRustAcceptanceGate(parseArgs(process.argv.slice(2))).catch((error) => {
    process.stderr.write(
      `[c2zc-rust-acceptance] ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
