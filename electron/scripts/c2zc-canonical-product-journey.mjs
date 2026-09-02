import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  realpath,
  stat,
} from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import process from "node:process";

import { restoreBackupThroughSettingsUi } from "./narrative-maintenance-product-journeys.mjs";
import {
  assertC2ZcRustVerifyContractVersion,
  assertC2ZcRustVerifyCoverage,
  C2ZC_RUST_VERIFY_COVERAGE_COUNT,
} from "../../scripts/c2zc-verify-contract.mjs";

/**
 * C2-ZC is one stateful lifecycle.  The runner owns only observations and
 * typed product calls; restore, Verify, Rebuild, Freshness, marker, and
 * workspace authority remain production-owned.
 */
export const C2ZC_PRODUCT_JOURNEY_ID = "c2-zc-canonical-authority-cutover";
export const C2ZC_RESTORE_FIXTURE_ENV = "GRIMODEX_C2ZC_RESTORE_FIXTURE";
export const C2ZC_RESTORE_FIXTURE_MANIFEST_VERSION = 1;
export const C2ZC_RESTORE_FIXTURE_CONTRACT_VERSION = 1;
export const C2ZC_RESTORE_FIXTURE_BUILDER_VERSION =
  "c2zc-restore-fixture-builder/v1";
export const C2ZC_VERIFY_COVERAGE_COUNT = C2ZC_RUST_VERIFY_COVERAGE_COUNT;
export const C2ZC_CANONICAL_PRODUCT_JOURNEY_PHASES = Object.freeze([
  `${C2ZC_PRODUCT_JOURNEY_ID}/restore-fixture`,
  `${C2ZC_PRODUCT_JOURNEY_ID}/restore`,
  `${C2ZC_PRODUCT_JOURNEY_ID}/open`,
  `${C2ZC_PRODUCT_JOURNEY_ID}/restart`,
  `${C2ZC_PRODUCT_JOURNEY_ID}/typed-write`,
  `${C2ZC_PRODUCT_JOURNEY_ID}/restart-persistence`,
]);

export const C2ZC_SEMANTIC_INDEX_ZERO_COUNTS = Object.freeze({
  metadataRows: 0,
  activeD1HeadRows: 0,
  v1EdgeRows: 0,
  consumerFreshnessRows: 0,
});

export const C2ZC_CANONICAL_FRESHNESS_CONTRACT = Object.freeze({
  authority: "GenericConsumerFreshness",
  rustSource:
    "src-tauri/crates/grimodex-db/src/narrative_extraction/c2zc_canonical_cutover.rs",
  rustReadFunction: "canonical_application_freshness",
  requiredEvidence: Object.freeze([
    "applicationId",
    "evidenceFreshness",
    "buildAction",
    "semanticEpochId",
    "lastEvaluatedRunId",
    "dependencySetDigest",
    "updatedAt",
  ]),
  noLegacyFallback: true,
  missingGenericError: "NEX_C2ZC_GENERIC_FRESHNESS_MISSING",
});

const C2ZC_CUTOVER_MIGRATION_ID = "narrative-c2-canonical-freshness-v1";
const C2ZC_CUTOVER_CONTRACT_VERSION = 1;
const C2ZC_FRESHNESS_CONSUMER_KIND = "application";
const C2ZC_INCREMENTAL_FRESHNESS_CONSUMER_ID =
  "narrative-incremental-freshness/v1";
const C2ZC_WAIT_MS = 60_000;
const C2ZC_FIXTURE_GIT_OBJECT_ID = /^[0-9a-f]{40,64}$/u;
const C2ZC_FIXTURE_SHA256 = /^sha256:[0-9a-f]{64}$/u;
const C2ZC_CANONICAL_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const C2ZC_TYPED_TREE_NODE_PRODUCER_TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(?:Z|\+00:00)$/u;
const C2ZC_RESTORE_FIXTURE_MANIFEST_KEYS = Object.freeze([
  "manifestVersion",
  "contractVersion",
  "schemaVersion",
  "databaseSchemaVersion",
  "c2zcMarkerPresent",
  "candidate",
  "builderVersion",
  "builderCommand",
  "exactBuilderCommand",
  "artifacts",
  "fixtureSha256",
  "fixtureSizeBytes",
  "semantic",
]);
const C2ZC_RESTORE_FIXTURE_CANDIDATE_KEYS = Object.freeze([
  "requested",
  "resolvedHeadSha",
  "resolvedTreeSha",
  "headSha",
  "treeSha",
  "clean",
  "statusSha256",
]);
const C2ZC_RESTORE_FIXTURE_ARTIFACT_KEYS = Object.freeze([
  "path",
  "sha256",
  "sizeBytes",
]);
const C2ZC_RESTORE_FIXTURE_SEMANTIC_KEYS = Object.freeze([
  "projectId",
  "sceneId",
  "applicationId",
  "applyRunId",
  "backfillRunId",
  "projectCount",
  "sceneCount",
  "e0Count",
  "completedBackfillCount",
  "dependencyEdgeCount",
  "applicationCount",
  "legacyProjectionFreshnessCount",
  "legacyProjectionDependencyCount",
  "applicationEdgeCount",
  "applicationEdgeStateCount",
  "applicationFreshnessCount",
  "cursorSettled",
  "semanticIndexRows",
  "sceneSourceRevision",
  "edgeSourceObjectIdentity",
  "edgeReadSetJson",
  "project",
  "projectDigest",
  "scene",
  "sceneDigest",
  "epoch",
  "epochDigest",
  "backfill",
  "backfillDigest",
  "application",
  "applicationDigest",
  "legacyProjection",
  "legacyProjectionDigest",
  "edge",
  "edgeDigest",
  "feedCursor",
  "feedCursorDigest",
  "derivedStateGap",
  "derivedStateGapDigest",
  "expectedRestoreGap",
  "expectedRestoreGapDigest",
  "semanticIndex",
  "semanticIndexDigest",
  "expectedRestoreLifecycle",
  "expectedRestoreLifecycleDigest",
  "contentsDigest",
]);

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseObject(value, label) {
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch (error) {
      throw new Error(`${label} is not valid JSON`, { cause: error });
    }
  }
  if (!isObject(parsed)) throw new Error(`${label} must be an object`);
  return parsed;
}

function parseArray(value, label) {
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch (error) {
      throw new Error(`${label} is not valid JSON`, { cause: error });
    }
  }
  if (!Array.isArray(parsed)) throw new Error(`${label} must be an array`);
  return parsed;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function digestJson(value) {
  return `sha256:${createHash("sha256")
    .update(stableJson(value), "utf8")
    .digest("hex")}`;
}

function assertCanonicalTimestamp(value, label) {
  requireText(value, label);
  if (
    !C2ZC_CANONICAL_TIMESTAMP.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new Error(`${label} must be a canonical UTC millisecond timestamp`);
  }
  return value;
}

function assertC2ZcTypedTreeNodeProducerTimestamp(value, label) {
  requireText(value, label);
  const match = C2ZC_TYPED_TREE_NODE_PRODUCER_TIMESTAMP.exec(value);
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] =
    match ?? [];
  // The typed tree-node producer output profile is zero-offset RFC3339 with
  // non-leap seconds. RFC3339 date-fullyear is four unsigned digits; keep
  // year 0000 in its proleptic Gregorian calendar so leap-year validation
  // remains deterministic without Date.parse normalization.
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const daysInMonth =
    month === 2
      ? year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
        ? 29
        : 28
      : [4, 6, 9, 11].includes(month)
        ? 30
        : 31;

  if (
    !match ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59 ||
    second < 0 ||
    second > 59
  ) {
    throw new Error(
      `${label} must be a typed tree-node producer timestamp (zero-offset RFC3339, non-leap seconds, optional 1-9 fractional digits)`,
    );
  }
  return value;
}

function semanticContentsPayload(semantic) {
  return {
    projectId: semantic.projectId,
    sceneId: semantic.sceneId,
    applicationId: semantic.applicationId,
    applyRunId: semantic.applyRunId,
    backfillRunId: semantic.backfillRunId,
    projectCount: semantic.projectCount,
    sceneCount: semantic.sceneCount,
    e0Count: semantic.e0Count,
    completedBackfillCount: semantic.completedBackfillCount,
    dependencyEdgeCount: semantic.dependencyEdgeCount,
    applicationCount: semantic.applicationCount,
    legacyProjectionFreshnessCount: semantic.legacyProjectionFreshnessCount,
    legacyProjectionDependencyCount: semantic.legacyProjectionDependencyCount,
    applicationEdgeCount: semantic.applicationEdgeCount,
    applicationEdgeStateCount: semantic.applicationEdgeStateCount,
    applicationFreshnessCount: semantic.applicationFreshnessCount,
    cursorSettled: semantic.cursorSettled,
    semanticIndexRows: semantic.semanticIndexRows,
    sceneSourceRevision: semantic.sceneSourceRevision,
    edgeSourceObjectIdentity: semantic.edgeSourceObjectIdentity,
    edgeReadSetJson: semantic.edgeReadSetJson,
    project: semantic.project,
    scene: semantic.scene,
    epoch: semantic.epoch,
    backfill: semantic.backfill,
    application: semantic.application,
    legacyProjection: semantic.legacyProjection,
    edge: semantic.edge,
    feedCursor: semantic.feedCursor,
    derivedStateGap: semantic.derivedStateGap,
    expectedRestoreGap: semantic.expectedRestoreGap,
    semanticIndex: semantic.semanticIndex,
    expectedRestoreLifecycle: semantic.expectedRestoreLifecycle,
  };
}

function assertExpectedRestoreLifecycle(value, label) {
  assertExactKeys(
    value,
    ["firstVerify", "conditionalRebuild", "confirmationVerify", "marker"],
    label,
  );
  if (
    value.firstVerify !== "rebuild-required" ||
    value.conditionalRebuild !== "required" ||
    value.confirmationVerify !== "clean" ||
    value.marker !== "after-confirmation-verify"
  ) {
    throw new Error(
      `${label} does not describe the canonical restore lifecycle`,
    );
  }
  return value;
}

function assertExactKeys(value, expected, label) {
  if (!isObject(value)) throw new Error(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const keys = [...expected].sort();
  if (
    actual.length !== keys.length ||
    actual.some((key, index) => key !== keys[index])
  ) {
    throw new Error(`${label} has unexpected keys`);
  }
}

function requireText(value, label) {
  if (
    typeof value !== "string" ||
    value.trim() === "" ||
    value !== value.trim() ||
    value.includes("\u0000")
  ) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function rowsOf(result) {
  return Array.isArray(result?.rows) ? result.rows : [];
}

function rows(value, label) {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function outcomeOf(value, label) {
  if (value?.outcomeSummaryJson !== undefined) {
    return parseObject(value.outcomeSummaryJson, `${label} outcomeSummaryJson`);
  }
  if (value?.outcome !== undefined) {
    return parseObject(value.outcome, `${label} outcome`);
  }
  return parseObject(value, `${label} outcome`);
}

function reportOf(value, label) {
  const outcome = outcomeOf(value, label);
  const report = outcome.report ?? value?.report;
  if (!isObject(report)) {
    throw new Error(`${label} must contain the production Verify report`);
  }
  return { outcome, report };
}

function expectedCoverageOf(value, label) {
  const candidate = value?.checkCoverage ?? value?.coverage ?? value;
  const coverage = parseObject(candidate, `${label} check coverage`);
  assertExactKeys(
    coverage,
    ["complete", "required", "covered", "missing"],
    label,
  );
  return coverage;
}

function normalizeCoverage(coverage, label) {
  assertC2ZcRustVerifyCoverage(coverage, label);
  return {
    ...coverage,
    missing: [],
  };
}

/**
 * Compare the persisted machine-readable values with the Rust Verify outcome.
 * Both sides are validated against the shared policy/Rust contract binding.
 */
export function assertC2ZcVerifyCoverage(
  run,
  rustOutcome,
  label = "C2-ZC Verify",
) {
  const { outcome } = reportOf(run, label);
  if (run?.status !== undefined && run.status !== "completed") {
    throw new Error(`${label} must be a completed production Verify Run`);
  }
  assertC2ZcRustVerifyContractVersion(
    outcome.verifyContractVersion,
    `${label} verifyContractVersion`,
  );
  const actual = expectedCoverageOf(outcome, `${label} persisted`);
  const normalizedActual = normalizeCoverage(actual, `${label} persisted`);
  if (rustOutcome !== undefined && rustOutcome !== null) {
    const parsedRustOutcome = parseObject(rustOutcome, "Rust Verify outcome");
    assertC2ZcRustVerifyContractVersion(
      parsedRustOutcome.verifyContractVersion,
      "Rust Verify outcome verifyContractVersion",
    );
    const expected = normalizeCoverage(
      expectedCoverageOf(parsedRustOutcome, "Rust Verify outcome"),
      "Rust Verify outcome",
    );
    if (stableJson(normalizedActual) !== stableJson(expected)) {
      throw new Error(`${label} coverage values differ from the Rust outcome`);
    }
  }
  return { outcome, checkCoverage: normalizedActual };
}

export function assertC2ZcSemanticIndexZero(
  value,
  label = "C2-ZC Semantic Index",
) {
  const { report } = reportOf(value, label);
  for (const field of [
    "semanticIndexDependencySetDigest",
    "semanticIndexGenerationCorrespondence",
  ]) {
    const check = report[field];
    if (!isObject(check))
      throw new Error(`${label} check '${field}' is missing`);
    if (
      stableJson(check.observedCounts) !==
      stableJson(C2ZC_SEMANTIC_INDEX_ZERO_COUNTS)
    ) {
      throw new Error(`${label} reserved Semantic Index surfaces are not zero`);
    }
    if (
      check.completed !== true ||
      check.passed !== true ||
      stableJson(check.issues) !== "[]" ||
      stableJson(check.incomplete) !== "[]"
    ) {
      throw new Error(`${label} check '${field}' is not complete and passed`);
    }
  }
  return C2ZC_SEMANTIC_INDEX_ZERO_COUNTS;
}

const C2ZC_VERIFY_CONSISTENCY_ARRAY_FIELDS = Object.freeze([
  "edgeIdsWithMissingSource",
  "duplicateEdgeKeys",
  "edgeIdsWithCrossProjectConsumer",
  "edgeIdsWithMalformedKeys",
  "edgeStateIdsOutsideCurrentEpoch",
  "findingObservationIdsOutsideCurrentEpoch",
  "duplicateEdgeIdsToDeactivate",
  "edgeIdsWithUnresolvableConsumerScope",
  "consumerKeysWithStaleDependencySetDigest",
  "orphanedAttentionFindingKeys",
  "orphanedAttentionRehomeAmbiguities",
]);

const C2ZC_VERIFY_INCOMPLETE_ARRAY_FIELDS = Object.freeze([
  "edgeIdsWithoutCurrentEpochState",
  "consumerKeysWithoutCurrentEpochFreshness",
  "consumerKeysWithUncomputedDependencySetDigest",
]);

const C2ZC_VERIFY_CHECK_FIELDS = Object.freeze([
  "applicationRevisionArtifactReferences",
  "semanticIndexDependencySetDigest",
  "contributionToApplicationCommitCorrespondence",
  "legacyMirrorMigrationParity",
  "cursorAndFeedHeadConsistency",
  "semanticIndexGenerationCorrespondence",
]);

function assertProductionVerifyReport(
  report,
  { first, label } = { first: false, label: "C2-ZC Verify report" },
) {
  if (!isObject(report)) throw new Error(`${label} must be an object`);
  for (const field of [
    ...C2ZC_VERIFY_CONSISTENCY_ARRAY_FIELDS,
    ...C2ZC_VERIFY_INCOMPLETE_ARRAY_FIELDS,
  ]) {
    if (!Array.isArray(report[field])) {
      throw new Error(`${label}.${field} must be an array`);
    }
  }
  if (
    C2ZC_VERIFY_CONSISTENCY_ARRAY_FIELDS.some(
      (field) => report[field].length !== 0,
    )
  ) {
    throw new Error(`${label} contains a consistency issue`);
  }
  for (const field of C2ZC_VERIFY_CHECK_FIELDS) {
    const check = report[field];
    if (!isObject(check)) throw new Error(`${label}.${field} is missing`);
    if (!Array.isArray(check.issues) || !Array.isArray(check.incomplete)) {
      throw new Error(`${label}.${field} has invalid issue state`);
    }
    if (check.issues.length !== 0) {
      throw new Error(`${label}.${field} contains a Verify issue`);
    }
  }
  if (typeof report.rebuildRequired !== "boolean") {
    throw new Error(`${label}.rebuildRequired is missing`);
  }
  const incompleteCount = C2ZC_VERIFY_INCOMPLETE_ARRAY_FIELDS.reduce(
    (total, field) => total + report[field].length,
    0,
  );
  const incompleteChecks = C2ZC_VERIFY_CHECK_FIELDS.filter(
    (field) => report[field].incomplete.length !== 0,
  );
  if (first) {
    if (
      report.rebuildRequired !== true ||
      incompleteCount + incompleteChecks.length === 0
    ) {
      throw new Error(`${label} must be incomplete-only and require Rebuild`);
    }
    for (const field of C2ZC_VERIFY_CHECK_FIELDS) {
      const check = report[field];
      if (check.incomplete.length === 0) {
        if (check.completed !== true || check.passed !== true) {
          throw new Error(
            `${label}.${field} is non-clean without an incomplete finding`,
          );
        }
      } else if (check.completed === true || check.passed === true) {
        throw new Error(
          `${label}.${field} is marked complete despite an incomplete finding`,
        );
      }
    }
  } else {
    if (
      report.rebuildRequired !== false ||
      incompleteCount !== 0 ||
      incompleteChecks.length !== 0
    ) {
      throw new Error(`${label} confirmation Verify is not clean`);
    }
    for (const field of C2ZC_VERIFY_CHECK_FIELDS) {
      const check = report[field];
      if (check.completed !== true || check.passed !== true) {
        throw new Error(`${label}.${field} is not complete and passed`);
      }
    }
  }
  return report;
}

function markerRowsOf(snapshot) {
  if (Array.isArray(snapshot)) return snapshot;
  if (Array.isArray(snapshot?.markerRows)) return snapshot.markerRows;
  if (snapshot?.marker) return [snapshot.marker];
  return [];
}

export function assertC2ZcMarkerExactlyOnce(snapshot, label = "C2-ZC marker") {
  const markerRows = markerRowsOf(snapshot);
  if (markerRows.length !== 1) {
    throw new Error(`${label} must contain exactly one persisted marker row`);
  }
  const marker = markerRows[0];
  if (
    marker?.migrationId !== C2ZC_CUTOVER_MIGRATION_ID ||
    Number(marker?.contractVersion) !== C2ZC_CUTOVER_CONTRACT_VERSION ||
    typeof marker?.appliedAt !== "string" ||
    marker.appliedAt.trim() === ""
  ) {
    throw new Error(`${label} is not the current C2-ZC marker`);
  }
  assertCanonicalTimestamp(marker.appliedAt, `${label}.appliedAt`);
  return marker;
}

const C2ZC_TERMINAL_FINDING_STATES = new Set(["resolved"]);

function findingRowsOf(snapshot) {
  if (Array.isArray(snapshot?.findingRows)) return snapshot.findingRows;
  if (Array.isArray(snapshot?.findingLifecycle))
    return snapshot.findingLifecycle;
  if (Array.isArray(snapshot?.findings)) return snapshot.findings;
  return [];
}

export function assertC2ZcFindingRowsResolved(
  snapshot,
  label = "C2-ZC findings",
) {
  const findingRows = findingRowsOf(snapshot);
  const inbox = snapshot?.inboxEntries ?? snapshot?.inbox ?? [];
  if (!Array.isArray(inbox)) {
    throw new Error(`${label} must expose an Inbox array`);
  }
  const unresolved = findingRows.filter((finding) => {
    const state = String(
      finding?.lifecycleState ?? finding?.state ?? finding?.status ?? "",
    ).toLowerCase();
    return !C2ZC_TERMINAL_FINDING_STATES.has(state);
  });
  if (unresolved.length !== 0) {
    throw new Error(`${label} contains unresolved Finding lifecycle rows`);
  }
  const explicitUnresolved =
    snapshot?.unresolvedFindingRows ?? snapshot?.unresolvedFindings;
  if (explicitUnresolved !== undefined) {
    if (!Array.isArray(explicitUnresolved) || explicitUnresolved.length !== 0) {
      throw new Error(`${label} contains unresolved findings`);
    }
  }
  if (inbox.length !== 0) {
    throw new Error(`${label} contains Inbox entries`);
  }
  return { findingRows, unresolved: [], inbox };
}

export function assertC2ZcFindingInboxEmpty(
  snapshot,
  label = "C2-ZC findings",
) {
  assertC2ZcFindingRowsResolved(snapshot, label);
  return true;
}

export function assertC2ZcLegacyProjectionStable(
  before,
  after,
  label = "C2-ZC Legacy projection",
) {
  if (stableJson(before) !== stableJson(after)) {
    throw new Error(`${label} changed across the lifecycle boundary`);
  }
  return after;
}

export function assertC2ZcGenericRowsComplete(
  snapshot,
  label = "C2-ZC Generic storage",
) {
  const genericRows = rows(snapshot?.genericRows, `${label} rows`);
  for (const [index, row] of genericRows.entries()) {
    for (const field of C2ZC_CANONICAL_FRESHNESS_CONTRACT.requiredEvidence) {
      if (
        row[field] === undefined ||
        row[field] === null ||
        row[field] === ""
      ) {
        throw new Error(`${label} row ${index} is missing ${field}`);
      }
    }
    if (row.consumerKind !== C2ZC_FRESHNESS_CONSUMER_KIND) {
      throw new Error(
        `${label} row ${index} is not an Application Consumer row`,
      );
    }
  }
  return genericRows;
}

export function assertC2ZcGenericFreshnessStorage(
  snapshot,
  { projectId, applicationId, epochId } = {},
  label = "C2-ZC Generic storage",
) {
  requireText(projectId, `${label} projectId`);
  requireText(applicationId, `${label} applicationId`);
  requireText(epochId, `${label} epochId`);
  const candidates = rows(snapshot?.genericRows, `${label} rows`).filter(
    (row) =>
      row.projectId === projectId &&
      row.consumerKind === C2ZC_FRESHNESS_CONSUMER_KIND &&
      row.consumerKey === applicationId,
  );
  if (candidates.length !== 1) {
    throw new Error(`${label} must contain exactly one targeted Generic row`);
  }
  const row = candidates[0];
  if (row.semanticEpochId !== epochId) {
    throw new Error(`${label} row is not bound to the current Semantic Epoch`);
  }
  assertC2ZcGenericRowsComplete({ genericRows: [row] }, label);
  if (row.evidenceFreshness !== "fresh" || row.buildAction !== "none") {
    throw new Error(`${label} row is not settled Freshness evidence`);
  }
  if (row.updatedAt !== undefined) {
    assertCanonicalTimestamp(row.updatedAt, `${label} row updatedAt`);
  }
  const producer = rows(snapshot?.runs, `${label} runs`).find(
    (run) => run.id === row.lastEvaluatedRunId,
  );
  if (
    !producer ||
    producer.status !== "completed" ||
    producer.runKind !== "freshness-evaluation" ||
    producer.semanticEpochId !== epochId ||
    producer.runKind === "dependency-repair" ||
    (producer.projectId !== undefined && producer.projectId !== projectId)
  ) {
    throw new Error(`${label} row has no completed current-Epoch producer`);
  }
  const application = rows(
    snapshot?.applications,
    `${label} applications`,
  ).find((candidate) => applicationIdOf(candidate) === applicationId);
  if (application?.runId === row.lastEvaluatedRunId) {
    throw new Error(
      `${label} Generic producer must be distinct from Application Run`,
    );
  }
  return row;
}

export function assertC2ZcFeedCursorSettled(
  snapshot,
  { epochId, projectId, consumerId } = {},
  label = "C2-ZC Change Feed cursor",
) {
  const feedCursor = snapshot?.feedCursor;
  if (!isObject(feedCursor)) throw new Error(`${label} is missing its cursor`);
  const cursor = isObject(feedCursor.cursor) ? feedCursor.cursor : feedCursor;
  if (projectId !== undefined && cursor.projectId !== projectId) {
    throw new Error(`${label} belongs to an unexpected project`);
  }
  if (consumerId !== undefined && cursor.consumerId !== consumerId) {
    throw new Error(`${label} belongs to an unexpected consumer`);
  }
  const acknowledgedThrough =
    cursor.acknowledgedThroughSequence ?? cursor.acknowledgedThrough;
  if (
    cursor.lastError !== null &&
    cursor.lastError !== undefined &&
    cursor.lastError !== ""
  ) {
    throw new Error(`${label} has a persisted error`);
  }
  if (
    !Number.isSafeInteger(Number(feedCursor.feedHead)) ||
    Number(feedCursor.feedHead) < 0 ||
    !Number.isSafeInteger(Number(acknowledgedThrough)) ||
    Number(acknowledgedThrough) !== Number(feedCursor.feedHead) ||
    (cursor.reservedThrough !== null && cursor.reservedThrough !== undefined) ||
    (cursor.activeRunId !== null && cursor.activeRunId !== undefined)
  ) {
    throw new Error(`${label} is not fully acknowledged`);
  }
  if (
    epochId !== undefined &&
    cursor.semanticEpochId !== null &&
    cursor.semanticEpochId !== undefined
  ) {
    throw new Error(`${label} retains an active Semantic Epoch`);
  }
  return cursor;
}

export function assertC2ZcProjectInventory(
  snapshot,
  expectedProjectId,
  label = "C2-ZC project inventory",
) {
  requireText(expectedProjectId, `${label} expected projectId`);
  const inventory = rows(snapshot?.projectInventory, `${label} rows`);
  if (inventory.length !== 1) {
    throw new Error(`${label} must contain exactly one project`);
  }
  const observedProjectId =
    typeof inventory[0] === "string"
      ? inventory[0]
      : (inventory[0]?.projectId ?? inventory[0]?.id);
  if (observedProjectId !== expectedProjectId) {
    throw new Error(`${label} does not match the restored fixture project`);
  }
  if (
    snapshot?.projectId !== undefined &&
    snapshot.projectId !== expectedProjectId
  ) {
    throw new Error(`${label} snapshot project authority changed`);
  }
  return inventory;
}

export function assertC2ZcNoDependencyRepair(
  snapshot,
  label = "C2-ZC lifecycle",
) {
  const lifecycleRuns = rows(snapshot?.runs, `${label} runs`);
  if (
    lifecycleRuns.some(
      (run) => String(run?.runKind ?? "").toLowerCase() === "dependency-repair",
    )
  ) {
    throw new Error(`${label} contains a dependency-repair Run`);
  }
  return lifecycleRuns;
}

function applicationIdOf(value) {
  return value?.applicationId ?? value?.id;
}

export function assertC2ZcFixtureApplicationParity(
  snapshot,
  manifestOrSemantic,
  label = "C2-ZC fixture Application",
) {
  const semantic = manifestOrSemantic?.semantic ?? manifestOrSemantic;
  assertC2ZcFixtureSemantic(semantic, `${label} semantic`);
  const projectId = semantic.projectId;
  const applicationId = semantic.applicationId;
  assertC2ZcProjectInventory(snapshot, projectId, `${label} inventory`);
  const { e1 } = restoredEpoch(snapshot.epochs, `${label} epochs`);
  if (snapshot.currentEpochId !== e1.id) {
    throw new Error(`${label} is not bound to restored E1`);
  }
  assertC2ZcNoDependencyRepair(snapshot, label);
  if (snapshot.projectSettled !== true) {
    throw new Error(`${label} project is not settled`);
  }
  const dependencyEdges = rows(snapshot.dependencyEdges, `${label} edges`);
  const applicationEdges = dependencyEdges.filter(
    (edge) =>
      edge.projectId === projectId &&
      edge.consumerKind === C2ZC_FRESHNESS_CONSUMER_KIND &&
      edge.consumerKey === applicationId,
  );
  if (applicationEdges.length !== 1) {
    throw new Error(`${label} does not contain the manifest Application edge`);
  }
  if (applicationEdges[0].owningRunId !== semantic.backfillRunId) {
    throw new Error(
      `${label} fixture Edge is not owned by the manifest Backfill Run`,
    );
  }
  if (stableJson(applicationEdges[0]) !== stableJson(semantic.edge)) {
    throw new Error(`${label} fixture Edge differs from the manifest`);
  }
  const applications = rows(snapshot.applications, `${label} applications`);
  const matchingApplications = applications.filter(
    (application) => applicationIdOf(application) === applicationId,
  );
  if (applications.length !== 1 || matchingApplications.length !== 1) {
    throw new Error(
      `${label} does not contain exactly one manifest Application`,
    );
  }
  const applicationRow = matchingApplications[0];
  if (
    applicationRow.projectId !== undefined &&
    applicationRow.projectId !== projectId
  ) {
    throw new Error(`${label} Application changed project authority`);
  }
  if (
    semantic.application?.projectId !== undefined &&
    semantic.application.projectId !== projectId
  ) {
    throw new Error(`${label} manifest Application changed project authority`);
  }
  if (
    semantic.application?.runId !== undefined &&
    applicationRow.runId !== undefined &&
    applicationRow.runId !== semantic.application.runId
  ) {
    throw new Error(`${label} Application producer differs from the manifest`);
  }
  if (stableJson(applicationRow) !== stableJson(semantic.application)) {
    throw new Error(`${label} Application differs from the manifest`);
  }
  const genericRows = rows(snapshot.genericRows, `${label} Generic rows`);
  assertC2ZcGenericFreshnessStorage(
    snapshot,
    { projectId, applicationId, epochId: e1.id },
    `${label} Generic storage`,
  );
  if (genericRows.length !== 1) {
    throw new Error(`${label} must contain exactly one manifest Generic row`);
  }
  if (
    stableJson(snapshot.legacyProjection) !==
    stableJson(semantic.legacyProjection)
  ) {
    throw new Error(`${label} Legacy/Generic projection parity changed`);
  }
  assertC2ZcFindingRowsResolved(snapshot, `${label} findings`);
  assertC2ZcFeedCursorSettled(
    snapshot,
    {
      epochId: e1.id,
      projectId,
      consumerId: C2ZC_INCREMENTAL_FRESHNESS_CONSUMER_ID,
    },
    `${label} feed cursor`,
  );
  return { projectId, applicationId, epochId: e1.id, applicationRow };
}

function assertPositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function assertNonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return value;
}

function assertFixtureGitObjectId(value, label) {
  if (typeof value !== "string" || !C2ZC_FIXTURE_GIT_OBJECT_ID.test(value)) {
    throw new Error(`${label} must be a lowercase Git object ID`);
  }
  return value;
}

function assertFixtureSha256(value, label) {
  if (typeof value !== "string" || !C2ZC_FIXTURE_SHA256.test(value)) {
    throw new Error(`${label} must be a sha256 digest`);
  }
  return value;
}

function assertFixtureArtifactPath(value, label) {
  requireText(value, label);
  if (
    path.isAbsolute(value) ||
    value !== path.basename(value) ||
    value === "." ||
    value === ".." ||
    value.split(/[\\/]/u).some((part) => part === "." || part === "..")
  ) {
    throw new Error(`${label} must be a relative file name`);
  }
  return value;
}

function assertC2ZcFixtureCandidate(candidate, label) {
  if (!isObject(candidate)) throw new Error(`${label} must be an object`);
  assertExactKeys(candidate, C2ZC_RESTORE_FIXTURE_CANDIDATE_KEYS, label);
  requireText(candidate.requested, `${label}.requested`);
  for (const field of [
    "resolvedHeadSha",
    "resolvedTreeSha",
    "headSha",
    "treeSha",
  ]) {
    assertFixtureGitObjectId(candidate[field], `${label}.${field}`);
  }
  if (
    candidate.resolvedHeadSha !== candidate.headSha ||
    candidate.resolvedTreeSha !== candidate.treeSha
  ) {
    throw new Error(`${label} head/tree aliases do not match resolved values`);
  }
  if (candidate.clean !== true) {
    throw new Error(`${label}.clean must be true`);
  }
  assertFixtureSha256(candidate.statusSha256, `${label}.statusSha256`);
  return candidate;
}

function assertC2ZcFixtureArtifact(artifact, label) {
  if (!isObject(artifact)) throw new Error(`${label} must be an object`);
  assertExactKeys(artifact, C2ZC_RESTORE_FIXTURE_ARTIFACT_KEYS, label);
  assertFixtureArtifactPath(artifact.path, `${label}.path`);
  assertFixtureSha256(artifact.sha256, `${label}.sha256`);
  assertNonNegativeInteger(artifact.sizeBytes, `${label}.sizeBytes`);
  return artifact;
}

function assertC2ZcFixtureSemantic(semantic, label) {
  if (!isObject(semantic)) throw new Error(`${label} must be an object`);
  assertExactKeys(semantic, C2ZC_RESTORE_FIXTURE_SEMANTIC_KEYS, label);
  for (const field of [
    "projectId",
    "sceneId",
    "applicationId",
    "applyRunId",
    "backfillRunId",
  ]) {
    requireText(semantic[field], `${label}.${field}`);
  }
  for (const field of [
    "projectCount",
    "sceneCount",
    "e0Count",
    "completedBackfillCount",
    "dependencyEdgeCount",
    "applicationCount",
    "legacyProjectionFreshnessCount",
    "legacyProjectionDependencyCount",
    "applicationEdgeCount",
    "applicationEdgeStateCount",
    "applicationFreshnessCount",
    "semanticIndexRows",
  ]) {
    assertNonNegativeInteger(semantic[field], `${label}.${field}`);
  }
  if (
    semantic.projectCount !== 1 ||
    semantic.sceneCount !== 1 ||
    semantic.e0Count !== 1 ||
    semantic.completedBackfillCount !== 1 ||
    semantic.dependencyEdgeCount < semantic.applicationEdgeCount ||
    semantic.applicationCount !== 1 ||
    semantic.legacyProjectionFreshnessCount !== 1 ||
    semantic.legacyProjectionDependencyCount !== 1 ||
    semantic.applicationEdgeCount !== 1 ||
    semantic.applicationEdgeStateCount !== 0 ||
    semantic.applicationFreshnessCount !== 0 ||
    semantic.semanticIndexRows !== 0 ||
    semantic.cursorSettled !== true
  ) {
    throw new Error(
      `${label} is not the required pre-cutover derived-state gap`,
    );
  }
  for (const field of [
    "sceneSourceRevision",
    "edgeSourceObjectIdentity",
    "edgeReadSetJson",
  ]) {
    requireText(semantic[field], `${label}.${field}`);
  }
  for (const field of [
    "projectDigest",
    "sceneDigest",
    "epochDigest",
    "backfillDigest",
    "applicationDigest",
    "legacyProjectionDigest",
    "edgeDigest",
    "feedCursorDigest",
    "derivedStateGapDigest",
    "expectedRestoreGapDigest",
    "semanticIndexDigest",
    "expectedRestoreLifecycleDigest",
    "contentsDigest",
  ]) {
    assertFixtureSha256(semantic[field], `${label}.${field}`);
  }
  for (const field of [
    "project",
    "scene",
    "epoch",
    "backfill",
    "application",
    "legacyProjection",
    "edge",
    "feedCursor",
    "derivedStateGap",
    "expectedRestoreGap",
    "semanticIndex",
    "expectedRestoreLifecycle",
  ]) {
    if (!isObject(semantic[field])) {
      throw new Error(`${label}.${field} must be an object`);
    }
  }
  const project = semantic.project;
  assertExactKeys(
    project,
    [
      "id",
      "title",
      "genre",
      "pov",
      "tense",
      "language",
      "createdAt",
      "updatedAt",
    ],
    `${label}.project`,
  );
  if (
    project.id !== semantic.projectId ||
    project.title !== "C2-ZC offline restore fixture" ||
    project.genre !== "fixture" ||
    project.pov !== null ||
    project.tense !== null ||
    project.language !== "en"
  ) {
    throw new Error(`${label}.project does not match the fixture source`);
  }
  assertCanonicalTimestamp(project.createdAt, `${label}.project.createdAt`);
  assertCanonicalTimestamp(project.updatedAt, `${label}.project.updatedAt`);
  if (project.createdAt !== project.updatedAt) {
    throw new Error(`${label}.project timestamps are not the fixture seed`);
  }

  const scene = semantic.scene;
  assertExactKeys(
    scene,
    [
      "id",
      "projectId",
      "nodeType",
      "title",
      "synopsis",
      "status",
      "content",
      "version",
      "updatedAt",
    ],
    `${label}.scene`,
  );
  if (
    scene.id !== semantic.sceneId ||
    scene.projectId !== semantic.projectId ||
    scene.nodeType !== "scene" ||
    scene.title !== "Offline restore scene" ||
    scene.synopsis !== "A canonical source used by the restore gap fixture." ||
    scene.status !== "draft" ||
    scene.content !== "{}"
  ) {
    throw new Error(`${label}.scene does not match the fixture source`);
  }
  assertNonNegativeInteger(scene.version, `${label}.scene.version`);
  assertC2ZcTypedTreeNodeProducerTimestamp(
    scene.updatedAt,
    `${label}.scene.updatedAt`,
  );
  if (semantic.sceneSourceRevision !== `v${scene.version}@${scene.updatedAt}`) {
    throw new Error(`${label}.scene source revision is not bound to the seed`);
  }

  assertExactKeys(semantic.epoch, ["rows"], `${label}.epoch`);
  const epochRows = rows(semantic.epoch.rows, `${label}.epoch.rows`);
  if (epochRows.length !== 1) {
    throw new Error(`${label}.epoch must contain exactly one E0 row`);
  }
  const epoch = epochRows[0];
  assertExactKeys(
    epoch,
    [
      "id",
      "projectId",
      "epochNumber",
      "reason",
      "triggeredByChangeEventUid",
      "createdAt",
    ],
    `${label}.epoch.rows[0]`,
  );
  requireText(epoch.id, `${label}.epoch.rows[0].id`);
  if (
    epoch.projectId !== semantic.projectId ||
    epoch.epochNumber !== 0 ||
    epoch.reason !== "initial" ||
    epoch.triggeredByChangeEventUid !== null
  ) {
    throw new Error(`${label}.epoch is not the fixture E0`);
  }
  assertCanonicalTimestamp(epoch.createdAt, `${label}.epoch.rows[0].createdAt`);

  assertExactKeys(semantic.backfill, ["rows"], `${label}.backfill`);
  const backfillRows = rows(semantic.backfill.rows, `${label}.backfill.rows`);
  if (backfillRows.length !== 1) {
    throw new Error(`${label}.backfill must contain exactly one Run`);
  }
  const backfill = backfillRows[0];
  assertExactKeys(
    backfill,
    [
      "id",
      "projectId",
      "runKind",
      "workKey",
      "specJson",
      "specDigest",
      "status",
      "semanticEpochId",
      "createdAt",
      "startedAt",
      "completedAt",
      "outcomeSummaryJson",
      "taskCount",
      "attemptCount",
    ],
    `${label}.backfill.rows[0]`,
  );
  if (
    backfill.id !== semantic.backfillRunId ||
    backfill.projectId !== semantic.projectId ||
    backfill.runKind !== "backfill" ||
    backfill.workKey !== "legacy-dependency-backfill:v3" ||
    backfill.status !== "completed" ||
    backfill.semanticEpochId !== epoch.id
  ) {
    throw new Error(`${label}.backfill is not the canonical completed Run`);
  }
  const backfillSpec = parseObject(
    backfill.specJson,
    `${label}.backfill.rows[0].specJson`,
  );
  assertExactKeys(
    backfillSpec,
    ["backfillAlgorithmVersion"],
    `${label}.backfill spec`,
  );
  if (backfillSpec.backfillAlgorithmVersion !== "3") {
    throw new Error(`${label}.backfill spec is not v3`);
  }
  assertFixtureSha256(backfill.specDigest, `${label}.backfill.specDigest`);
  if (backfill.specDigest !== digestJson(backfillSpec)) {
    throw new Error(`${label}.backfill spec digest does not match`);
  }
  const backfillCreatedAt = assertCanonicalTimestamp(
    backfill.createdAt,
    `${label}.backfill.createdAt`,
  );
  const backfillStartedAt = assertCanonicalTimestamp(
    backfill.startedAt,
    `${label}.backfill.startedAt`,
  );
  const backfillCompletedAt = assertCanonicalTimestamp(
    backfill.completedAt,
    `${label}.backfill.completedAt`,
  );
  if (
    Date.parse(backfillCreatedAt) > Date.parse(backfillStartedAt) ||
    Date.parse(backfillStartedAt) >= Date.parse(backfillCompletedAt)
  ) {
    throw new Error(`${label}.backfill timestamps are not strictly ordered`);
  }
  assertNonNegativeInteger(backfill.taskCount, `${label}.backfill.taskCount`);
  assertNonNegativeInteger(
    backfill.attemptCount,
    `${label}.backfill.attemptCount`,
  );
  const backfillOutcome = parseObject(
    backfill.outcomeSummaryJson,
    `${label}.backfill.rows[0].outcomeSummaryJson`,
  );
  assertExactKeys(
    backfillOutcome,
    [
      "maintenancePhase",
      "backfillAlgorithmVersion",
      "semanticEpochId",
      "summary",
    ],
    `${label}.backfill outcome`,
  );
  if (
    backfillOutcome.maintenancePhase !== "backfill-complete" ||
    backfillOutcome.backfillAlgorithmVersion !== "3" ||
    backfillOutcome.semanticEpochId !== epoch.id
  ) {
    throw new Error(`${label}.backfill outcome is not complete`);
  }
  assertExactKeys(
    backfillOutcome.summary,
    [
      "epoch_created",
      "contributions_created",
      "edges_created",
      "applications_without_run_id",
    ],
    `${label}.backfill outcome summary`,
  );
  if (
    backfillOutcome.summary.epoch_created !== false ||
    backfillOutcome.summary.contributions_created !== 1 ||
    backfillOutcome.summary.edges_created !== 1 ||
    backfillOutcome.summary.applications_without_run_id !== 0
  ) {
    throw new Error(
      `${label}.backfill outcome summary is not the fixture result`,
    );
  }

  const application = semantic.application;
  assertExactKeys(
    application,
    [
      "id",
      "commitId",
      "projectId",
      "runId",
      "runStatus",
      "proposalSetId",
      "requestId",
      "planDigest",
      "commitStatus",
      "sessionId",
      "commitCreatedAt",
      "completedAt",
      "commitVersion",
      "proposalId",
      "revisionId",
      "appliedEntityKind",
      "appliedEntityId",
      "eventId",
      "createdAt",
      "applicationKind",
      "compensatesApplicationId",
    ],
    `${label}.application`,
  );
  if (
    application.id !== semantic.applicationId ||
    application.projectId !== semantic.projectId ||
    application.runId !== semantic.applyRunId ||
    application.runStatus !== "completed" ||
    application.commitStatus !== "applied" ||
    application.applicationKind !== "normal" ||
    application.compensatesApplicationId !== null ||
    application.appliedEntityKind !== "event" ||
    typeof application.appliedEntityId !== "string" ||
    application.appliedEntityId.trim() === "" ||
    application.eventId !== application.appliedEntityId
  ) {
    throw new Error(`${label}.application provenance is not the applied event`);
  }
  for (const field of [
    "commitId",
    "requestId",
    "planDigest",
    "sessionId",
    "proposalId",
    "revisionId",
  ]) {
    requireText(application[field], `${label}.application.${field}`);
  }
  assertCanonicalTimestamp(
    application.commitCreatedAt,
    `${label}.application.commitCreatedAt`,
  );
  assertCanonicalTimestamp(
    application.completedAt,
    `${label}.application.completedAt`,
  );
  assertNonNegativeInteger(
    application.commitVersion,
    `${label}.application.commitVersion`,
  );
  assertCanonicalTimestamp(
    application.createdAt,
    `${label}.application.createdAt`,
  );
  if (
    semantic.project.id !== undefined &&
    semantic.project.id !== semantic.projectId
  ) {
    throw new Error(`${label}.project does not match projectId`);
  }
  if (
    semantic.scene.id !== undefined &&
    semantic.scene.id !== semantic.sceneId
  ) {
    throw new Error(`${label}.scene does not match sceneId`);
  }
  if (
    semantic.scene.projectId !== undefined &&
    semantic.scene.projectId !== semantic.projectId
  ) {
    throw new Error(`${label}.scene does not match projectId`);
  }
  const applicationIdentity =
    semantic.application.applicationId ?? semantic.application.id;
  if (applicationIdentity !== semantic.applicationId) {
    throw new Error(`${label}.application does not match applicationId`);
  }
  if (
    semantic.application.projectId !== undefined &&
    semantic.application.projectId !== semantic.projectId
  ) {
    throw new Error(`${label}.application does not match projectId`);
  }
  if (
    semantic.application.runId !== undefined &&
    semantic.application.runId !== semantic.applyRunId
  ) {
    throw new Error(`${label}.application does not match applyRunId`);
  }
  if (
    semantic.edge.consumerKind !== C2ZC_FRESHNESS_CONSUMER_KIND ||
    semantic.edge.consumerKey !== semantic.applicationId ||
    (semantic.edge.projectId !== undefined &&
      semantic.edge.projectId !== semantic.projectId)
  ) {
    throw new Error(`${label}.edge must target the manifest Application`);
  }
  if (
    semantic.edge.sourceObjectIdentity !== undefined &&
    semantic.edge.sourceObjectIdentity !== semantic.edgeSourceObjectIdentity
  ) {
    throw new Error(`${label}.edge source identity does not match`);
  }
  if (
    semantic.edge.readSetJson !== undefined &&
    semantic.edge.readSetJson !== semantic.edgeReadSetJson
  ) {
    throw new Error(`${label}.edge read set does not match`);
  }
  assertExactKeys(
    semantic.edge,
    [
      "id",
      "projectId",
      "consumerKind",
      "consumerKey",
      "sourceObjectIdentity",
      "readSetJson",
      "generatedByTransactionId",
      "createdAt",
      "owningRunId",
    ],
    `${label}.edge`,
  );
  if (
    semantic.edge.generatedByTransactionId !== null ||
    semantic.edge.owningRunId !== semantic.backfillRunId
  ) {
    throw new Error(`${label}.edge is not bound to the completed Backfill Run`);
  }
  requireText(semantic.edge.id, `${label}.edge.id`);
  assertCanonicalTimestamp(semantic.edge.createdAt, `${label}.edge.createdAt`);
  assertExactKeys(
    semantic.expectedRestoreGap,
    [
      "edgeIdsWithoutCurrentEpochState",
      "consumerKeysWithoutCurrentEpochFreshness",
    ],
    `${label}.expectedRestoreGap`,
  );
  const expectedGapEdges = rows(
    semantic.expectedRestoreGap.edgeIdsWithoutCurrentEpochState,
    `${label}.expectedRestoreGap.edgeIdsWithoutCurrentEpochState`,
  );
  const expectedGapConsumers = rows(
    semantic.expectedRestoreGap.consumerKeysWithoutCurrentEpochFreshness,
    `${label}.expectedRestoreGap.consumerKeysWithoutCurrentEpochFreshness`,
  );
  if (
    expectedGapEdges.length !== 2 ||
    semantic.dependencyEdgeCount !== expectedGapEdges.length
  ) {
    throw new Error(`${label}.expectedRestoreGap edge count does not match`);
  }
  if (expectedGapConsumers.length !== 2) {
    throw new Error(`${label}.expectedRestoreGap consumer count is invalid`);
  }
  if (
    new Set(expectedGapEdges.map((edge) => edge.id)).size !==
    expectedGapEdges.length
  ) {
    throw new Error(`${label}.expectedRestoreGap contains duplicate edges`);
  }
  if (
    new Set(
      expectedGapConsumers.map(
        (consumer) => `${consumer.consumerKind}\u0000${consumer.consumerKey}`,
      ),
    ).size !== expectedGapConsumers.length
  ) {
    throw new Error(`${label}.expectedRestoreGap contains duplicate consumers`);
  }
  const orderedExpectedGapEdges = [...expectedGapEdges].sort((left, right) =>
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
  );
  if (stableJson(expectedGapEdges) !== stableJson(orderedExpectedGapEdges)) {
    throw new Error(`${label}.expectedRestoreGap edges are not ordered`);
  }
  const orderedExpectedGapConsumers = [...expectedGapConsumers].sort(
    (left, right) => {
      const kindOrder =
        left.consumerKind < right.consumerKind
          ? -1
          : left.consumerKind > right.consumerKind
            ? 1
            : 0;
      return kindOrder !== 0
        ? kindOrder
        : left.consumerKey < right.consumerKey
          ? -1
          : left.consumerKey > right.consumerKey
            ? 1
            : 0;
    },
  );
  if (
    stableJson(expectedGapConsumers) !== stableJson(orderedExpectedGapConsumers)
  ) {
    throw new Error(`${label}.expectedRestoreGap consumers are not ordered`);
  }
  for (const [index, expectedEdge] of expectedGapEdges.entries()) {
    assertExactKeys(
      expectedEdge,
      ["id", "consumerKind", "consumerKey"],
      `${label}.expectedRestoreGap.edge[${index}]`,
    );
    requireText(
      expectedEdge.id,
      `${label}.expectedRestoreGap.edge[${index}].id`,
    );
    requireText(
      expectedEdge.consumerKind,
      `${label}.expectedRestoreGap.edge[${index}].consumerKind`,
    );
    requireText(
      expectedEdge.consumerKey,
      `${label}.expectedRestoreGap.edge[${index}].consumerKey`,
    );
  }
  for (const [index, expectedConsumer] of expectedGapConsumers.entries()) {
    assertExactKeys(
      expectedConsumer,
      ["consumerKind", "consumerKey"],
      `${label}.expectedRestoreGap.consumer[${index}]`,
    );
    requireText(
      expectedConsumer.consumerKind,
      `${label}.expectedRestoreGap.consumer[${index}].consumerKind`,
    );
    requireText(
      expectedConsumer.consumerKey,
      `${label}.expectedRestoreGap.consumer[${index}].consumerKey`,
    );
  }
  const expectedApplicationEdge = expectedGapEdges.filter(
    (candidate) =>
      candidate.consumerKind === C2ZC_FRESHNESS_CONSUMER_KIND &&
      candidate.consumerKey === semantic.applicationId,
  );
  if (
    expectedApplicationEdge.length !== 1 ||
    expectedApplicationEdge[0].id !== semantic.edge.id
  ) {
    throw new Error(`${label}.expectedRestoreGap Application edge is invalid`);
  }
  const expectedApplicationConsumer = expectedGapConsumers.filter(
    (candidate) =>
      candidate.consumerKind === C2ZC_FRESHNESS_CONSUMER_KIND &&
      candidate.consumerKey === semantic.applicationId,
  );
  if (expectedApplicationConsumer.length !== 1) {
    throw new Error(
      `${label}.expectedRestoreGap Application consumer is invalid`,
    );
  }
  const expectedProposalRevision = expectedGapEdges.filter(
    (candidate) =>
      candidate.consumerKind === "proposal-revision" &&
      candidate.consumerKey === semantic.application.revisionId,
  );
  if (expectedProposalRevision.length !== 1) {
    throw new Error(
      `${label}.expectedRestoreGap proposal-revision edge is invalid`,
    );
  }
  const expectedProposalConsumer = expectedGapConsumers.filter(
    (candidate) =>
      candidate.consumerKind === "proposal-revision" &&
      candidate.consumerKey === semantic.application.revisionId,
  );
  if (expectedProposalConsumer.length !== 1) {
    throw new Error(
      `${label}.expectedRestoreGap proposal-revision consumer is invalid`,
    );
  }
  const legacy = semantic.legacyProjection;
  assertExactKeys(
    legacy,
    ["freshness", "dependencies"],
    `${label}.legacyProjection`,
  );
  if (!isObject(legacy.freshness)) {
    throw new Error(`${label}.legacyProjection.freshness must be an object`);
  }
  assertExactKeys(
    legacy.freshness,
    ["applicationId", "status", "reasonJson", "version", "updatedAt"],
    `${label}.legacyProjection.freshness`,
  );
  if (
    legacy.freshness.applicationId !== semantic.applicationId ||
    legacy.freshness.status !== "fresh" ||
    legacy.freshness.reasonJson !== null ||
    legacy.freshness.version !== 0
  ) {
    throw new Error(
      `${label}.legacyProjection freshness is not the applied Application`,
    );
  }
  assertCanonicalTimestamp(
    legacy.freshness.updatedAt,
    `${label}.legacyProjection.freshness.updatedAt`,
  );
  const legacyDependencies = rows(
    legacy.dependencies,
    `${label}.legacyProjection.dependencies`,
  );
  if (legacyDependencies.length !== 1) {
    throw new Error(`${label}.legacyProjection must contain one dependency`);
  }
  assertExactKeys(
    legacyDependencies[0],
    ["sourceKind", "sourceKey", "observedRevisionToken", "propagation"],
    `${label}.legacyProjection.dependencies[0]`,
  );
  if (
    legacyDependencies[0].sourceKind !== "scene-body" ||
    legacyDependencies[0].sourceKey !== semantic.edgeSourceObjectIdentity ||
    legacyDependencies[0].observedRevisionToken !==
      semantic.sceneSourceRevision ||
    legacyDependencies[0].propagation !== "freshness-only"
  ) {
    throw new Error(
      `${label}.legacyProjection dependency is not the scene source`,
    );
  }
  assertExactKeys(
    semantic.derivedStateGap,
    [
      "applicationEdgeStateRows",
      "applicationFreshnessRows",
      "genericApplicationRows",
      "rebuildScope",
    ],
    `${label}.derivedStateGap`,
  );
  for (const field of [
    "applicationEdgeStateRows",
    "applicationFreshnessRows",
    "genericApplicationRows",
  ]) {
    if (semantic.derivedStateGap[field] !== 0) {
      throw new Error(`${label}.derivedStateGap.${field} must be zero`);
    }
  }
  requireText(
    semantic.derivedStateGap.rebuildScope,
    `${label}.derivedStateGap.rebuildScope`,
  );
  assertExactKeys(
    semantic.semanticIndex,
    [
      "metadataRows",
      "activeD1HeadRows",
      "v1EdgeRows",
      "consumerFreshnessRows",
      "totalRows",
    ],
    `${label}.semanticIndex`,
  );
  for (const field of [
    "metadataRows",
    "activeD1HeadRows",
    "v1EdgeRows",
    "consumerFreshnessRows",
    "totalRows",
  ]) {
    if (semantic.semanticIndex[field] !== 0) {
      throw new Error(`${label}.semanticIndex.${field} must be zero`);
    }
  }
  assertExactKeys(
    semantic.feedCursor,
    ["feedHead", "cursor"],
    `${label}.feedCursor`,
  );
  if (!isObject(semantic.feedCursor.cursor)) {
    throw new Error(`${label}.feedCursor.cursor must be an object`);
  }
  assertExactKeys(
    semantic.feedCursor.cursor,
    [
      "projectId",
      "consumerId",
      "acknowledgedThroughSequence",
      "leaseOwner",
      "leaseExpiresAt",
      "lastError",
      "updatedAt",
    ],
    `${label}.feedCursor.cursor`,
  );
  if (
    semantic.feedCursor.cursor.projectId !== semantic.projectId ||
    semantic.feedCursor.cursor.consumerId !==
      C2ZC_INCREMENTAL_FRESHNESS_CONSUMER_ID ||
    semantic.feedCursor.cursor.leaseOwner !== null ||
    semantic.feedCursor.cursor.leaseExpiresAt !== null ||
    semantic.feedCursor.cursor.lastError !== null ||
    semantic.feedCursor.cursor.acknowledgedThroughSequence !==
      semantic.feedCursor.feedHead ||
    !Number.isSafeInteger(semantic.feedCursor.feedHead) ||
    semantic.feedCursor.feedHead < 0
  ) {
    throw new Error(`${label}.feedCursor is not settled`);
  }
  assertCanonicalTimestamp(
    semantic.feedCursor.cursor.updatedAt,
    `${label}.feedCursor.cursor.updatedAt`,
  );
  assertExpectedRestoreLifecycle(
    semantic.expectedRestoreLifecycle,
    `${label}.expectedRestoreLifecycle`,
  );
  const payloadDigests = [
    ["project", semantic.projectDigest, semantic.project],
    ["scene", semantic.sceneDigest, semantic.scene],
    ["epoch", semantic.epochDigest, semantic.epoch],
    ["backfill", semantic.backfillDigest, semantic.backfill],
    ["application", semantic.applicationDigest, semantic.application],
    [
      "legacyProjection",
      semantic.legacyProjectionDigest,
      semantic.legacyProjection,
    ],
    ["edge", semantic.edgeDigest, semantic.edge],
    ["feedCursor", semantic.feedCursorDigest, semantic.feedCursor],
    [
      "derivedStateGap",
      semantic.derivedStateGapDigest,
      semantic.derivedStateGap,
    ],
    [
      "expectedRestoreGap",
      semantic.expectedRestoreGapDigest,
      semantic.expectedRestoreGap,
    ],
    ["semanticIndex", semantic.semanticIndexDigest, semantic.semanticIndex],
    [
      "expectedRestoreLifecycle",
      semantic.expectedRestoreLifecycleDigest,
      semantic.expectedRestoreLifecycle,
    ],
  ];
  for (const [field, actual, value] of payloadDigests) {
    if (actual !== digestJson(value)) {
      throw new Error(`${label}.${field}Digest does not match its payload`);
    }
  }
  if (
    semantic.contentsDigest !== digestJson(semanticContentsPayload(semantic))
  ) {
    throw new Error(`${label}.contentsDigest does not match semantic contents`);
  }
  return semantic;
}

/** Validate the exact output contract of the Rust offline fixture builder. */
export function assertC2ZcRestoreFixtureManifest(
  manifest,
  label = "C2-ZC restore fixture manifest",
) {
  if (!isObject(manifest)) throw new Error(`${label} must be an object`);
  assertExactKeys(manifest, C2ZC_RESTORE_FIXTURE_MANIFEST_KEYS, label);
  if (manifest.manifestVersion !== C2ZC_RESTORE_FIXTURE_MANIFEST_VERSION) {
    throw new Error(`${label} manifestVersion is unsupported`);
  }
  if (manifest.contractVersion !== C2ZC_RESTORE_FIXTURE_CONTRACT_VERSION) {
    throw new Error(`${label} contractVersion is unsupported`);
  }
  assertPositiveInteger(manifest.schemaVersion, `${label}.schemaVersion`);
  if (manifest.databaseSchemaVersion !== manifest.schemaVersion) {
    throw new Error(
      `${label} databaseSchemaVersion does not match schemaVersion`,
    );
  }
  if (manifest.c2zcMarkerPresent !== false) {
    throw new Error(`${label} must be a pre-cutover image without the marker`);
  }
  assertC2ZcFixtureCandidate(manifest.candidate, `${label}.candidate`);
  if (manifest.builderVersion !== C2ZC_RESTORE_FIXTURE_BUILDER_VERSION) {
    throw new Error(`${label} builderVersion is unsupported`);
  }
  if (
    !Array.isArray(manifest.builderCommand) ||
    manifest.builderCommand.length === 0 ||
    manifest.builderCommand.some((value) => typeof value !== "string") ||
    !Array.isArray(manifest.exactBuilderCommand) ||
    manifest.exactBuilderCommand.length === 0 ||
    manifest.exactBuilderCommand.some((value) => typeof value !== "string") ||
    stableJson(manifest.builderCommand) !==
      stableJson(manifest.exactBuilderCommand)
  ) {
    throw new Error(`${label} builder command is invalid`);
  }
  if (!isObject(manifest.artifacts)) {
    throw new Error(`${label}.artifacts must be an object`);
  }
  assertExactKeys(
    manifest.artifacts,
    ["fixture", "database"],
    `${label}.artifacts`,
  );
  assertC2ZcFixtureArtifact(
    manifest.artifacts.fixture,
    `${label}.artifacts.fixture`,
  );
  assertC2ZcFixtureArtifact(
    manifest.artifacts.database,
    `${label}.artifacts.database`,
  );
  assertFixtureSha256(manifest.fixtureSha256, `${label}.fixtureSha256`);
  assertNonNegativeInteger(
    manifest.fixtureSizeBytes,
    `${label}.fixtureSizeBytes`,
  );
  if (
    manifest.fixtureSha256 !== manifest.artifacts.fixture.sha256 ||
    manifest.fixtureSizeBytes !== manifest.artifacts.fixture.sizeBytes
  ) {
    throw new Error(
      `${label} top-level fixture digest disagrees with artifact`,
    );
  }
  assertC2ZcFixtureSemantic(manifest.semantic, `${label}.semantic`);
  return manifest;
}

/**
 * Narrow boundary between the fixture builder and this journey. The builder
 * owns the offline SQLite image; this runner only stages the verified image
 * and uses the production Settings restore route.
 */
export function assertC2ZcRestoreFixtureInput(
  input,
  label = "C2-ZC restore fixture",
) {
  if (!isObject(input)) throw new Error(`${label} must be an object`);
  assertExactKeys(input, ["path", "manifest"], label);
  if (
    typeof input.path !== "string" ||
    !path.isAbsolute(input.path) ||
    input.path.includes("\u0000")
  ) {
    throw new Error(`${label} path must be absolute and NUL-free`);
  }
  if (typeof input.manifest === "string") {
    if (!path.isAbsolute(input.manifest) || input.manifest.includes("\u0000")) {
      throw new Error(`${label} manifest path must be absolute and NUL-free`);
    }
    return input;
  }
  assertC2ZcRestoreFixtureManifest(
    parseObject(input.manifest, `${label} manifest`),
    `${label} manifest`,
  );
  return input;
}

export function resolveC2ZcRestoreFixtureInput(
  input,
  environment = process.env,
) {
  let value = input;
  if (value === undefined || value === null || value === "") {
    value = environment[C2ZC_RESTORE_FIXTURE_ENV];
  }
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch (error) {
      throw new Error(`${C2ZC_RESTORE_FIXTURE_ENV} must be JSON`, {
        cause: error,
      });
    }
  }
  return assertC2ZcRestoreFixtureInput(value);
}

async function stageC2ZcRestoreFixture(workspace, fixture) {
  const sourceMetadata = await lstat(fixture.path);
  if (!sourceMetadata.isFile()) {
    throw new Error("C2-ZC restore fixture path must be a regular file");
  }
  const sourcePath = await realpath(fixture.path);
  const sourceStat = await stat(sourcePath);
  if (!sourceStat.isFile())
    throw new Error("C2-ZC restore fixture path must be a file");
  const backupDirectory = path.join(workspace, "backups");
  await mkdir(backupDirectory, { recursive: true });
  const targetPath = path.join(
    backupDirectory,
    fixture.manifest.artifacts.fixture.path,
  );
  await copyFile(sourcePath, targetPath);
  await assertFixtureArtifactDigest(
    targetPath,
    fixture.manifest.artifacts.fixture,
    "C2-ZC staged restore fixture",
  );
  return { targetPath, sourcePath, manifest: fixture.manifest };
}

async function assertFixtureArtifactDigest(filePath, expected, label) {
  const metadata = await lstat(filePath);
  if (!metadata.isFile()) throw new Error(`${label} must be a regular file`);
  const bytes = await readFile(filePath);
  const actualSha256 = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  if (actualSha256 !== expected.sha256 || bytes.length !== expected.sizeBytes) {
    throw new Error(`${label} bytes do not match its manifest digest`);
  }
  return { sha256: actualSha256, sizeBytes: bytes.length };
}

export async function loadC2ZcRestoreFixtureInput(
  input,
  environment = process.env,
) {
  const fixture = resolveC2ZcRestoreFixtureInput(input, environment);
  let manifestPath = null;
  const manifest =
    typeof fixture.manifest === "string"
      ? ((manifestPath = fixture.manifest),
        parseObject(
          JSON.parse(await readFile(fixture.manifest, "utf8")),
          "C2-ZC restore fixture manifest",
        ))
      : fixture.manifest;
  assertC2ZcRestoreFixtureManifest(manifest);
  const manifestBase = path.dirname(manifestPath ?? fixture.path);
  for (const [name, artifact] of Object.entries(manifest.artifacts)) {
    const artifactPath = path.resolve(manifestBase, artifact.path);
    const resolvedInput = path.resolve(fixture.path);
    if (path.resolve(artifactPath) !== resolvedInput && name === "fixture") {
      throw new Error("C2-ZC fixture path does not match manifest artifact");
    }
    await assertFixtureArtifactDigest(
      artifactPath,
      artifact,
      `C2-ZC ${name} artifact`,
    );
  }
  return {
    path: fixture.path,
    manifest,
    manifestPath,
  };
}

function observedCandidateOf(value, label) {
  const candidate = value?.receipt?.candidate ?? value?.candidate ?? value;
  if (!isObject(candidate)) {
    throw new Error(`${label} must expose the candidate-bound Rust receipt`);
  }
  return candidate;
}

/**
 * Re-bind the fixture's candidate/head/tree evidence to the live Rust receipt.
 * The Rust receipt uses a richer candidate shape; only equivalent fields are
 * compared here, while the fixture's status and byte digests are checked
 * against their own manifest artifacts above.
 */
export function assertC2ZcFixtureCandidateBinding(
  manifestCandidate,
  observedCandidate,
  label = "C2-ZC fixture candidate",
) {
  const fixtureCandidate = assertC2ZcFixtureCandidate(manifestCandidate, label);
  const candidate = observedCandidateOf(observedCandidate, label);
  const requested = candidate.requestedHead ?? candidate.requested;
  const resolvedHeadSha = candidate.resolvedHeadSha;
  const resolvedTreeSha =
    candidate.resolvedHeadTreeSha ?? candidate.resolvedTreeSha;
  const currentHeadSha = candidate.currentHeadSha ?? candidate.headSha;
  const worktreeClean = candidate.worktreeClean ?? candidate.clean;
  if (
    typeof requested !== "string" ||
    typeof resolvedHeadSha !== "string" ||
    typeof resolvedTreeSha !== "string" ||
    typeof currentHeadSha !== "string" ||
    worktreeClean !== true
  ) {
    throw new Error(`${label} does not expose a complete candidate binding`);
  }
  if (requested !== fixtureCandidate.requested) {
    throw new Error(
      `${label} requested candidate does not match the Rust receipt`,
    );
  }
  if (resolvedHeadSha !== fixtureCandidate.resolvedHeadSha) {
    throw new Error(`${label} resolved HEAD does not match the Rust receipt`);
  }
  if (resolvedTreeSha !== fixtureCandidate.resolvedTreeSha) {
    throw new Error(`${label} resolved tree does not match the Rust receipt`);
  }
  if (currentHeadSha !== fixtureCandidate.headSha) {
    throw new Error(`${label} current HEAD does not match the fixture`);
  }
  if (
    candidate.fixtureStatusSha256 !== undefined &&
    candidate.fixtureStatusSha256 !== fixtureCandidate.statusSha256
  ) {
    throw new Error(`${label} status digest does not match the fixture`);
  }
  const observedStatusSha256 =
    candidate.fixtureStatusSha256 ??
    candidate.worktreeStatusHash ??
    candidate.statusSha256;
  if (typeof observedStatusSha256 === "string") {
    const normalizedStatusSha256 = observedStatusSha256.startsWith("sha256:")
      ? observedStatusSha256
      : `sha256:${observedStatusSha256}`;
    if (normalizedStatusSha256 !== fixtureCandidate.statusSha256) {
      throw new Error(`${label} status digest does not match the fixture`);
    }
  }
  return fixtureCandidate;
}

function defineC2ZcAuthorityQuery(sql, params) {
  return Object.freeze({ sql, params });
}

/**
 * Count SQLite anonymous parameter tokens without treating question marks in
 * literals, quoted identifiers, or comments as bind parameters.  The query
 * descriptors are intentionally limited to anonymous `?` parameters, but the
 * scanner understands all quote/comment forms accepted by SQLite so a future
 * descriptor cannot silently get the wrong arity from a regexp.
 */
export function countC2ZcSqlPlaceholders(sql) {
  if (typeof sql !== "string") {
    throw new TypeError("C2-ZC SQL must be a string");
  }
  let count = 0;
  let index = 0;
  while (index < sql.length) {
    const character = sql[index];
    if (character === "-") {
      if (sql[index + 1] === "-") {
        index += 2;
        while (index < sql.length && sql[index] !== "\n") index += 1;
        continue;
      }
    } else if (character === "/" && sql[index + 1] === "*") {
      index += 2;
      while (
        index < sql.length &&
        !(sql[index] === "*" && sql[index + 1] === "/")
      ) {
        index += 1;
      }
      index = Math.min(sql.length, index + 2);
      continue;
    } else if (
      character === "'" ||
      character === '"' ||
      character === "`" ||
      character === "["
    ) {
      const closingCharacter = character === "[" ? "]" : character;
      index += 1;
      while (index < sql.length) {
        if (sql[index] !== closingCharacter) {
          index += 1;
          continue;
        }
        if (closingCharacter !== "]" && sql[index + 1] === closingCharacter) {
          index += 2;
          continue;
        }
        index += 1;
        break;
      }
      continue;
    } else if (character === "?") {
      if (sql[index + 1] >= "0" && sql[index + 1] <= "9") {
        throw new Error(
          "C2-ZC SQL uses unsupported numbered SQLite placeholder '?NNN'",
        );
      }
      count += 1;
    } else if (character === ":" || character === "@" || character === "$") {
      throw new Error(
        `C2-ZC SQL uses unsupported named SQLite placeholder '${character}name'`,
      );
    }
    index += 1;
  }
  return count;
}

export function resolveC2ZcAuthorityQuery(definition, context = {}) {
  if (!definition || typeof definition.sql !== "string") {
    throw new Error("C2-ZC authority query definition is invalid");
  }
  if (typeof definition.params !== "function") {
    throw new Error("C2-ZC authority query parameters are invalid");
  }
  const params = definition.params(context);
  if (!Array.isArray(params)) {
    throw new Error("C2-ZC authority query parameters must be an array");
  }
  const placeholderCount = countC2ZcSqlPlaceholders(definition.sql);
  if (params.length !== placeholderCount) {
    throw new Error(
      `C2-ZC authority query parameter arity mismatch: expected ${placeholderCount}, got ${params.length}`,
    );
  }
  return { sql: definition.sql, params };
}

/**
 * The live authority snapshot is deliberately assembled from one query
 * definition set. Contract tests execute these exact SQL strings against a
 * migrated workspace so a fixture-shaped row cannot hide schema drift.
 */
export const C2ZC_AUTHORITY_SNAPSHOT_QUERIES = Object.freeze({
  marker: defineC2ZcAuthorityQuery(
    `SELECT migration_id AS migrationId,
            contract_version AS contractVersion,
            applied_at AS appliedAt
       FROM schema_data_migrations
      WHERE migration_id = ?`,
    () => [C2ZC_CUTOVER_MIGRATION_ID],
  ),
  epochs: defineC2ZcAuthorityQuery(
    `SELECT id, project_id AS projectId,
            epoch_number AS epochNumber, reason,
            created_at AS createdAt
       FROM narrative_semantic_epochs
      WHERE project_id = ?
      ORDER BY epoch_number, id`,
    ({ projectId }) => [projectId],
  ),
  runs: defineC2ZcAuthorityQuery(
    `SELECT id, project_id AS projectId,
            run_kind AS runKind, work_key AS workKey, status,
            semantic_epoch_id AS semanticEpochId,
            outcome_summary_json AS outcomeSummaryJson,
            created_at AS createdAt, started_at AS startedAt,
            completed_at AS completedAt, version
       FROM narrative_extraction_runs
      WHERE project_id = ?
      ORDER BY created_at, id`,
    ({ projectId }) => [projectId],
  ),
  genericFreshness: defineC2ZcAuthorityQuery(
    `SELECT project_id AS projectId,
            consumer_kind AS consumerKind,
            consumer_key AS consumerKey,
            consumer_key AS applicationId,
            evidence_freshness AS evidenceFreshness,
            build_action AS buildAction,
            semantic_epoch_id AS semanticEpochId,
            last_evaluated_run_id AS lastEvaluatedRunId,
            dependency_set_digest AS dependencySetDigest,
            updated_at AS updatedAt
       FROM narrative_consumer_freshness
      WHERE project_id = ? AND consumer_kind = ?
      ORDER BY consumer_key`,
    ({ projectId }) => [projectId, C2ZC_FRESHNESS_CONSUMER_KIND],
  ),
  legacyFreshness: defineC2ZcAuthorityQuery(
    `SELECT application.id AS applicationId,
            freshness.status AS status,
            freshness.reason_json AS reasonJson,
            freshness.version AS version,
            freshness.updated_at AS updatedAt
       FROM narrative_projection_freshness freshness
       JOIN narrative_proposal_applications application
         ON application.id = freshness.application_id
       JOIN narrative_apply_commits commit_row
         ON commit_row.id = application.commit_id
      WHERE commit_row.project_id = ?
      ORDER BY application.id`,
    ({ projectId }) => [projectId],
  ),
  legacyDependencies: defineC2ZcAuthorityQuery(
    `SELECT dependency.source_kind AS sourceKind,
            dependency.source_key AS sourceKey,
            dependency.observed_revision_token AS observedRevisionToken,
            dependency.propagation AS propagation
       FROM narrative_projection_dependencies dependency
       JOIN narrative_proposal_applications application
         ON application.id = dependency.application_id
       JOIN narrative_apply_commits commit_row
         ON commit_row.id = application.commit_id
      WHERE commit_row.project_id = ?
      ORDER BY application.id, dependency.source_kind, dependency.source_key`,
    ({ projectId }) => [projectId],
  ),
  dependencyEdges: defineC2ZcAuthorityQuery(
    `SELECT id AS id, project_id AS projectId,
            consumer_kind AS consumerKind,
            consumer_key AS consumerKey,
            source_object_identity AS sourceObjectIdentity,
            read_set_json AS readSetJson,
            generated_by_transaction_id AS generatedByTransactionId,
            created_at AS createdAt,
            owning_run_id AS owningRunId
       FROM narrative_dependency_edges
      WHERE project_id = ?
      ORDER BY id`,
    ({ projectId }) => [projectId],
  ),
  feedCursor: defineC2ZcAuthorityQuery(
    `SELECT COALESCE(MAX(canonical_sequence), 0) AS feedHead,
            (SELECT project_id
               FROM narrative_change_cursors
              WHERE project_id = ? AND consumer_id = ?
              LIMIT 1) AS cursorProjectId,
            (SELECT consumer_id
               FROM narrative_change_cursors
              WHERE project_id = ? AND consumer_id = ?
              LIMIT 1) AS consumerId,
            (SELECT acknowledged_through_sequence
               FROM narrative_change_cursors
              WHERE project_id = ? AND consumer_id = ?
              LIMIT 1) AS acknowledgedThrough,
            (SELECT reserved_through_sequence
               FROM narrative_change_cursors
              WHERE project_id = ? AND consumer_id = ?
              LIMIT 1) AS reservedThrough,
            (SELECT active_run_id
               FROM narrative_change_cursors
              WHERE project_id = ? AND consumer_id = ?
              LIMIT 1) AS activeRunId,
            (SELECT semantic_epoch_id
               FROM narrative_change_cursors
              WHERE project_id = ? AND consumer_id = ?
              LIMIT 1) AS semanticEpochId,
            (SELECT last_error
               FROM narrative_change_cursors
              WHERE project_id = ? AND consumer_id = ?
              LIMIT 1) AS lastError,
            (SELECT lease_owner
               FROM narrative_change_cursors
              WHERE project_id = ? AND consumer_id = ?
              LIMIT 1) AS leaseOwner,
            (SELECT lease_expires_at
               FROM narrative_change_cursors
              WHERE project_id = ? AND consumer_id = ?
              LIMIT 1) AS leaseExpiresAt,
            (SELECT updated_at
               FROM narrative_change_cursors
              WHERE project_id = ? AND consumer_id = ?
              LIMIT 1) AS updatedAt
       FROM narrative_change_events
      WHERE project_id = ?`,
    ({ projectId }) => [
      projectId,
      C2ZC_INCREMENTAL_FRESHNESS_CONSUMER_ID,
      projectId,
      C2ZC_INCREMENTAL_FRESHNESS_CONSUMER_ID,
      projectId,
      C2ZC_INCREMENTAL_FRESHNESS_CONSUMER_ID,
      projectId,
      C2ZC_INCREMENTAL_FRESHNESS_CONSUMER_ID,
      projectId,
      C2ZC_INCREMENTAL_FRESHNESS_CONSUMER_ID,
      projectId,
      C2ZC_INCREMENTAL_FRESHNESS_CONSUMER_ID,
      projectId,
      C2ZC_INCREMENTAL_FRESHNESS_CONSUMER_ID,
      projectId,
      C2ZC_INCREMENTAL_FRESHNESS_CONSUMER_ID,
      projectId,
      C2ZC_INCREMENTAL_FRESHNESS_CONSUMER_ID,
      projectId,
      C2ZC_INCREMENTAL_FRESHNESS_CONSUMER_ID,
      projectId,
    ],
  ),
  applications: defineC2ZcAuthorityQuery(
    `SELECT application.id AS id,
            application.commit_id AS commitId,
            commit_row.project_id AS projectId,
            commit_row.run_id AS runId,
            extraction_run.status AS runStatus,
            commit_row.proposal_set_id AS proposalSetId,
            commit_row.request_id AS requestId,
            commit_row.plan_digest AS planDigest,
            commit_row.status AS commitStatus,
            commit_row.session_id AS sessionId,
            commit_row.created_at AS commitCreatedAt,
            commit_row.completed_at AS completedAt,
            commit_row.version AS commitVersion,
            application.proposal_id AS proposalId,
            application.revision_id AS revisionId,
            application.applied_entity_kind AS appliedEntityKind,
            application.applied_entity_id AS appliedEntityId,
            CASE WHEN application.applied_entity_kind = 'event'
                 THEN application.applied_entity_id ELSE NULL END AS eventId,
            application.created_at AS createdAt,
            application.application_kind AS applicationKind,
            application.compensates_application_id AS compensatesApplicationId
       FROM narrative_proposal_applications application
       JOIN narrative_apply_commits commit_row
         ON commit_row.id = application.commit_id
       LEFT JOIN narrative_extraction_runs extraction_run
         ON extraction_run.id = commit_row.run_id
        AND extraction_run.project_id = commit_row.project_id
      WHERE commit_row.project_id = ?
      ORDER BY application.id`,
    ({ projectId }) => [projectId],
  ),
  codexEntries: defineC2ZcAuthorityQuery(
    `SELECT id AS entryId, project_id AS projectId, name, type AS typeSlug
       FROM codex_entries
      WHERE project_id = ?
      ORDER BY id`,
    ({ projectId }) => [projectId],
  ),
  projectInventory: defineC2ZcAuthorityQuery(
    "SELECT id AS projectId FROM projects ORDER BY id",
    () => [],
  ),
  findingLifecycle: defineC2ZcAuthorityQuery(
    `SELECT id, finding_identity AS findingIdentity,
            lifecycle_state AS lifecycleState,
            semantic_epoch_id AS semanticEpochId
       FROM narrative_maintenance_finding_lifecycle
      WHERE project_id = ?
      ORDER BY id`,
    ({ projectId }) => [projectId],
  ),
});

export const C2ZC_AUTHORITY_APPLICATION_ROWS_QUERY = defineC2ZcAuthorityQuery(
  `SELECT id AS applicationId
     FROM narrative_proposal_applications
    WHERE commit_id = ?
    ORDER BY id`,
  ({ commitId }) => [commitId],
);

async function queryRows(harness, page, sql, params = []) {
  return rowsOf(
    await harness.invokeOk(page, "db_execute", {
      sql,
      params,
      method: "all",
    }),
  );
}

async function queryAuthorityRows(harness, page, definition, context) {
  const request = resolveC2ZcAuthorityQuery(definition, context);
  return queryRows(harness, page, request.sql, request.params);
}

async function readInbox(harness, page, projectId) {
  const result = await harness.invokeOk(
    page,
    "narrative_maintenance_inbox_list",
    {
      payload: { projectId },
    },
  );
  if (Array.isArray(result)) return result;
  if (Array.isArray(result?.entries)) return result.entries;
  throw new Error("C2-ZC maintenance Inbox did not return an array");
}

export async function readC2ZcRunLedger(
  harness,
  page,
  projectId,
  existingRuns,
) {
  if (Array.isArray(existingRuns)) return existingRuns;
  return queryAuthorityRows(
    harness,
    page,
    C2ZC_AUTHORITY_SNAPSHOT_QUERIES.runs,
    { projectId },
  );
}

/** Read live durable values without inventing a second maintenance engine. */
export async function readC2ZcAuthoritySnapshot(harness, page, projectId) {
  const [
    markerRows,
    epochs,
    runs,
    genericRows,
    legacyFreshnessRows,
    legacyDependencyRows,
    dependencyEdges,
    feedCursorRows,
    applications,
    codexEntries,
    projectInventory,
    findingRows,
    inboxEntries,
  ] = await Promise.all([
    queryAuthorityRows(harness, page, C2ZC_AUTHORITY_SNAPSHOT_QUERIES.marker, {
      projectId,
    }),
    queryAuthorityRows(harness, page, C2ZC_AUTHORITY_SNAPSHOT_QUERIES.epochs, {
      projectId,
    }),
    readC2ZcRunLedger(harness, page, projectId),
    queryAuthorityRows(
      harness,
      page,
      C2ZC_AUTHORITY_SNAPSHOT_QUERIES.genericFreshness,
      { projectId },
    ),
    queryAuthorityRows(
      harness,
      page,
      C2ZC_AUTHORITY_SNAPSHOT_QUERIES.legacyFreshness,
      { projectId },
    ),
    queryAuthorityRows(
      harness,
      page,
      C2ZC_AUTHORITY_SNAPSHOT_QUERIES.legacyDependencies,
      { projectId },
    ),
    queryAuthorityRows(
      harness,
      page,
      C2ZC_AUTHORITY_SNAPSHOT_QUERIES.dependencyEdges,
      { projectId },
    ),
    queryAuthorityRows(
      harness,
      page,
      C2ZC_AUTHORITY_SNAPSHOT_QUERIES.feedCursor,
      { projectId },
    ),
    queryAuthorityRows(
      harness,
      page,
      C2ZC_AUTHORITY_SNAPSHOT_QUERIES.applications,
      { projectId },
    ),
    queryAuthorityRows(
      harness,
      page,
      C2ZC_AUTHORITY_SNAPSHOT_QUERIES.codexEntries,
      { projectId },
    ),
    queryAuthorityRows(
      harness,
      page,
      C2ZC_AUTHORITY_SNAPSHOT_QUERIES.projectInventory,
      {},
    ),
    queryAuthorityRows(
      harness,
      page,
      C2ZC_AUTHORITY_SNAPSHOT_QUERIES.findingLifecycle,
      { projectId },
    ),
    readInbox(harness, page, projectId),
  ]);
  const feedCursorRow = feedCursorRows[0] ?? null;
  const feedCursor = feedCursorRow
    ? {
        feedHead: feedCursorRow.feedHead,
        cursor:
          feedCursorRow.cursorProjectId === null ||
          feedCursorRow.cursorProjectId === undefined
            ? null
            : {
                projectId: feedCursorRow.cursorProjectId,
                consumerId: feedCursorRow.consumerId,
                acknowledgedThroughSequence: feedCursorRow.acknowledgedThrough,
                leaseOwner: feedCursorRow.leaseOwner,
                leaseExpiresAt: feedCursorRow.leaseExpiresAt,
                lastError: feedCursorRow.lastError,
                updatedAt: feedCursorRow.updatedAt,
                reservedThrough: feedCursorRow.reservedThrough,
                activeRunId: feedCursorRow.activeRunId,
                semanticEpochId: feedCursorRow.semanticEpochId,
              },
      }
    : null;
  const currentEpoch = epochs.at(-1) ?? null;
  const legacyFreshness = legacyFreshnessRows[0] ?? null;
  const legacyProjection = {
    freshness: legacyFreshness,
    dependencies: legacyDependencyRows,
  };
  return {
    projectId,
    projectInventory,
    markerRows,
    marker: markerRows[0] ?? null,
    epochs,
    currentEpochId: currentEpoch?.id ?? null,
    runs,
    genericRows,
    dependencyEdges,
    legacyProjection,
    feedCursor,
    applications,
    codexEntries,
    findingRows,
    inboxEntries,
    projectSettled:
      runs.length > 0 && runs.every((run) => run.status === "completed"),
  };
}

function initialEpoch(epochs, label) {
  const values = rows(epochs, `${label} epochs`);
  const epoch = values.find((candidate) => Number(candidate.epochNumber) === 0);
  if (!epoch || epoch.reason !== "initial" || typeof epoch.id !== "string") {
    throw new Error(`${label} must retain an initial E0 epoch`);
  }
  return epoch;
}

function restoredEpoch(epochs, label) {
  const values = rows(epochs, `${label} epochs`);
  const e0 = initialEpoch(values, label);
  const e1 = values.find((candidate) => Number(candidate.epochNumber) === 1);
  if (!e1 || e1.reason !== "restore" || e1.id === e0.id) {
    throw new Error(`${label} must contain restored E1 after E0`);
  }
  return { e0, e1 };
}

function assertSameEpochLineage(before, after, label) {
  const left = rows(before, `${label} before epochs`);
  const right = rows(after, `${label} after epochs`);
  if (
    left.length !== right.length ||
    left.some((epoch, index) => stableJson(epoch) !== stableJson(right[index]))
  ) {
    throw new Error(`${label} changed the persisted Semantic Epoch lineage`);
  }
  return right;
}

/** Verify -> optional Rebuild -> confirmation Verify -> Freshness. */
export function assertC2ZcRestoreLifecycleOrder(
  runValues,
  {
    currentEpochId,
    restoreEpochId,
    rustOutcome,
    expectedRestoreLifecycle,
    marker,
    fixtureSemantic,
  } = {},
  label = "C2-ZC restore lifecycle",
) {
  const runsValue = rows(runValues, `${label} runs`);
  const strict = expectedRestoreLifecycle !== undefined || marker !== undefined;
  const lifecycleKinds = new Set([
    "dependency-verify",
    "semantic-index-rebuild",
    "freshness-evaluation",
  ]);
  assertC2ZcNoDependencyRepair({ runs: runsValue }, label);
  const lifecycleRuns = runsValue.filter((run) =>
    lifecycleKinds.has(run.runKind),
  );
  const completed = runsValue.filter((run) => run.status === "completed");
  if (!strict) {
    const verifyRuns = completed.filter(
      (run) => run.runKind === "dependency-verify",
    );
    if (verifyRuns.length === 0) throw new Error(`${label} is missing Verify`);
    const firstVerify = verifyRuns[0];
    if (
      restoreEpochId !== undefined &&
      firstVerify.semanticEpochId !== restoreEpochId
    ) {
      throw new Error(
        `${label} first Verify is not bound to the restored E1 Semantic Epoch`,
      );
    }
    const firstReport = reportOf(firstVerify, `${label} first Verify`).report;
    const firstCoverage = assertC2ZcVerifyCoverage(
      firstVerify,
      rustOutcome,
      `${label} first Verify`,
    );
    let finalVerify = firstVerify;
    let endIndex = runsValue.indexOf(firstVerify);
    if (firstReport.rebuildRequired === true) {
      const rebuild = completed.find(
        (run) =>
          runsValue.indexOf(run) > endIndex &&
          run.runKind === "semantic-index-rebuild",
      );
      if (!rebuild) throw new Error(`${label} requires a conditional Rebuild`);
      const rebuildIndex = runsValue.indexOf(rebuild);
      finalVerify = completed.find(
        (run) =>
          runsValue.indexOf(run) > rebuildIndex &&
          run.runKind === "dependency-verify",
      );
      if (!finalVerify) {
        throw new Error(`${label} is missing the confirmation Verify`);
      }
      endIndex = runsValue.indexOf(finalVerify);
    }
    const finalReport = reportOf(finalVerify, `${label} final Verify`).report;
    if (
      restoreEpochId !== undefined &&
      finalVerify.semanticEpochId !== restoreEpochId
    ) {
      throw new Error(
        `${label} confirmation Verify is not bound to the restored E1 Semantic Epoch`,
      );
    }
    if (finalReport.rebuildRequired !== false) {
      throw new Error(`${label} final Verify still requests Rebuild`);
    }
    const finalCoverage = assertC2ZcVerifyCoverage(
      finalVerify,
      rustOutcome ?? firstCoverage.outcome,
      `${label} final Verify`,
    );
    const freshness = completed.find(
      (run) =>
        runsValue.indexOf(run) > endIndex &&
        run.runKind === "freshness-evaluation" &&
        (currentEpochId === undefined ||
          run.semanticEpochId === currentEpochId),
    );
    if (!freshness)
      throw new Error(`${label} is missing post-Verify Freshness`);
    return {
      firstVerify,
      rebuild:
        firstReport.rebuildRequired === true
          ? completed.find(
              (run) =>
                runsValue.indexOf(run) > runsValue.indexOf(firstVerify) &&
                run.runKind === "semantic-index-rebuild",
            )
          : null,
      finalVerify,
      firstCoverage,
      finalCoverage,
      freshness,
    };
  }

  assertExpectedRestoreLifecycle(
    expectedRestoreLifecycle,
    `${label}.expectedRestoreLifecycle`,
  );
  if (rustOutcome === undefined || rustOutcome === null) {
    throw new Error(`${label} requires the verified Rust Verify outcome`);
  }
  if (!marker) throw new Error(`${label} requires a persisted marker`);
  const markerRow = assertC2ZcMarkerExactlyOnce(
    { markerRows: [marker] },
    `${label} marker`,
  );
  if (lifecycleRuns.length !== 4) {
    throw new Error(
      `${label} must contain exactly Verify/Rebuild/Verify/Freshness`,
    );
  }
  const [firstVerify, rebuild, finalVerify, freshness] = lifecycleRuns;
  const expectedKinds = [
    "dependency-verify",
    "semantic-index-rebuild",
    "dependency-verify",
    "freshness-evaluation",
  ];
  if (
    lifecycleRuns.some((run, index) => run.runKind !== expectedKinds[index]) ||
    firstVerify.id === finalVerify.id ||
    lifecycleRuns.some((run) => run.status !== "completed")
  ) {
    throw new Error(`${label} has an invalid canonical run order`);
  }
  const timestamps = [];
  for (const [index, run] of lifecycleRuns.entries()) {
    const createdAt = assertCanonicalTimestamp(
      run.createdAt,
      `${label} ${expectedKinds[index]} createdAt`,
    );
    const startedAt = assertCanonicalTimestamp(
      run.startedAt,
      `${label} ${expectedKinds[index]} startedAt`,
    );
    const completedAt = assertCanonicalTimestamp(
      run.completedAt,
      `${label} ${expectedKinds[index]} completedAt`,
    );
    if (
      Date.parse(createdAt) > Date.parse(startedAt) ||
      Date.parse(startedAt) > Date.parse(completedAt)
    ) {
      throw new Error(`${label} contains non-monotonic Run timestamps`);
    }
    if (
      index > 0 &&
      Date.parse(timestamps[index - 1].completedAt) > Date.parse(createdAt)
    ) {
      throw new Error(`${label} Run timestamps are not in canonical order`);
    }
    timestamps.push({ createdAt, startedAt, completedAt });
  }
  for (const run of lifecycleRuns) {
    if (
      restoreEpochId !== undefined &&
      run.semanticEpochId !== restoreEpochId
    ) {
      throw new Error(`${label} Run is not bound to restored E1`);
    }
    if (
      currentEpochId !== undefined &&
      run.semanticEpochId !== currentEpochId
    ) {
      throw new Error(`${label} Run is not bound to current E1`);
    }
  }
  const firstReport = reportOf(firstVerify, `${label} first Verify`).report;
  assertProductionVerifyReport(firstReport, {
    first: true,
    label: `${label} first Verify`,
  });
  if (fixtureSemantic !== undefined) {
    assertC2ZcFixtureSemantic(fixtureSemantic, `${label} fixture semantic`);
    const expectedApplication = fixtureSemantic.applicationId;
    const expectedGap = fixtureSemantic.expectedRestoreGap;
    const expectedEdgeIds = expectedGap.edgeIdsWithoutCurrentEpochState.map(
      (edge) => edge.id,
    );
    const expectedConsumerPairs =
      expectedGap.consumerKeysWithoutCurrentEpochFreshness.map((consumer) => [
        consumer.consumerKind,
        consumer.consumerKey,
      ]);
    const expectedLegacyGap = `application:${expectedApplication}:generic-freshness-missing`;
    const targetLegacyGaps =
      firstReport.legacyMirrorMigrationParity.incomplete.filter(
        (entry) =>
          typeof entry === "string" &&
          entry.startsWith(`application:${expectedApplication}:`),
      );
    if (
      stableJson(firstReport.edgeIdsWithoutCurrentEpochState) !==
        stableJson(expectedEdgeIds) ||
      stableJson(firstReport.consumerKeysWithoutCurrentEpochFreshness) !==
        stableJson(expectedConsumerPairs) ||
      !firstReport.legacyMirrorMigrationParity.incomplete.includes(
        expectedLegacyGap,
      ) ||
      targetLegacyGaps.some((entry) => entry !== expectedLegacyGap)
    ) {
      throw new Error(
        `${label} first Verify does not identify the fixture Application gap`,
      );
    }
  }
  const firstCoverage = assertC2ZcVerifyCoverage(
    firstVerify,
    rustOutcome,
    `${label} first Verify`,
  );
  assertC2ZcSemanticIndexZero(
    firstVerify,
    `${label} first Verify Semantic Index`,
  );
  const finalReport = reportOf(
    finalVerify,
    `${label} confirmation Verify`,
  ).report;
  assertProductionVerifyReport(finalReport, {
    first: false,
    label: `${label} confirmation Verify`,
  });
  const finalCoverage = assertC2ZcVerifyCoverage(
    finalVerify,
    rustOutcome ?? firstCoverage.outcome,
    `${label} confirmation Verify`,
  );
  assertC2ZcSemanticIndexZero(
    finalVerify,
    `${label} confirmation Verify Semantic Index`,
  );
  if (
    Date.parse(markerRow.appliedAt) <= Date.parse(timestamps[3].completedAt)
  ) {
    throw new Error(
      `${label} marker must be strictly after Freshness completion`,
    );
  }
  return {
    firstVerify,
    rebuild,
    finalVerify,
    firstCoverage,
    finalCoverage,
    freshness,
  };
}

export function assertC2ZcRestartInvariants({
  before,
  restart,
  label = "C2-ZC first restart",
} = {}) {
  if (!before || !restart) throw new Error(`${label} requires both snapshots`);
  if (before.projectId !== restart.projectId) {
    throw new Error(`${label} changed the project authority`);
  }
  assertC2ZcMarkerExactlyOnce(before, `${label} before marker`);
  assertC2ZcMarkerExactlyOnce(restart, `${label} after marker`);
  if (stableJson(before.markerRows) !== stableJson(restart.markerRows)) {
    throw new Error(`${label} changed the persisted authority marker`);
  }
  const beforeEpochs = restoredEpoch(before.epochs, `${label} before`);
  const restartEpochs = restoredEpoch(restart.epochs, `${label} restart`);
  if (
    beforeEpochs.e0.id !== restartEpochs.e0.id ||
    beforeEpochs.e1.id !== restartEpochs.e1.id
  ) {
    throw new Error(`${label} changed the E0/E1 authority lineage`);
  }
  assertSameEpochLineage(before.epochs, restart.epochs, label);
  if (
    before.currentEpochId !== undefined &&
    before.currentEpochId !== restart.currentEpochId
  ) {
    throw new Error(`${label} changed the current Semantic Epoch authority`);
  }
  if (
    before.currentEpochId !== undefined &&
    before.currentEpochId !== beforeEpochs.e1.id
  ) {
    throw new Error(`${label} before snapshot is not current E1`);
  }
  if (
    restart.currentEpochId !== undefined &&
    restart.currentEpochId !== restartEpochs.e1.id
  ) {
    throw new Error(`${label} restart snapshot is not current E1`);
  }
  if (before.projectInventory !== undefined) {
    assertC2ZcProjectInventory(
      before,
      before.projectId,
      `${label} before inventory`,
    );
  }
  if (restart.projectInventory !== undefined) {
    assertC2ZcProjectInventory(
      restart,
      restart.projectId,
      `${label} restart inventory`,
    );
  }
  if (before.runs !== undefined) assertC2ZcNoDependencyRepair(before, label);
  if (restart.runs !== undefined) assertC2ZcNoDependencyRepair(restart, label);
  if (before.findingRows !== undefined || before.inboxEntries !== undefined) {
    assertC2ZcFindingRowsResolved(before, `${label} before findings`);
  }
  if (restart.findingRows !== undefined || restart.inboxEntries !== undefined) {
    assertC2ZcFindingRowsResolved(restart, `${label} restart findings`);
  }
  if (before.feedCursor !== undefined) {
    assertC2ZcFeedCursorSettled(
      before,
      {
        epochId: beforeEpochs.e1.id,
        projectId: before.projectId,
        consumerId: C2ZC_INCREMENTAL_FRESHNESS_CONSUMER_ID,
      },
      label,
    );
  }
  if (restart.feedCursor !== undefined) {
    assertC2ZcFeedCursorSettled(
      restart,
      {
        epochId: restartEpochs.e1.id,
        projectId: restart.projectId,
        consumerId: C2ZC_INCREMENTAL_FRESHNESS_CONSUMER_ID,
      },
      label,
    );
  }
  assertC2ZcLegacyProjectionStable(
    before.legacyProjection,
    restart.legacyProjection,
    `${label} Legacy projection`,
  );
  const beforeIds = new Set(
    rows(before.runs, `${label} before runs`).map((run) => run.id),
  );
  const restartRuns = rows(restart.runs, `${label} restart runs`);
  if ([...beforeIds].some((id) => !restartRuns.some((run) => run.id === id))) {
    throw new Error(`${label} lost a durable Run identity`);
  }
  if (
    restartRuns.some(
      (run) =>
        run.runKind === "backfill" &&
        run.semanticEpochId === restart.epochs.at(-1)?.id,
    )
  ) {
    throw new Error(`${label} minted an E1 Backfill on restart`);
  }
  return restart;
}

export function assertC2ZcFinalRestartPersistence({
  before,
  restart,
  application,
  label = "C2-ZC final restart",
} = {}) {
  assertC2ZcRestartInvariants({ before, restart, label });
  if (!application?.applicationId) {
    throw new Error(`${label} requires the typed Application identity`);
  }
  assertC2ZcGenericFreshnessStorage(
    restart,
    {
      projectId: application.projectId,
      applicationId: application.applicationId,
      epochId: restart.currentEpochId ?? restart.epochs.at(-1)?.id,
    },
    `${label} Generic storage`,
  );
  if (
    !restart.applications.some(
      (row) => row.applicationId === application.applicationId,
    ) ||
    !restart.codexEntries.some((row) => row.entryId === application.entryId)
  ) {
    throw new Error(`${label} lost the typed Application or Generic entity`);
  }
  return restart;
}

function assertC2ZcPostMarkerSnapshot(
  snapshot,
  application,
  { requireTypedApplication = true, label } = {},
) {
  if (!snapshot) throw new Error(`${label} snapshot is missing`);
  if (snapshot.projectId !== application.projectId) {
    throw new Error(`${label} changed project authority`);
  }
  assertC2ZcMarkerExactlyOnce(snapshot, `${label} marker`);
  assertC2ZcProjectInventory(
    snapshot,
    application.projectId,
    `${label} inventory`,
  );
  const { e1 } = restoredEpoch(snapshot.epochs, `${label} epochs`);
  if (snapshot.currentEpochId !== e1.id) {
    throw new Error(`${label} is not on current E1`);
  }
  assertC2ZcNoDependencyRepair(snapshot, label);
  assertC2ZcFindingRowsResolved(snapshot, `${label} findings`);
  assertC2ZcFeedCursorSettled(
    snapshot,
    {
      epochId: e1.id,
      projectId: application.projectId,
      consumerId: C2ZC_INCREMENTAL_FRESHNESS_CONSUMER_ID,
    },
    `${label} feed cursor`,
  );
  if (snapshot.projectSettled !== true) {
    throw new Error(`${label} project is not settled`);
  }
  if (!requireTypedApplication) return { epochId: e1.id };
  const genericRows = rows(snapshot.genericRows, `${label} Generic rows`);
  const targetGenericRows = genericRows.filter(
    (row) =>
      row.projectId === application.projectId &&
      row.consumerKind === C2ZC_FRESHNESS_CONSUMER_KIND &&
      row.consumerKey === application.applicationId,
  );
  if (targetGenericRows.length !== 1) {
    throw new Error(`${label} must contain one typed Application Generic row`);
  }
  const generic = assertC2ZcGenericFreshnessStorage(
    snapshot,
    {
      projectId: application.projectId,
      applicationId: application.applicationId,
      epochId: e1.id,
    },
    `${label} Generic storage`,
  );
  if (generic.lastEvaluatedRunId === application.runId) {
    throw new Error(
      `${label} Generic row is not produced by a distinct Freshness Run`,
    );
  }
  const typedEdges = rows(snapshot.dependencyEdges, `${label} edges`).filter(
    (edge) =>
      edge.projectId === application.projectId &&
      edge.consumerKind === C2ZC_FRESHNESS_CONSUMER_KIND &&
      edge.consumerKey === application.applicationId,
  );
  if (
    typedEdges.length !== 1 ||
    typedEdges[0].owningRunId !== application.runId
  ) {
    throw new Error(`${label} Edge is not owned by the typed Application Run`);
  }
  const appRows = rows(snapshot.applications, `${label} applications`).filter(
    (row) => applicationIdOf(row) === application.applicationId,
  );
  if (
    appRows.length !== 1 ||
    (appRows[0].projectId !== undefined &&
      appRows[0].projectId !== application.projectId) ||
    (appRows[0].runId !== undefined && appRows[0].runId !== application.runId)
  ) {
    throw new Error(`${label} typed Application identity is not durable`);
  }
  if (application.entryId !== undefined) {
    const entries = rows(
      snapshot.codexEntries,
      `${label} Codex entries`,
    ).filter(
      (entry) =>
        entry.entryId === application.entryId &&
        (entry.projectId === undefined ||
          entry.projectId === application.projectId),
    );
    if (entries.length !== 1) {
      throw new Error(`${label} typed Codex entity is not durable`);
    }
  }
  const producer = rows(snapshot.runs, `${label} runs`).find(
    (run) => run.id === application.runId,
  );
  if (
    !producer ||
    producer.status !== "completed" ||
    producer.semanticEpochId !== e1.id ||
    producer.runKind !== "application"
  ) {
    throw new Error(
      `${label} typed Application producer is not completed in E1`,
    );
  }
  return { epochId: e1.id, generic, typedEdges: [typedEdges[0]], producer };
}

export function assertC2ZcPostMarkerApplicationPersistence({
  beforeMutation,
  afterMutation,
  restart,
  application,
  label = "C2-ZC post-marker Application",
} = {}) {
  if (!isObject(application)) throw new Error(`${label} identity is missing`);
  requireText(application.applicationId, `${label} applicationId`);
  requireText(application.projectId, `${label} projectId`);
  requireText(application.runId, `${label} runId`);
  if (application.entryId !== undefined) {
    requireText(application.entryId, `${label} entryId`);
  }
  assertC2ZcPostMarkerSnapshot(beforeMutation, application, {
    requireTypedApplication: false,
    label: `${label} before mutation`,
  });
  assertC2ZcPostMarkerSnapshot(afterMutation, application, {
    label: `${label} after mutation`,
  });
  assertC2ZcPostMarkerSnapshot(restart, application, {
    label: `${label} final restart`,
  });
  assertC2ZcRestartInvariants({
    before: beforeMutation,
    restart: afterMutation,
    label: `${label} mutation authority`,
  });
  assertC2ZcRestartInvariants({
    before: afterMutation,
    restart,
    label: `${label} restart authority`,
  });
  assertC2ZcLegacyProjectionStable(
    beforeMutation.legacyProjection,
    afterMutation.legacyProjection,
    `${label} Legacy pre-write/post-write`,
  );
  assertC2ZcLegacyProjectionStable(
    afterMutation.legacyProjection,
    restart.legacyProjection,
    `${label} Legacy post-write/restart`,
  );
  if (
    stableJson(beforeMutation.markerRows) !==
      stableJson(afterMutation.markerRows) ||
    stableJson(afterMutation.markerRows) !== stableJson(restart.markerRows)
  ) {
    throw new Error(`${label} marker changed across typed write or restart`);
  }
  if (
    beforeMutation.currentEpochId !== afterMutation.currentEpochId ||
    afterMutation.currentEpochId !== restart.currentEpochId
  ) {
    throw new Error(
      `${label} Semantic Epoch changed across typed write or restart`,
    );
  }
  return restart;
}

function stablePayloadDigest(value) {
  return `sha256:${createHash("sha256").update(stableJson(value), "utf8").digest("hex")}`;
}

async function captureWorkspaceBinding(harness, page, workspace, label) {
  const binding = await harness.invokeOk(
    page,
    "narrative_extraction_capture_workspace_binding",
    { expectedWorkspacePath: workspace },
  );
  if (
    !isObject(binding) ||
    typeof binding.authorityId !== "string" ||
    binding.authorityId.trim() === "" ||
    !Number.isSafeInteger(Number(binding.generation)) ||
    Number(binding.generation) <= 0 ||
    typeof binding.authorityInstanceId !== "string" ||
    binding.authorityInstanceId.trim() === ""
  ) {
    throw new Error(`${label} returned an invalid Native workspace binding`);
  }
  return {
    authorityId: binding.authorityId,
    generation: Number(binding.generation),
    authorityInstanceId: binding.authorityInstanceId,
  };
}

/** One real typed producer/Application write after the canonical marker. */
export async function createTypedApplicationAfterMarker(
  harness,
  page,
  workspace,
  projectId,
) {
  const workspaceBinding = await captureWorkspaceBinding(
    harness,
    page,
    workspace,
    "C2-ZC typed Application",
  );
  const runId = `c2-zc-typed-run-${randomUUID()}`;
  const taskId = `${runId}-task`;
  const snapshot = { kind: "c2-zc-typed-source@1", projectId, runId };
  const snapshotDigest = stablePayloadDigest(snapshot);
  const specJson = { kind: "c2-zc-typed-application@1", version: 1, projectId };
  const createdRun = await harness.invokeOk(
    page,
    "narrative_extraction_create_run",
    {
      payload: {
        runId,
        projectId,
        surfacePathId: "c2-zc-typed-application",
        scopeJson: { projectId },
        specJson,
        specDigest: stablePayloadDigest(specJson),
        snapshotDigest,
        catalogDigest: null,
        registryDigest: null,
        coverageJson: null,
        tasks: [
          {
            taskId,
            taskKind: "c2-zc-typed-application",
            inputJson: snapshot,
            priority: 1,
          },
        ],
      },
      workspaceBinding,
    },
  );
  if (createdRun?.runId !== runId || createdRun?.status !== "running") {
    throw new Error(
      `C2-ZC typed Application Run was not created: ${JSON.stringify(createdRun)}`,
    );
  }
  const leaseOwner = `c2-zc-typed-journey:${randomUUID()}`;
  const claimed = await harness.invokeOk(
    page,
    "narrative_extraction_claim_task",
    {
      payload: {
        runId,
        projectId,
        leaseOwner,
        leaseDurationSecs: 60,
        taskKinds: ["c2-zc-typed-application"],
      },
      workspaceBinding,
    },
  );
  if (
    claimed?.claimed !== true ||
    claimed.task?.taskId !== taskId ||
    typeof claimed.task?.attemptId !== "string"
  ) {
    throw new Error(
      `C2-ZC typed Application Task was not claimed: ${JSON.stringify(claimed)}`,
    );
  }
  const attemptId = claimed.task.attemptId;
  const proposalSetId = `${runId}-proposal-set`;
  const proposalId = `${runId}-proposal`;
  const entryId = `${runId}-entry`;
  const entryPayload = {
    entryId,
    typeSlug: "character",
    name: "C2-ZC canonical lifecycle entry",
    summary: "Typed mutation after marker",
    aliases: [],
    parentId: null,
    content: '{"type":"doc","content":[]}',
    narrativeEntityId: `${runId}-entity`,
  };
  const readSet = [
    {
      inputRef: `snapshot:${runId}`,
      kind: "snapshot-document",
      sourceKind: "snapshot-document",
      revisionToken: snapshotDigest,
    },
  ];
  const revisionEnvelope = {
    schemaVersion: 1,
    runId,
    taskId,
    reconcilerId: "c2-zc-canonical-lifecycle",
    reconcilerVersion: "1",
    proposalSchemaId: "codex.entry.create",
    proposalSchemaVersion: "1",
    sourceBasis: [
      {
        sourceKind: "snapshot-document",
        sourceKey: `snapshot:${runId}`,
        revisionToken: snapshotDigest,
      },
    ],
    evidenceSet: [],
    readSet,
    readSetDigest: stablePayloadDigest(readSet),
    changeKind: "add",
  };
  const savedSet = await harness.invokeOk(
    page,
    "narrative_extraction_save_proposal_set",
    {
      payload: {
        runId,
        projectId,
        proposalSetId,
        setKind: "c2-zc.canonical-lifecycle@1",
        summaryJson: { kind: "c2-zc-typed-application@1" },
        proposals: [
          {
            proposalId,
            proposalKey: `${runId}:entry-create`,
            kind: "codex.entry.create",
            payloadJson: entryPayload,
            reconciliationEnvelope: revisionEnvelope,
          },
        ],
      },
      workspaceBinding,
    },
  );
  const savedProposal = savedSet?.proposals?.[0];
  if (
    savedSet?.proposalSetId !== proposalSetId ||
    savedProposal?.proposalId !== proposalId ||
    typeof savedProposal?.revisionId !== "string"
  ) {
    throw new Error(
      `C2-ZC typed ProposalSet was not persisted: ${JSON.stringify(savedSet)}`,
    );
  }
  const revisionId = savedProposal.revisionId;
  await harness.invokeOk(page, "narrative_extraction_append_human_decision", {
    payload: {
      runId,
      projectId,
      proposalId,
      revisionId,
      decision: "approved",
      decisionJson: {},
      createdBy: "c2-zc-product-journey",
    },
  });
  const requestId = `${runId}-apply-request`;
  const prepared = await harness.invokeOk(
    page,
    "narrative_extraction_prepare_commit",
    {
      payload: {
        projectId,
        runId,
        proposalSetId,
        requestId,
        planDigest: stablePayloadDigest({ runId, proposalId, revisionId }),
        sessionId: C2ZC_PRODUCT_JOURNEY_ID,
        surface: "narrative-extraction",
        operations: [
          {
            kind: "codex.entry.create",
            payload: entryPayload,
            proposalId,
            revisionId,
          },
        ],
        applications: [{ proposalId, revisionId }],
        expectedTailOrdinal: null,
        entityBindings: [],
        expectedCalendarVersion: null,
      },
    },
  );
  if (typeof prepared?.preparedCommitId !== "string") {
    throw new Error(
      `C2-ZC typed Commit was not prepared: ${JSON.stringify(prepared)}`,
    );
  }
  const applied = await harness.invokeOk(
    page,
    "narrative_extraction_apply_commit",
    {
      payload: {
        projectId,
        preparedCommitId: prepared.preparedCommitId,
        requestId,
        sessionId: C2ZC_PRODUCT_JOURNEY_ID,
        expectedVersion: prepared.version ?? 0,
      },
    },
  );
  const commitId = applied?.commitId ?? applied?.id;
  if (typeof commitId !== "string" || commitId.trim() === "") {
    throw new Error(
      `C2-ZC typed Commit did not apply: ${JSON.stringify(applied)}`,
    );
  }
  const applicationRows = await queryAuthorityRows(
    harness,
    page,
    C2ZC_AUTHORITY_APPLICATION_ROWS_QUERY,
    { commitId },
  );
  if (applicationRows.length !== 1) {
    throw new Error(
      `C2-ZC typed Commit did not create one Application: ${JSON.stringify(applicationRows)}`,
    );
  }
  const applicationId = applicationRows[0].applicationId;
  const finished = await harness.invokeOk(
    page,
    "narrative_extraction_finish_task",
    {
      payload: {
        runId,
        projectId,
        taskId,
        attemptId,
        leaseOwner,
        outputJson: {
          kind: "c2-zc-typed-application-completed@1",
          commitId,
          applicationId,
        },
      },
      workspaceBinding,
    },
  );
  if (
    finished?.status !== "completed" ||
    finished.task?.status !== "completed"
  ) {
    throw new Error(
      `C2-ZC typed Application Task did not finish: ${JSON.stringify(finished)}`,
    );
  }
  return {
    projectId,
    runId,
    taskId,
    attemptId,
    proposalSetId,
    proposalId,
    revisionId,
    entryId,
    commitId,
    applicationId,
  };
}

async function waitForProjectId(
  harness,
  page,
  expectedProjectId,
  { requireExpected = false } = {},
) {
  return harness.waitUntil(
    async () => {
      const projects = await queryAuthorityRows(
        harness,
        page,
        C2ZC_AUTHORITY_SNAPSHOT_QUERIES.projectInventory,
        {},
      );
      const match = projects.find((row) => row.projectId === expectedProjectId);
      if (requireExpected && !match) return null;
      return match?.projectId ?? projects[0]?.projectId ?? null;
    },
    "C2-ZC restored project hydration",
    C2ZC_WAIT_MS,
    250,
  );
}

async function waitForLifecycle(
  harness,
  page,
  projectId,
  {
    restoreEpochId,
    rustOutcome,
    expectedRestoreLifecycle,
    fixtureSemantic,
  } = {},
) {
  return harness.waitUntil(
    async () => {
      const snapshot = await readC2ZcAuthoritySnapshot(
        harness,
        page,
        projectId,
      );
      try {
        const lifecycle = assertC2ZcRestoreLifecycleOrder(snapshot.runs, {
          currentEpochId: snapshot.currentEpochId,
          restoreEpochId,
          rustOutcome,
          expectedRestoreLifecycle,
          marker: snapshot.marker,
          fixtureSemantic,
        });
        assertC2ZcMarkerExactlyOnce(snapshot);
        assertC2ZcFindingRowsResolved(snapshot);
        if (fixtureSemantic !== undefined) {
          assertC2ZcFixtureApplicationParity(snapshot, fixtureSemantic);
        }
        assertC2ZcFeedCursorSettled(snapshot, {
          epochId: snapshot.currentEpochId,
          projectId: snapshot.projectId,
          consumerId: C2ZC_INCREMENTAL_FRESHNESS_CONSUMER_ID,
        });
        return { snapshot, lifecycle };
      } catch {
        return null;
      }
    },
    "C2-ZC canonical restore lifecycle settlement",
    C2ZC_WAIT_MS,
    250,
  );
}

async function closeLaunch(harness, launch, reason) {
  if (!launch) return;
  await harness.close(launch.app, launch.page, reason);
}

/**
 * Run the complete stateful lifecycle.  `options.restoreFixture` is the
 * narrow programmatic injection; `GRIMODEX_C2ZC_RESTORE_FIXTURE` carries the
 * same `{path, manifest}` object for the product runner.
 */
export async function runC2ZcCanonicalAuthorityJourney(
  harness,
  configureWorkspace,
  options = {},
) {
  const fixture = await loadC2ZcRestoreFixtureInput(options.restoreFixture);
  const rustOutcome =
    options.rustOutcome ?? harness.c2zcRustAcceptanceEvidence?.verifyOutcome;
  if (!isObject(rustOutcome)) {
    throw new Error(
      "C2-ZC canonical lifecycle requires the verified Rust Verify outcome",
    );
  }
  const rustAcceptance =
    options.candidate ??
    harness.c2zcRustAcceptanceEvidence?.candidate ??
    harness.c2zcRustAcceptanceEvidence?.receipt?.candidate;
  assertC2ZcFixtureCandidateBinding(fixture.manifest.candidate, rustAcceptance);
  const workspace = harness.workspacePath(C2ZC_PRODUCT_JOURNEY_ID);
  await configureWorkspace(harness, workspace);
  const staged = await stageC2ZcRestoreFixture(workspace, fixture);
  harness.recordTimeline?.(`${C2ZC_PRODUCT_JOURNEY_ID}/restore-fixture`, {
    backupName: fixture.manifest.artifacts.fixture.path,
    manifestVersion: fixture.manifest.manifestVersion,
    fixtureSha256: fixture.manifest.fixtureSha256,
    fixtureSizeBytes: fixture.manifest.fixtureSizeBytes,
    stagedPath: staged.targetPath,
  });

  let restoreLaunch = null;
  let projectId = fixture.manifest.semantic.projectId;
  let restoredSnapshot;
  try {
    restoreLaunch = await harness.launch(`${C2ZC_PRODUCT_JOURNEY_ID}/restore`);
    projectId = await waitForProjectId(harness, restoreLaunch.page, projectId);
    const beforeRestore = await readC2ZcAuthoritySnapshot(
      harness,
      restoreLaunch.page,
      projectId,
    );
    await restoreBackupThroughSettingsUi(
      { page: restoreLaunch.page, harness },
      fixture.manifest.artifacts.fixture.path,
    );
    projectId = await waitForProjectId(
      harness,
      restoreLaunch.page,
      fixture.manifest.semantic.projectId,
      { requireExpected: true },
    );
    restoredSnapshot = await harness.waitUntil(
      async () => {
        const snapshot = await readC2ZcAuthoritySnapshot(
          harness,
          restoreLaunch.page,
          projectId,
        );
        try {
          restoredEpoch(snapshot.epochs, "C2-ZC restored Settings UI image");
          return snapshot;
        } catch {
          return null;
        }
      },
      "C2-ZC restored E1 observation",
      C2ZC_WAIT_MS,
      250,
    );
    restoredEpoch(restoredSnapshot.epochs, "C2-ZC restored Settings UI image");
    assertC2ZcProjectInventory(
      restoredSnapshot,
      fixture.manifest.semantic.projectId,
      "C2-ZC restored Settings UI inventory",
    );
    harness.recordTimeline?.(`${C2ZC_PRODUCT_JOURNEY_ID}/restore`, {
      projectId,
      beforeRunCount: beforeRestore.runs.length,
      restoredEpoch: restoredSnapshot.currentEpochId,
      restoreObservedThrough: "production-settings-ui",
    });
  } finally {
    await closeLaunch(
      harness,
      restoreLaunch,
      `${C2ZC_PRODUCT_JOURNEY_ID}/restore`,
    );
  }

  let openLaunch = null;
  let openSnapshot;
  let lifecycle;
  try {
    openLaunch = await harness.launch(`${C2ZC_PRODUCT_JOURNEY_ID}/open`);
    projectId = await waitForProjectId(harness, openLaunch.page, projectId);
    const settled = await waitForLifecycle(
      harness,
      openLaunch.page,
      projectId,
      {
        restoreEpochId: restoredSnapshot.currentEpochId,
        rustOutcome,
        expectedRestoreLifecycle:
          fixture.manifest.semantic.expectedRestoreLifecycle,
        fixtureSemantic: fixture.manifest.semantic,
      },
    );
    openSnapshot = settled.snapshot;
    lifecycle = settled.lifecycle;
    assertC2ZcFindingRowsResolved(openSnapshot, "C2-ZC open findings");
    assertC2ZcFixtureApplicationParity(
      openSnapshot,
      fixture.manifest.semantic,
      "C2-ZC open Application",
    );
    harness.recordTimeline?.(`${C2ZC_PRODUCT_JOURNEY_ID}/open`, {
      projectId,
      verifyRunIds: [lifecycle.firstVerify.id, lifecycle.finalVerify.id],
      rebuildRunId: lifecycle.rebuild?.id ?? null,
      freshnessRunId: lifecycle.freshness.id,
      markerCount: openSnapshot.markerRows.length,
    });
  } finally {
    await closeLaunch(harness, openLaunch, `${C2ZC_PRODUCT_JOURNEY_ID}/open`);
  }

  let restartLaunch = null;
  let firstRestartSnapshot;
  let afterTypedWrite;
  let typedFreshnessRow;
  let application;
  try {
    restartLaunch = await harness.launch(`${C2ZC_PRODUCT_JOURNEY_ID}/restart`);
    projectId = await waitForProjectId(harness, restartLaunch.page, projectId);
    firstRestartSnapshot = await harness.waitUntil(
      async () => {
        const snapshot = await readC2ZcAuthoritySnapshot(
          harness,
          restartLaunch.page,
          projectId,
        );
        try {
          assertC2ZcMarkerExactlyOnce(snapshot);
          assertC2ZcRestartInvariants({
            before: openSnapshot,
            restart: snapshot,
          });
          assertC2ZcProjectInventory(
            snapshot,
            fixture.manifest.semantic.projectId,
            "C2-ZC first restart inventory",
          );
          assertC2ZcFixtureApplicationParity(
            snapshot,
            fixture.manifest.semantic,
            "C2-ZC first restart Application",
          );
          return snapshot;
        } catch {
          return null;
        }
      },
      "C2-ZC first restart authority invariants",
      C2ZC_WAIT_MS,
      250,
    );
    harness.recordTimeline?.(`${C2ZC_PRODUCT_JOURNEY_ID}/restart`, {
      projectId,
      markerCount: firstRestartSnapshot.markerRows.length,
      epochCount: firstRestartSnapshot.epochs.length,
    });
    application = await createTypedApplicationAfterMarker(
      harness,
      restartLaunch.page,
      workspace,
      projectId,
    );
    afterTypedWrite = await harness.waitUntil(
      async () => {
        const snapshot = await readC2ZcAuthoritySnapshot(
          harness,
          restartLaunch.page,
          projectId,
        );
        try {
          assertC2ZcGenericFreshnessStorage(snapshot, {
            projectId,
            applicationId: application.applicationId,
            epochId: snapshot.currentEpochId,
          });
          return snapshot;
        } catch {
          return null;
        }
      },
      "C2-ZC typed write Generic storage",
      C2ZC_WAIT_MS,
      250,
    );
    typedFreshnessRow = assertC2ZcGenericFreshnessStorage(afterTypedWrite, {
      projectId,
      applicationId: application.applicationId,
      epochId: afterTypedWrite.currentEpochId,
    });
    harness.recordTimeline?.(`${C2ZC_PRODUCT_JOURNEY_ID}/typed-write`, {
      projectId,
      applicationId: application.applicationId,
      applicationRunId: application.runId,
      freshnessProducerRunId: typedFreshnessRow.lastEvaluatedRunId,
    });
  } finally {
    await closeLaunch(
      harness,
      restartLaunch,
      `${C2ZC_PRODUCT_JOURNEY_ID}/typed-write`,
    );
  }

  let finalLaunch = null;
  let finalSnapshot;
  try {
    finalLaunch = await harness.launch(
      `${C2ZC_PRODUCT_JOURNEY_ID}/restart-persistence`,
    );
    projectId = await waitForProjectId(harness, finalLaunch.page, projectId);
    finalSnapshot = await harness.waitUntil(
      async () => {
        const snapshot = await readC2ZcAuthoritySnapshot(
          harness,
          finalLaunch.page,
          projectId,
        );
        try {
          assertC2ZcPostMarkerApplicationPersistence({
            beforeMutation: firstRestartSnapshot,
            afterMutation: afterTypedWrite,
            restart: snapshot,
            application,
          });
          return snapshot;
        } catch {
          return null;
        }
      },
      "C2-ZC final restart persistence",
      C2ZC_WAIT_MS,
      250,
    );
    harness.recordTimeline?.(`${C2ZC_PRODUCT_JOURNEY_ID}/restart-persistence`, {
      projectId,
      markerCount: finalSnapshot.markerRows.length,
      applicationId: application.applicationId,
      noLegacyFallback: C2ZC_CANONICAL_FRESHNESS_CONTRACT.noLegacyFallback,
    });
  } finally {
    await closeLaunch(
      harness,
      finalLaunch,
      `${C2ZC_PRODUCT_JOURNEY_ID}/restart-persistence`,
    );
  }

  return {
    journeyId: C2ZC_PRODUCT_JOURNEY_ID,
    projectId,
    restoreFixture: {
      backupName: fixture.manifest.artifacts.fixture.path,
      manifestVersion: fixture.manifest.manifestVersion,
      manifestPath: fixture.manifestPath,
      fixtureSha256: fixture.manifest.fixtureSha256,
      fixtureSizeBytes: fixture.manifest.fixtureSizeBytes,
      stagedPath: staged.targetPath,
    },
    lifecycle: {
      verifyRunIds: [lifecycle.firstVerify.id, lifecycle.finalVerify.id],
      rebuildRunId: lifecycle.rebuild?.id ?? null,
      freshnessRunId: lifecycle.freshness.id,
    },
    typedWrite: {
      applicationRunId: application.runId,
      freshnessProducerRunId: typedFreshnessRow.lastEvaluatedRunId,
    },
    markerCount: finalSnapshot.markerRows.length,
    application,
  };
}
