import { createHash, randomUUID } from "node:crypto";

import {
  assertRestoreFixtureEvidence,
  compareInstants,
  parseInstant,
  restoreBackupThroughSettingsUi,
  runRestoreVerifyRebuildVerifyScenario,
  NARRATIVE_MAINTENANCE_OWNER_TOKEN,
  withLaunchEnvironmentForTest,
} from "./narrative-maintenance-product-journeys.mjs";

const C2ZC_CUTOVER_MIGRATION_ID = "narrative-c2-canonical-freshness-v1";
const C2ZC_CUTOVER_CONTRACT_VERSION = 1;
const C2ZC_FRESHNESS_CONSUMER_KIND = "application";
export const C2ZC_VERIFY_CHECK_NAMES = Object.freeze([
  "producer-and-generation-consistency",
  "active-edge-duplicates",
  "cross-project-edge",
  "consumer-and-source-key-format",
  "application-revision-artifact-references",
  "dependency-set-digest",
  "contribution-to-application-commit-correspondence",
  "legacy-mirror-migration-parity",
  "edge-state-belongs-to-current-epoch",
  "consumer-freshness-dependency-set-digest",
  "finding-observation-belongs-to-current-epoch",
  "cursor-and-feed-head-consistency",
  "semantic-index-generation-correspondence",
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
  rustReceiptComposition: Object.freeze({
    source:
      "src-tauri/crates/grimodex-db/src/narrative_extraction/c2zc_canonical_cutover.rs",
    readFunction: "canonical_application_freshness",
    status: "composed-by-shared-rust-receipt",
  }),
});
const C2ZC_WAIT_MS = 60_000;
const C2ZC_PHASE_RUN_KINDS = Object.freeze([
  "dependency-verify",
  "semantic-index-rebuild",
  "dependency-verify",
]);
const C2ZC_IDLE_RUN_KIND = "freshness-evaluation";
const C2ZC_IDLE_TASK_KIND = "incremental-freshness-batch";
const C2ZC_IDLE_TASK_INPUT_KIND = "current-epoch-idle-checkpoint";
const C2ZC_IDLE_SPEC_KIND = "incremental-freshness-idle-checkpoint@1";
const C2ZC_IDLE_HEX_DIGEST = /^sha256:[0-9a-f]{64}$/;
const C2ZC_INCREMENTAL_FRESHNESS_CONSUMER_ID =
  "narrative-incremental-freshness/v1";
const C2ZC_INCREMENTAL_FRESHNESS_TASK_KIND = "incremental-freshness-batch";
const C2ZC_SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/;
// Generic Consumer Freshness stores the dependency-set digest as the native
// Rust helper's bare lowercase SHA-256 hex.  Accept the historical
// `sha256:`-prefixed representation in fixture snapshots, but never accept a
// free-form token or a digest with the wrong length.
const C2ZC_DEPENDENCY_SHA256_DIGEST = /^(?:sha256:)?[0-9a-f]{64}$/u;
const C2ZC_REBUILD_WORK_KEY = "dependency-rebuild-derived";
const C2ZC_REBUILD_TASK_KIND = "maintenance-semantic-index-rebuild";
const C2ZC_MAX_IDLE_ATTEMPTS = 3;
const C2ZC_AUTOMATIC_RUN_KINDS = new Set([
  "backfill",
  "dependency-verify",
  "semantic-index-rebuild",
  "dependency-repair",
]);
const C2ZC_SETTLING_RUN_KINDS = new Set([
  ...C2ZC_AUTOMATIC_RUN_KINDS,
  C2ZC_IDLE_RUN_KIND,
]);

export const C2ZC_PRODUCT_JOURNEY_ID = "c2-zc-canonical-authority-cutover";
export const C2ZC_PRODUCT_JOURNEY_PHASES = Object.freeze([
  `${C2ZC_PRODUCT_JOURNEY_ID}/restore-fixture`,
  `${C2ZC_PRODUCT_JOURNEY_ID}/restore`,
  `${C2ZC_PRODUCT_JOURNEY_ID}/open`,
  `${C2ZC_PRODUCT_JOURNEY_ID}/restart`,
  `${C2ZC_PRODUCT_JOURNEY_ID}/restart-persistence`,
  `${C2ZC_PRODUCT_JOURNEY_ID}/new-project`,
]);

const C2ZC_WORKSPACE_LIFECYCLE_PHASES = Object.freeze([
  "switch-requested",
  "quiescence-started",
  "authority-commit",
  "new-scope-hydrated",
]);

function rowsOf(result) {
  return Array.isArray(result?.rows) ? result.rows : [];
}

function c2zcOutcome(value, label) {
  if (value?.outcomeSummaryJson !== undefined) {
    return parseObject(value.outcomeSummaryJson, `${label} outcomeSummaryJson`);
  }
  if (value?.outcome !== undefined) {
    return parseObject(value.outcome, `${label} outcome`);
  }
  return parseObject(value, `${label} outcome`);
}

function c2zcReport(value, label) {
  const outcome = c2zcOutcome(value, label);
  const report = outcome?.report ?? value?.report;
  if (!report || typeof report !== "object" || Array.isArray(report)) {
    throw new Error(`${label} must contain the production Verify report`);
  }
  return { outcome, report };
}

/**
 * Validate the machine-readable coverage persisted by a production Verify
 * Run. The Rust validator compares this object against its compiled
 * catalogue; this product contract repeats that exact comparison so a
 * journey cannot pass by merely observing a completed Run.
 */
export function assertC2ZcVerifyCoverage(run, label = "C2-ZC Verify") {
  const { outcome, report } = c2zcReport(run, label);
  if (run?.status !== undefined && run.status !== "completed") {
    throw new Error(`${label} must be a completed production Verify Run`);
  }
  const coverage = outcome.checkCoverage;
  if (!coverage || typeof coverage !== "object" || Array.isArray(coverage)) {
    throw new Error(`${label} is missing its machine-readable check coverage`);
  }
  assertExactKeys(
    coverage,
    ["complete", "required", "covered", "missing"],
    `${label} check coverage`,
  );
  if (
    coverage.complete !== true ||
    canonicalJson(coverage.required) !==
      canonicalJson(C2ZC_VERIFY_CHECK_NAMES) ||
    canonicalJson(coverage.covered) !==
      canonicalJson(C2ZC_VERIFY_CHECK_NAMES) ||
    canonicalJson(coverage.missing) !== "[]"
  ) {
    throw new Error(
      `${label} does not contain the exact production 13-check coverage`,
    );
  }
  const typedChecks = [
    [
      "application-revision-artifact-references",
      "applicationRevisionArtifactReferences",
    ],
    [
      "semantic-index-dependency-set-digest",
      "semanticIndexDependencySetDigest",
    ],
    [
      "contribution-to-application-commit-correspondence",
      "contributionToApplicationCommitCorrespondence",
    ],
    ["legacy-mirror-migration-parity", "legacyMirrorMigrationParity"],
    ["cursor-and-feed-head-consistency", "cursorAndFeedHeadConsistency"],
    [
      "semantic-index-generation-correspondence",
      "semanticIndexGenerationCorrespondence",
    ],
  ];
  for (const [checkName, field] of typedChecks) {
    const check = report[field];
    if (!check || typeof check !== "object" || Array.isArray(check)) {
      throw new Error(`${label} typed check '${checkName}' is missing`);
    }
    assertExactKeys(
      check,
      [
        "completed",
        "passed",
        "issues",
        "incomplete",
        ...(Object.hasOwn(check, "observedCounts") ? ["observedCounts"] : []),
      ],
      `${label} typed check '${checkName}'`,
    );
    if (
      check.completed !== true ||
      check.passed !== true ||
      canonicalJson(check.issues) !== "[]" ||
      canonicalJson(check.incomplete) !== "[]"
    ) {
      throw new Error(
        `${label} typed check '${checkName}' is not complete and passed`,
      );
    }
  }
  for (const field of [
    "edgeIdsWithMissingSource",
    "duplicateEdgeKeys",
    "edgeIdsWithCrossProjectConsumer",
    "edgeIdsWithMalformedKeys",
    "edgeStateIdsOutsideCurrentEpoch",
    "edgeIdsWithoutCurrentEpochState",
    "findingObservationIdsOutsideCurrentEpoch",
    "consumerKeysWithoutCurrentEpochFreshness",
    "duplicateEdgeIdsToDeactivate",
    "edgeIdsWithUnresolvableConsumerScope",
    "consumerKeysWithStaleDependencySetDigest",
    "consumerKeysWithUncomputedDependencySetDigest",
    "orphanedAttentionFindingKeys",
    "orphanedAttentionRehomeAmbiguities",
  ]) {
    if (canonicalJson(report[field]) !== "[]") {
      throw new Error(`${label} report has unresolved '${field}' evidence`);
    }
  }
  if (report.rebuildRequired !== false) {
    throw new Error(`${label} report still requires a derived-state rebuild`);
  }
  return { outcome, report, checkCoverage: coverage };
}

/** Validate both production-owned Semantic Index footprint checks. */
export function assertC2ZcSemanticIndexZero(
  value,
  label = "C2-ZC Semantic Index",
) {
  const { report } = c2zcReport(value, label);
  for (const field of [
    "semanticIndexDependencySetDigest",
    "semanticIndexGenerationCorrespondence",
  ]) {
    const check = report[field];
    if (!check || typeof check !== "object") {
      throw new Error(`${label} check '${field}' is missing`);
    }
    assertExactKeys(
      check,
      ["completed", "passed", "issues", "incomplete", "observedCounts"],
      `${label} check '${field}'`,
    );
    if (
      canonicalJson(check.observedCounts) !==
      canonicalJson(C2ZC_SEMANTIC_INDEX_ZERO_COUNTS)
    ) {
      throw new Error(
        `${label} reserved Semantic Index surfaces are not exactly zero`,
      );
    }
    if (
      check.completed !== true ||
      check.passed !== true ||
      canonicalJson(check.issues) !== "[]" ||
      canonicalJson(check.incomplete) !== "[]"
    ) {
      throw new Error(`${label} check '${field}' is not complete and passed`);
    }
  }
  return C2ZC_SEMANTIC_INDEX_ZERO_COUNTS;
}

/** A marker is a one-way activation fact, never a count-only observation. */
export function assertC2ZcMarkerExactlyOnce(snapshot, label = "C2-ZC marker") {
  const markerRows = Array.isArray(snapshot?.markerRows)
    ? snapshot.markerRows
    : snapshot?.marker
      ? [snapshot.marker]
      : [];
  if (markerRows.length !== 1) {
    throw new Error(`${label} must contain exactly one persisted marker row`);
  }
  const marker = markerRows[0];
  if (
    marker?.migrationId !== C2ZC_CUTOVER_MIGRATION_ID ||
    Number(marker?.contractVersion) !== C2ZC_CUTOVER_CONTRACT_VERSION
  ) {
    throw new Error(`${label} is not the current C2-ZC marker`);
  }
  parseInstant(marker.appliedAt, `${label} appliedAt`);
  if (
    snapshot?.marker &&
    canonicalJson(snapshot.marker) !== canonicalJson(marker)
  ) {
    throw new Error(
      `${label} primary observation does not match its marker rows`,
    );
  }
  return marker;
}

function activeC2ZcInboxEntries(entries) {
  return rows(entries, "C2-ZC Inbox entries").filter((entry) => {
    const observation = entry?.latestObservation ?? entry?.latest_observation;
    return observation !== null && observation !== undefined;
  });
}

/**
 * A resolved lifecycle row is a claim about an earlier observation, not a
 * self-authenticating status bit.  The native writer binds that row to an
 * exact prior observation and material-basis digest; keep the Electron
 * acceptance boundary honest when a snapshot includes resolved history.
 */
function assertC2ZcFindingResolutionCausality(snapshot, label) {
  const lifecycle = Array.isArray(snapshot?.findingLifecycle)
    ? snapshot.findingLifecycle
    : [];
  const resolved = lifecycle.filter(
    (finding) => finding?.lifecycleState === "resolved",
  );
  if (resolved.length === 0) return;
  const observations = snapshot?.findingObservations;
  if (!Array.isArray(observations)) {
    throw new Error(
      `${label} resolved Finding lifecycle rows have no observed-evidence ledger`,
    );
  }
  for (const finding of resolved) {
    const prior = observations.find(
      (observation) =>
        observation?.projectId === finding.projectId &&
        observation?.findingIdentity === finding.findingIdentity &&
        observation?.findingKey === finding.findingKey &&
        observation?.ruleId === finding.ruleId &&
        Number(observation?.ruleVersion) === Number(finding.ruleVersion) &&
        observation?.materialBasisDigest === finding.materialBasisDigest &&
        observation?.semanticEpochId === finding.semanticEpochId &&
        typeof observation?.observedAt === "string" &&
        compareInstants(observation.observedAt, finding.observedAt) <= 0,
    );
    if (!prior) {
      throw new Error(
        `${label} resolved Finding '${finding.findingIdentity}' is not causally anchored to an observed prior`,
      );
    }
  }
}

/** Findings are zero only when final unresolved lifecycle and active Inbox rows are both empty. */
export function assertC2ZcFindingInboxEmpty(snapshot, label = "C2-ZC marker") {
  const lifecycle = Array.isArray(snapshot?.findingLifecycle)
    ? snapshot.findingLifecycle
    : null;
  let unresolved =
    snapshot?.unresolvedFindings ?? snapshot?.findings?.unresolved ?? [];
  if (lifecycle !== null) {
    const epochs = Array.isArray(snapshot?.epochs) ? snapshot.epochs : [];
    if (epochs.length > 0) {
      unresolved = latestC2ZcFindingLifecycle(lifecycle, epochs);
    } else {
      const latestByIdentity = new Map();
      for (const finding of lifecycle) {
        if (typeof finding?.findingIdentity !== "string") continue;
        const prior = latestByIdentity.get(finding.findingIdentity);
        if (
          !prior ||
          compareInstants(prior.observedAt, finding.observedAt) < 0 ||
          (compareInstants(prior.observedAt, finding.observedAt) === 0 &&
            String(prior.id).localeCompare(String(finding.id)) < 0)
        ) {
          latestByIdentity.set(finding.findingIdentity, finding);
        }
      }
      unresolved = [...latestByIdentity.values()].filter(
        (finding) => finding.lifecycleState !== "resolved",
      );
    }
  }
  const activeInbox = Array.isArray(snapshot?.inboxEntries)
    ? activeC2ZcInboxEntries(snapshot.inboxEntries)
    : Array.isArray(snapshot?.inbox)
      ? activeC2ZcInboxEntries(snapshot.inbox)
      : null;
  const inboxFindings = snapshot?.inboxFindings;
  if (!Array.isArray(unresolved) || unresolved.length !== 0) {
    throw new Error(`${label} has unresolved Finding lifecycle rows`);
  }
  if (Array.isArray(activeInbox) && activeInbox.length !== 0) {
    throw new Error(`${label} Inbox still contains active Findings`);
  }
  if (
    !Array.isArray(activeInbox) &&
    (!Array.isArray(inboxFindings) || inboxFindings.length !== 0)
  ) {
    throw new Error(`${label} Inbox still contains active Findings`);
  }
  assertC2ZcFindingResolutionCausality(snapshot, label);
  return snapshot;
}

/** Compare every Legacy projection row and value, including nullable fields. */
export function assertC2ZcLegacyProjectionStable(
  before,
  after,
  label = "C2-ZC Legacy projection",
) {
  if (canonicalJson(before) !== canonicalJson(after)) {
    throw new Error(
      `${label} changed; the compatibility projection must remain byte-for-byte stable`,
    );
  }
  return after;
}

/**
 * Fixture DML is deliberately represented by a typed operation receipt. The
 * receipt is part of the backup contract so the acceptance cannot silently
 * substitute an arbitrary SQL mutation or a count-only observation.
 */
export function assertC2ZcFixtureOperationReceipt(
  receipt,
  expectedKind,
  { projectId, edgeId, consumerKey } = {},
  label = `C2-ZC fixture ${expectedKind}`,
) {
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) {
    throw new Error(`${label} receipt is missing`);
  }
  assertExactKeys(
    receipt,
    [
      "operationCount",
      "operationDigest",
      "operations",
      "beforeCounts",
      "afterCounts",
    ],
    `${label} receipt`,
  );
  if (
    receipt.operationCount !== 1 ||
    !/^sha256:[0-9a-f]{64}$/.test(receipt.operationDigest) ||
    !Array.isArray(receipt.operations) ||
    receipt.operations.length !== 1 ||
    !Array.isArray(receipt.beforeCounts) ||
    !Array.isArray(receipt.afterCounts) ||
    receipt.beforeCounts.length !== 1 ||
    receipt.afterCounts.length !== 1
  ) {
    throw new Error(
      `${label} receipt must describe exactly one operation and its counts`,
    );
  }
  const entry = receipt.operations[0];
  assertExactKeys(
    entry,
    ["operation", "kind", "operationDigest", "beforeCounts", "afterCounts"],
    `${label} operation receipt`,
  );
  if (
    entry.kind !== expectedKind ||
    canonicalJson(entry.operationDigest) !==
      canonicalJson(sha256Canonical(entry.operation)) ||
    canonicalJson(entry.beforeCounts) !==
      canonicalJson(receipt.beforeCounts[0]) ||
    canonicalJson(entry.afterCounts) !== canonicalJson(receipt.afterCounts[0])
  ) {
    throw new Error(`${label} operation digest/count binding is invalid`);
  }
  if (expectedKind === "dependency-edge-insert") {
    const operation = entry.operation;
    assertExactKeys(
      operation,
      [
        "kind",
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
      `${label} operation`,
    );
    if (
      operation.projectId !== projectId ||
      operation.id !== edgeId ||
      operation.consumerKind !== "narrative-extraction-run" ||
      operation.consumerKey !== consumerKey ||
      operation.owningRunId !== consumerKey ||
      operation.generatedByTransactionId !== null ||
      entry.beforeCounts?.rows !== 0 ||
      entry.afterCounts?.rows !== 1
    ) {
      throw new Error(`${label} is not the exact owned Dependency Edge insert`);
    }
  } else if (expectedKind === "dependency-derived-state-gap-delete") {
    const operation = entry.operation;
    assertExactKeys(
      operation,
      ["kind", "projectId", "edgeId", "consumerKind", "consumerKey"],
      `${label} operation`,
    );
    if (
      operation.projectId !== projectId ||
      operation.edgeId !== edgeId ||
      operation.consumerKind !== "narrative-extraction-run" ||
      operation.consumerKey !== consumerKey ||
      canonicalJson(entry.beforeCounts) !==
        canonicalJson({ edgeStateRows: 1, freshnessRows: 1 }) ||
      canonicalJson(entry.afterCounts) !==
        canonicalJson({ edgeStateRows: 0, freshnessRows: 0 })
    ) {
      throw new Error(
        `${label} is not the exact owned derived-state gap delete`,
      );
    }
  } else {
    throw new Error(`${label} is not a permitted C2-ZC fixture operation kind`);
  }
  return receipt;
}

/**
 * Prove the post-marker typed-writer -> Change Feed -> Generic storage and
 * provenance path from its durable Generic row and completed producer Run.
 * The canonical read function remains Rust-owned because no Electron IPC
 * exposes it; this acceptance assertion deliberately does not fabricate such
 * an IPC call or fall back to Legacy rows.
 */
export function assertC2ZcGenericFreshnessStorage(
  snapshot,
  { projectId, applicationId, epochId },
  label = "C2-ZC post-marker Generic Freshness storage/provenance",
) {
  if (
    typeof projectId !== "string" ||
    typeof applicationId !== "string" ||
    typeof epochId !== "string"
  ) {
    throw new Error(
      `${label} requires project, Application, and Epoch identities`,
    );
  }
  const genericRows = snapshot?.genericRows ?? snapshot?.generic ?? [];
  const targetRows = rows(genericRows, `${label} Generic rows`).filter(
    (candidate) =>
      (candidate?.applicationId ?? candidate?.consumerKey) === applicationId,
  );
  if (targetRows.length !== 1) {
    throw new Error(
      `${label} must contain exactly one post-marker Generic Consumer Freshness row`,
    );
  }
  const row = targetRows[0];
  if (
    (row.projectId !== undefined && row.projectId !== projectId) ||
    row.consumerKind !== C2ZC_FRESHNESS_CONSUMER_KIND ||
    (row.applicationId ?? row.consumerKey) !== applicationId ||
    row.evidenceFreshness !== "fresh" ||
    row.buildAction !== "none" ||
    row.semanticEpochId !== epochId ||
    typeof row.lastEvaluatedRunId !== "string" ||
    row.lastEvaluatedRunId.trim() === "" ||
    typeof row.dependencySetDigest !== "string" ||
    !dependencyDigestMatchesExpected(
      row.dependencySetDigest,
      Array.isArray(snapshot?.dependencyEdges)
        ? snapshot.dependencyEdges
            .filter(
              (edge) =>
                edge.projectId === projectId &&
                edge.consumerKind === C2ZC_FRESHNESS_CONSUMER_KIND &&
                edge.consumerKey === applicationId,
            )
            .map((edge) => edge.sourceObjectIdentity)
        : null,
    ) ||
    typeof row.updatedAt !== "string"
  ) {
    throw new Error(
      `${label} Generic row is not current evaluated storage/provenance`,
    );
  }
  parseInstant(row.updatedAt, `${label} Generic updatedAt`);
  const producer = rows(snapshot?.runs, `${label} producer Runs`).find(
    (run) => run.id === row.lastEvaluatedRunId,
  );
  if (
    !producer ||
    producer.projectId !== projectId ||
    producer.status !== "completed" ||
    producer.semanticEpochId !== epochId
  ) {
    throw new Error(
      `${label} Generic row is not bound to a completed current-epoch producer Run`,
    );
  }
  if (producer.runKind === "freshness-evaluation") {
    if (producer.consumerId !== C2ZC_INCREMENTAL_FRESHNESS_CONSUMER_ID) {
      throw new Error(
        `${label} Generic row producer Run has no exact Freshness consumerId`,
      );
    }
    assertC2ZcIncrementalPublisherProvenance(
      snapshot,
      row,
      producer,
      { projectId, applicationId, epochId },
      label,
    );
  } else if (producer.runKind === "semantic-index-rebuild") {
    assertC2ZcRebuildPublisherProvenance(
      snapshot,
      row,
      producer,
      { projectId, epochId },
      label,
    );
  } else {
    throw new Error(
      `${label} Generic row producer Run is neither non-idle Freshness nor exact Rebuild`,
    );
  }
  return { row, producer, contract: C2ZC_CANONICAL_FRESHNESS_CONTRACT };
}

/**
 * Validate the alternate canonical publisher: a completed, current-Epoch
 * Rebuild-Derived lifecycle.  Rebuild does not have a Feed range, so it is
 * accepted only with the strict native maintenance spec/outcome and its
 * exactly-one Task/Attempt terminal contract.
 */
function assertC2ZcRebuildPublisherProvenance(
  snapshot,
  row,
  producer,
  { projectId, epochId },
  label,
) {
  if (
    producer.projectId !== projectId ||
    producer.runKind !== "semantic-index-rebuild" ||
    producer.status !== "completed" ||
    producer.semanticEpochId !== epochId ||
    producer.workKey !== C2ZC_REBUILD_WORK_KEY ||
    producer.consumerId !== null
  ) {
    throw new Error(`${label} Rebuild publisher identity is invalid`);
  }
  const spec = parseObject(producer.specJson, `${label} Rebuild Run specJson`);
  let baseSpec = spec;
  if (Object.hasOwn(spec, "systemWork")) {
    const marker = spec.systemWork;
    if (!marker || typeof marker !== "object" || Array.isArray(marker)) {
      throw new Error(`${label} Rebuild systemWork marker is malformed`);
    }
    const markerKeys = Object.keys(marker).sort();
    const allowedMarkerKeys = [
      "canonicalWorkKey",
      "correlation",
      "generation",
      "kind",
      "owner",
      "projectId",
      "trigger",
    ].sort();
    if (markerKeys.some((key) => !allowedMarkerKeys.includes(key))) {
      throw new Error(`${label} Rebuild systemWork marker has unknown fields`);
    }
    baseSpec = { ...spec };
    delete baseSpec.systemWork;
  }
  if (
    canonicalJson(baseSpec) !== "{}" ||
    producer.specDigest !== sha256Json(baseSpec)
  ) {
    throw new Error(
      `${label} Rebuild spec/digest is not the exact empty contract`,
    );
  }
  const outcome = c2zcOutcome(producer, `${label} Rebuild Run`);
  assertExactKeys(
    outcome,
    ["rebuildContractVersion", "semanticEpochId", "summaryDigest", "summary"],
    `${label} Rebuild outcome`,
  );
  if (
    outcome.rebuildContractVersion !== "1" ||
    outcome.semanticEpochId !== epochId ||
    !C2ZC_SHA256_DIGEST.test(outcome.summaryDigest)
  ) {
    throw new Error(`${label} Rebuild outcome header is invalid`);
  }
  const summary = parseObject(outcome.summary, `${label} Rebuild summary`);
  assertExactKeys(
    summary,
    [
      "consumersEvaluated",
      "edgesEvaluated",
      "consumersSkippedUnresolvableScope",
      "edgesSkippedUnresolvableScope",
    ],
    `${label} Rebuild summary`,
  );
  if (
    Object.values(summary).some(
      (count) => !Number.isSafeInteger(count) || count < 0,
    ) ||
    sha256Canonical(summary) !== outcome.summaryDigest
  ) {
    throw new Error(`${label} Rebuild summary/digest is malformed`);
  }
  const tasks = rows(producer.tasks, `${label} Rebuild tasks`);
  if (tasks.length !== 1) {
    throw new Error(`${label} Rebuild must contain exactly one Task`);
  }
  const task = tasks[0];
  if (
    task.taskKind !== C2ZC_REBUILD_TASK_KIND ||
    task.status !== "completed" ||
    Number(task.attemptCount) !== 1
  ) {
    throw new Error(`${label} Rebuild Task lifecycle is invalid`);
  }
  const taskInput = parseObject(task.inputJson, `${label} Rebuild Task input`);
  if (canonicalJson(taskInput) !== canonicalJson(spec)) {
    throw new Error(`${label} Rebuild Task input is not the exact Run spec`);
  }
  const taskOutput = parseObject(
    task.outputJson,
    `${label} Rebuild Task output`,
  );
  if (canonicalJson(taskOutput) !== canonicalJson(outcome)) {
    throw new Error(
      `${label} Rebuild Task output does not match its Run outcome`,
    );
  }
  const attempts = rows(task.attempts, `${label} Rebuild attempts`);
  if (attempts.length !== 1) {
    throw new Error(`${label} Rebuild must contain exactly one Attempt`);
  }
  const attempt = attempts[0];
  if (
    attempt.taskId !== task.id ||
    Number(attempt.attemptNumber) !== 1 ||
    attempt.status !== "completed" ||
    attempt.failureCode !== null ||
    attempt.retryDisposition !== null ||
    attempt.policyVersion !== null ||
    attempt.nextAttemptAt !== null
  ) {
    throw new Error(`${label} Rebuild Attempt lifecycle is invalid`);
  }
  const attemptOutput = parseObject(
    attempt.outputJson,
    `${label} Rebuild Attempt output`,
  );
  if (canonicalJson(attemptOutput) !== canonicalJson(outcome)) {
    throw new Error(
      `${label} Rebuild Attempt output does not match its Run outcome`,
    );
  }
  for (const [name, value] of [
    ["Run.createdAt", producer.createdAt],
    ["Run.startedAt", producer.startedAt],
    ["Run.completedAt", producer.completedAt],
    ["Task.createdAt", task.createdAt],
    ["Task.startedAt", task.startedAt],
    ["Task.completedAt", task.completedAt],
    ["Attempt.startedAt", attempt.startedAt],
    ["Attempt.completedAt", attempt.completedAt],
  ]) {
    parseInstant(value, `${label} Rebuild ${name}`);
  }
  if (
    ![
      [producer.createdAt, producer.startedAt],
      [task.createdAt, task.startedAt],
      [producer.createdAt, task.createdAt],
      [producer.startedAt, task.startedAt],
      [task.startedAt, attempt.startedAt],
      [attempt.startedAt, attempt.completedAt],
      [attempt.completedAt, task.completedAt],
      [task.completedAt, producer.completedAt],
    ].every(([left, right]) => compareInstants(left, right) <= 0) ||
    task.completedAt !== attempt.completedAt ||
    producer.completedAt !== task.completedAt
  ) {
    throw new Error(`${label} Rebuild lifecycle timestamps are not exact`);
  }
  return { row, producer, task, attempts, outcome };
}

/**
 * A Generic row is publishable evidence only when its Freshness Run carries
 * the exact non-idle Feed descriptor and closed Task/Attempt lifecycle that
 * produced it.  This mirrors the shared Rust cutover validator while keeping
 * the Electron journey honest about the route it actually executes: the
 * journey observes typed writer -> Feed -> Generic storage/provenance and
 * never invokes canonical_application_freshness through an invented IPC.
 */
function assertC2ZcIncrementalPublisherProvenance(
  snapshot,
  row,
  producer,
  { projectId, applicationId = null, epochId },
  label,
) {
  if (
    producer.projectId !== projectId ||
    producer.runKind !== "freshness-evaluation" ||
    producer.status !== "completed" ||
    producer.semanticEpochId !== epochId ||
    producer.consumerId !== C2ZC_INCREMENTAL_FRESHNESS_CONSUMER_ID
  ) {
    throw new Error(`${label} Freshness publisher Run identity is invalid`);
  }
  const spec = parseObject(
    producer.specJson,
    `${label} publisher Run specJson`,
  );
  if (Object.hasOwn(spec, "systemWork")) {
    const systemWork = parseObject(
      spec.systemWork,
      `${label} publisher Run systemWork`,
    );
    if (
      Object.keys(systemWork).some(
        (key) =>
          ![
            "canonicalWorkKey",
            "correlation",
            "generation",
            "kind",
            "owner",
            "projectId",
            "trigger",
          ].includes(key),
      )
    ) {
      throw new Error(`${label} publisher Run systemWork has unknown fields`);
    }
    delete spec.systemWork;
  }
  assertExactKeys(
    spec,
    [
      "projectId",
      "fromSequenceExclusive",
      "throughSequenceInclusive",
      "eventIds",
      "affectedObjects",
      "feedPageDigest",
    ],
    `${label} publisher Run Feed descriptor`,
  );
  const fromSequence = spec.fromSequenceExclusive;
  const throughSequence = spec.throughSequenceInclusive;
  if (
    spec.projectId !== projectId ||
    !Number.isSafeInteger(fromSequence) ||
    fromSequence < 0 ||
    !Number.isSafeInteger(throughSequence) ||
    throughSequence <= fromSequence ||
    !Array.isArray(spec.eventIds) ||
    spec.eventIds.length === 0 ||
    spec.eventIds.some(
      (eventId) => typeof eventId !== "string" || eventId.trim() === "",
    ) ||
    !Array.isArray(spec.affectedObjects) ||
    spec.affectedObjects.some(
      (objectId) => typeof objectId !== "string" || objectId.trim() === "",
    ) ||
    !C2ZC_SHA256_DIGEST.test(spec.feedPageDigest) ||
    typeof producer.specDigest !== "string" ||
    producer.specDigest !== sha256Json(spec)
  ) {
    throw new Error(
      `${label} publisher Run does not carry the exact current Feed descriptor/digest`,
    );
  }
  const expectedWorkKey = `incremental-freshness:${epochId}:${fromSequence}:${throughSequence}:${producer.specDigest.slice("sha256:".length)}`;
  if (producer.workKey !== expectedWorkKey) {
    throw new Error(`${label} publisher Run workKey is not Feed-bound`);
  }

  const outcome = c2zcOutcome(producer, `${label} publisher Run`);
  assertExactKeys(
    outcome,
    [
      "projectId",
      "runId",
      "fromSequenceExclusive",
      "throughSequenceInclusive",
      "affectedEdgeCount",
      "affectedConsumerCount",
      "hasMore",
    ],
    `${label} publisher Run outcome`,
  );
  if (
    outcome.projectId !== projectId ||
    outcome.runId !== producer.id ||
    outcome.fromSequenceExclusive !== fromSequence ||
    outcome.throughSequenceInclusive !== throughSequence ||
    !Number.isSafeInteger(outcome.affectedEdgeCount) ||
    outcome.affectedEdgeCount <= 0 ||
    !Number.isSafeInteger(outcome.affectedConsumerCount) ||
    outcome.affectedConsumerCount <= 0 ||
    typeof outcome.hasMore !== "boolean"
  ) {
    throw new Error(`${label} publisher Run outcome is idle or malformed`);
  }
  const tasks = rows(producer.tasks, `${label} publisher Run tasks`);
  if (tasks.length !== 1) {
    throw new Error(`${label} publisher Run must contain exactly one Task`);
  }
  const task = tasks[0];
  if (
    task.taskKind !== C2ZC_INCREMENTAL_FRESHNESS_TASK_KIND ||
    task.status !== "completed" ||
    !Number.isSafeInteger(Number(task.attemptCount)) ||
    Number(task.attemptCount) <= 0
  ) {
    throw new Error(
      `${label} publisher Task is not a completed Freshness batch`,
    );
  }
  const taskInput = parseObject(
    task.inputJson,
    `${label} publisher Task inputJson`,
  );
  assertExactKeys(
    taskInput,
    ["changeSetId", "fromSequenceExclusive", "throughSequenceInclusive"],
    `${label} publisher Task input`,
  );
  if (
    typeof taskInput.changeSetId !== "string" ||
    taskInput.changeSetId.trim() === "" ||
    taskInput.fromSequenceExclusive !== fromSequence ||
    taskInput.throughSequenceInclusive !== throughSequence
  ) {
    throw new Error(`${label} publisher Task input is not Feed-bound`);
  }
  if (
    canonicalJson(
      parseObject(task.outputJson, `${label} publisher Task output`),
    ) !== canonicalJson(outcome)
  ) {
    throw new Error(
      `${label} publisher Task output does not match its Run outcome`,
    );
  }

  const changeSet = rows(
    snapshot?.changeSets,
    `${label} publisher Change Sets`,
  ).find(
    (candidate) =>
      candidate.changeSetId === taskInput.changeSetId &&
      candidate.projectId === projectId,
  );
  if (!changeSet) {
    throw new Error(`${label} publisher Change Set is missing`);
  }
  const sealedEventIds = parseArray(
    changeSet.eventIdsJson,
    `${label} publisher Change Set eventIdsJson`,
  );
  if (
    changeSet.fromSequenceExclusive !== fromSequence ||
    changeSet.throughSequenceInclusive !== throughSequence ||
    changeSet.digest !== producer.specDigest ||
    canonicalJson(sealedEventIds) !== canonicalJson(spec.eventIds) ||
    !C2ZC_SHA256_DIGEST.test(String(changeSet.digest))
  ) {
    throw new Error(`${label} publisher Change Set is not bound to its Run`);
  }
  const liveEvents = rows(
    snapshot?.feedEvents,
    `${label} publisher Feed events`,
  )
    .filter(
      (event) =>
        event.canonicalSequence > fromSequence &&
        event.canonicalSequence <= throughSequence,
    )
    .sort(
      (left, right) =>
        left.canonicalSequence - right.canonicalSequence ||
        left.eventOrdinal - right.eventOrdinal ||
        String(left.eventId).localeCompare(String(right.eventId)),
    );
  if (
    canonicalJson(liveEvents.map((event) => event.eventId)) !==
    canonicalJson(spec.eventIds)
  ) {
    throw new Error(`${label} publisher live Feed range is not Run-bound`);
  }
  if (applicationId !== null) {
    const targetEdges = rows(
      snapshot?.dependencyEdges,
      `${label} publisher Dependency Edges`,
    ).filter(
      (edge) =>
        edge.projectId === projectId &&
        edge.consumerKind === C2ZC_FRESHNESS_CONSUMER_KIND &&
        edge.consumerKey === applicationId &&
        typeof edge.sourceObjectIdentity === "string" &&
        edge.sourceObjectIdentity.trim() !== "",
    );
    const affectedObjects = parseArray(
      changeSet.affectedObjectsJson,
      `${label} publisher Change Set affectedObjectsJson`,
    );
    if (
      affectedObjects.some(
        (objectId) => typeof objectId !== "string" || objectId.trim() === "",
      ) ||
      !targetEdges.some((edge) =>
        affectedObjects.includes(edge.sourceObjectIdentity),
      )
    ) {
      throw new Error(
        `${label} publisher range does not contain source/full-graph evidence for the target Application`,
      );
    }
  }

  const attempts = rows(task.attempts, `${label} publisher Task attempts`);
  if (attempts.length !== Number(task.attemptCount)) {
    throw new Error(`${label} publisher Task attempt count is not exact`);
  }
  for (const [index, attempt] of attempts.entries()) {
    if (
      attempt.taskId !== task.id ||
      Number(attempt.attemptNumber) !== index + 1 ||
      !["failed", "completed"].includes(attempt.status)
    ) {
      throw new Error(`${label} publisher Attempt topology is invalid`);
    }
    parseInstant(attempt.startedAt, `${label} publisher Attempt.startedAt`);
    parseInstant(attempt.completedAt, `${label} publisher Attempt.completedAt`);
    if (attempt.status === "failed") {
      if (
        attempt.outputJson !== null ||
        typeof attempt.failureCode !== "string" ||
        !attempt.failureCode.startsWith("NEX_") ||
        !["retryable", "terminal"].includes(attempt.retryDisposition) ||
        attempt.policyVersion !== "v1" ||
        index === attempts.length - 1
      ) {
        throw new Error(
          `${label} publisher failed Attempt metadata is invalid`,
        );
      }
    } else if (
      index !== attempts.length - 1 ||
      attempt.failureCode !== null ||
      attempt.retryDisposition !== null ||
      attempt.policyVersion !== null ||
      attempt.nextAttemptAt !== null ||
      canonicalJson(
        parseObject(attempt.outputJson, `${label} publisher Attempt output`),
      ) !== canonicalJson(outcome)
    ) {
      throw new Error(
        `${label} publisher completed Attempt output/lifecycle is invalid`,
      );
    }
  }
  if (attempts.at(-1)?.status !== "completed") {
    throw new Error(`${label} publisher Run has no completed final Attempt`);
  }
  for (const [name, value] of [
    ["Run.createdAt", producer.createdAt],
    ["Run.startedAt", producer.startedAt],
    ["Run.completedAt", producer.completedAt],
    ["Task.createdAt", task.createdAt],
    ["Task.startedAt", task.startedAt],
    ["Task.completedAt", task.completedAt],
  ]) {
    parseInstant(value, `${label} publisher ${name}`);
  }
  return { row, producer, task, attempts, outcome };
}

/** Require one current-Epoch, non-idle Freshness publisher for a Feed event. */
export function assertC2ZcNonIdleFreshnessProducer(
  snapshot,
  { projectId, epochId, eventId },
  label = "C2-ZC Freshness producer",
) {
  const candidates = rows(snapshot?.runs, `${label} Runs`)
    .filter(
      (run) =>
        run.runKind === "freshness-evaluation" &&
        run.status === "completed" &&
        run.semanticEpochId === epochId &&
        run.consumerId === C2ZC_INCREMENTAL_FRESHNESS_CONSUMER_ID,
    )
    .reverse();
  for (const producer of candidates) {
    try {
      const spec = parseObject(producer.specJson, `${label} specJson`);
      if (!parseArray(spec.eventIds, `${label} eventIds`).includes(eventId)) {
        continue;
      }
      assertC2ZcIncrementalPublisherProvenance(
        snapshot,
        {},
        producer,
        { projectId, applicationId: null, epochId },
        label,
      );
      return producer;
    } catch {
      // Keep searching only among current-Epoch Freshness Runs. A malformed
      // candidate is not evidence for another run and is reported below.
    }
  }
  throw new Error(
    `${label} has no valid current-Epoch non-idle publisher containing Feed event '${eventId}'`,
  );
}

// Compatibility export for the focused contract tests. Runtime journey code
// uses the storage/provenance name above and never claims to execute the Rust
// canonical_application_freshness read through Electron.
export const assertC2ZcCanonicalFreshnessEvidence =
  assertC2ZcGenericFreshnessStorage;

/** Ensure the snapshot carries every durable Generic Consumer Freshness value. */
export function assertC2ZcGenericRowsComplete(
  snapshot,
  label = "C2-ZC Generic Consumer Freshness",
) {
  const genericRows = rows(
    snapshot?.genericRows ?? snapshot?.generic ?? [],
    `${label} rows`,
  );
  for (const [index, row] of genericRows.entries()) {
    assertExactKeys(
      row,
      [
        "projectId",
        "consumerKind",
        "consumerKey",
        "evidenceFreshness",
        "buildAction",
        "semanticEpochId",
        "lastEvaluatedRunId",
        "dependencySetDigest",
        "updatedAt",
      ],
      `${label} row ${index}`,
    );
    if (
      typeof row.projectId !== "string" ||
      row.projectId.trim() === "" ||
      row.consumerKind !== C2ZC_FRESHNESS_CONSUMER_KIND ||
      typeof row.consumerKey !== "string" ||
      row.consumerKey.trim() === "" ||
      !new Set([
        "fresh",
        "stale",
        "source-missing",
        "anchor-mismatch",
        "read-set-drift",
        "unknown",
      ]).has(row.evidenceFreshness) ||
      !new Set([
        "none",
        "revalidate-exact",
        "reanchor-candidate",
        "resolve-only",
        "recompile-only",
        "rebuild-required",
        "refresh-available",
        "manual",
      ]).has(row.buildAction) ||
      typeof row.semanticEpochId !== "string" ||
      row.semanticEpochId.trim() === "" ||
      (row.lastEvaluatedRunId === null
        ? row.evidenceFreshness !== "unknown" || row.buildAction !== "manual"
        : typeof row.lastEvaluatedRunId !== "string" ||
          row.lastEvaluatedRunId.trim() === "") ||
      (row.dependencySetDigest !== null &&
        !dependencyDigestMatchesExpected(
          row.dependencySetDigest,
          Array.isArray(snapshot?.dependencyEdges)
            ? snapshot.dependencyEdges
                .filter(
                  (edge) =>
                    edge.projectId === row.projectId &&
                    edge.consumerKind === row.consumerKind &&
                    edge.consumerKey === row.consumerKey,
                )
                .map((edge) => edge.sourceObjectIdentity)
            : null,
        )) ||
      typeof row.updatedAt !== "string"
    ) {
      throw new Error(`${label} row ${index} has incomplete durable values`);
    }
    parseInstant(row.updatedAt, `${label} row ${index} updatedAt`);
    if (row.lastEvaluatedRunId !== null) {
      const producer = rows(snapshot?.runs, `${label} producer Runs`).find(
        (run) => run.id === row.lastEvaluatedRunId,
      );
      if (!producer) {
        throw new Error(
          `${label} row ${index} references a missing producer Run`,
        );
      }
      if (producer.runKind === "freshness-evaluation") {
        assertC2ZcIncrementalPublisherProvenance(
          snapshot,
          row,
          producer,
          {
            projectId: row.projectId,
            applicationId: row.consumerKey,
            epochId: row.semanticEpochId,
          },
          `${label} row ${index}`,
        );
      } else if (
        producer.runKind !== "semantic-index-rebuild" ||
        producer.status !== "completed" ||
        producer.semanticEpochId !== row.semanticEpochId
      ) {
        throw new Error(
          `${label} row ${index} has an invalid producer Run kind`,
        );
      } else {
        assertC2ZcRebuildPublisherProvenance(
          snapshot,
          row,
          producer,
          {
            projectId: row.projectId,
            epochId: row.semanticEpochId,
          },
          `${label} row ${index}`,
        );
      }
    }
  }
  return genericRows;
}

/** A new post-marker Project must settle all maintenance work, not just mint E0. */
export function assertC2ZcPostMarkerProjectSettled(
  snapshot,
  label = "C2-ZC post-marker project",
) {
  if (snapshot?.epochs?.length !== 1) {
    throw new Error(`${label} must retain exactly one initial Epoch`);
  }
  const pending = snapshot?.pendingRuns ?? snapshot?.pendingOrRunningRuns ?? [];
  if (!Array.isArray(pending) || pending.length !== 0) {
    throw new Error(
      `${label} is not settled: pending or running maintenance remains`,
    );
  }
  if (snapshot?.projectSettled === false) {
    throw new Error(`${label} did not reach the settled project boundary`);
  }
  assertC2ZcGenericRowsComplete(snapshot, label);
  assertC2ZcFindingInboxEmpty(snapshot, label);
  return snapshot.epochs[0];
}

/** Validate the released Change Feed cursor against the observed feed head. */
export function assertC2ZcFeedCursorSettled(
  snapshot,
  { epochId = null } = {},
  label = "C2-ZC Change Feed cursor",
) {
  const feedAndCursor = snapshot?.feedAndCursor;
  const feedHead = Number(feedAndCursor?.feedHead);
  const cursor = feedAndCursor?.cursor;
  if (!Number.isSafeInteger(feedHead) || feedHead < 0 || !cursor) {
    throw new Error(`${label} is missing its durable feed head or cursor`);
  }
  if (
    Number(cursor.acknowledgedThrough) !== feedHead ||
    cursor.activeRunId !== null ||
    cursor.reservedThrough !== null ||
    cursor.semanticEpochId !== null ||
    cursor.lastError !== null
  ) {
    throw new Error(`${label} is not released at the observed feed head`);
  }
  if (epochId !== null && snapshot?.epochs?.at(-1)?.id !== epochId) {
    throw new Error(`${label} is not bound to the expected current Epoch`);
  }
  return feedAndCursor;
}

/**
 * Prove the workspace-wide cutover gate with two independently observed
 * projects.  A settled project is not sufficient authority: the marker must
 * remain absent while any other project's cursor is still incomplete, then
 * appear exactly once only after both projects converge at their own feed
 * heads.
 */
export function assertC2ZcTwoProjectConvergenceGate({
  primarySettled,
  secondaryIncomplete,
  markerRowsWhileIncomplete,
  convergedPrimary,
  convergedSecondary,
  label = "C2-ZC two-project convergence gate",
}) {
  if (!primarySettled || !secondaryIncomplete) {
    throw new Error(`${label} is missing both project observations`);
  }
  assertC2ZcFeedCursorSettled(
    primarySettled,
    { epochId: primarySettled.epochs?.at(-1)?.id },
    `${label} primary project`,
  );
  const secondaryFeed = secondaryIncomplete.feedAndCursor;
  const secondaryCursor = secondaryFeed?.cursor;
  if (
    !secondaryCursor ||
    !Number.isSafeInteger(Number(secondaryFeed.feedHead)) ||
    Number(secondaryFeed.feedHead) < 0 ||
    (Number(secondaryCursor.acknowledgedThrough) ===
      Number(secondaryFeed.feedHead) &&
      secondaryCursor.activeRunId === null &&
      secondaryCursor.reservedThrough === null &&
      secondaryCursor.semanticEpochId === null &&
      secondaryCursor.lastError === null)
  ) {
    throw new Error(`${label} secondary project was already cursor-settled`);
  }
  if (
    !Array.isArray(markerRowsWhileIncomplete) ||
    markerRowsWhileIncomplete.length !== 0
  ) {
    throw new Error(
      `${label} published the canonical marker while the secondary cursor was incomplete`,
    );
  }
  if (convergedPrimary === undefined || convergedSecondary === undefined) {
    return { primary: primarySettled, secondary: secondaryIncomplete };
  }
  assertC2ZcMarkerExactlyOnce(
    convergedPrimary,
    `${label} converged primary marker`,
  );
  assertC2ZcMarkerExactlyOnce(
    convergedSecondary,
    `${label} converged secondary marker`,
  );
  assertC2ZcFeedCursorSettled(
    convergedPrimary,
    { epochId: convergedPrimary.epochs?.at(-1)?.id },
    `${label} converged primary cursor`,
  );
  assertC2ZcFeedCursorSettled(
    convergedSecondary,
    { epochId: convergedSecondary.epochs?.at(-1)?.id },
    `${label} converged secondary cursor`,
  );
  if (
    canonicalJson(convergedPrimary.markerRows) !==
      canonicalJson(convergedSecondary.markerRows) ||
    convergedPrimary.markerRows.length !== 1 ||
    convergedSecondary.markerRows.length !== 1
  ) {
    throw new Error(`${label} did not converge to one shared marker row`);
  }
  return {
    primary: convergedPrimary,
    secondary: convergedSecondary,
  };
}

const C2ZC_INCREMENTAL_HOLD_PROTECTED_FIELDS = Object.freeze([
  "marker",
  "markerRows",
  "feedAndCursor",
  "changeSets",
]);
const C2ZC_SECONDARY_MAINTENANCE_RUN_KINDS = Object.freeze([
  "backfill",
  "dependency-verify",
  "semantic-index-rebuild",
  "dependency-verify",
]);

/**
 * Project creation is one typed transaction that publishes the four builtin
 * Codex catalog events. Keep this assertion tied to the transaction/request,
 * ordinals, and object keys rather than treating the transaction as a single
 * Feed row.
 */
export function assertC2ZcProjectCreateFeedEvidence(
  snapshot,
  { projectId, requireUnacked = true },
  label = "C2-ZC project_create Feed",
) {
  if (typeof projectId !== "string" || projectId.trim() === "") {
    throw new Error(`${label} requires a projectId`);
  }
  const requestId = `c2-zc-journey-project-create:${projectId}`;
  const events = rows(snapshot?.feedEvents, `${label} events`).filter(
    (event) => event.requestId === requestId,
  );
  if (events.length !== 4) {
    throw new Error(
      `${label} must contain exactly four typed project_create Feed events`,
    );
  }
  const expectedSlugs = ["character", "location", "item", "lore"];
  const transactionId = events[0]?.transactionId;
  if (typeof transactionId !== "string" || transactionId.trim() === "") {
    throw new Error(`${label} transaction binding is missing`);
  }
  for (const [ordinal, event] of events.entries()) {
    if (
      event.transactionId !== transactionId ||
      event.requestId !== requestId ||
      event.sourceDomain !== "project.create" ||
      Number(event.eventOrdinal) !== ordinal ||
      !Number.isSafeInteger(Number(event.canonicalSequence)) ||
      Number(event.canonicalSequence) <= 0 ||
      event.changeKind !== "catalog" ||
      event.mutationKind !== "create"
    ) {
      throw new Error(`${label} event ${ordinal} has invalid typed binding`);
    }
    const objectKey = parseObject(
      event.objectKeyJson,
      `${label} event ${ordinal} objectKeyJson`,
    );
    assertExactKeys(
      objectKey,
      ["kind", "componentId"],
      `${label} event ${ordinal} object key`,
    );
    if (
      objectKey.kind !== "component" ||
      objectKey.componentId !==
        `codex-type:${projectId}-${expectedSlugs[ordinal]}`
    ) {
      throw new Error(
        `${label} event ${ordinal} is not the builtin catalog row`,
      );
    }
    if (requireUnacked) {
      const acknowledgedThrough = Number(
        snapshot?.feedAndCursor?.cursor?.acknowledgedThrough ?? 0,
      );
      if (
        !Number.isSafeInteger(acknowledgedThrough) ||
        Number(event.canonicalSequence) <= acknowledgedThrough
      ) {
        throw new Error(
          `${label} event ${ordinal} was acknowledged before hold`,
        );
      }
    }
  }
  return events;
}

function assertC2ZcNoIncrementalFreshnessWrites(snapshot, label) {
  const freshnessRuns = rows(snapshot?.runs, `${label} Runs`).filter(
    (run) =>
      run?.runKind === "freshness-evaluation" ||
      run?.consumerId === C2ZC_INCREMENTAL_FRESHNESS_CONSUMER_ID ||
      run?.taskKind === C2ZC_INCREMENTAL_FRESHNESS_TASK_KIND,
  );
  for (const run of rows(snapshot?.runs, `${label} Runs`)) {
    for (const task of Array.isArray(run?.tasks) ? run.tasks : []) {
      if (
        task?.taskKind === C2ZC_INCREMENTAL_FRESHNESS_TASK_KIND ||
        (Array.isArray(task?.attempts) &&
          task.attempts.length > 0 &&
          run?.runKind === "freshness-evaluation")
      ) {
        freshnessRuns.push(run);
        break;
      }
    }
  }
  if (freshnessRuns.length !== 0) {
    throw new Error(
      `${label} contains an incremental Freshness Run/Task/Attempt before the held cycle`,
    );
  }
}

function assertC2ZcNoFreshnessCursorWrite(snapshot, label) {
  const feedAndCursor = snapshot?.feedAndCursor;
  const feedHead = Number(feedAndCursor?.feedHead);
  const cursor = feedAndCursor?.cursor;
  if (!Number.isSafeInteger(feedHead) || feedHead < 0 || !cursor) {
    throw new Error(`${label} is missing its durable Feed/cursor observation`);
  }
  const acknowledgedThrough =
    cursor.acknowledgedThrough === null ||
    cursor.acknowledgedThrough === undefined
      ? null
      : Number(cursor.acknowledgedThrough);
  if (
    acknowledgedThrough !== null &&
    (!Number.isSafeInteger(acknowledgedThrough) ||
      acknowledgedThrough >= feedHead)
  ) {
    throw new Error(`${label} Freshness cursor ACKed the B Feed head`);
  }
  if (
    (cursor.activeRunId !== null && cursor.activeRunId !== undefined) ||
    (cursor.reservedThrough !== null && cursor.reservedThrough !== undefined) ||
    (cursor.semanticEpochId !== null && cursor.semanticEpochId !== undefined)
  ) {
    throw new Error(
      `${label} Freshness cursor retained a reservation or active Run`,
    );
  }
  if (cursor.lastError !== null) {
    throw new Error(`${label} Freshness cursor has an unresolved error`);
  }
}

function assertC2ZcCompletedMaintenanceRun(
  run,
  { projectId, epochId, taskKind },
  label,
) {
  if (
    run?.projectId !== projectId ||
    run?.status !== "completed" ||
    run?.semanticEpochId !== epochId ||
    run?.taskKind !== taskKind ||
    run?.taskStatus !== "completed" ||
    Number(run?.taskCount) !== 1 ||
    Number(run?.attemptCount) !== 1 ||
    Number(run?.taskAttemptCount) !== 1 ||
    Number(run?.lastAttemptNumber) !== 1 ||
    Number(run?.maxAttemptNumber) !== 1 ||
    run?.lastAttemptStatus !== "completed"
  ) {
    throw new Error(`${label} Run/Task/Attempt lifecycle is not complete`);
  }
  const tasks = rows(run.tasks, `${label} tasks`);
  if (tasks.length !== 1) {
    throw new Error(`${label} must contain exactly one Task`);
  }
  const task = tasks[0];
  const attempts = rows(task.attempts, `${label} attempts`);
  if (
    task.id !== run.taskId ||
    task.taskKind !== taskKind ||
    task.status !== "completed" ||
    Number(task.attemptCount) !== 1 ||
    attempts.length !== 1 ||
    attempts[0]?.taskId !== task.id ||
    Number(attempts[0]?.attemptNumber) !== 1 ||
    attempts[0]?.status !== "completed"
  ) {
    throw new Error(`${label} Task/Attempt identity or lifecycle is invalid`);
  }
  const lifecycleFields = [
    "createdAt",
    "startedAt",
    "taskCreatedAt",
    "taskStartedAt",
    "lastAttemptStartedAt",
    "lastAttemptCompletedAt",
    "taskCompletedAt",
    "completedAt",
  ];
  for (let index = 0; index < lifecycleFields.length; index += 1) {
    const field = lifecycleFields[index];
    parseInstant(run[field], `${label} ${field}`);
    if (
      index > 0 &&
      compareInstants(run[lifecycleFields[index - 1]], run[field]) > 0
    ) {
      throw new Error(`${label} lifecycle timestamps are not monotonic`);
    }
  }
  return run;
}

/**
 * Validate the secondary project transition independently from the held q
 * receipt. Project creation happens before the marker and therefore has no
 * C2-ZC epoch; normal Backfill owns the first epoch and the V/R/V readiness
 * chain. Only the project-create Feed rows and incremental Freshness surfaces
 * are immutable across that transition.
 */
export function assertC2ZcSecondaryMaintenanceReadiness({
  projectId,
  afterCreate,
  atHold,
  label = "C2-ZC secondary maintenance",
}) {
  if (
    typeof projectId !== "string" ||
    projectId.trim() === "" ||
    !afterCreate ||
    !atHold
  ) {
    throw new Error(`${label} requires the post-create and held snapshots`);
  }
  for (const [phase, snapshot] of [
    ["post-create", afterCreate],
    ["held", atHold],
  ]) {
    if (snapshot.projectId !== undefined && snapshot.projectId !== projectId) {
      throw new Error(`${label} ${phase} snapshot crossed project identity`);
    }
    assertC2ZcNoIncrementalFreshnessWrites(snapshot, `${label} ${phase}`);
    assertC2ZcNoFreshnessCursorWrite(snapshot, `${label} ${phase}`);
  }
  if (rows(afterCreate.epochs, `${label} post-create Epochs`).length !== 0) {
    throw new Error(
      `${label} post-create snapshot must preserve the no-epoch pre-marker boundary`,
    );
  }
  const createEvents = assertC2ZcProjectCreateFeedEvidence(
    afterCreate,
    { projectId, requireUnacked: true },
    `${label} post-create project_create`,
  );
  const heldCreateEvents = assertC2ZcProjectCreateFeedEvidence(
    atHold,
    { projectId, requireUnacked: true },
    `${label} held project_create`,
  );
  if (canonicalJson(createEvents) !== canonicalJson(heldCreateEvents)) {
    throw new Error(
      `${label} original project_create Feed identities changed before the held cycle`,
    );
  }
  for (const field of C2ZC_INCREMENTAL_HOLD_PROTECTED_FIELDS) {
    if (
      field === "feedAndCursor" ||
      field === "changeSets" ||
      field === "marker" ||
      field === "markerRows"
    ) {
      if (canonicalJson(atHold[field]) !== canonicalJson(afterCreate[field])) {
        throw new Error(`${label} held B changed protected ${field}`);
      }
    }
  }
  if (
    Number(atHold.feedAndCursor?.feedHead) !==
    Number(afterCreate.feedAndCursor?.feedHead)
  ) {
    throw new Error(`${label} held B changed its project_create Feed head`);
  }

  const epochs = rows(atHold.epochs, `${label} held Epochs`);
  if (
    epochs.length !== 1 ||
    Number(epochs[0]?.epochNumber) !== 0 ||
    epochs[0]?.reason !== "initial" ||
    typeof epochs[0]?.id !== "string" ||
    epochs[0].id.trim() === ""
  ) {
    throw new Error(
      `${label} held B must contain exactly one initial epoch created by Backfill`,
    );
  }
  parseInstant(epochs[0].createdAt, `${label} held B initial Epoch createdAt`);

  const maintenanceRuns = rows(atHold.runs, `${label} held Runs`).filter(
    (run) => C2ZC_AUTOMATIC_RUN_KINDS.has(run.runKind),
  );
  if (
    canonicalJson(maintenanceRuns.map((run) => run.runKind)) !==
    canonicalJson(C2ZC_SECONDARY_MAINTENANCE_RUN_KINDS)
  ) {
    throw new Error(
      `${label} held B maintenance must be exactly Backfill -> Verify -> Rebuild -> confirmation Verify`,
    );
  }
  const [backfill, verify, rebuild, confirmationVerify] = maintenanceRuns;
  const maintenanceRunIds = new Set();
  for (const run of maintenanceRuns) {
    if (
      typeof run.id !== "string" ||
      run.id.trim() === "" ||
      maintenanceRunIds.has(run.id)
    ) {
      throw new Error(
        `${label} held B maintenance Run identities are not unique`,
      );
    }
    maintenanceRunIds.add(run.id);
  }
  assertC2ZcCompletedMaintenanceRun(
    backfill,
    {
      projectId,
      epochId: epochs[0].id,
      taskKind: "maintenance-backfill",
    },
    `${label} Backfill`,
  );
  for (const [index, run] of [verify, confirmationVerify].entries()) {
    assertC2ZcCompletedMaintenanceRun(
      run,
      {
        projectId,
        epochId: epochs[0].id,
        taskKind: "maintenance-dependency-verify",
      },
      `${label} Verify ${index + 1}`,
    );
    assertC2ZcVerifyCoverage(run, `${label} Verify ${index + 1}`);
    assertC2ZcSemanticIndexZero(run, `${label} Verify ${index + 1}`);
  }
  assertC2ZcCompletedMaintenanceRun(
    rebuild,
    {
      projectId,
      epochId: epochs[0].id,
      taskKind: "maintenance-semantic-index-rebuild",
    },
    `${label} Rebuild`,
  );
  if (
    atHold.projectSettled !== true ||
    rows(atHold.pendingRuns, `${label} held pending Runs`).length !== 0
  ) {
    throw new Error(`${label} held B is not maintenance-ready`);
  }
  assertC2ZcFindingInboxEmpty(atHold, `${label} held B Findings/Inbox`);
  return {
    projectId,
    projectCreateEvents: heldCreateEvents,
    initialEpoch: epochs[0],
    maintenanceRuns,
  };
}

/**
 * Prove the causal A/B hold checkpoint used by the canonical journey.  The
 * receipt alone is not enough: A must have a real typed Feed event with a
 * current non-idle publisher, while B must be selected by the held cycle and
 * remain unchanged at the durable boundary.
 */
export function assertC2ZcCausalHoldEvidence({
  primarySnapshot,
  secondaryBeforeHold,
  secondaryDuringHold,
  heldReceipt,
  primaryProjectId,
  secondaryProjectId,
  primaryEventId,
  primaryEpochId = null,
  verifyRuns = [],
  label = "C2-ZC causal A/B hold",
}) {
  if (
    !primarySnapshot ||
    !secondaryBeforeHold ||
    !secondaryDuringHold ||
    !heldReceipt ||
    typeof primaryProjectId !== "string" ||
    typeof secondaryProjectId !== "string" ||
    typeof primaryEventId !== "string"
  ) {
    throw new Error(
      `${label} is missing the primary, secondary, or hold receipt`,
    );
  }
  const receipt = heldReceipt.receipt ?? heldReceipt;
  const state = receipt?.state;
  const freshness = receipt?.freshness;
  if (
    !freshness ||
    freshness.heldProjectId !== secondaryProjectId ||
    freshness.cutoverNotReady !== true ||
    freshness.noWrite !== true ||
    !state ||
    state.freshnessHoldProjectId !== secondaryProjectId ||
    state.heldProjectId !== secondaryProjectId ||
    state.marker !== null
  ) {
    throw new Error(
      `${label} requires the actual held B NOT_READY receipt with noWrite evidence`,
    );
  }
  if (
    primarySnapshot.markerRows?.length !== 0 ||
    primarySnapshot.marker !== null
  ) {
    throw new Error(`${label} observed a marker before the B cursor converged`);
  }
  const primaryEpoch = primarySnapshot.epochs?.at(-1);
  if (
    !primaryEpoch ||
    (primaryEpochId !== null && primaryEpoch.id !== primaryEpochId) ||
    Number(primaryEpoch.epochNumber) !== 1 ||
    primaryEpoch.reason !== "restore" ||
    primarySnapshot.projectSettled !== true
  ) {
    throw new Error(`${label} A is not readiness-clean at current restore E1`);
  }
  assertC2ZcFeedCursorSettled(
    primarySnapshot,
    { epochId: primaryEpoch.id },
    `${label} A current-Epoch cursor`,
  );
  const primaryEvent = rows(
    primarySnapshot.feedEvents,
    `${label} A Feed events`,
  ).find((event) => event.eventId === primaryEventId);
  if (
    !primaryEvent ||
    !Number.isSafeInteger(Number(primaryEvent.canonicalSequence)) ||
    Number(primaryEvent.canonicalSequence) <= 0 ||
    typeof primaryEvent.transactionId !== "string" ||
    primaryEvent.transactionId.trim() === "" ||
    typeof primaryEvent.requestId !== "string" ||
    primaryEvent.requestId.trim() === "" ||
    typeof primaryEvent.sourceDomain !== "string" ||
    primaryEvent.sourceDomain.trim() === ""
  ) {
    throw new Error(`${label} A Feed event is not a typed transaction event`);
  }
  assertC2ZcNonIdleFreshnessProducer(
    primarySnapshot,
    {
      projectId: primaryProjectId,
      epochId: primaryEpoch.id,
      eventId: primaryEventId,
    },
    `${label} A current-Epoch Freshness producer`,
  );
  const secondaryMaintenance = assertC2ZcSecondaryMaintenanceReadiness({
    projectId: secondaryProjectId,
    afterCreate: secondaryBeforeHold,
    atHold: secondaryDuringHold,
    label,
  });
  const secondaryEvents = secondaryMaintenance.projectCreateEvents;
  if (
    Number(secondaryDuringHold.feedAndCursor?.feedHead ?? 0) <=
    Number(secondaryDuringHold.feedAndCursor?.cursor?.acknowledgedThrough ?? 0)
  ) {
    throw new Error(
      `${label} B is not blocked by an incomplete Freshness cursor`,
    );
  }
  const heldProjects = new Map(
    rows(state.projects, `${label} held state projects`).map((project) => [
      project.projectId,
      project,
    ]),
  );
  const heldPrimary = heldProjects.get(primaryProjectId);
  const heldSecondary = heldProjects.get(secondaryProjectId);
  if (!heldPrimary || !heldSecondary) {
    throw new Error(`${label} held receipt omitted A or B workspace state`);
  }
  const cursorIsSettled = (project) =>
    project.cursor.acknowledgedThrough === project.feedHead &&
    project.cursor.activeRunId === null &&
    project.cursor.reservedThrough === null &&
    project.cursor.semanticEpochId === null &&
    project.cursor.lastError === null;
  if (cursorIsSettled(heldSecondary) || !cursorIsSettled(heldPrimary)) {
    throw new Error(
      `${label} receipt did not show A settled and B cursor-blocked`,
    );
  }
  const verifyRows = rows(verifyRuns, `${label} Verify Runs`);
  if (verifyRows.length !== 2) {
    throw new Error(`${label} requires both production Verify Runs`);
  }
  for (const [index, verifyRun] of verifyRows.entries()) {
    assertC2ZcVerifyCoverage(verifyRun, `${label} Verify ${index + 1}`);
    assertC2ZcSemanticIndexZero(
      verifyRun,
      `${label} Verify ${index + 1} Semantic Index`,
    );
  }
  return {
    primaryEvent,
    secondaryEvents,
    heldReceipt,
    primarySnapshot,
    secondaryBeforeHold,
    secondaryDuringHold,
    secondaryMaintenance,
  };
}

function settledWorkspaceLifecycleTransition(events, workspace) {
  if (!Array.isArray(events)) return null;
  const grouped = new Map();
  for (const event of events) {
    if (
      event?.schemaVersion !== 1 ||
      event.kind !== "workspace" ||
      typeof event.transitionId !== "string"
    ) {
      continue;
    }
    const group = grouped.get(event.transitionId) ?? [];
    group.push(event);
    grouped.set(event.transitionId, group);
  }
  const matching = [...grouped.values()]
    .map((group) =>
      [...group].sort((left, right) => left.sequence - right.sequence),
    )
    .filter((group) => {
      if (
        JSON.stringify(group.map((event) => event.phase)) !==
        JSON.stringify(C2ZC_WORKSPACE_LIFECYCLE_PHASES)
      ) {
        return false;
      }
      if (
        !group.every((event, index) => {
          const from = event.from;
          const to = event.to;
          if (
            event.sequence !== index ||
            to?.workspacePath !== workspace ||
            from?.workspacePath !== null ||
            from?.workspaceOpenRevision !== 0 ||
            typeof from?.projectId !== "string" ||
            from.projectId.trim() === ""
          ) {
            return false;
          }
          if (index < 2) {
            return to.workspaceOpenRevision === null && to.projectId === null;
          }
          return (
            Number.isSafeInteger(to.workspaceOpenRevision) &&
            to.workspaceOpenRevision > 0 &&
            typeof to.projectId === "string" &&
            to.projectId.trim() !== ""
          );
        })
      ) {
        return false;
      }
      const authority = group[2]?.to;
      const hydrated = group[3]?.to;
      return (
        authority?.workspaceOpenRevision === hydrated?.workspaceOpenRevision &&
        authority?.projectId === hydrated?.projectId
      );
    })
    .findLast((group) => {
      const settled = group.at(-1)?.to;
      return (
        settled?.workspacePath === workspace &&
        Number.isSafeInteger(settled.workspaceOpenRevision) &&
        settled.workspaceOpenRevision > 0 &&
        typeof settled.projectId === "string" &&
        settled.projectId.trim() !== ""
      );
    });
  return matching ?? null;
}

async function waitForC2ZcWorkspaceAuthority(harness, page, workspace) {
  if (typeof harness.readLifecycleTrace !== "function") {
    throw new Error(
      "C2-ZC post-marker project requires the lifecycle trace boundary",
    );
  }
  if (typeof harness.waitUntil !== "function") {
    throw new Error(
      "C2-ZC post-marker project requires the lifecycle settling wait boundary",
    );
  }
  return harness.waitUntil(
    async () => {
      const transition = settledWorkspaceLifecycleTransition(
        await harness.readLifecycleTrace(page),
        workspace,
      );
      if (!transition) {
        throw new Error(
          "C2-ZC post-marker workspace authority transition is not settled",
        );
      }
      return transition;
    },
    "C2-ZC post-marker workspace authority settlement",
    C2ZC_WAIT_MS,
    100,
  );
}

async function queryRows(harness, page, sql, params = []) {
  return rowsOf(
    await harness.invokeOk(page, "db_execute", {
      sql,
      params,
      method: "all",
    }),
  );
}

async function readC2ZcMaintenanceInbox(harness, page, projectId) {
  const value = await harness.invokeOk(
    page,
    "narrative_maintenance_inbox_list",
    {
      payload: { projectId },
    },
  );
  const entries = Array.isArray(value)
    ? value
    : Array.isArray(value?.entries)
      ? value.entries
      : null;
  if (!entries) {
    throw new Error(
      `C2-ZC maintenance Inbox returned a non-list value: ${JSON.stringify(value)}`,
    );
  }
  return entries;
}

function latestC2ZcFindingLifecycle(rowsValue, epochs) {
  const currentEpochId = rows(epochs, "C2-ZC finding Epochs").at(-1)?.id;
  if (typeof currentEpochId !== "string" || currentEpochId.trim() === "") {
    return [];
  }
  const latestByIdentity = new Map();
  for (const finding of rows(rowsValue, "C2-ZC Finding lifecycle")) {
    if (typeof finding?.findingIdentity !== "string") continue;
    const prior = latestByIdentity.get(finding.findingIdentity);
    if (
      !prior ||
      compareInstants(prior.observedAt, finding.observedAt) < 0 ||
      (compareInstants(prior.observedAt, finding.observedAt) === 0 &&
        String(prior.id).localeCompare(String(finding.id)) < 0)
    ) {
      latestByIdentity.set(finding.findingIdentity, finding);
    }
  }
  return [...latestByIdentity.values()].filter(
    (finding) =>
      finding.semanticEpochId === currentEpochId &&
      finding.lifecycleState !== "resolved",
  );
}

export async function readC2ZcRunLedger(harness, page, projectId, runs) {
  const [taskRows, attemptRows] = await Promise.all([
    queryRows(
      harness,
      page,
      `SELECT t.id,
              t.run_id AS runId,
              t.task_kind AS taskKind,
              t.status,
              t.attempt_count AS attemptCount,
              t.priority,
              t.lease_owner AS leaseOwner,
              t.lease_expires_at AS leaseExpiresAt,
              t.heartbeat_at AS heartbeatAt,
              t.error_message AS errorMessage,
              t.input_json AS inputJson,
              t.output_json AS outputJson,
              t.created_at AS createdAt,
              t.started_at AS startedAt,
              t.completed_at AS completedAt,
              t.version
         FROM narrative_extraction_tasks t
         JOIN narrative_extraction_runs r ON r.id = t.run_id
        WHERE r.project_id = ?
        ORDER BY t.run_id, t.created_at, t.id`,
      [projectId],
    ),
    queryRows(
      harness,
      page,
      `SELECT a.id,
              a.task_id AS taskId,
              a.attempt_number AS attemptNumber,
              a.status,
              a.started_at AS startedAt,
              a.completed_at AS completedAt,
              a.error_message AS errorMessage,
              a.output_json AS outputJson,
              a.failure_code AS failureCode,
              a.retry_disposition AS retryDisposition,
              a.policy_version AS policyVersion,
              a.next_attempt_at AS nextAttemptAt
         FROM narrative_extraction_attempts a
         JOIN narrative_extraction_tasks t ON t.id = a.task_id
         JOIN narrative_extraction_runs r ON r.id = t.run_id
        WHERE r.project_id = ?
        ORDER BY t.run_id, a.attempt_number, a.id`,
      [projectId],
    ),
  ]);
  const attemptsByTaskId = new Map();
  for (const attempt of attemptRows) {
    const taskAttempts = attemptsByTaskId.get(attempt.taskId) ?? [];
    taskAttempts.push(attempt);
    attemptsByTaskId.set(attempt.taskId, taskAttempts);
  }
  const tasksByRunId = new Map();
  for (const task of taskRows) {
    const runTasks = tasksByRunId.get(task.runId) ?? [];
    runTasks.push({
      ...task,
      attempts: attemptsByTaskId.get(task.id) ?? [],
    });
    tasksByRunId.set(task.runId, runTasks);
  }
  return rows(runs, "C2-ZC Run ledger").map((run) => {
    const runTasks = tasksByRunId.get(run.id) ?? [];
    const firstTask = runTasks[0] ?? null;
    const attempts = runTasks.flatMap((task) => task.attempts ?? []);
    const lastAttempt = attempts.at(-1) ?? null;
    return {
      ...run,
      tasks: runTasks,
      taskId: firstTask?.id ?? null,
      taskKind: firstTask?.taskKind ?? null,
      taskStatus: firstTask?.status ?? null,
      taskCount: runTasks.length,
      attemptCount: attempts.length,
      taskAttemptCount: firstTask?.attemptCount ?? null,
      lastAttemptStatus: lastAttempt?.status ?? null,
      lastAttemptNumber: lastAttempt?.attemptNumber ?? null,
      maxAttemptNumber:
        attempts.length === 0
          ? null
          : Math.max(
              ...attempts.map((attempt) => Number(attempt.attemptNumber)),
            ),
      taskInputJson: firstTask?.inputJson ?? null,
      taskCreatedAt: firstTask?.createdAt ?? null,
      taskStartedAt: firstTask?.startedAt ?? null,
      taskCompletedAt: firstTask?.completedAt ?? null,
      lastAttemptStartedAt: lastAttempt?.startedAt ?? null,
      lastAttemptCompletedAt: lastAttempt?.completedAt ?? null,
    };
  });
}

export async function createProjectAfterCutover(
  harness,
  page,
  workspace,
  {
    idPrefix = "c2-zc-journey-project",
    title = "C2-ZC post-marker project",
  } = {},
) {
  if (typeof workspace !== "string" || workspace.trim() === "") {
    throw new Error(
      "C2-ZC post-marker project requires an open workspace path",
    );
  }
  await waitForC2ZcWorkspaceAuthority(harness, page, workspace);
  const projectId = `${idPrefix}-${randomUUID()}`;
  const now = new Date().toISOString();
  await harness.invokeOk(page, "project_create", {
    payload: {
      requestId: `c2-zc-journey-project-create:${projectId}`,
      projectId,
      sessionId: C2ZC_PRODUCT_JOURNEY_ID,
      eventUid: `c2-zc-journey-project-create-event:${projectId}`,
      origin: "human",
      originalTransactionId: null,
      undoJournalId: null,
      title,
      genre: null,
      pov: null,
      tense: null,
      language: "ja",
      styleGuide: null,
      aiInstructions: null,
      outline: null,
      targetReaders: null,
      createdAt: now,
      updatedAt: now,
    },
  });
  return projectId;
}

/**
 * Append one real primary-project Feed event while the restore launch still
 * has setup/Freshness disabled.  This is a typed Scene metadata writer for
 * the fixture's existing source identity, so the two-project hold observes
 * an actual A event that can evaluate the restored Edge before B is selected;
 * no Feed or Freshness authority table is seeded by fixture SQL.
 */
export async function createPrimaryTypedFeedMutation(harness, page, projectId) {
  const current = await queryRows(
    harness,
    page,
    `SELECT id, version,
            story_time_order AS storyTimeOrder,
            story_time_label AS storyTimeLabel,
            chronicle_start_time AS startTime,
            chronicle_start_minute AS startMinute,
            chronicle_start_granularity AS startGranularity,
            chronicle_end_time AS endTime,
            chronicle_end_minute AS endMinute,
            chronicle_end_granularity AS endGranularity,
            chronicle_precision AS precision
       FROM tree_nodes
      WHERE project_id = ? AND node_type = 'scene'
      ORDER BY id
      LIMIT 1`,
    [projectId],
  );
  if (
    current.length !== 1 ||
    typeof current[0]?.id !== "string" ||
    !Number.isSafeInteger(Number(current[0]?.version))
  ) {
    throw new Error(
      "C2-ZC primary typed Feed mutation could not read Scene OCC state",
    );
  }
  const requestId = `c2-zc-primary-feed:${projectId}:${randomUUID()}`;
  const nextStoryTimeLabel = `${current[0].storyTimeLabel ?? ""} [C2-ZC typed Feed]`;
  const result = await harness.invokeOk(page, "temporal_scene_patch", {
    payload: {
      projectId,
      requestId,
      sessionId: C2ZC_PRODUCT_JOURNEY_ID,
      eventUid: `${requestId}:event`,
      origin: "human",
      authorityRoute: "human-direct",
      caller: "typed-domain-api",
      controls: [
        "runtime-policy",
        "actor-context",
        "typed-writer",
        "occ",
        "change-event",
        "change-feed",
      ],
      provenance: null,
      writesAuthorityProtectedField: false,
      originalTransactionId: null,
      undoJournalId: null,
      targetId: current[0].id,
      baseVersion: Number(current[0].version),
      storyTimeOrder: current[0].storyTimeOrder ?? null,
      storyTimeLabel: nextStoryTimeLabel,
      startTime: current[0].startTime ?? null,
      startMinute: current[0].startMinute ?? null,
      startGranularity: current[0].startGranularity ?? "none",
      endTime: current[0].endTime ?? null,
      endMinute: current[0].endMinute ?? null,
      endGranularity: current[0].endGranularity ?? "none",
      precision: current[0].precision ?? "exact",
    },
  });
  if (result?.sceneId !== current[0].id) {
    throw new Error(
      `C2-ZC primary typed Scene mutation did not commit: ${JSON.stringify(result)}`,
    );
  }
  const events = await queryRows(
    harness,
    page,
    `SELECT event.id AS eventId,
            event.canonical_sequence AS canonicalSequence,
            transaction_row.request_id AS requestId
       FROM narrative_change_events event
       JOIN narrative_change_transactions transaction_row
         ON transaction_row.project_id = event.project_id
        AND transaction_row.id = event.transaction_id
      WHERE event.project_id = ?
        AND transaction_row.request_id = ?
      ORDER BY event.canonical_sequence, event.event_ordinal, event.id`,
    [projectId, requestId],
  );
  if (
    events.length !== 1 ||
    events[0].requestId !== requestId ||
    !Number.isSafeInteger(Number(events[0].canonicalSequence))
  ) {
    throw new Error(
      `C2-ZC primary typed Project mutation did not append exactly one Feed event: ${JSON.stringify(events)}`,
    );
  }
  return {
    projectId,
    requestId,
    eventId: events[0].eventId,
    canonicalSequence: Number(events[0].canonicalSequence),
  };
}

async function readAuthoritySnapshot(harness, page, projectId) {
  const [
    markerRows,
    epochs,
    runRows,
    genericRows,
    dependencyEdges,
    legacyFreshness,
    legacyDependencies,
    findingLifecycle,
    findingObservations,
    inboxEntries,
    feedAndCursorRows,
    feedEvents,
    changeSets,
    proposalSets,
    proposals,
    proposalRevisions,
    proposalDecisions,
    applyCommits,
    applyOperations,
    applications,
    commitJournals,
    codexEntries,
  ] = await Promise.all([
    queryRows(
      harness,
      page,
      `SELECT migration_id AS migrationId,
              contract_version AS contractVersion,
              applied_at AS appliedAt
         FROM schema_data_migrations
        WHERE migration_id = ?`,
      [C2ZC_CUTOVER_MIGRATION_ID],
    ),
    queryRows(
      harness,
      page,
      `SELECT id, project_id AS projectId,
              epoch_number AS epochNumber, reason,
              created_at AS createdAt
         FROM narrative_semantic_epochs
        WHERE project_id = ?
        ORDER BY epoch_number, id`,
      [projectId],
    ),
    queryRows(
      harness,
      page,
      `SELECT id, project_id AS projectId,
              run_kind AS runKind, work_key AS workKey, status,
              semantic_epoch_id AS semanticEpochId,
              consumer_id AS consumerId,
              surface_path_id AS surfacePathId,
              scope_json AS scopeJson,
              spec_json AS specJson,
              spec_digest AS specDigest,
              snapshot_digest AS snapshotDigest,
              catalog_digest AS catalogDigest,
              registry_digest AS registryDigest,
              coverage_json AS coverageJson,
              outcome_summary_json AS outcomeSummaryJson,
              terminal_reason_code AS terminalReasonCode,
              created_at AS createdAt, started_at AS startedAt,
              completed_at AS completedAt,
              version,
              superseded_by_run_id AS supersededByRunId,
              request_id AS requestId,
              idempotency_domain AS idempotencyDomain,
              request_payload_digest AS requestPayloadDigest,
              actor_id AS actorId
         FROM narrative_extraction_runs
        WHERE project_id = ?
        ORDER BY created_at, id`,
      [projectId],
    ),
    queryRows(
      harness,
      page,
      `SELECT project_id AS projectId,
              consumer_kind AS consumerKind,
              consumer_key AS consumerKey,
              evidence_freshness AS evidenceFreshness,
              build_action AS buildAction,
              semantic_epoch_id AS semanticEpochId,
              last_evaluated_run_id AS lastEvaluatedRunId,
              dependency_set_digest AS dependencySetDigest,
              updated_at AS updatedAt
         FROM narrative_consumer_freshness
        WHERE project_id = ? AND consumer_kind = ?
        ORDER BY consumer_kind, consumer_key`,
      [projectId, C2ZC_FRESHNESS_CONSUMER_KIND],
    ),
    queryRows(
      harness,
      page,
      `SELECT id AS edgeId,
              project_id AS projectId,
              consumer_kind AS consumerKind,
              consumer_key AS consumerKey,
              source_object_identity AS sourceObjectIdentity,
              read_set_json AS readSetJson,
              generated_by_transaction_id AS generatedByTransactionId,
              created_at AS createdAt,
              owning_run_id AS owningRunId
         FROM narrative_dependency_edges
        WHERE project_id = ?
        ORDER BY consumer_kind, consumer_key, source_object_identity, id`,
      [projectId],
    ),
    queryRows(
      harness,
      page,
      `SELECT a.id AS applicationId,
              f.status,
              f.reason_json AS reasonJson,
              f.version,
              f.updated_at AS updatedAt
         FROM narrative_projection_freshness f
         JOIN narrative_proposal_applications a ON a.id = f.application_id
         JOIN narrative_apply_commits c ON c.id = a.commit_id
        WHERE c.project_id = ?
        ORDER BY a.id`,
      [projectId],
    ),
    queryRows(
      harness,
      page,
      `SELECT a.id AS applicationId,
              d.source_kind AS sourceKind,
              d.source_key AS sourceKey,
              d.observed_revision_token AS observedRevisionToken,
              d.propagation
         FROM narrative_projection_dependencies d
         JOIN narrative_proposal_applications a ON a.id = d.application_id
         JOIN narrative_apply_commits c ON c.id = a.commit_id
        WHERE c.project_id = ?
        ORDER BY a.id, d.source_kind, d.source_key`,
      [projectId],
    ),
    queryRows(
      harness,
      page,
      `SELECT id,
              project_id AS projectId,
              finding_identity AS findingIdentity,
              finding_key AS findingKey,
              rule_id AS ruleId,
              rule_version AS ruleVersion,
              lifecycle_state AS lifecycleState,
              observation_digest AS observationDigest,
              material_basis_digest AS materialBasisDigest,
              run_id AS runId,
              semantic_epoch_id AS semanticEpochId,
              observed_at AS observedAt
         FROM narrative_maintenance_finding_lifecycle
        WHERE project_id = ?
        ORDER BY observed_at, id`,
      [projectId],
    ),
    queryRows(
      harness,
      page,
      `SELECT id,
              project_id AS projectId,
              run_id AS runId,
              semantic_epoch_id AS semanticEpochId,
              edge_id AS edgeId,
              finding_key AS findingKey,
              reason_code AS reasonCode,
              evidence_freshness_snapshot AS evidenceFreshnessSnapshot,
              material_basis_digest AS materialBasisDigest,
              observed_at AS observedAt,
              finding_identity AS findingIdentity,
              rule_id AS ruleId,
              rule_version AS ruleVersion,
              observation_digest AS observationDigest
         FROM narrative_maintenance_finding_observations
        WHERE project_id = ?
        ORDER BY observed_at, id`,
      [projectId],
    ),
    readC2ZcMaintenanceInbox(harness, page, projectId),
    queryRows(
      harness,
      page,
      `SELECT COALESCE(MAX(canonical_sequence), 0) AS feedHead,
              (SELECT acknowledged_through_sequence
                 FROM narrative_change_cursors
                WHERE project_id = ?
                  AND consumer_id = 'narrative-incremental-freshness/v1'
                LIMIT 1) AS acknowledgedThrough,
              (SELECT reserved_through_sequence
                 FROM narrative_change_cursors
                WHERE project_id = ?
                  AND consumer_id = 'narrative-incremental-freshness/v1'
                LIMIT 1) AS reservedThrough,
              (SELECT active_run_id
                 FROM narrative_change_cursors
                WHERE project_id = ?
                  AND consumer_id = 'narrative-incremental-freshness/v1'
                LIMIT 1) AS activeRunId,
              (SELECT semantic_epoch_id
                 FROM narrative_change_cursors
                WHERE project_id = ?
                  AND consumer_id = 'narrative-incremental-freshness/v1'
                LIMIT 1) AS semanticEpochId,
              (SELECT last_error
                 FROM narrative_change_cursors
                WHERE project_id = ?
                  AND consumer_id = 'narrative-incremental-freshness/v1'
                LIMIT 1) AS lastError,
              (SELECT COUNT(*)
                 FROM narrative_change_cursors
                WHERE project_id = ?
                  AND consumer_id = 'narrative-incremental-freshness/v1') AS cursorPresent
         FROM narrative_change_events
        WHERE project_id = ?`,
      [
        projectId,
        projectId,
        projectId,
        projectId,
        projectId,
        projectId,
        projectId,
      ],
    ),
    queryRows(
      harness,
      page,
      `SELECT event.id AS eventId,
              event.canonical_sequence AS canonicalSequence,
              event.event_ordinal AS eventOrdinal,
              event.transaction_id AS transactionId,
              event.canonical_change_event_uid AS canonicalChangeEventUid,
              event.object_key_json AS objectKeyJson,
              event.change_kind AS changeKind,
              event.mutation_kind AS mutationKind,
              transaction_row.request_id AS requestId,
              transaction_row.source_domain AS sourceDomain,
              transaction_row.cause_kind AS causeKind,
              transaction_row.origin,
              transaction_row.application_ids_json AS applicationIdsJson
         FROM narrative_change_events event
         LEFT JOIN narrative_change_transactions transaction_row
           ON transaction_row.project_id = event.project_id
          AND transaction_row.id = event.transaction_id
        WHERE event.project_id = ?
        ORDER BY event.canonical_sequence, event.event_ordinal, event.id`,
      [projectId],
    ),
    queryRows(
      harness,
      page,
      `SELECT id AS changeSetId,
              project_id AS projectId,
              from_sequence_exclusive AS fromSequenceExclusive,
              through_sequence_inclusive AS throughSequenceInclusive,
              event_ids_json AS eventIdsJson,
              affected_objects_json AS affectedObjectsJson,
              digest
         FROM narrative_change_sets
        WHERE project_id = ?
        ORDER BY from_sequence_exclusive, through_sequence_inclusive, id`,
      [projectId],
    ),
    queryRows(
      harness,
      page,
      `SELECT id AS proposalSetId,
              run_id AS runId,
              project_id AS projectId,
              set_kind AS setKind,
              status,
              summary_json AS summaryJson,
              created_at AS createdAt,
              updated_at AS updatedAt,
              version
         FROM narrative_proposal_sets
        WHERE project_id = ?
        ORDER BY id`,
      [projectId],
    ),
    queryRows(
      harness,
      page,
      `SELECT proposal.id AS proposalId,
              proposal.proposal_set_id AS proposalSetId,
              proposal.proposal_key AS proposalKey,
              proposal.kind,
              proposal.status,
              proposal.payload_json AS payloadJson,
              proposal.current_revision_id AS currentRevisionId,
              proposal.created_at AS createdAt,
              proposal.updated_at AS updatedAt
         FROM narrative_proposals proposal
         JOIN narrative_proposal_sets proposal_set
           ON proposal_set.id = proposal.proposal_set_id
        WHERE proposal_set.project_id = ?
        ORDER BY proposal.id`,
      [projectId],
    ),
    queryRows(
      harness,
      page,
      `SELECT revision.id AS revisionId,
              revision.proposal_id AS proposalId,
              revision.revision_number AS revisionNumber,
              revision.payload_json AS payloadJson,
              revision.plan_fragment_json AS planFragmentJson,
              revision.plan_fragment_digest AS planFragmentDigest,
              revision.origin_kind AS originKind,
              revision.reconciliation_envelope_json AS reconciliationEnvelopeJson,
              revision.reconciliation_envelope_digest AS reconciliationEnvelopeDigest,
              revision.created_at AS createdAt,
              revision.created_by AS createdBy
         FROM narrative_proposal_revisions revision
         JOIN narrative_proposals proposal ON proposal.id = revision.proposal_id
         JOIN narrative_proposal_sets proposal_set
           ON proposal_set.id = proposal.proposal_set_id
        WHERE proposal_set.project_id = ?
        ORDER BY revision.proposal_id, revision.revision_number, revision.id`,
      [projectId],
    ),
    queryRows(
      harness,
      page,
      `SELECT decision.id AS decisionId,
              decision.proposal_id AS proposalId,
              decision.revision_id AS revisionId,
              decision.decision,
              decision.decision_json AS decisionJson,
              decision.created_at AS createdAt,
              decision.created_by AS createdBy,
              decision.actor_kind AS actorKind,
              decision.actor_id AS actorId,
              decision.authority_scope AS authorityScope,
              decision.override_field_paths_json AS overrideFieldPathsJson
         FROM narrative_proposal_decisions decision
         JOIN narrative_proposals proposal ON proposal.id = decision.proposal_id
         JOIN narrative_proposal_sets proposal_set
           ON proposal_set.id = proposal.proposal_set_id
        WHERE proposal_set.project_id = ?
        ORDER BY decision.proposal_id, decision.created_at, decision.id`,
      [projectId],
    ),
    queryRows(
      harness,
      page,
      `SELECT id AS commitId,
              project_id AS projectId,
              run_id AS runId,
              proposal_set_id AS proposalSetId,
              request_id AS requestId,
              plan_digest AS planDigest,
              status,
              receipt_json AS receiptJson,
              error_message AS errorMessage,
              prepared_plan_json AS preparedPlanJson,
              prepared_policy_version AS preparedPolicyVersion,
              prepared_at AS preparedAt,
              authority_digest AS authorityDigest,
              session_id AS sessionId,
              created_at AS createdAt,
              completed_at AS completedAt,
              version
         FROM narrative_apply_commits
        WHERE project_id = ?
        ORDER BY created_at, id`,
      [projectId],
    ),
    queryRows(
      harness,
      page,
      `SELECT operation.id AS operationId,
              operation.commit_id AS commitId,
              operation.operation_index AS operationIndex,
              operation.operation_kind AS operationKind,
              operation.payload_json AS payloadJson,
              operation.result_entity_kind AS resultEntityKind,
              operation.result_entity_id AS resultEntityId,
              operation.status,
              operation.created_at AS createdAt
         FROM narrative_apply_operations operation
         JOIN narrative_apply_commits commit_row
           ON commit_row.id = operation.commit_id
        WHERE commit_row.project_id = ?
        ORDER BY operation.commit_id, operation.operation_index, operation.id`,
      [projectId],
    ),
    queryRows(
      harness,
      page,
      `SELECT application.id AS applicationId,
              application.commit_id AS commitId,
              application.proposal_id AS proposalId,
              application.revision_id AS revisionId,
              application.applied_entity_kind AS appliedEntityKind,
              application.applied_entity_id AS appliedEntityId,
              application.created_at AS createdAt,
              application.application_kind AS applicationKind,
              application.compensates_application_id AS compensatesApplicationId
         FROM narrative_proposal_applications application
         JOIN narrative_apply_commits commit_row
           ON commit_row.id = application.commit_id
        WHERE commit_row.project_id = ?
        ORDER BY application.id`,
      [projectId],
    ),
    queryRows(
      harness,
      page,
      `SELECT journal.id AS journalId,
              journal.commit_id AS commitId,
              journal.project_id AS projectId,
              journal.before_json AS beforeJson,
              journal.after_json AS afterJson,
              journal.created_at AS createdAt
         FROM narrative_commit_journals journal
        WHERE journal.project_id = ?
        ORDER BY journal.commit_id, journal.id`,
      [projectId],
    ),
    queryRows(
      harness,
      page,
      `SELECT id AS entryId,
              project_id AS projectId,
              parent_id AS parentId,
              type,
              name,
              aliases,
              excluded_aliases AS excludedAliases,
              summary,
              content,
              icon,
              tags_cache AS tagsCache,
              context_mode AS contextMode,
              children_budget AS childrenBudget,
              source_chat_message_id AS sourceChatMessageId,
              notes,
              created_at AS createdAt,
              updated_at AS updatedAt
              ,version,
              readings
         FROM codex_entries
        WHERE project_id = ?
        ORDER BY id`,
      [projectId],
    ),
  ]);
  const runs = await readC2ZcRunLedger(harness, page, projectId, runRows);
  const unresolvedFindings = latestC2ZcFindingLifecycle(
    findingLifecycle,
    epochs,
  );
  const inboxFindings = activeC2ZcInboxEntries(inboxEntries);
  const pendingRuns = runs.filter(
    (run) =>
      C2ZC_SETTLING_RUN_KINDS.has(run.runKind) &&
      (run.status === "pending" || run.status === "running"),
  );
  const legacyProjection = {
    freshness: legacyFreshness,
    dependencies: legacyDependencies,
  };
  const latestVerifyRun = [...runs]
    .reverse()
    .find(
      (run) =>
        run.runKind === "dependency-verify" && run.status === "completed",
    );
  let verifyCoverage = null;
  let semanticIndexCounts = null;
  if (latestVerifyRun) {
    const verify = assertC2ZcVerifyCoverage(
      latestVerifyRun,
      "C2-ZC persisted Verify",
    );
    verifyCoverage = verify.checkCoverage;
    semanticIndexCounts = assertC2ZcSemanticIndexZero(
      latestVerifyRun,
      "C2-ZC persisted Verify Semantic Index",
    );
  }
  const feedRow = feedAndCursorRows[0] ?? {};
  return {
    projectId,
    marker: markerRows[0] ?? null,
    markerRows,
    epochs,
    runs,
    verifyRunId: latestVerifyRun?.id ?? null,
    verifyCoverage,
    semanticIndexCounts,
    genericRows,
    genericCount: genericRows.length,
    dependencyEdges,
    legacyProjection,
    legacyCount: legacyFreshness.length + legacyDependencies.length,
    findingLifecycle,
    findingObservations,
    unresolvedFindings,
    inboxEntries,
    inboxFindings,
    feedEvents,
    changeSets,
    typedArtifacts: {
      proposalSets,
      proposals,
      proposalRevisions,
      proposalDecisions,
      applyCommits,
      applyOperations,
      applications,
      commitJournals,
      codexEntries,
    },
    pendingRuns,
    feedAndCursor: {
      feedHead: Number(feedRow.feedHead ?? 0),
      cursor: {
        acknowledgedThrough:
          feedRow.acknowledgedThrough === null ||
          feedRow.acknowledgedThrough === undefined
            ? null
            : Number(feedRow.acknowledgedThrough),
        reservedThrough:
          feedRow.reservedThrough === null ||
          feedRow.reservedThrough === undefined
            ? null
            : Number(feedRow.reservedThrough),
        activeRunId: feedRow.activeRunId ?? null,
        semanticEpochId: feedRow.semanticEpochId ?? null,
        lastError: feedRow.lastError ?? null,
        cursorPresent: Number(feedRow.cursorPresent ?? 0) > 0,
      },
    },
    projectSettled:
      pendingRuns.length === 0 &&
      unresolvedFindings.length === 0 &&
      inboxFindings.length === 0,
  };
}

/**
 * Create one real post-marker Application through the existing typed
 * extraction/review/Apply route. This is intentionally a small Codex entry
 * mutation: it exercises the production Application writer and Change Feed
 * without adding a cutover/writer IPC or seeding authority tables from SQL.
 */
export async function createPostMarkerTypedApplication(
  harness,
  page,
  workspace,
  projectId,
) {
  const workspaceBinding = await harness.invokeOk(
    page,
    "narrative_extraction_capture_workspace_binding",
    { expectedWorkspacePath: workspace },
  );
  const runId = `c2-zc-post-marker-run-${randomUUID()}`;
  const taskId = `${runId}-task`;
  const snapshotDigest = sha256Canonical({
    kind: "c2-zc-post-marker-snapshot@1",
    runId,
  });
  const specJson = {
    kind: "c2-zc-post-marker-application@1",
    version: 1,
    projectId,
  };
  const createdRun = await harness.invokeOk(
    page,
    "narrative_extraction_create_run",
    {
      payload: {
        runId,
        projectId,
        surfacePathId: "c2-zc-post-marker-application",
        scopeJson: { projectId },
        specJson,
        specDigest: sha256Canonical(specJson),
        snapshotDigest,
        catalogDigest: null,
        registryDigest: null,
        coverageJson: null,
        tasks: [
          {
            taskId,
            taskKind: "c2-zc-post-marker-application",
            inputJson: { kind: "c2-zc-post-marker-source@1" },
            priority: 1,
          },
        ],
      },
      workspaceBinding,
    },
  );
  if (createdRun?.runId !== runId || createdRun?.status !== "running") {
    throw new Error(
      `C2-ZC post-marker typed Application Run was not created: ${JSON.stringify(createdRun)}`,
    );
  }
  const leaseOwner = `c2-zc-post-marker-journey:${randomUUID()}`;
  const claimed = await harness.invokeOk(
    page,
    "narrative_extraction_claim_task",
    {
      payload: {
        runId,
        projectId,
        leaseOwner,
        leaseDurationSecs: 60,
        taskKinds: ["c2-zc-post-marker-application"],
      },
      workspaceBinding,
    },
  );
  if (
    claimed?.claimed !== true ||
    claimed.task?.taskId !== taskId ||
    typeof claimed.task?.attemptId !== "string" ||
    claimed.task.attemptId.trim() === ""
  ) {
    throw new Error(
      `C2-ZC post-marker typed Application Task was not claimed: ${JSON.stringify(claimed)}`,
    );
  }
  const attemptId = claimed.task.attemptId;

  const proposalSetId = `${runId}-proposal-set`;
  const proposalId = `${runId}-proposal`;
  const entryId = `${runId}-entry`;
  const revisionEnvelope = {
    schemaVersion: 1,
    runId,
    taskId,
    reconcilerId: "c2-zc-post-marker-product-journey",
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
    readSet: [
      {
        inputRef: `snapshot:${runId}`,
        kind: "snapshot-document",
        sourceKind: "snapshot-document",
        revisionToken: snapshotDigest,
      },
    ],
    readSetDigest: sha256Canonical([
      {
        inputRef: `snapshot:${runId}`,
        kind: "snapshot-document",
        sourceKind: "snapshot-document",
        revisionToken: snapshotDigest,
      },
    ]),
    changeKind: "add",
  };
  const entryPayload = {
    entryId,
    typeSlug: "character",
    name: "C2-ZC post-marker acceptance entry",
    summary: "Typed post-marker mutation",
    aliases: [],
    parentId: null,
    content: '{"type":"doc","content":[]}',
    narrativeEntityId: `${runId}-entity`,
  };
  const savedSet = await harness.invokeOk(
    page,
    "narrative_extraction_save_proposal_set",
    {
      payload: {
        runId,
        projectId,
        proposalSetId,
        setKind: "c2-zc.post-marker.review@1",
        summaryJson: { kind: "c2-zc-post-marker-application@1" },
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
    typeof savedProposal?.revisionId !== "string" ||
    savedProposal.revisionId.trim() === ""
  ) {
    throw new Error(
      `C2-ZC post-marker typed ProposalSet was not persisted: ${JSON.stringify(savedSet)}`,
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
        planDigest: sha256Canonical({ runId, proposalId, revisionId }),
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
  if (
    typeof prepared?.preparedCommitId !== "string" ||
    prepared.preparedCommitId.trim() === ""
  ) {
    throw new Error(
      `C2-ZC post-marker typed Commit was not prepared: ${JSON.stringify(prepared)}`,
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
      `C2-ZC post-marker typed Commit did not apply: ${JSON.stringify(applied)}`,
    );
  }
  const applicationRows = await queryRows(
    harness,
    page,
    `SELECT id AS applicationId
       FROM narrative_proposal_applications
      WHERE commit_id = ? AND project_id = ?
      ORDER BY id`,
    [commitId, projectId],
  );
  if (
    applicationRows.length !== 1 ||
    typeof applicationRows[0]?.applicationId !== "string"
  ) {
    throw new Error(
      `C2-ZC post-marker typed Commit must create exactly one Application: ${JSON.stringify(applicationRows)}`,
    );
  }
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
          kind: "c2-zc-post-marker-application-completed@1",
          commitId,
          applicationId: applicationRows[0].applicationId,
        },
      },
      workspaceBinding,
    },
  );
  if (
    finished?.status !== "completed" ||
    finished.task?.id !== taskId ||
    finished.task?.status !== "completed"
  ) {
    throw new Error(
      `C2-ZC post-marker typed Application Task did not finish: ${JSON.stringify(finished)}`,
    );
  }
  return {
    projectId,
    runId,
    taskId,
    attemptId,
    leaseOwner,
    proposalSetId,
    proposalId,
    revisionId,
    entryId,
    commitId,
    applicationId: applicationRows[0].applicationId,
    snapshotDigest,
  };
}

async function waitForMarker(harness, page, projectId) {
  return harness.waitUntil(
    async () => {
      const snapshot = await readAuthoritySnapshot(harness, page, projectId);
      if (
        snapshot.markerRows.length !== 1 ||
        snapshot.epochs.length === 0 ||
        snapshot.projectSettled !== true
      ) {
        return null;
      }
      assertC2ZcMarkerExactlyOnce(snapshot);
      assertC2ZcFindingInboxEmpty(snapshot);
      assertC2ZcGenericRowsComplete(snapshot);
      assertC2ZcFeedCursorSettled(snapshot, {
        epochId: snapshot.epochs.at(-1)?.id,
      });
      return snapshot;
    },
    "C2-ZC canonical marker after main scheduler wake",
    C2ZC_WAIT_MS,
    250,
  );
}

async function waitForTwoProjectConvergenceGate(
  harness,
  page,
  primaryProjectId,
  secondaryProjectId,
) {
  let incompleteGate = null;
  await harness.waitUntil(
    async () => {
      const [primary, secondary] = await Promise.all([
        readAuthoritySnapshot(harness, page, primaryProjectId),
        readAuthoritySnapshot(harness, page, secondaryProjectId),
      ]);
      if (primary.markerRows.length !== 0) {
        throw new Error(
          "C2-ZC two-project gate observed the marker before its incomplete-cursor checkpoint",
        );
      }
      try {
        assertC2ZcTwoProjectConvergenceGate({
          primarySettled: primary,
          secondaryIncomplete: secondary,
          markerRowsWhileIncomplete: primary.markerRows,
        });
        incompleteGate = { primary, secondary };
        return incompleteGate;
      } catch {
        return null;
      }
    },
    "C2-ZC two-project incomplete-cursor checkpoint",
    C2ZC_WAIT_MS,
    250,
  );
  return incompleteGate;
}

function rows(value, label) {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function initialEpoch(epochs, label) {
  const value = rows(epochs, `${label} Epochs`);
  if (
    value.length !== 1 ||
    value[0]?.epochNumber !== 0 ||
    value[0]?.reason !== "initial" ||
    typeof value[0]?.id !== "string" ||
    value[0].id.trim() === ""
  ) {
    throw new Error(`${label} must contain exactly one initial epoch E0`);
  }
  parseInstant(value[0].createdAt, `${label} E0 createdAt`);
  return value[0];
}

function sameEpochLineage(before, after, label) {
  const left = rows(before, `${label} before Epochs`);
  const right = rows(after, `${label} after Epochs`);
  if (
    left.length !== right.length ||
    right.some(
      (epoch, index) =>
        epoch?.id !== left[index]?.id ||
        Number(epoch?.epochNumber) !== Number(left[index]?.epochNumber) ||
        epoch?.reason !== left[index]?.reason,
    )
  ) {
    throw new Error(`${label} changed the existing Semantic Epoch lineage`);
  }
  return right;
}

/** Validate the pre-cutover WAL-safe E0/B0 image and its real derived gap. */
export function assertC2ZcRestoreBackupFixture(
  snapshot,
  label = "C2-ZC pre-cutover backup",
) {
  if (!snapshot || typeof snapshot !== "object") {
    throw new Error(`${label} is not an object`);
  }
  if (snapshot.marker !== null) {
    throw new Error(
      `${label} pre-cutover backup must not contain the C2-ZC marker`,
    );
  }
  const e0 = initialEpoch(snapshot.epochs, label);
  const backfills = rows(
    snapshot.backfillRuns ?? (snapshot.backfill ? [snapshot.backfill] : []),
    `${label} Backfill Runs`,
  );
  const backfill =
    snapshot.backfill ?? (backfills.length === 1 ? backfills[0] : null);
  if (backfills.length !== 1 || !backfill) {
    throw new Error(
      `${label} must contain exactly one closed Task and Attempt`,
    );
  }
  if (
    backfill.runKind !== "backfill" ||
    backfill.workKey !== "legacy-dependency-backfill:v3" ||
    backfill.semanticEpochId !== e0.id ||
    backfill.status !== "completed" ||
    backfill.taskKind !== "maintenance-backfill" ||
    backfill.taskStatus !== "completed" ||
    backfill.lastAttemptStatus !== "completed" ||
    Number(backfill.taskCount) !== 1 ||
    Number(backfill.attemptCount) !== 1 ||
    Number(backfill.taskAttemptCount) !== 1 ||
    Number(backfill.lastAttemptNumber) !== 1 ||
    Number(backfill.maxAttemptNumber) !== 1 ||
    typeof backfill.id !== "string" ||
    backfill.id.trim() === "" ||
    (backfill.taskId !== undefined && !backfill.taskId) ||
    (backfill.attemptId !== undefined && !backfill.attemptId)
  ) {
    throw new Error(
      `${label} must contain exactly one closed Task and Attempt`,
    );
  }
  const expectedProjectId =
    snapshot.projectId ?? backfill.projectId ?? snapshot.edge?.projectId;
  if (
    typeof expectedProjectId !== "string" ||
    expectedProjectId.trim() === "" ||
    backfill.projectId !== expectedProjectId ||
    snapshot.edge?.projectId !== expectedProjectId
  ) {
    throw new Error(
      `${label} B0 and canonical Edge must belong to the same project`,
    );
  }
  const lifecycleFields = [
    "createdAt",
    "startedAt",
    "taskCreatedAt",
    "taskStartedAt",
    "lastAttemptStartedAt",
    "lastAttemptCompletedAt",
    "taskCompletedAt",
    "completedAt",
  ];
  for (const field of lifecycleFields) {
    parseInstant(backfill[field], `${label} B0 ${field}`);
  }
  for (let index = 1; index < lifecycleFields.length; index += 1) {
    if (
      compareInstants(
        backfill[lifecycleFields[index - 1]],
        backfill[lifecycleFields[index]],
      ) > 0
    ) {
      throw new Error(`${label} B0 lifecycle timestamps are not monotonic`);
    }
  }
  const edge = snapshot.edge;
  if (!edge || Number(snapshot.derivedState?.edgeCount) !== 1) {
    throw new Error(`${label} derived-state gap requires one canonical Edge`);
  }
  let readSetToken = snapshot.readSetToken;
  if (!readSetToken) {
    try {
      const readSet = JSON.parse(edge.readSetJson);
      readSetToken = Array.isArray(readSet) ? readSet[0] : null;
    } catch {
      readSetToken = null;
    }
  }
  assertRestoreFixtureEvidence([edge], {
    projectId: edge.projectId,
    edgeId: edge.id,
    consumerKey: edge.consumerKey,
    sourceObjectIdentity: edge.sourceObjectIdentity,
    owningRunId: edge.owningRunId,
    readSetToken,
  });
  if (
    Number(snapshot.derivedState?.edgeStateCount) !== 0 ||
    Number(snapshot.derivedState?.freshnessCount) !== 0
  ) {
    throw new Error(
      `${label} must preserve the canonical Edge while containing a derived-state gap`,
    );
  }
  const fixtureOperations = snapshot.fixtureOperations;
  if (
    !fixtureOperations ||
    typeof fixtureOperations !== "object" ||
    Array.isArray(fixtureOperations)
  ) {
    throw new Error(`${label} must bind its typed fixture operation receipts`);
  }
  assertExactKeys(
    fixtureOperations,
    ["edgeInsert", "gapDelete"],
    `${label} fixture operation binding`,
  );
  assertC2ZcFixtureOperationReceipt(
    fixtureOperations.edgeInsert,
    "dependency-edge-insert",
    {
      projectId: expectedProjectId,
      edgeId: edge.id,
      consumerKey: edge.consumerKey,
    },
    `${label} Dependency Edge insert`,
  );
  assertC2ZcFixtureOperationReceipt(
    fixtureOperations.gapDelete,
    "dependency-derived-state-gap-delete",
    {
      projectId: expectedProjectId,
      edgeId: edge.id,
      consumerKey: edge.consumerKey,
    },
    `${label} derived-state gap delete`,
  );
  return { e0, backfill, edge };
}

/** Validate disabled Settings restore: E0/B0 remain and only E1 is minted. */
export function assertC2ZcRestoreStageIsolation({
  setup,
  marker,
  beforeEpochs,
  afterEpochs,
  beforeRuns,
  afterRuns,
  label = "C2-ZC restore stage",
}) {
  if (setup !== "disabled") {
    throw new Error(`${label} must launch with maintenance setup disabled`);
  }
  if (marker !== null) {
    throw new Error(`${label} must not apply the C2-ZC marker during restore`);
  }
  const e0 = initialEpoch(beforeEpochs, `${label} before`);
  const after = rows(afterEpochs, `${label} after Epochs`);
  if (
    after.length !== 2 ||
    after[0]?.id !== e0.id ||
    Number(after[0]?.epochNumber) !== 0 ||
    after[1]?.reason !== "restore" ||
    Number(after[1]?.epochNumber) !== 1 ||
    typeof after[1]?.id !== "string" ||
    after[1].id === e0.id
  ) {
    throw new Error(
      `${label} must mint exactly E1(reason=restore) while retaining E0`,
    );
  }
  parseInstant(after[1].createdAt, `${label} E1 createdAt`);
  const priorRuns = rows(beforeRuns, `${label} before Runs`);
  const currentRuns = rows(afterRuns, `${label} after Runs`);
  const priorIds = new Set(priorRuns.map((run) => run.id));
  const freshFreshness = currentRuns.filter(
    (run) => !priorIds.has(run.id) && run.runKind === C2ZC_IDLE_RUN_KIND,
  );
  if (freshFreshness.length > 0) {
    throw new Error(`${label} must not run Freshness Runs during restore`);
  }
  const fresh = currentRuns.filter(
    (run) => !priorIds.has(run.id) && C2ZC_AUTOMATIC_RUN_KINDS.has(run.runKind),
  );
  if (fresh.length > 0) {
    throw new Error(`${label} must not run maintenance phases during restore`);
  }
  const b0 = priorRuns.find(
    (run) =>
      run.runKind === "backfill" &&
      run.workKey === "legacy-dependency-backfill:v3",
  );
  const retainedB0 = currentRuns.find((run) => run.id === b0?.id);
  if (
    !b0 ||
    !retainedB0 ||
    b0.semanticEpochId !== e0.id ||
    retainedB0.semanticEpochId !== e0.id
  ) {
    throw new Error(`${label} must retain the canonical B0 under E0`);
  }
  return after[1];
}

function parseObject(value, label) {
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch (error) {
      throw new Error(`${label} is not canonical JSON`, { cause: error });
    }
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return parsed;
}

function parseArray(value, label) {
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch (error) {
      throw new Error(`${label} is not canonical JSON`, { cause: error });
    }
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON array`);
  }
  return parsed;
}

// This is the JS counterpart of the shared Rust digest_plan seam: object keys
// are sorted recursively, arrays retain their order, and the UTF-8 JSON bytes
// are hashed with SHA-256. The idle descriptor contains only JSON-safe integer,
// boolean, and string values, so JSON.stringify has the same number spelling as
// serde_json for this contract.
function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256Canonical(value) {
  return `sha256:${createHash("sha256")
    .update(canonicalJson(value), "utf8")
    .digest("hex")}`;
}

function dependencySetSha256(sourceObjectIdentities) {
  const canonical = [...sourceObjectIdentities]
    .sort()
    .map((identity) => `${Buffer.byteLength(identity, "utf8")}:${identity}\n`)
    .join("");
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

function dependencyDigestMatchesExpected(value, identities) {
  if (typeof value !== "string" || !C2ZC_DEPENDENCY_SHA256_DIGEST.test(value)) {
    return false;
  }
  if (!identities) return true;
  const expected = dependencySetSha256(identities);
  return value === expected || value === `sha256:${expected}`;
}

// Incremental Freshness stores the Feed descriptor digest over the producer's
// insertion-order JSON (the Rust `digest_json` helper), unlike the sorted
// digest used by idle checkpoints and most contract snapshots.
function sha256Json(value) {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(value), "utf8")
    .digest("hex")}`;
}

function assertExactKeys(value, expected, label) {
  const actual = Object.keys(value).sort();
  const keys = [...expected].sort();
  if (
    actual.length !== keys.length ||
    actual.some((key, index) => key !== keys[index])
  ) {
    throw new Error(`${label} has unexpected keys`);
  }
}

function assertOutputMatchesRunOutcome(outputJson, outcome, label) {
  let output;
  try {
    output = parseObject(outputJson, `${label} outputJson`);
  } catch (error) {
    throw new Error(`${label} output JSON does not match Run outcome`, {
      cause: error,
    });
  }
  if (canonicalJson(output) !== canonicalJson(outcome)) {
    throw new Error(`${label} output JSON does not match Run outcome`);
  }
}

function parseCanonicalLifecycleInstant(value, label) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  ) {
    throw new Error(`${label} must be canonical RFC3339 milliseconds`);
  }
  return parseInstant(value, label);
}

function assertC2ZcIdleCheckpointRun(run, restoreEpochId, label) {
  if (
    run?.runKind !== C2ZC_IDLE_RUN_KIND ||
    run.status !== "completed" ||
    run.semanticEpochId !== restoreEpochId ||
    typeof run.id !== "string" ||
    run.id.trim() === ""
  ) {
    throw new Error(`${label} must be a completed current-E1 Freshness Run`);
  }
  if (run.projectId !== undefined && typeof run.projectId !== "string") {
    throw new Error(`${label} project binding is invalid`);
  }
  if (run.consumerId !== "narrative-incremental-freshness/v1") {
    throw new Error(
      `${label} consumerId must be narrative-incremental-freshness/v1`,
    );
  }

  const taskRows = Array.isArray(run.tasks) ? run.tasks : [];
  const task = taskRows[0];
  const attempts = Array.isArray(task?.attempts) ? task.attempts : [];
  const taskAttemptCount = Number(task?.attemptCount);
  if (
    taskRows.length !== 1 ||
    !task ||
    typeof task.id !== "string" ||
    task.id.trim() === "" ||
    (task.runId !== undefined && task.runId !== run.id) ||
    task.taskKind !== C2ZC_IDLE_TASK_KIND ||
    task.status !== "completed" ||
    run.taskKind !== task.taskKind ||
    run.taskStatus !== task.status ||
    Number(run.taskCount) !== taskRows.length ||
    Number(run.attemptCount) !== attempts.length ||
    Number(run.taskAttemptCount) !== taskAttemptCount ||
    !Number.isInteger(taskAttemptCount) ||
    taskAttemptCount < 1 ||
    taskAttemptCount > C2ZC_MAX_IDLE_ATTEMPTS ||
    taskAttemptCount !== attempts.length
  ) {
    throw new Error(`${label} Task/Attempt retry topology is invalid`);
  }
  if (task.inputJson !== undefined && task.inputJson !== run.taskInputJson) {
    throw new Error(`${label} Task/Attempt retry topology is invalid`);
  }

  const taskInput = parseObject(run.taskInputJson, `${label} Task input`);
  assertExactKeys(
    taskInput,
    [
      "kind",
      "version",
      "projectId",
      "semanticEpochId",
      "fromSequenceExclusive",
      "throughSequenceInclusive",
      "feedHead",
      "inputDigest",
    ],
    `${label} Task input`,
  );
  if (
    taskInput.kind !== C2ZC_IDLE_TASK_INPUT_KIND ||
    taskInput.version !== 1 ||
    taskInput.semanticEpochId !== restoreEpochId ||
    (run.projectId !== undefined && taskInput.projectId !== run.projectId) ||
    !Number.isSafeInteger(taskInput.feedHead) ||
    taskInput.feedHead < 0 ||
    taskInput.fromSequenceExclusive !== taskInput.feedHead ||
    taskInput.throughSequenceInclusive !== taskInput.feedHead ||
    !C2ZC_IDLE_HEX_DIGEST.test(taskInput.inputDigest)
  ) {
    throw new Error(
      `${label} Task input is not a tagged zero-width current-E1 checkpoint`,
    );
  }
  const taskInputPayload = { ...taskInput };
  delete taskInputPayload.inputDigest;
  if (sha256Canonical(taskInputPayload) !== taskInput.inputDigest) {
    throw new Error(
      `${label} Task input digest does not match its canonical payload`,
    );
  }

  const spec = parseObject(run.specJson, `${label} Run spec`);
  assertExactKeys(spec, ["kind", "inputDigest"], `${label} Run spec`);
  if (
    spec.kind !== C2ZC_IDLE_SPEC_KIND ||
    spec.inputDigest !== taskInput.inputDigest
  ) {
    throw new Error(`${label} Run spec is not bound to the idle Task input`);
  }
  if (!C2ZC_IDLE_HEX_DIGEST.test(run.specDigest ?? "")) {
    throw new Error(`${label} Run specDigest is not a canonical sha256 digest`);
  }
  if (sha256Canonical(spec) !== run.specDigest) {
    throw new Error(`${label} specDigest does not match its canonical spec`);
  }
  const expectedWorkKey =
    `incremental-freshness:${restoreEpochId}:${taskInput.fromSequenceExclusive}:` +
    `${taskInput.throughSequenceInclusive}:${taskInput.inputDigest.slice("sha256:".length)}`;
  if (run.workKey !== expectedWorkKey) {
    throw new Error(`${label} work_key is not bound to the idle Task input`);
  }

  const outcome = parseObject(run.outcomeSummaryJson, `${label} Run outcome`);
  assertExactKeys(
    outcome,
    [
      "kind",
      "version",
      "projectId",
      "runId",
      "fromSequenceExclusive",
      "throughSequenceInclusive",
      "affectedEdgeCount",
      "affectedConsumerCount",
      "hasMore",
    ],
    `${label} Run outcome`,
  );
  if (
    outcome.kind !== C2ZC_IDLE_TASK_INPUT_KIND ||
    outcome.version !== 1 ||
    outcome.projectId !== taskInput.projectId ||
    outcome.runId !== run.id ||
    outcome.fromSequenceExclusive !== taskInput.fromSequenceExclusive ||
    outcome.throughSequenceInclusive !== taskInput.throughSequenceInclusive ||
    outcome.affectedEdgeCount !== 0 ||
    outcome.affectedConsumerCount !== 0 ||
    outcome.hasMore !== false
  ) {
    throw new Error(`${label} outcome is not a zero-width idle checkpoint`);
  }
  assertOutputMatchesRunOutcome(task.outputJson, outcome, `${label} Task`);

  let lifecycle;
  try {
    lifecycle = {
      runCreatedAt: parseCanonicalLifecycleInstant(
        run.createdAt,
        `${label} Run.createdAt`,
      ),
      runStartedAt: parseCanonicalLifecycleInstant(
        run.startedAt,
        `${label} Run.startedAt`,
      ),
      taskCreatedAt: parseCanonicalLifecycleInstant(
        run.taskCreatedAt,
        `${label} Task.createdAt`,
      ),
      taskStartedAt: parseCanonicalLifecycleInstant(
        run.taskStartedAt,
        `${label} Task.startedAt`,
      ),
      attemptStartedAt: parseCanonicalLifecycleInstant(
        run.lastAttemptStartedAt,
        `${label} Attempt.startedAt`,
      ),
      attemptCompletedAt: parseCanonicalLifecycleInstant(
        run.lastAttemptCompletedAt,
        `${label} Attempt.completedAt`,
      ),
      taskCompletedAt: parseCanonicalLifecycleInstant(
        run.taskCompletedAt,
        `${label} Task.completedAt`,
      ),
      runCompletedAt: parseCanonicalLifecycleInstant(
        run.completedAt,
        `${label} Run.completedAt`,
      ),
      taskDetailCreatedAt: parseCanonicalLifecycleInstant(
        task.createdAt,
        `${label} Task.createdAt detail`,
      ),
      taskDetailStartedAt: parseCanonicalLifecycleInstant(
        task.startedAt,
        `${label} Task.startedAt detail`,
      ),
      taskDetailCompletedAt: parseCanonicalLifecycleInstant(
        task.completedAt,
        `${label} Task.completedAt detail`,
      ),
    };
  } catch (error) {
    throw new Error(
      `${label} Task/Attempt lifecycle temporal envelope is invalid`,
      {
        cause: error,
      },
    );
  }
  if (
    compareInstants(lifecycle.taskCreatedAt, lifecycle.taskDetailCreatedAt) !==
      0 ||
    compareInstants(lifecycle.taskStartedAt, lifecycle.taskDetailStartedAt) !==
      0 ||
    compareInstants(
      lifecycle.taskCompletedAt,
      lifecycle.taskDetailCompletedAt,
    ) !== 0
  ) {
    throw new Error(
      `${label} Task/Attempt lifecycle temporal envelope is invalid`,
    );
  }
  const orderedLifecycle = [
    ["Run.createdAt", lifecycle.runCreatedAt],
    ["Run.startedAt", lifecycle.runStartedAt],
    ["Task.createdAt", lifecycle.taskCreatedAt],
    ["Task.startedAt", lifecycle.taskStartedAt],
    ["Attempt.startedAt", lifecycle.attemptStartedAt],
    ["Attempt.completedAt", lifecycle.attemptCompletedAt],
    ["Task.completedAt", lifecycle.taskCompletedAt],
    ["Run.completedAt", lifecycle.runCompletedAt],
  ];
  for (let index = 1; index < orderedLifecycle.length; index += 1) {
    if (
      compareInstants(
        orderedLifecycle[index - 1][1],
        orderedLifecycle[index][1],
      ) > 0
    ) {
      throw new Error(
        `${label} Task/Attempt lifecycle temporal envelope is invalid`,
      );
    }
  }

  const attemptIds = new Set();
  let previousStartedAt = lifecycle.taskStartedAt;
  let previousCompletedAt = null;
  let completedAttemptIndex = -1;
  for (const [index, attempt] of attempts.entries()) {
    if (
      typeof attempt?.id !== "string" ||
      attempt.id.trim() === "" ||
      attemptIds.has(attempt.id) ||
      (attempt.taskId !== undefined && attempt.taskId !== task.id) ||
      Number(attempt.attemptNumber) !== index + 1 ||
      !["failed", "completed"].includes(attempt.status)
    ) {
      throw new Error(`${label} Task/Attempt retry topology is invalid`);
    }
    attemptIds.add(attempt.id);
    let startedAt;
    let completedAt;
    try {
      startedAt = parseCanonicalLifecycleInstant(
        attempt.startedAt,
        `${label} Attempt ${index + 1}.startedAt`,
      );
      completedAt = parseCanonicalLifecycleInstant(
        attempt.completedAt,
        `${label} Attempt ${index + 1}.completedAt`,
      );
    } catch (error) {
      throw new Error(
        `${label} Task/Attempt lifecycle temporal envelope is invalid`,
        {
          cause: error,
        },
      );
    }
    if (
      compareInstants(startedAt, previousStartedAt) < 0 ||
      (previousCompletedAt &&
        compareInstants(startedAt, previousCompletedAt) < 0) ||
      compareInstants(completedAt, startedAt) < 0
    ) {
      throw new Error(`${label} Task/Attempt retry topology is invalid`);
    }
    if (attempt.status === "failed") {
      if (attempt.outputJson !== null) {
        throw new Error(
          `${label} Task/Attempt retry topology is invalid: failed Attempt outputJson must be NULL`,
        );
      }
      let nextAttemptAt;
      try {
        nextAttemptAt = parseCanonicalLifecycleInstant(
          attempt.nextAttemptAt,
          `${label} Attempt ${index + 1}.nextAttemptAt`,
        );
      } catch (error) {
        throw new Error(`${label} Task/Attempt retry topology is invalid`, {
          cause: error,
        });
      }
      if (
        typeof attempt.failureCode !== "string" ||
        !attempt.failureCode.startsWith("NEX_") ||
        attempt.retryDisposition !== "retryable" ||
        attempt.policyVersion !== "v1" ||
        compareInstants(nextAttemptAt, completedAt) < 0
      ) {
        throw new Error(`${label} Task/Attempt retry topology is invalid`);
      }
      if (completedAttemptIndex >= 0) {
        throw new Error(`${label} Task/Attempt retry topology is invalid`);
      }
    } else {
      if (
        attempt.failureCode != null ||
        attempt.retryDisposition != null ||
        attempt.policyVersion != null ||
        attempt.nextAttemptAt != null
      ) {
        throw new Error(`${label} Task/Attempt retry topology is invalid`);
      }
      if (completedAttemptIndex >= 0) {
        throw new Error(`${label} Task/Attempt retry topology is invalid`);
      }
      completedAttemptIndex = index;
    }
    previousStartedAt = startedAt;
    previousCompletedAt = completedAt;
  }
  if (
    completedAttemptIndex !== attempts.length - 1 ||
    compareInstants(lifecycle.taskCompletedAt, previousCompletedAt) < 0
  ) {
    throw new Error(`${label} Task/Attempt retry topology is invalid`);
  }
  const finalAttempt = attempts.at(-1);
  assertOutputMatchesRunOutcome(
    finalAttempt.outputJson,
    outcome,
    `${label} final Attempt`,
  );
  if (
    Number(run.lastAttemptNumber) !== finalAttempt.attemptNumber ||
    Number(run.maxAttemptNumber) !== finalAttempt.attemptNumber ||
    run.lastAttemptStatus !== finalAttempt.status ||
    compareInstants(run.lastAttemptStartedAt, finalAttempt.startedAt) !== 0 ||
    compareInstants(run.lastAttemptCompletedAt, finalAttempt.completedAt) !== 0
  ) {
    throw new Error(`${label} Task/Attempt retry topology is invalid`);
  }
  return run;
}

/** Validate the exact V/R/V -> one current-E1 idle Freshness -> marker order. */
export function assertC2ZcOpenTotalOrder({
  markerBefore,
  markerAfter,
  beforeEpochs,
  afterEpochs,
  beforeRuns,
  afterRuns,
  phaseRuns,
  idleRun,
  restoreEpochId,
  label = "C2-ZC normal open",
}) {
  const phases = assertC2ZcOpenPhaseTimeline({
    markerBefore,
    markerAfter,
    beforeEpochs,
    afterEpochs,
    beforeRuns,
    afterRuns,
    phaseRuns,
    restoreEpochId,
    label,
  });
  const priorIds = new Set(
    rows(beforeRuns, `${label} before Runs`).map((run) => run.id),
  );
  const current = rows(afterRuns, `${label} after Runs`).filter(
    (run) => !priorIds.has(run.id),
  );
  const freshnessRuns = current.filter(
    (run) => run.runKind === C2ZC_IDLE_RUN_KIND,
  );
  if (freshnessRuns.length !== 1) {
    throw new Error(
      `${label} must contain exactly one post-baseline Freshness Run`,
    );
  }
  const observedIdle = freshnessRuns[0];
  if (observedIdle.semanticEpochId !== restoreEpochId) {
    throw new Error(
      `${label} sole post-baseline Freshness Run must be bound to current E1`,
    );
  }
  if (idleRun && observedIdle.id !== idleRun.id) {
    throw new Error(
      `${label} idle Freshness identity does not match the observed Run`,
    );
  }
  const validatedIdle = assertC2ZcIdleCheckpointRun(
    observedIdle,
    restoreEpochId,
    `${label} idle Freshness`,
  );
  if (phases.length !== C2ZC_PHASE_RUN_KINDS.length) {
    throw new Error(
      `${label} maintenance phase rows must remain exactly Verify -> Rebuild -> Verify`,
    );
  }
  if (compareInstants(phases[2].completedAt, validatedIdle.createdAt) >= 0) {
    throw new Error(
      `${label} idle Freshness must start after confirmation Verify completedAt`,
    );
  }
  const markerAppliedAt = parseInstant(
    markerAfter.appliedAt,
    `${label} marker appliedAt`,
  );
  const idleLifecycleFields = [
    "createdAt",
    "startedAt",
    "taskCreatedAt",
    "taskStartedAt",
    "lastAttemptStartedAt",
    "lastAttemptCompletedAt",
    "taskCompletedAt",
    "completedAt",
  ];
  for (const field of idleLifecycleFields) {
    if (
      compareInstants(
        markerAppliedAt,
        parseInstant(validatedIdle[field], `${label} idle Freshness ${field}`),
      ) < 0
    ) {
      throw new Error(
        `${label} marker must be after idle Task/Attempt lifecycle`,
      );
    }
  }
  if (compareInstants(markerAppliedAt, validatedIdle.completedAt) < 0) {
    throw new Error(
      `${label} marker must be applied after idle Freshness completedAt`,
    );
  }
  return { phaseRuns: phases, idleRun: validatedIdle };
}

/** Validate exact current-E1 Verify -> Rebuild -> confirmation Verify. */
export function assertC2ZcOpenPhaseTimeline({
  markerBefore,
  markerAfter,
  beforeEpochs,
  afterEpochs,
  beforeRuns,
  afterRuns,
  phaseRuns,
  restoreEpochId,
  label = "C2-ZC normal open",
}) {
  if (markerBefore !== null) {
    throw new Error(`${label} must begin before the C2-ZC marker is applied`);
  }
  if (
    markerAfter?.migrationId !== C2ZC_CUTOVER_MIGRATION_ID ||
    Number(markerAfter?.contractVersion) !== C2ZC_CUTOVER_CONTRACT_VERSION
  ) {
    throw new Error(`${label} did not observe the v1 C2-ZC marker`);
  }
  const markerAppliedAt = parseInstant(
    markerAfter.appliedAt,
    `${label} marker appliedAt`,
  );
  const before = rows(beforeEpochs, `${label} before Epochs`);
  const after = rows(afterEpochs, `${label} after Epochs`);
  if (before.length !== 2 || after.length !== 2) {
    throw new Error(`${label} must retain exactly E0 and E1`);
  }
  sameEpochLineage(before, after, label);
  if (
    !after.find(
      (epoch) => epoch.id === restoreEpochId && epoch.reason === "restore",
    )
  ) {
    throw new Error(`${label} is not bound to the current restore E1`);
  }
  const restoreEpoch = after.find((epoch) => epoch.id === restoreEpochId);
  const restoreCreatedAt = parseInstant(
    restoreEpoch.createdAt,
    `${label} E1 createdAt`,
  );
  const phases = rows(phaseRuns, `${label} phase Runs`);
  if (phases.length !== C2ZC_PHASE_RUN_KINDS.length) {
    throw new Error(
      `${label} must contain exactly current-E1 Verify/Rebuild/Verify`,
    );
  }
  const ids = new Set();
  let previousCreatedAt = null;
  let previousCompletedAt = null;
  for (const [index, run] of phases.entries()) {
    if (run.runKind !== C2ZC_PHASE_RUN_KINDS[index]) {
      throw new Error(
        `${label} phase order must be Verify -> Rebuild -> confirmation Verify`,
      );
    }
    if (
      typeof run.id !== "string" ||
      run.id.trim() === "" ||
      ids.has(run.id) ||
      run.status !== "completed" ||
      run.semanticEpochId !== restoreEpochId
    ) {
      throw new Error(
        `${label} phase Runs must be unique, completed, and bound to E1`,
      );
    }
    ids.add(run.id);
    const createdAt = parseInstant(
      run.createdAt,
      `${label} phase ${index + 1} createdAt`,
    );
    const completedAt = parseInstant(
      run.completedAt,
      `${label} phase ${index + 1} completedAt`,
    );
    if (
      compareInstants(createdAt, completedAt) >= 0 ||
      compareInstants(createdAt, restoreCreatedAt) < 0
    ) {
      throw new Error(`${label} phase timestamps are invalid for E1`);
    }
    if (
      previousCreatedAt &&
      (compareInstants(createdAt, previousCreatedAt) <= 0 ||
        compareInstants(createdAt, previousCompletedAt) <= 0 ||
        compareInstants(completedAt, previousCompletedAt) <= 0)
    ) {
      throw new Error(
        `${label} phase timestamps must be strict and non-overlapping`,
      );
    }
    previousCreatedAt = createdAt;
    previousCompletedAt = completedAt;
  }
  const priorIds = new Set(
    rows(beforeRuns, `${label} before Runs`).map((run) => run.id),
  );
  const current = rows(afterRuns, `${label} after Runs`);
  if (
    current.some(
      (run) =>
        run.runKind === "backfill" && run.semanticEpochId === restoreEpochId,
    )
  ) {
    throw new Error(`${label} must not mint an E1 Backfill`);
  }
  const fresh = current.filter(
    (run) => !priorIds.has(run.id) && C2ZC_AUTOMATIC_RUN_KINDS.has(run.runKind),
  );
  if (fresh.length !== phases.length || fresh.some((run) => !ids.has(run.id))) {
    throw new Error(
      `${label} must add exactly the three current-E1 phase Runs`,
    );
  }
  if (
    compareInstants(
      markerAppliedAt,
      phases[2].completedAt,
      `${label} marker appliedAt`,
      `${label} confirmation Verify completedAt`,
    ) <= 0
  ) {
    throw new Error(
      `${label} marker must be applied after confirmation Verify completedAt`,
    );
  }
  return phases;
}

function assertC2ZcRestartPhaseRows(phaseRuns, restoreEpoch, label) {
  const phases = rows(phaseRuns, `${label} phase Runs`);
  if (phases.length !== C2ZC_PHASE_RUN_KINDS.length) {
    throw new Error(
      `${label} must preserve exactly Verify -> Rebuild -> Verify`,
    );
  }
  const epochCreatedAt = parseInstant(
    restoreEpoch.createdAt,
    `${label} E1 createdAt`,
  );
  const ids = new Set();
  let previousCreatedAt = null;
  let previousCompletedAt = null;
  for (const [index, run] of phases.entries()) {
    if (
      run.runKind !== C2ZC_PHASE_RUN_KINDS[index] ||
      typeof run.id !== "string" ||
      run.id.trim() === "" ||
      ids.has(run.id) ||
      run.status !== "completed" ||
      run.semanticEpochId !== restoreEpoch.id ||
      typeof run.workKey !== "string" ||
      run.workKey.trim() === ""
    ) {
      throw new Error(`${label} persisted phase Run contract is invalid`);
    }
    ids.add(run.id);
    const createdAt = parseInstant(
      run.createdAt,
      `${label} phase ${index + 1} createdAt`,
    );
    const completedAt = parseInstant(
      run.completedAt,
      `${label} phase ${index + 1} completedAt`,
    );
    if (
      compareInstants(createdAt, epochCreatedAt) < 0 ||
      compareInstants(createdAt, completedAt) >= 0 ||
      (previousCreatedAt &&
        (compareInstants(createdAt, previousCreatedAt) <= 0 ||
          compareInstants(createdAt, previousCompletedAt) <= 0 ||
          compareInstants(completedAt, previousCompletedAt) <= 0))
    ) {
      throw new Error(`${label} persisted phase Run timestamps are invalid`);
    }
    previousCreatedAt = createdAt;
    previousCompletedAt = completedAt;
  }
  return phases;
}

function normalizeC2ZcRunContract(run) {
  const fields = [
    "id",
    "runKind",
    "projectId",
    "workKey",
    "status",
    "semanticEpochId",
    "consumerId",
    "surfacePathId",
    "scopeJson",
    "createdAt",
    "startedAt",
    "completedAt",
    "specJson",
    "specDigest",
    "snapshotDigest",
    "coverageJson",
    "outcomeSummaryJson",
    "terminalReasonCode",
    "catalogDigest",
    "registryDigest",
    "version",
    "supersededByRunId",
    "requestId",
    "idempotencyDomain",
    "requestPayloadDigest",
    "actorId",
    "taskKind",
    "taskStatus",
    "taskCount",
    "attemptCount",
    "taskAttemptCount",
    "lastAttemptStatus",
    "lastAttemptNumber",
    "maxAttemptNumber",
    "taskInputJson",
    "taskCreatedAt",
    "taskStartedAt",
    "taskCompletedAt",
    "lastAttemptStartedAt",
    "lastAttemptCompletedAt",
  ];
  const normalized = Object.fromEntries(
    fields.map((field) => [
      field,
      c2zcJsonColumn(field)
        ? normalizeC2ZcJsonValue(run?.[field] ?? null)
        : (run?.[field] ?? null),
    ]),
  );
  normalized.tasks = Array.isArray(run?.tasks)
    ? [...run.tasks]
        .map((task) => ({
          id: task?.id ?? null,
          runId: task?.runId ?? null,
          taskKind: task?.taskKind ?? null,
          status: task?.status ?? null,
          attemptCount: task?.attemptCount ?? null,
          priority: task?.priority ?? null,
          leaseOwner: task?.leaseOwner ?? null,
          leaseExpiresAt: task?.leaseExpiresAt ?? null,
          heartbeatAt: task?.heartbeatAt ?? null,
          errorMessage: task?.errorMessage ?? null,
          inputJson: normalizeC2ZcJsonValue(task?.inputJson ?? null),
          outputJson: normalizeC2ZcJsonValue(task?.outputJson ?? null),
          createdAt: task?.createdAt ?? null,
          startedAt: task?.startedAt ?? null,
          completedAt: task?.completedAt ?? null,
          version: task?.version ?? null,
          attempts: Array.isArray(task?.attempts)
            ? [...task.attempts]
                .map((attempt) => ({
                  id: attempt?.id ?? null,
                  taskId: attempt?.taskId ?? null,
                  attemptNumber: attempt?.attemptNumber ?? null,
                  status: attempt?.status ?? null,
                  startedAt: attempt?.startedAt ?? null,
                  completedAt: attempt?.completedAt ?? null,
                  errorMessage: attempt?.errorMessage ?? null,
                  outputJson: normalizeC2ZcJsonValue(
                    attempt?.outputJson ?? null,
                  ),
                  failureCode: attempt?.failureCode ?? null,
                  retryDisposition: attempt?.retryDisposition ?? null,
                  policyVersion: attempt?.policyVersion ?? null,
                  nextAttemptAt: attempt?.nextAttemptAt ?? null,
                }))
                .sort(compareC2ZcIdentityRows)
            : null,
        }))
        .sort(compareC2ZcIdentityRows)
    : null;
  return normalized;
}

const C2ZC_TYPED_ARTIFACT_ARRAYS = Object.freeze([
  "proposalSets",
  "proposals",
  "proposalRevisions",
  "proposalDecisions",
  "applyCommits",
  "applyOperations",
  "applications",
  "commitJournals",
  "codexEntries",
]);

/**
 * Normalize durable JSON columns without discarding any row or nullable
 * value.  Restart comparisons use this representation so SQLite's JSON text
 * key order cannot hide a changed typed artifact, while every non-JSON
 * column, including timestamps and linkage IDs, remains exact.
 */
function normalizeC2ZcTypedRow(row) {
  if (!row || typeof row !== "object" || Array.isArray(row)) return row;
  return Object.fromEntries(
    Object.entries(row)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => {
        return [
          key,
          c2zcJsonColumn(key) ? normalizeC2ZcJsonValue(value) : value,
        ];
      }),
  );
}

function c2zcJsonColumn(key) {
  return (
    typeof key === "string" &&
    (key.endsWith("Json") ||
      key === "aliases" ||
      key === "excludedAliases" ||
      key === "tagsCache" ||
      key === "readings")
  );
}

function normalizeC2ZcJsonValue(value) {
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      // Keep malformed JSON as text; the contract validator reports the
      // corruption instead of allowing normalization to erase it.
      return value;
    }
  }
  if (Array.isArray(parsed)) return parsed.map(normalizeC2ZcJsonValue);
  if (parsed !== null && typeof parsed === "object") {
    return Object.fromEntries(
      Object.entries(parsed)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, normalizeC2ZcJsonValue(child)]),
    );
  }
  return parsed;
}

function compareC2ZcIdentityRows(left, right) {
  const identityFields = [
    "id",
    "edgeId",
    "changeSetId",
    "eventId",
    "proposalSetId",
    "proposalId",
    "revisionId",
    "decisionId",
    "commitId",
    "operationId",
    "applicationId",
    "journalId",
    "entryId",
    "runId",
    "consumerKind",
    "consumerKey",
    "sourceObjectIdentity",
    "findingIdentity",
    "observedAt",
    "canonicalSequence",
    "eventOrdinal",
  ];
  const identity = (row) =>
    identityFields.map((field) => String(row?.[field] ?? "")).join("\u0000");
  const leftIdentity = identity(left);
  const rightIdentity = identity(right);
  return leftIdentity.localeCompare(rightIdentity);
}

function sortedC2ZcRows(value) {
  if (!Array.isArray(value)) return value ?? null;
  return [...value].map(normalizeC2ZcTypedRow).sort(compareC2ZcIdentityRows);
}

/**
 * Normalize every durable post-marker row used by the restart proof.  JSON
 * text is parsed and object keys are canonicalized, while arrays are sorted
 * by stable row identity; lifecycle timestamps and digest strings remain
 * exact values.  This is an equality ledger, not a projection or a count.
 */
export function normalizeC2ZcPostMarkerLedger(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return snapshot ?? null;
  const typed = snapshot.typedArtifacts ?? {};
  return {
    marker: normalizeC2ZcTypedRow(snapshot.marker),
    markerRows: sortedC2ZcRows(snapshot.markerRows),
    epochs: sortedC2ZcRows(snapshot.epochs),
    runs: Array.isArray(snapshot.runs)
      ? [...snapshot.runs]
          .map(normalizeC2ZcRunContract)
          .sort(compareC2ZcIdentityRows)
      : (snapshot.runs ?? null),
    genericRows: sortedC2ZcRows(snapshot.genericRows),
    dependencyEdges: sortedC2ZcRows(snapshot.dependencyEdges),
    legacyProjection:
      snapshot.legacyProjection && typeof snapshot.legacyProjection === "object"
        ? {
            freshness: sortedC2ZcRows(snapshot.legacyProjection.freshness),
            dependencies: sortedC2ZcRows(
              snapshot.legacyProjection.dependencies,
            ),
          }
        : (snapshot.legacyProjection ?? null),
    findingLifecycle: sortedC2ZcRows(snapshot.findingLifecycle),
    findingObservations: sortedC2ZcRows(snapshot.findingObservations),
    inboxEntries: sortedC2ZcRows(snapshot.inboxEntries),
    unresolvedFindings: sortedC2ZcRows(snapshot.unresolvedFindings),
    inboxFindings: sortedC2ZcRows(snapshot.inboxFindings),
    feedAndCursor: normalizeC2ZcTypedRow(snapshot.feedAndCursor),
    feedEvents: sortedC2ZcRows(snapshot.feedEvents),
    changeSets: sortedC2ZcRows(snapshot.changeSets),
    typedArtifacts: Object.fromEntries(
      C2ZC_TYPED_ARTIFACT_ARRAYS.map((name) => [
        name,
        sortedC2ZcRows(typed[name]),
      ]),
    ),
    pendingRuns: sortedC2ZcRows(snapshot.pendingRuns),
    projectSettled: snapshot.projectSettled ?? null,
  };
}

/**
 * Require the complete typed writer artifact graph for one post-marker
 * Application.  This is intentionally stronger than checking Run/Task
 * counts: each durable row is selected by its stable identity and all
 * proposal/review/prepare/apply/entry/feed links are checked.
 */
export function assertC2ZcTypedArtifactSnapshot(
  snapshot,
  application,
  label = "C2-ZC typed Application artifacts",
) {
  if (
    !application ||
    typeof application !== "object" ||
    [
      "projectId",
      "runId",
      "taskId",
      "attemptId",
      "proposalSetId",
      "proposalId",
      "revisionId",
      "entryId",
      "commitId",
      "applicationId",
    ].some(
      (field) =>
        typeof application[field] !== "string" ||
        application[field].trim() === "",
    )
  ) {
    throw new Error(`${label} application identity is missing`);
  }
  const typed = snapshot?.typedArtifacts;
  if (!typed || typeof typed !== "object" || Array.isArray(typed)) {
    throw new Error(`${label} complete typed artifact snapshot is missing`);
  }
  const arrays = Object.fromEntries(
    C2ZC_TYPED_ARTIFACT_ARRAYS.map((name) => {
      const value = typed[name];
      if (!Array.isArray(value)) {
        throw new Error(`${label}.${name} must be an array`);
      }
      return [name, value.map(normalizeC2ZcTypedRow)];
    }),
  );
  const findExactly = (name, predicate, identity) => {
    const matches = arrays[name].filter(predicate);
    if (matches.length !== 1) {
      throw new Error(
        `${label} requires exactly one ${name} row for ${identity}; found ${matches.length}`,
      );
    }
    return matches[0];
  };
  const proposalSet = findExactly(
    "proposalSets",
    (row) => row.proposalSetId === application.proposalSetId,
    application.proposalSetId,
  );
  if (
    proposalSet.runId !== application.runId ||
    proposalSet.projectId !== application.projectId ||
    proposalSet.status !== "draft" ||
    proposalSet.setKind !== "c2-zc.post-marker.review@1"
  ) {
    throw new Error(`${label} ProposalSet binding/status is invalid`);
  }
  const proposal = findExactly(
    "proposals",
    (row) => row.proposalId === application.proposalId,
    application.proposalId,
  );
  if (
    proposal.proposalSetId !== application.proposalSetId ||
    proposal.kind !== "codex.entry.create" ||
    proposal.status !== "approved" ||
    proposal.currentRevisionId !== application.revisionId
  ) {
    throw new Error(`${label} Proposal binding/status is invalid`);
  }
  const revision = findExactly(
    "proposalRevisions",
    (row) => row.revisionId === application.revisionId,
    application.revisionId,
  );
  if (
    revision.proposalId !== application.proposalId ||
    Number(revision.revisionNumber) !== 1 ||
    !["enveloped", "legacy-unbound"].includes(revision.originKind) ||
    revision.createdBy !== "system" ||
    typeof revision.reconciliationEnvelopeDigest !== "string"
  ) {
    throw new Error(`${label} Proposal revision binding is invalid`);
  }
  const decision = findExactly(
    "proposalDecisions",
    (row) =>
      row.proposalId === application.proposalId &&
      row.revisionId === application.revisionId,
    application.proposalId,
  );
  if (
    decision.decision !== "approved" ||
    decision.createdBy !== "c2-zc-product-journey" ||
    decision.actorKind !== "human"
  ) {
    throw new Error(`${label} human decision is invalid`);
  }
  const commit = findExactly(
    "applyCommits",
    (row) => row.commitId === application.commitId,
    application.commitId,
  );
  if (
    commit.projectId !== application.projectId ||
    commit.runId !== application.runId ||
    commit.proposalSetId !== application.proposalSetId ||
    commit.requestId !== `${application.runId}-apply-request` ||
    commit.status !== "applied" ||
    typeof commit.planDigest !== "string" ||
    typeof commit.preparedPlanJson !== "object" ||
    commit.preparedPolicyVersion === null ||
    typeof commit.authorityDigest !== "string" ||
    commit.sessionId !== C2ZC_PRODUCT_JOURNEY_ID
  ) {
    throw new Error(`${label} prepared/applied Commit binding is invalid`);
  }
  const operation = findExactly(
    "applyOperations",
    (row) => row.commitId === application.commitId,
    application.commitId,
  );
  if (
    Number(operation.operationIndex) !== 0 ||
    operation.operationKind !== "codex.entry.create" ||
    operation.resultEntityKind !== "codex_entry" ||
    operation.resultEntityId !== application.entryId ||
    operation.status !== "applied"
  ) {
    throw new Error(`${label} applied operation binding is invalid`);
  }
  const appliedApplication = findExactly(
    "applications",
    (row) => row.applicationId === application.applicationId,
    application.applicationId,
  );
  if (
    appliedApplication.commitId !== application.commitId ||
    appliedApplication.proposalId !== application.proposalId ||
    appliedApplication.revisionId !== application.revisionId ||
    appliedApplication.appliedEntityKind !== "codex_entry" ||
    appliedApplication.appliedEntityId !== application.entryId ||
    appliedApplication.applicationKind !== "normal" ||
    appliedApplication.compensatesApplicationId !== null
  ) {
    throw new Error(`${label} Application linkage is invalid`);
  }
  const journal = findExactly(
    "commitJournals",
    (row) => row.commitId === application.commitId,
    application.commitId,
  );
  if (
    journal.projectId !== application.projectId ||
    journal.beforeJson !== null ||
    !journal.afterJson
  ) {
    throw new Error(`${label} Commit journal is incomplete`);
  }
  const entry = findExactly(
    "codexEntries",
    (row) => row.entryId === application.entryId,
    application.entryId,
  );
  if (
    entry.projectId !== application.projectId ||
    typeof entry.name !== "string" ||
    entry.name.trim() === "" ||
    typeof entry.content !== "string"
  ) {
    throw new Error(`${label} Codex entry binding is invalid`);
  }
  const matchingFeedEvents = rows(
    snapshot?.feedEvents,
    `${label} Feed events`,
  ).filter((event) =>
    parseArray(
      event.applicationIdsJson ?? "[]",
      `${label} Feed application IDs`,
    ).includes(application.applicationId),
  );
  if (matchingFeedEvents.length !== 1) {
    throw new Error(`${label} must bind exactly one Feed event to Application`);
  }
  const matchingChangeSets = rows(
    snapshot?.changeSets,
    `${label} Change Sets`,
  ).filter(
    (changeSet) =>
      changeSet.projectId === application.projectId &&
      parseArray(
        changeSet.eventIdsJson,
        `${label} Change Set event IDs`,
      ).includes(matchingFeedEvents[0].eventId),
  );
  if (matchingChangeSets.length !== 1) {
    throw new Error(
      `${label} must bind the Application Feed event to one Change Set`,
    );
  }
  return {
    ...arrays,
    feedEvents: [normalizeC2ZcTypedRow(matchingFeedEvents[0])],
    changeSets: [normalizeC2ZcTypedRow(matchingChangeSets[0])],
  };
}

/** Validate marker, epoch, and phase Run identity across restart. */
export function assertC2ZcRestartInvariants({
  open,
  restart,
  phaseRunIds,
  idleRunId,
  baselineRuns = [],
  label = "C2-ZC restart",
}) {
  const left = open?.marker;
  const right = restart?.marker;
  if (
    left?.migrationId !== C2ZC_CUTOVER_MIGRATION_ID ||
    Number(left?.contractVersion) !== C2ZC_CUTOVER_CONTRACT_VERSION ||
    right?.migrationId !== left.migrationId ||
    Number(right?.contractVersion) !== Number(left.contractVersion) ||
    right?.appliedAt !== left.appliedAt
  ) {
    throw new Error(`${label} changed marker appliedAt/version across restart`);
  }
  parseInstant(left.appliedAt, `${label} marker appliedAt`);
  const openEpochs = rows(open?.epochs, `${label} open Epochs`);
  const restartEpochs = rows(restart?.epochs, `${label} restart Epochs`);
  if (openEpochs.length !== 2 || restartEpochs.length !== 2) {
    throw new Error(
      `${label} must preserve E0 and E1 without minting a new epoch`,
    );
  }
  sameEpochLineage(openEpochs, restartEpochs, label);
  const ids = rows(phaseRunIds, `${label} phase Run IDs`);
  if (new Set(ids).size !== ids.length)
    throw new Error(`${label} phase Run IDs must be unique`);
  const openRuns = rows(open?.runs, `${label} open Runs`);
  const restartRuns = rows(restart?.runs, `${label} restart Runs`);
  const openIds = new Set(
    openRuns
      .filter((run) => C2ZC_AUTOMATIC_RUN_KINDS.has(run.runKind))
      .map((run) => run.id),
  );
  const restartIds = new Set(
    restartRuns
      .filter((run) => C2ZC_AUTOMATIC_RUN_KINDS.has(run.runKind))
      .map((run) => run.id),
  );
  if (
    openIds.size !== restartIds.size ||
    [...openIds].some((id) => !restartIds.has(id)) ||
    ids.some((id) => !openIds.has(id) || !restartIds.has(id))
  ) {
    throw new Error(
      `${label} did not preserve phase Run IDs without rerunning them`,
    );
  }
  const baselineIds = new Set(
    rows(baselineRuns, `${label} baseline Runs`).map((run) => run.id),
  );
  const openFreshnessIds = new Set(
    openRuns
      .filter(
        (run) => run.runKind === C2ZC_IDLE_RUN_KIND && !baselineIds.has(run.id),
      )
      .map((run) => run.id),
  );
  const restartFreshnessIds = new Set(
    restartRuns
      .filter(
        (run) => run.runKind === C2ZC_IDLE_RUN_KIND && !baselineIds.has(run.id),
      )
      .map((run) => run.id),
  );
  if (
    openFreshnessIds.size !== 1 ||
    restartFreshnessIds.size !== 1 ||
    [...openFreshnessIds].some((id) => !restartFreshnessIds.has(id))
  ) {
    throw new Error(
      `${label} post-baseline Freshness Run identities changed across restart`,
    );
  }
  if (typeof idleRunId !== "string" || idleRunId.trim() === "") {
    throw new Error(`${label} requires the current-E1 idle Freshness Run ID`);
  }
  const openIdle = openRuns.filter((run) => run.id === idleRunId);
  const restartIdle = restartRuns.filter((run) => run.id === idleRunId);
  if (
    openIdle.length !== 1 ||
    restartIdle.length !== 1 ||
    openIdle[0]?.runKind !== C2ZC_IDLE_RUN_KIND ||
    restartIdle[0]?.runKind !== C2ZC_IDLE_RUN_KIND ||
    openIdle[0]?.semanticEpochId !== restartEpochs[1]?.id ||
    restartIdle[0]?.semanticEpochId !== restartEpochs[1]?.id
  ) {
    throw new Error(
      `${label} did not preserve the current-E1 idle Freshness Run ID`,
    );
  }
  const openIdleIds = new Set(
    openRuns
      .filter(
        (run) =>
          run.runKind === C2ZC_IDLE_RUN_KIND &&
          run.semanticEpochId === restartEpochs[1]?.id,
      )
      .map((run) => run.id),
  );
  const restartIdleIds = new Set(
    restartRuns
      .filter(
        (run) =>
          run.runKind === C2ZC_IDLE_RUN_KIND &&
          run.semanticEpochId === restartEpochs[1]?.id,
      )
      .map((run) => run.id),
  );
  if (
    openIdleIds.size !== 1 ||
    restartIdleIds.size !== 1 ||
    [...openIdleIds].some((id) => !restartIdleIds.has(id))
  ) {
    throw new Error(
      `${label} reran or minted a second current-E1 idle Freshness Run`,
    );
  }
  const restartPhaseRuns = ids.map((id) =>
    restartRuns.find((run) => run.id === id),
  );
  assertC2ZcRestartPhaseRows(
    restartPhaseRuns,
    restartEpochs[1],
    `${label} restart`,
  );
  const restartIdleRun = restartIdle[0];
  assertC2ZcIdleCheckpointRun(
    restartIdleRun,
    restartEpochs[1].id,
    `${label} restart idle Freshness`,
  );
  for (const id of [...ids, idleRunId]) {
    const openRun = openRuns.find((run) => run.id === id);
    const restartRun = restartRuns.find((run) => run.id === id);
    if (
      !openRun ||
      !restartRun ||
      canonicalJson(normalizeC2ZcRunContract(openRun)) !==
        canonicalJson(normalizeC2ZcRunContract(restartRun))
    ) {
      throw new Error(
        `${label} persisted Run contract changed across restart for ${id}`,
      );
    }
  }
  if (
    restartRuns.some(
      (run) =>
        run.runKind === "backfill" &&
        run.semanticEpochId === restartEpochs[1].id,
    )
  ) {
    throw new Error(`${label} minted an E1 Backfill during restart`);
  }
  return restart;
}

/** Validate direct post-marker project_create birth. */
export function assertC2ZcPostMarkerProjectBirth({
  marker,
  epochs,
  label = "C2-ZC post-marker project",
}) {
  if (
    marker?.migrationId !== C2ZC_CUTOVER_MIGRATION_ID ||
    Number(marker?.contractVersion) !== C2ZC_CUTOVER_CONTRACT_VERSION
  ) {
    throw new Error(
      `${label} requires the applied v1 C2-ZC marker and exactly one initial epoch`,
    );
  }
  parseInstant(marker.appliedAt, `${label} marker appliedAt`);
  return initialEpoch(epochs, label);
}

/**
 * Bind the post-marker typed Application, its producer evidence, and the
 * restart boundary into one acceptance contract.  The compatibility
 * projection is compared as complete row/value snapshots; a count-only
 * observation is deliberately insufficient.
 */
export function assertC2ZcPostMarkerRestartInvariants({
  beforeMutation,
  afterMutation,
  restart,
  application,
  label = "C2-ZC post-marker Application",
}) {
  if (!application || typeof application.applicationId !== "string") {
    throw new Error(`${label} is missing the typed Application identity`);
  }
  for (const [phase, snapshot] of [
    ["before mutation", beforeMutation],
    ["after mutation", afterMutation],
    ["restart", restart],
  ]) {
    assertC2ZcMarkerExactlyOnce(snapshot, `${label} ${phase} marker`);
    assertC2ZcFindingInboxEmpty(snapshot, `${label} ${phase} Findings/Inbox`);
    assertC2ZcPostMarkerProjectSettled(snapshot, `${label} ${phase}`);
    assertC2ZcFeedCursorSettled(
      snapshot,
      { epochId: snapshot.epochs[0]?.id },
      `${label} ${phase} Change Feed cursor`,
    );
  }
  if (
    canonicalJson(beforeMutation.markerRows) !==
      canonicalJson(afterMutation.markerRows) ||
    canonicalJson(afterMutation.markerRows) !==
      canonicalJson(restart.markerRows) ||
    canonicalJson(beforeMutation.epochs) !==
      canonicalJson(afterMutation.epochs) ||
    canonicalJson(afterMutation.epochs) !== canonicalJson(restart.epochs) ||
    beforeMutation.epochs.length !== 1 ||
    afterMutation.epochs.length !== 1 ||
    restart.epochs.length !== 1
  ) {
    throw new Error(`${label} changed marker or Semantic Epoch continuity`);
  }
  assertC2ZcLegacyProjectionStable(
    beforeMutation.legacyProjection,
    afterMutation.legacyProjection,
    `${label} changed Legacy projection after the typed mutation`,
  );
  assertC2ZcLegacyProjectionStable(
    afterMutation.legacyProjection,
    restart.legacyProjection,
    `${label} changed Legacy projection across restart`,
  );
  if (
    afterMutation.genericRows.length !== 1 ||
    restart.genericRows.length !== 1
  ) {
    throw new Error(`${label} must expose exactly one complete Generic row`);
  }
  assertC2ZcGenericFreshnessStorage(
    afterMutation,
    {
      projectId: application.projectId,
      applicationId: application.applicationId,
      epochId: afterMutation.epochs[0].id,
    },
    `${label} after mutation Generic storage/provenance`,
  );
  assertC2ZcGenericFreshnessStorage(
    restart,
    {
      projectId: application.projectId,
      applicationId: application.applicationId,
      epochId: restart.epochs[0].id,
    },
    `${label} restart Generic storage/provenance`,
  );
  assertC2ZcTypedArtifactSnapshot(
    afterMutation,
    application,
    `${label} after mutation typed artifacts`,
  );
  assertC2ZcTypedArtifactSnapshot(
    restart,
    application,
    `${label} restart typed artifacts`,
  );
  if (
    canonicalJson(normalizeC2ZcPostMarkerLedger(afterMutation)) !==
    canonicalJson(normalizeC2ZcPostMarkerLedger(restart))
  ) {
    throw new Error(
      `${label} normalized durable ledger changed across restart`,
    );
  }
  for (const [phase, snapshot] of [
    ["after mutation", afterMutation],
    ["restart", restart],
  ]) {
    const run = rows(snapshot.runs, `${label} ${phase} Runs`).find(
      (candidate) => candidate.id === application.runId,
    );
    if (!run || run.status !== "completed") {
      throw new Error(
        `${label} ${phase} did not retain the completed typed producer Run`,
      );
    }
    const task = rows(run.tasks, `${label} ${phase} typed Run tasks`).find(
      (candidate) => candidate.id === application.taskId,
    );
    if (
      !task ||
      task.status !== "completed" ||
      rows(task.attempts, `${label} ${phase} typed Run attempts`).length !==
        1 ||
      task.attempts[0]?.id !== application.attemptId ||
      task.attempts[0]?.status !== "completed"
    ) {
      throw new Error(
        `${label} ${phase} typed Task/Attempt is not durably complete`,
      );
    }
  }
  return restart;
}

/**
 * Exercise the production Settings restore, normal scheduler open, restart,
 * and direct post-marker project_create. No cutover IPC or marker write is
 * available to this runner; those remain main/N-API production ownership.
 */
export async function runC2ZcCanonicalAuthorityJourney(
  harness,
  configureWorkspace,
) {
  let restoreSnapshot = null;
  let openSnapshot = null;
  let projectId = null;
  let secondaryProjectId = null;
  let primaryTypedFeedMutation = null;
  let primaryBeforeHoldSnapshot = null;
  let secondaryBeforeHoldSnapshot = null;
  let heldTwoProjectGate = null;
  let openBeforeRuns = null;
  let openBeforeEpochs = null;
  let openPhaseRuns = null;
  let markerPersistenceRestartEvidence = null;
  const scenario = await runRestoreVerifyRebuildVerifyScenario(
    harness,
    configureWorkspace,
    {
      id: C2ZC_PRODUCT_JOURNEY_ID,
      restorePhase: "restore",
      openPhase: "open",
      restartPhase: "restart",
      restoreEnvironment: {
        setup: "disabled",
        freshness: "disabled",
      },
      // The secondary project is created by the typed project_create route
      // during the setup-disabled restore phase. Resolve the hold only after
      // that durable identity exists; the helper masks it again for restart.
      openEnvironment: async () => {
        if (!secondaryProjectId) {
          throw new Error(
            "C2-ZC Freshness hold cannot resolve before the secondary project exists",
          );
        }
        return { freshnessHoldProjectId: secondaryProjectId };
      },
      restoreThroughSettingsUi: restoreBackupThroughSettingsUi,
      onFixture: ({ fixtureEvidence }) => {
        assertC2ZcRestoreBackupFixture(fixtureEvidence.backupContract);
        harness.recordTimeline("c2-zc-pre-cutover-backup-ready", {
          projectId: fixtureEvidence.backupContract.projectId,
          epochIds: fixtureEvidence.backupContract.epochs.map(
            (epoch) => epoch.id,
          ),
          backfillRunId: fixtureEvidence.backupContract.backfill?.id,
          edgeId: fixtureEvidence.backupContract.edge?.id,
          derivedState: fixtureEvidence.backupContract.derivedState,
          fixtureOperations: fixtureEvidence.backupContract.fixtureOperations,
        });
      },
      onRestore: async ({ context, setup, beforeRuns, beforeEpochs }) => {
        const observed = await readAuthoritySnapshot(
          harness,
          context.page,
          context.projectId,
        );
        const e1 = assertC2ZcRestoreStageIsolation({
          setup,
          marker: observed.marker,
          beforeEpochs,
          afterEpochs: observed.epochs,
          beforeRuns,
          afterRuns: observed.runs,
        });
        assertC2ZcFindingInboxEmpty(observed, "C2-ZC restore stage");
        assertC2ZcGenericRowsComplete(observed, "C2-ZC restore stage");
        projectId = context.projectId;
        primaryTypedFeedMutation = await createPrimaryTypedFeedMutation(
          harness,
          context.page,
          projectId,
        );
        primaryBeforeHoldSnapshot = await readAuthoritySnapshot(
          harness,
          context.page,
          projectId,
        );
        if (
          primaryBeforeHoldSnapshot.feedAndCursor.feedHead <
          primaryTypedFeedMutation.canonicalSequence
        ) {
          throw new Error(
            "C2-ZC primary typed mutation did not become a durable Feed head",
          );
        }
        restoreSnapshot = {
          marker: observed.marker,
          markerRows: observed.markerRows,
          epochs: observed.epochs,
          runs: observed.runs,
          verifyRunId: observed.verifyRunId,
          verifyCoverage: observed.verifyCoverage,
          semanticIndexCounts: observed.semanticIndexCounts,
          genericRows: observed.genericRows,
          genericCount: observed.genericCount,
          legacyProjection: observed.legacyProjection,
          legacyCount: observed.legacyCount,
          findingLifecycle: observed.findingLifecycle,
          unresolvedFindings: observed.unresolvedFindings,
          inboxEntries: observed.inboxEntries,
          inboxFindings: observed.inboxFindings,
          pendingRuns: observed.pendingRuns,
          feedAndCursor: observed.feedAndCursor,
          projectSettled: observed.projectSettled,
        };
        // Create a second project while the setup-disabled restore document is
        // still open. Its typed project-create event is therefore present
        // before the normal scheduler starts, giving the main Freshness owner
        // a real two-project gate to cross (A can settle while B remains
        // cursor-incomplete; the marker must still be absent).
        secondaryProjectId = await createProjectAfterCutover(
          harness,
          context.page,
          context.workspace,
          {
            title: "C2-ZC two-project incomplete-cursor project",
          },
        );
        secondaryBeforeHoldSnapshot = await readAuthoritySnapshot(
          harness,
          context.page,
          secondaryProjectId,
        );
        if (secondaryBeforeHoldSnapshot.epochs.length !== 0) {
          throw new Error(
            "C2-ZC secondary project_create must remain epochless before normal maintenance",
          );
        }
        assertC2ZcProjectCreateFeedEvidence(
          secondaryBeforeHoldSnapshot,
          { projectId: secondaryProjectId, requireUnacked: true },
          "C2-ZC post-create secondary project_create",
        );
        assertC2ZcNoIncrementalFreshnessWrites(
          secondaryBeforeHoldSnapshot,
          "C2-ZC post-create secondary",
        );
        assertC2ZcNoFreshnessCursorWrite(
          secondaryBeforeHoldSnapshot,
          "C2-ZC post-create secondary",
        );
        context.record("c2-zc-restore-stage-isolated", {
          setup,
          epochIds: observed.epochs.map((epoch) => epoch.id),
          restoreEpochId: e1.id,
          marker: observed.marker,
          runIds: observed.runs.map((run) => run.id),
        });
      },
      onOpen: async ({
        context,
        beforeRuns,
        beforeEpochs,
        phaseRuns,
        openLaunch,
      }) => {
        if (
          !secondaryProjectId ||
          !secondaryBeforeHoldSnapshot ||
          !primaryTypedFeedMutation ||
          !primaryBeforeHoldSnapshot
        ) {
          throw new Error("C2-ZC two-project hold fixture is missing");
        }
        // Project B is born during the setup-disabled restore, so its normal
        // project_create path intentionally has no Semantic Epoch. Let the
        // ordinary maintenance owner create the initial Epoch and complete
        // Backfill -> Verify -> Rebuild -> confirmation Verify before asking
        // the Freshness owner to hold B.
        await harness.waitUntil(
          async () => {
            const value = await readAuthoritySnapshot(
              harness,
              context.page,
              secondaryProjectId,
            );
            try {
              return assertC2ZcSecondaryMaintenanceReadiness({
                projectId: secondaryProjectId,
                afterCreate: secondaryBeforeHoldSnapshot,
                atHold: value,
                label: "C2-ZC secondary normal maintenance",
              });
            } catch {
              return null;
            }
          },
          "C2-ZC secondary normal maintenance readiness",
          C2ZC_WAIT_MS,
          250,
        );
        const binding = await harness.invokeOk(
          context.page,
          "narrative_extraction_capture_workspace_binding",
          { expectedWorkspacePath: context.workspace },
        );
        if (
          !binding ||
          typeof binding.authorityId !== "string" ||
          !Number.isSafeInteger(binding.generation) ||
          binding.generation <= 0
        ) {
          throw new Error(
            "C2-ZC hold gate received an invalid workspace binding",
          );
        }
        // This is the causal checkpoint: native has actually selected B,
        // performed the ordinary cutover attempt, and returned NOT_READY. A
        // merely absent marker or an idle DB snapshot cannot satisfy it.
        const heldReceipt = await harness.awaitQuiescence(
          openLaunch.app,
          `${C2ZC_PRODUCT_JOURNEY_ID}/open-held-quiescence`,
          {
            previousSequence:
              openLaunch.quiescenceArtifact?.receipt.sequence ?? 0,
            requestNonce: randomUUID(),
            authorityId: binding.authorityId,
            generation: binding.generation,
          },
        );
        const held = heldReceipt.receipt;
        if (
          held.freshness.heldProjectId !== secondaryProjectId ||
          held.freshness.cutoverNotReady !== true ||
          held.freshness.noWrite !== true ||
          held.state.freshnessHoldProjectId !== secondaryProjectId ||
          held.state.heldProjectId !== secondaryProjectId ||
          held.state.marker !== null
        ) {
          throw new Error(
            "C2-ZC hold receipt did not prove the held secondary NOT_READY cycle",
          );
        }
        const heldProjects = new Map(
          held.state.projects.map((project) => [project.projectId, project]),
        );
        const heldPrimary = heldProjects.get(context.projectId);
        const heldSecondary = heldProjects.get(secondaryProjectId);
        if (!heldPrimary || !heldSecondary) {
          throw new Error(
            "C2-ZC hold receipt did not include both workspace projects",
          );
        }
        const cursorIsSettled = (project) =>
          project.cursor.acknowledgedThrough === project.feedHead &&
          project.cursor.activeRunId === null &&
          project.cursor.reservedThrough === null &&
          project.cursor.semanticEpochId === null &&
          project.cursor.lastError === null;
        if (cursorIsSettled(heldSecondary)) {
          throw new Error(
            "C2-ZC hold receipt incorrectly reported the secondary cursor as settled",
          );
        }
        if (!cursorIsSettled(heldPrimary)) {
          throw new Error(
            "C2-ZC hold receipt did not show the primary project settled before the held candidate",
          );
        }
        const secondaryDuringHold = await readAuthoritySnapshot(
          harness,
          context.page,
          secondaryProjectId,
        );
        assertC2ZcSecondaryMaintenanceReadiness({
          projectId: secondaryProjectId,
          afterCreate: secondaryBeforeHoldSnapshot,
          atHold: secondaryDuringHold,
          label: "C2-ZC held secondary maintenance",
        });
        const primaryDuringHold = await readAuthoritySnapshot(
          harness,
          context.page,
          context.projectId,
        );
        assertC2ZcProjectCreateFeedEvidence(
          secondaryBeforeHoldSnapshot,
          { projectId: secondaryProjectId, requireUnacked: true },
          "C2-ZC held B project_create",
        );
        const causalHold = assertC2ZcCausalHoldEvidence({
          primarySnapshot: primaryDuringHold,
          secondaryBeforeHold: secondaryBeforeHoldSnapshot,
          secondaryDuringHold,
          heldReceipt,
          primaryProjectId: context.projectId,
          secondaryProjectId,
          primaryEventId: primaryTypedFeedMutation.eventId,
          primaryEpochId: primaryBeforeHoldSnapshot.epochs.at(-1)?.id,
          verifyRuns: phaseRuns.filter(
            (run) => run.runKind === "dependency-verify",
          ),
          label: "C2-ZC causal A/B hold",
        });
        if (primaryDuringHold.markerRows.length !== 0) {
          throw new Error(
            "C2-ZC hold gate observed a marker before every project converged",
          );
        }
        if (
          primaryDuringHold.epochs.length !== 2 ||
          primaryDuringHold.epochs.at(-1)?.id !==
            primaryBeforeHoldSnapshot.epochs.at(-1)?.id ||
          primaryDuringHold.feedAndCursor.feedHead <
            primaryTypedFeedMutation.canonicalSequence
        ) {
          throw new Error(
            "C2-ZC hold receipt did not show primary A at current restore Epoch with its typed Feed head",
          );
        }
        assertC2ZcFeedCursorSettled(
          primaryDuringHold,
          { epochId: primaryDuringHold.epochs.at(-1)?.id },
          "C2-ZC held primary current-Epoch cursor",
        );
        assertC2ZcNonIdleFreshnessProducer(
          primaryDuringHold,
          {
            projectId: context.projectId,
            epochId: primaryDuringHold.epochs.at(-1)?.id,
            eventId: primaryTypedFeedMutation.eventId,
          },
          "C2-ZC held primary current-Epoch Freshness producer",
        );
        if (primaryDuringHold.projectSettled !== true) {
          throw new Error(
            "C2-ZC held primary project is not fully settled/readiness-clean",
          );
        }
        assertC2ZcProjectCreateFeedEvidence(
          secondaryDuringHold,
          { projectId: secondaryProjectId, requireUnacked: true },
          "C2-ZC held B project_create during hold",
        );
        assertC2ZcFindingInboxEmpty(
          primaryDuringHold,
          "C2-ZC pre-marker primary Findings/Inbox",
        );
        assertC2ZcGenericRowsComplete(
          primaryDuringHold,
          "C2-ZC pre-marker primary Generic",
        );
        assertC2ZcLegacyProjectionStable(
          restoreSnapshot.legacyProjection,
          primaryDuringHold.legacyProjection,
          "C2-ZC restore-to-hold Legacy projection",
        );
        const verifyRuns = phaseRuns.filter(
          (run) => run.runKind === "dependency-verify",
        );
        if (verifyRuns.length !== 2) {
          throw new Error("C2-ZC open must retain both production Verify Runs");
        }
        for (const [index, verifyRun] of verifyRuns.entries()) {
          assertC2ZcVerifyCoverage(verifyRun, `C2-ZC open Verify ${index + 1}`);
          assertC2ZcSemanticIndexZero(
            verifyRun,
            `C2-ZC open Verify ${index + 1} Semantic Index`,
          );
        }
        const incompleteGate = await waitForTwoProjectConvergenceGate(
          harness,
          context.page,
          context.projectId,
          secondaryProjectId,
        );
        heldTwoProjectGate = incompleteGate;
        context.record("c2-zc-two-project-cursor-gate", {
          primaryProjectId: context.projectId,
          secondaryProjectId,
          holdReceipt: heldReceipt.receipt,
          holdReceiptSha256: heldReceipt.sha256,
          causalPrimaryFeedEventId: causalHold.primaryEvent.eventId,
          causalSecondaryFeedEventIds: causalHold.secondaryEvents.map(
            (event) => event.eventId,
          ),
          markerRowsWhileIncomplete: incompleteGate.primary.markerRows,
          primaryFeedAndCursor: incompleteGate.primary.feedAndCursor,
          secondaryFeedAndCursor: incompleteGate.secondary.feedAndCursor,
        });
        openBeforeRuns = beforeRuns;
        openBeforeEpochs = beforeEpochs;
        openPhaseRuns = phaseRuns;
      },
      onRestart: async ({ context }) => {
        // The shared scenario invokes this production launch with an empty
        // environment transaction, which actively masks the hold and all
        // other seam variables before spawning Electron.
        const markerSnapshot = await waitForMarker(
          harness,
          context.page,
          context.projectId,
        );
        const runs = await readC2ZcRunLedger(
          harness,
          context.page,
          context.projectId,
          await context.runs(),
        );
        const epochs = await context.epochs();
        assertC2ZcMarkerExactlyOnce(markerSnapshot, "C2-ZC restart marker");
        assertC2ZcFindingInboxEmpty(
          markerSnapshot,
          "C2-ZC restart Findings/Inbox",
        );
        assertC2ZcGenericRowsComplete(markerSnapshot, "C2-ZC restart Generic");
        assertC2ZcFeedCursorSettled(
          markerSnapshot,
          {
            epochId: epochs.at(-1)?.id,
          },
          "C2-ZC restart Change Feed cursor",
        );
        const verifyRuns = openPhaseRuns.filter(
          (run) => run.runKind === "dependency-verify",
        );
        for (const [index, verifyRun] of verifyRuns.entries()) {
          assertC2ZcVerifyCoverage(
            verifyRun,
            `C2-ZC restart Verify ${index + 1}`,
          );
          assertC2ZcSemanticIndexZero(
            verifyRun,
            `C2-ZC restart Verify ${index + 1} Semantic Index`,
          );
        }
        if (
          verifyRuns.length !== 2 ||
          markerSnapshot.verifyRunId !== verifyRuns.at(-1)?.id ||
          canonicalJson(markerSnapshot.semanticIndexCounts) !==
            canonicalJson(C2ZC_SEMANTIC_INDEX_ZERO_COUNTS)
        ) {
          throw new Error(
            "C2-ZC restart snapshot is missing the final Verify authority evidence",
          );
        }
        const secondaryConverged = await harness.waitUntil(
          async () => {
            const value = await readAuthoritySnapshot(
              harness,
              context.page,
              secondaryProjectId,
            );
            if (value.markerRows.length !== 1) return null;
            try {
              assertC2ZcMarkerExactlyOnce(
                value,
                "C2-ZC two-project converged secondary marker",
              );
              assertC2ZcFindingInboxEmpty(
                value,
                "C2-ZC two-project converged secondary Findings/Inbox",
              );
              assertC2ZcPostMarkerProjectSettled(
                value,
                "C2-ZC two-project converged secondary project",
              );
              assertC2ZcFeedCursorSettled(
                value,
                { epochId: value.epochs.at(-1)?.id },
                "C2-ZC two-project converged secondary cursor",
              );
              assertC2ZcProjectCreateFeedEvidence(
                value,
                { projectId: secondaryProjectId, requireUnacked: false },
                "C2-ZC two-project converged secondary project_create",
              );
              return value;
            } catch {
              return null;
            }
          },
          "C2-ZC two-project secondary convergence",
          C2ZC_WAIT_MS,
          250,
        );
        if (!openPhaseRuns || !openBeforeRuns || !openBeforeEpochs) {
          throw new Error("C2-ZC open phase evidence was not retained");
        }
        // The marker is only checked after the held receipt was observed,
        // the hold was masked by the restart launch, and B actually settled.
        if (!heldTwoProjectGate) {
          throw new Error("C2-ZC held two-project gate was not retained");
        }
        assertC2ZcTwoProjectConvergenceGate({
          primarySettled: heldTwoProjectGate.primary,
          secondaryIncomplete: heldTwoProjectGate.secondary,
          markerRowsWhileIncomplete: [],
          convergedPrimary: markerSnapshot,
          convergedSecondary: secondaryConverged,
          label: "C2-ZC two-project convergence gate",
        });
        assertC2ZcLegacyProjectionStable(
          restoreSnapshot.legacyProjection,
          markerSnapshot.legacyProjection,
          "C2-ZC restore-to-marker Legacy projection",
        );
        const totalOrder = assertC2ZcOpenTotalOrder({
          markerBefore: restoreSnapshot.marker,
          markerAfter: markerSnapshot.marker,
          beforeEpochs: openBeforeEpochs,
          afterEpochs: epochs,
          beforeRuns: openBeforeRuns,
          afterRuns: runs,
          phaseRuns: openPhaseRuns,
          restoreEpochId: restoreSnapshot.epochs[1].id,
        });
        const beforeRuns = openBeforeRuns;
        openSnapshot = {
          ...markerSnapshot,
          beforeRuns,
          phaseRuns: totalOrder.phaseRuns,
          idleRun: totalOrder.idleRun,
        };
        context.record("c2-zc-canonical-authority-activated", {
          marker: markerSnapshot.marker,
          epochIds: epochs.map((epoch) => epoch.id),
          phaseRunIds: totalOrder.phaseRuns.map((run) => run.id),
          idleRunId: totalOrder.idleRun.id,
          genericCount: markerSnapshot.genericCount,
          legacyCount: markerSnapshot.legacyCount,
          electronEvidenceScope: {
            owner: "Electron main plus typed N-API Freshness routes",
            canonicalRead: "composed later by the shared Rust receipt",
          },
          rustCanonicalReadContract:
            C2ZC_CANONICAL_FRESHNESS_CONTRACT.rustReceiptComposition,
        });
        context.record("c2-zc-canonical-authority-marker-created", {
          marker: markerSnapshot.marker,
          epochIds: epochs.map((epoch) => epoch.id),
          phaseRunIds: openSnapshot.phaseRuns.map((run) => run.id),
          idleRunId: openSnapshot.idleRun.id,
        });
      },
    },
  );
  if (!projectId || !restoreSnapshot || !openSnapshot || !scenario.restart) {
    throw new Error(
      "C2-ZC shared restore scenario did not complete all authority phases",
    );
  }

  // The split scenario's first restart is where the held secondary project
  // converges and the shared marker is created.  Keep one additional masked
  // production launch at that boundary so the Legacy projection is compared
  // against a genuinely subsequent restart, rather than comparing two
  // snapshots collected during the same process lifetime.
  const markerPersistencePhase = `${C2ZC_PRODUCT_JOURNEY_ID}/restart-persistence`;
  let markerPersistenceLaunch = await withLaunchEnvironmentForTest(
    { ownerToken: NARRATIVE_MAINTENANCE_OWNER_TOKEN },
    () => harness.launch(markerPersistencePhase),
  );
  let markerPersistenceSnapshot;
  try {
    markerPersistenceSnapshot = await harness.waitUntil(
      async () => {
        const value = await readAuthoritySnapshot(
          harness,
          markerPersistenceLaunch.page,
          projectId,
        );
        if (
          value.markerRows.length !== 1 ||
          value.epochs.length !== 2 ||
          value.projectSettled !== true
        ) {
          return null;
        }
        try {
          assertC2ZcMarkerExactlyOnce(
            value,
            "C2-ZC marker persistence restart",
          );
          assertC2ZcFindingInboxEmpty(
            value,
            "C2-ZC marker persistence restart Findings/Inbox",
          );
          assertC2ZcGenericRowsComplete(
            value,
            "C2-ZC marker persistence restart Generic",
          );
          assertC2ZcFeedCursorSettled(
            value,
            { epochId: value.epochs.at(-1)?.id },
            "C2-ZC marker persistence restart Change Feed cursor",
          );
          assertC2ZcLegacyProjectionStable(
            openSnapshot.legacyProjection,
            value.legacyProjection,
            "C2-ZC marker persistence restart Legacy projection",
          );
          assertC2ZcRestartInvariants({
            open: openSnapshot,
            restart: {
              marker: value.marker,
              epochs: value.epochs,
              runs: value.runs,
            },
            phaseRunIds: openSnapshot.phaseRuns.map((run) => run.id),
            idleRunId: openSnapshot.idleRun.id,
            baselineRuns: openSnapshot.beforeRuns,
            label: "C2-ZC marker persistence restart",
          });
          return value;
        } catch {
          return null;
        }
      },
      "C2-ZC marker persistence restart",
      C2ZC_WAIT_MS,
      250,
    );
    const launchReceipt = markerPersistenceLaunch.launchReceipt;
    const receiptArtifact = {
      path: launchReceipt?.path ?? null,
      realPath: launchReceipt?.realPath ?? null,
      sha256: launchReceipt?.sha256 ?? null,
    };
    const launchEvidence = {
      phase: markerPersistencePhase,
      launchId: markerPersistenceLaunch.launchId,
      receipt: launchReceipt?.receipt ?? null,
      receiptNonce: launchReceipt?.receipt?.nonce ?? null,
      receiptSha256: launchReceipt?.sha256 ?? null,
      receiptArtifact,
      realpathSha256Binding: receiptArtifact,
      marker: markerPersistenceSnapshot.marker,
      legacyProjectionDigest: sha256Canonical(
        markerPersistenceSnapshot.legacyProjection,
      ),
      functionalSeamsMasked: true,
    };
    if (
      !launchEvidence.launchId ||
      !launchEvidence.receipt ||
      typeof launchEvidence.receiptNonce !== "string" ||
      typeof launchEvidence.receiptSha256 !== "string" ||
      launchEvidence.receiptNonce !== launchEvidence.receipt.nonce ||
      launchEvidence.marker === null ||
      typeof launchEvidence.legacyProjectionDigest !== "string" ||
      typeof receiptArtifact.path !== "string" ||
      typeof receiptArtifact.realPath !== "string" ||
      receiptArtifact.realPath !== receiptArtifact.path ||
      receiptArtifact.sha256 !== launchEvidence.receiptSha256
    ) {
      throw new Error(
        "C2-ZC marker persistence restart did not retain its launch receipt identity/hash/path binding",
      );
    }
    markerPersistenceRestartEvidence = launchEvidence;
    harness.recordTimeline("c2-zc-marker-persisted-after-restart", {
      projectId,
      marker: markerPersistenceSnapshot.marker,
      epochIds: markerPersistenceSnapshot.epochs.map((epoch) => epoch.id),
      legacyProjection: markerPersistenceSnapshot.legacyProjection,
      launchEvidence,
    });
  } finally {
    await harness.close(
      markerPersistenceLaunch.app,
      markerPersistenceLaunch.page,
      markerPersistencePhase,
    );
    markerPersistenceLaunch = null;
  }

  const postMarkerPhase = `${C2ZC_PRODUCT_JOURNEY_ID}/new-project`;
  let launched = await withLaunchEnvironmentForTest({}, () =>
    harness.launch(postMarkerPhase),
  );
  try {
    const newProjectId = await createProjectAfterCutover(
      harness,
      launched.page,
      scenario.workspace,
    );
    const beforeMutation = await harness.waitUntil(
      async () => {
        const value = await readAuthoritySnapshot(
          harness,
          launched.page,
          newProjectId,
        );
        if (value.markerRows.length !== 1 || value.epochs.length !== 1)
          return null;
        try {
          assertC2ZcPostMarkerProjectBirth(value);
          assertC2ZcPostMarkerProjectSettled(
            value,
            "C2-ZC post-marker project before mutation",
          );
          assertC2ZcFeedCursorSettled(value, { epochId: value.epochs[0].id });
          return value;
        } catch {
          return null;
        }
      },
      "C2-ZC post-marker project settled before typed mutation",
      C2ZC_WAIT_MS,
      250,
    );
    const epoch = assertC2ZcPostMarkerProjectBirth(beforeMutation);
    const application = await createPostMarkerTypedApplication(
      harness,
      launched.page,
      scenario.workspace,
      newProjectId,
    );
    harness.recordTimeline("c2-zc-post-marker-typed-application-applied", {
      projectId: newProjectId,
      runId: application.runId,
      taskId: application.taskId,
      attemptId: application.attemptId,
      commitId: application.commitId,
      applicationId: application.applicationId,
    });
    const afterMutation = await harness.waitUntil(
      async () => {
        const value = await readAuthoritySnapshot(
          harness,
          launched.page,
          newProjectId,
        );
        if (value.markerRows.length !== 1 || value.epochs.length !== 1)
          return null;
        try {
          assertC2ZcPostMarkerProjectSettled(
            value,
            "C2-ZC post-marker project after mutation",
          );
          assertC2ZcFeedCursorSettled(value, { epochId: value.epochs[0].id });
          assertC2ZcGenericFreshnessStorage(
            value,
            {
              projectId: newProjectId,
              applicationId: application.applicationId,
              epochId: value.epochs[0].id,
            },
            "C2-ZC post-marker typed Application Generic storage/provenance",
          );
          return value;
        } catch {
          return null;
        }
      },
      "C2-ZC post-marker typed Application Generic Freshness",
      C2ZC_WAIT_MS,
      250,
    );
    if (
      canonicalJson(beforeMutation.epochs) !==
      canonicalJson(afterMutation.epochs)
    ) {
      throw new Error(
        "C2-ZC post-marker typed Application changed Semantic Epoch lineage",
      );
    }
    if (
      canonicalJson(beforeMutation.markerRows) !==
      canonicalJson(afterMutation.markerRows)
    ) {
      throw new Error(
        "C2-ZC post-marker typed Application changed the cutover marker",
      );
    }
    assertC2ZcLegacyProjectionStable(
      beforeMutation.legacyProjection,
      afterMutation.legacyProjection,
      "C2-ZC post-marker typed Application Legacy projection",
    );
    await harness.close(launched.app, launched.page, postMarkerPhase);
    launched = null;

    const restarted = await withLaunchEnvironmentForTest({}, () =>
      harness.launch(postMarkerPhase),
    );
    let restartSnapshot;
    try {
      restartSnapshot = await harness.waitUntil(
        async () => {
          const value = await readAuthoritySnapshot(
            harness,
            restarted.page,
            newProjectId,
          );
          if (value.markerRows.length !== 1 || value.epochs.length !== 1)
            return null;
          try {
            assertC2ZcPostMarkerRestartInvariants({
              beforeMutation,
              afterMutation,
              restart: value,
              application,
              label: "C2-ZC post-marker typed Application",
            });
            return value;
          } catch {
            return null;
          }
        },
        "C2-ZC post-marker typed Application restart",
        C2ZC_WAIT_MS,
        250,
      );
      harness.recordTimeline("c2-zc-post-marker-typed-application-restarted", {
        projectId: newProjectId,
        runId: application.runId,
        commitId: application.commitId,
        applicationId: application.applicationId,
        marker: restartSnapshot.marker,
        epochId: restartSnapshot.epochs[0].id,
        markerRowCount: restartSnapshot.markerRows.length,
        epochCount: restartSnapshot.epochs.length,
      });
    } finally {
      await harness.close(restarted.app, restarted.page, postMarkerPhase);
    }
    harness.recordTimeline("c2-zc-post-marker-project-created", {
      projectId: newProjectId,
      epochId: epoch.id,
      epochCount: beforeMutation.epochs.length,
      markerRowCount: beforeMutation.markerRows.length,
      legacyRows: beforeMutation.legacyProjection,
    });
  } finally {
    if (launched) {
      await harness.close(launched.app, launched.page, postMarkerPhase);
    }
  }
  return {
    projectId,
    secondaryProjectId,
    markerPersistenceRestart: markerPersistenceRestartEvidence,
  };
}
