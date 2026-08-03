import { strToU8, zipSync, type Zippable } from "fflate";
import packageJson from "../../../package.json";

import {
  buildProjectAuthorshipReport,
  type ProjectAuthorshipReport,
} from "@/features/attribution/projectAuthorship";
import {
  buildProvenanceBreakdown,
  type ProvenanceDisclosureReport,
} from "@/features/attribution/provenance";
import {
  AI_PATHS,
  AI_RUNTIME_ROUTES,
} from "@/features/ai-verification/aiPathRegistry";
import {
  assertAiAuditWorkspacePath,
  readAiAuditSnapshot,
  snapshotAiAuditWorkspacePath,
  verifyAiAuditChain,
} from "./api";
import {
  AiAuditCoverageAccumulator,
  compareUnicodeCodePoints,
  type AiAuditCoverageReport,
} from "./reportCoverage";
import {
  LEGACY_EVIDENCE_COLLECTION_SCHEMA,
  LEGACY_EVIDENCE_SOURCE_TABLES,
  loadLegacyEvidence,
  type LegacyEvidenceArtifact,
  type LegacyEvidenceCollection,
} from "./legacyEvidence";
import type {
  AiAuditSnapshot,
  AiAuditStoredEvent,
  AiAuditVerifyResult,
} from "./types";
import {
  assertAiAuditFrozenReadProofActive,
  type AiAuditFrozenReadProof,
} from "./exportBoundary";

export const AI_AUDIT_BUNDLE_SCHEMA = "grimodex/ai-use-audit-bundle/v1";
export const AI_AUDIT_EXPORT_PAGE_SIZE = 1_000;

interface ChainArtifact {
  readonly scopeId: string;
  readonly projectId: string | null;
  readonly highWaterSequence: number;
  readonly highWaterHash: string;
  readonly verify: AiAuditVerifyResult;
  readonly verification: {
    readonly status: "verified" | "verificationFailed";
    readonly verificationFailed: boolean;
    readonly warnings: readonly string[];
  };
  readonly coverage: AiAuditCoverageReport;
  readonly eventsJsonl: string;
}

export interface AiAuditPathRegistryCoverage {
  readonly registrySource: "src/features/ai-verification/aiPathRegistry.ts#AI_PATHS";
  readonly fullObservablePathIds: readonly string[];
  readonly partialObservablePathIds: readonly string[];
  /** Union of fullObservablePathIds and partialObservablePathIds. */
  readonly auditRequiredPathIds: readonly string[];
  readonly controlEventPathIds: readonly string[];
  readonly notApplicablePathIds: readonly string[];
  readonly observedPathIds: readonly string[];
  readonly observedAuditRequiredPathIds: readonly string[];
  readonly auditRequiredButUnobservedPathIds: readonly string[];
  readonly observedUnregisteredPathIds: readonly string[];
  readonly note: string;
}

export interface AiAuditRuntimeRouteRegistryCoverage {
  readonly registrySource: "src/features/ai-verification/aiPathRegistry.ts#AI_RUNTIME_ROUTES";
  readonly registeredRuntimeRouteIds: readonly string[];
  readonly fullObservableRuntimeRouteIds: readonly string[];
  readonly partialObservableRuntimeRouteIds: readonly string[];
  readonly allRoutesHaveAuditContract: boolean;
  readonly allRoutesHaveConsentContract: boolean;
  readonly ledgerUsageObservation: "not-derived-from-a-distinct-runtime-path-id";
  readonly note: string;
}

export interface AiAuditBundleManifest {
  readonly schema: typeof AI_AUDIT_BUNDLE_SCHEMA;
  readonly generatedAt: string;
  readonly appVersion: string;
  readonly exportConsistency: {
    readonly applicationMutationAdmissionFrozen: boolean;
    readonly strictQuiescenceCompletedBeforeFirstRead: boolean;
    readonly projectWorkspaceIdentityPinned: boolean;
    readonly nativeMultiTableSnapshot: false;
    readonly externalWriterExclusion: false;
    readonly note: string;
  };
  readonly project: {
    readonly id: string;
    readonly title: string;
  };
  readonly sections: {
    readonly currentRemainingAiContent: {
      readonly scope: "body-text-only";
      readonly authorshipFile: string;
      readonly provenanceDisclosureFile: string;
      readonly note: string;
    };
    readonly forwardExecutionLedger: {
      readonly projectLedgerFile: string;
      readonly workspaceLedgerFile: string;
      readonly executionSummaryFile: string;
      readonly note: string;
    };
    readonly selectedSurvivingLegacyEvidence: {
      readonly directory: "legacy-evidence/";
      readonly artifactCount: number;
      readonly totalRowCount: number;
      readonly snapshotAtomic: false;
      readonly note: string;
    };
  };
  readonly chains: {
    readonly project: Omit<ChainArtifact, "eventsJsonl">;
    readonly workspace: Omit<ChainArtifact, "eventsJsonl">;
  };
  readonly legacyEvidence: Omit<LegacyEvidenceCollection, "artifacts"> & {
    readonly artifacts: readonly Omit<LegacyEvidenceArtifact, "jsonl">[];
  };
  readonly captureContract: {
    readonly forwardLedgerTransportCredentialsExcluded: true;
    readonly legacyEvidenceCredentialPolicy: LegacyEvidenceCollection["credentialPolicy"];
    readonly modelVisibleContentPreservation: {
      readonly policy: "exact_when_capture_state_is_complete";
      readonly allRecordedEventsDeclareCompleteCapture: boolean;
      readonly nonCompleteEventCount: number;
      readonly undeclaredCaptureStateEventCount: number;
      readonly note: string;
    };
    readonly priorHistoryNotBackfilled: true;
    readonly projectScopeIncludesNonInteractiveAndIndirectAiPaths: true;
    readonly workspaceScopePurpose: string;
    readonly observedVersions: {
      readonly auditSchemaVersions: readonly string[];
      readonly captureContractVersions: readonly string[];
      readonly recorders: readonly string[];
      readonly appVersions: readonly string[];
      readonly unknownAppVersionEventCount: number;
    };
  };
  readonly pathRegistryCoverage: AiAuditPathRegistryCoverage;
  readonly runtimeRouteRegistryCoverage: AiAuditRuntimeRouteRegistryCoverage;
  readonly observabilityLimitations: {
    readonly providerPrivateReasoningObservable: false;
    readonly externalAiClientPromptsAutomaticallyObservable: false;
    readonly importedOrPastedAiPromptsAutomaticallyObservable: false;
    readonly standaloneMcpClientPromptsAutomaticallyObservable: false;
    readonly existingAuthorshipEvidenceIncluded: true;
    readonly existingLegacyEvidenceIncluded: true;
    readonly externalChangeEventEvidenceIncluded: true;
    readonly externalChangeEventEvidenceMayRemainInWorkspace: true;
    readonly changeEventEvidenceMixedOrigin: true;
    readonly changeEventEvidenceIsAiPromptLog: false;
    readonly changeEventEvidenceIndependentFromForwardLedger: true;
    readonly providerSelectedFusionPanelModelsAutomaticallyObservable: false;
    readonly browserEffectiveRequestReceiptObservable: true;
    readonly browserEffectiveRequestJsonValueObservable: true;
    readonly browserEffectiveRequestSerializedBytesObservable: false;
    readonly browserRuntimeMayNormalizeOrDropRequestedOptions: true;
    readonly ollamaPromptFreeRunnerPreloadIncludedInInferenceLedger: false;
    readonly transportAttemptEventsCoverAllProviderHttpSends: false;
    readonly transportAttemptObservationBoundary: "instrumented-native-http-429-retry-helper";
    readonly note: string;
  };
  readonly integrityLimitations: {
    readonly localSelfAttestationOnly: true;
    readonly administratorTamperResistance: false;
    readonly detectsAccidentalInconsistency: true;
    readonly backupRestoreMayRewindLedger: true;
    readonly tailTruncationExternallyProvableOnlyWithPriorHighWaterReference: true;
    readonly legacyEvidenceHashChained: false;
    readonly changeEventEvidenceCarriesIndependentHashChainFields: true;
    readonly changeEventEvidenceChainVerifiedByThisExport: false;
    readonly legacyEvidenceSnapshotAtomic: false;
    readonly verificationFailed: boolean;
    readonly note: string;
  };
  readonly files: Readonly<
    Record<string, { readonly sha256: string; readonly bytes: number }>
  >;
}

export interface AiAuditBundleBuildResult {
  readonly bytes: Uint8Array;
  readonly filename: string;
  readonly manifest: AiAuditBundleManifest;
}

export interface AiAuditBundleDependencies {
  readSnapshot(
    projectId: string | null,
    options: {
      readonly afterSequence?: number;
      readonly highWaterSequence?: number;
      readonly limit?: number;
      readonly expectedWorkspacePath: string;
    },
  ): Promise<AiAuditSnapshot>;
  verifyChain(
    projectId: string | null,
    options: {
      readonly highWaterSequence?: number;
      readonly expectedWorkspacePath: string;
    },
  ): Promise<AiAuditVerifyResult>;
  buildAuthorship(projectId: string): Promise<ProjectAuthorshipReport>;
  buildProvenance(projectId: string): Promise<ProvenanceDisclosureReport>;
  buildLegacyEvidence(
    projectId: string,
    options: { readonly assertWorkspaceUnchanged: () => void },
  ): Promise<LegacyEvidenceCollection>;
  snapshotWorkspacePath?(): string;
  assertWorkspaceUnchanged?(expectedWorkspacePath: string): void;
}

const DEFAULT_DEPENDENCIES: AiAuditBundleDependencies = {
  readSnapshot: readAiAuditSnapshot,
  verifyChain: verifyAiAuditChain,
  buildAuthorship: buildProjectAuthorshipReport,
  buildProvenance: (projectId) =>
    buildProvenanceBreakdown(projectId, {
      includePassageExcerpts: true,
      includePrompts: true,
      includeFullSystemPrompt: true,
    }),
  buildLegacyEvidence: (projectId, options) =>
    loadLegacyEvidence(projectId, options),
  snapshotWorkspacePath: snapshotAiAuditWorkspacePath,
  assertWorkspaceUnchanged: assertAiAuditWorkspacePath,
};

function stableJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function sha256Bytes(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy.buffer);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort(compareUnicodeCodePoints);
}

function expectedScopeId(projectId: string | null): string {
  return projectId === null ? "workspace" : `project:${projectId}`;
}

function assertPageContract(
  page: AiAuditSnapshot,
  projectId: string | null,
  afterSequence: number,
  highWaterSequence: number,
  highWaterHash: string,
): void {
  if (
    page.scopeId !== expectedScopeId(projectId) ||
    page.projectId !== projectId ||
    page.afterSequence !== afterSequence ||
    page.highWaterSequence !== highWaterSequence ||
    page.highWaterHash !== highWaterHash
  ) {
    throw new Error(
      "AI audit snapshot changed identity or high-water during export",
    );
  }
}

function assertFirstPageContract(
  page: AiAuditSnapshot,
  projectId: string | null,
): void {
  if (
    page.scopeId !== expectedScopeId(projectId) ||
    page.projectId !== projectId ||
    page.afterSequence !== 0 ||
    !Number.isSafeInteger(page.highWaterSequence) ||
    page.highWaterSequence < 0 ||
    !/^[a-f0-9]{64}$/u.test(page.highWaterHash)
  ) {
    throw new Error("AI audit first snapshot page violated its scope contract");
  }
}

function assertEventPageContract(
  event: AiAuditStoredEvent,
  projectId: string | null,
  expectedSequence: number,
  highWaterSequence: number,
): void {
  if (
    event.scopeId !== expectedScopeId(projectId) ||
    event.projectId !== projectId ||
    !Number.isSafeInteger(event.sequence) ||
    event.sequence !== expectedSequence ||
    event.sequence > highWaterSequence
  ) {
    throw new Error(
      "AI audit event violated its pinned snapshot scope contract",
    );
  }
}

function verifyChainStatus(
  verify: AiAuditVerifyResult,
  highWaterSequence: number,
  highWaterHash: string,
  additionalWarnings: readonly string[] = [],
): ChainArtifact["verification"] {
  const warnings = [...additionalWarnings];
  if (!verify.ok) {
    warnings.push(
      `Hash-chain verification reported failure${verify.reason ? `: ${verify.reason}` : "."}`,
    );
  }
  if (verify.verifiedThroughSequence !== highWaterSequence) {
    warnings.push(
      `Verification stopped at sequence ${verify.verifiedThroughSequence}; exported high-water is ${highWaterSequence}.`,
    );
  }
  if (verify.tailHash !== highWaterHash) {
    warnings.push(
      `Verified tail hash ${verify.tailHash} does not match exported high-water hash ${highWaterHash}.`,
    );
  }
  return {
    status: warnings.length === 0 ? "verified" : "verificationFailed",
    verificationFailed: warnings.length > 0,
    warnings,
  };
}

async function loadChain(
  projectId: string | null,
  dependencies: AiAuditBundleDependencies,
  expectedWorkspacePath: string,
  assertReadBoundary: () => void,
): Promise<ChainArtifact> {
  const coverage = new AiAuditCoverageAccumulator();
  const jsonlParts: string[] = [];
  let afterSequence = 0;
  let highWaterSequence: number | undefined;
  let highWaterHash: string | undefined;
  let pages = 0;

  while (true) {
    const page = await dependencies.readSnapshot(projectId, {
      afterSequence,
      highWaterSequence,
      limit: AI_AUDIT_EXPORT_PAGE_SIZE,
      expectedWorkspacePath,
    });
    assertReadBoundary();
    if (highWaterSequence === undefined || highWaterHash === undefined) {
      assertFirstPageContract(page, projectId);
      highWaterSequence = page.highWaterSequence;
      highWaterHash = page.highWaterHash;
    } else {
      assertPageContract(
        page,
        projectId,
        afterSequence,
        highWaterSequence,
        highWaterHash,
      );
    }
    if (page.events.length > AI_AUDIT_EXPORT_PAGE_SIZE) {
      throw new Error("AI audit snapshot page exceeded the requested limit");
    }
    for (const [index, event] of page.events.entries()) {
      assertEventPageContract(
        event,
        projectId,
        afterSequence + index + 1,
        highWaterSequence,
      );
      coverage.add(event);
      jsonlParts.push(`${JSON.stringify(event)}\n`);
    }
    pages += 1;
    const next = page.nextAfterSequence;
    const lastSequence = page.events.at(-1)?.sequence ?? afterSequence;
    if (next === null) {
      if (lastSequence !== highWaterSequence) {
        throw new Error(
          "AI audit snapshot ended before its pinned high-water sequence",
        );
      }
      break;
    }
    if (!Number.isSafeInteger(next) || next <= afterSequence) {
      throw new Error("AI audit pagination cursor did not advance");
    }
    if (
      page.events.length !== AI_AUDIT_EXPORT_PAGE_SIZE ||
      next !== lastSequence ||
      next >= highWaterSequence
    ) {
      throw new Error("AI audit pagination cursor did not match its full page");
    }
    if (pages > Math.ceil(highWaterSequence / AI_AUDIT_EXPORT_PAGE_SIZE) + 1) {
      throw new Error(
        "AI audit pagination exceeded its pinned high-water bound",
      );
    }
    afterSequence = next;
  }

  highWaterSequence ??= 0;
  highWaterHash ??= "0".repeat(64);
  let verify: AiAuditVerifyResult;
  let verificationWarnings: string[] = [];
  try {
    verify = await dependencies.verifyChain(projectId, {
      highWaterSequence,
      expectedWorkspacePath,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    verificationWarnings = [
      `Hash-chain verification could not complete: ${reason}`,
    ];
    verify = {
      ok: false,
      verifiedThroughSequence: 0,
      brokenAtSequence: null,
      reason,
      tailHash: highWaterHash,
    };
  }
  assertReadBoundary();
  const verification = verifyChainStatus(
    verify,
    highWaterSequence,
    highWaterHash,
    verificationWarnings,
  );
  return {
    scopeId: expectedScopeId(projectId),
    projectId,
    highWaterSequence,
    highWaterHash,
    verify,
    verification,
    coverage: coverage.finish(),
    eventsJsonl: jsonlParts.join(""),
  };
}

function unionVersions(
  project: AiAuditCoverageReport,
  workspace: AiAuditCoverageReport,
) {
  const combine = (left: readonly string[], right: readonly string[]) =>
    sortedUnique([...left, ...right]);
  return {
    auditSchemaVersions: combine(
      project.versions.auditSchemaVersions,
      workspace.versions.auditSchemaVersions,
    ),
    captureContractVersions: combine(
      project.versions.captureContractVersions,
      workspace.versions.captureContractVersions,
    ),
    recorders: combine(
      project.versions.recorders,
      workspace.versions.recorders,
    ),
    appVersions: combine(
      project.versions.appVersions,
      workspace.versions.appVersions,
    ),
    unknownAppVersionEventCount:
      project.unknownAppVersionEventCount +
      workspace.unknownAppVersionEventCount,
  };
}

function registryCoverage(
  project: AiAuditCoverageReport,
  workspace: AiAuditCoverageReport,
): AiAuditPathRegistryCoverage {
  const fullObservablePathIds = sortedUnique(
    AI_PATHS.filter((path) => path.captureLevel === "full-observable").map(
      (path) => path.id,
    ),
  );
  const partialObservablePathIds = sortedUnique(
    AI_PATHS.filter((path) => path.captureLevel === "partial-observable").map(
      (path) => path.id,
    ),
  );
  const auditRequiredPathIds = sortedUnique([
    ...fullObservablePathIds,
    ...partialObservablePathIds,
  ]);
  const controlEventPathIds = sortedUnique(
    AI_PATHS.filter((path) => path.captureLevel === "control-event").map(
      (path) => path.id,
    ),
  );
  const notApplicablePathIds = sortedUnique(
    AI_PATHS.filter((path) => path.captureLevel === "not-applicable").map(
      (path) => path.id,
    ),
  );
  const registeredPathIds = new Set([
    ...fullObservablePathIds,
    ...partialObservablePathIds,
    ...controlEventPathIds,
    ...notApplicablePathIds,
  ]);
  const observedPathIds = sortedUnique([
    ...Object.keys(project.pathEventCounts),
    ...Object.keys(workspace.pathEventCounts),
  ]);
  const auditRequired = new Set(auditRequiredPathIds);
  const observed = new Set(observedPathIds);
  return {
    registrySource: "src/features/ai-verification/aiPathRegistry.ts#AI_PATHS",
    fullObservablePathIds,
    partialObservablePathIds,
    auditRequiredPathIds,
    controlEventPathIds,
    notApplicablePathIds,
    observedPathIds,
    observedAuditRequiredPathIds: observedPathIds.filter((pathId) =>
      auditRequired.has(pathId),
    ),
    auditRequiredButUnobservedPathIds: auditRequiredPathIds.filter(
      (pathId) => !observed.has(pathId),
    ),
    observedUnregisteredPathIds: observedPathIds.filter(
      (pathId) => !registeredPathIds.has(pathId),
    ),
    note: "Audit-required logical paths are the union of full-observable and partial-observable AI_PATHS; both classes remain listed separately. Missing comparison applies to that union. Control-event and not-applicable paths are listed separately. Audit-required-but-unobserved means no event for that logical path exists in this pinned export; it does not by itself prove missing instrumentation or non-use. Deployed runtime route contracts are reported separately because they do not create distinct ledger path IDs.",
  };
}

function runtimeRouteRegistryCoverage(): AiAuditRuntimeRouteRegistryCoverage {
  return {
    registrySource:
      "src/features/ai-verification/aiPathRegistry.ts#AI_RUNTIME_ROUTES",
    registeredRuntimeRouteIds: sortedUnique(
      AI_RUNTIME_ROUTES.map((route) => route.id),
    ),
    fullObservableRuntimeRouteIds: sortedUnique(
      AI_RUNTIME_ROUTES.filter(
        (route) => route.captureLevel === "full-observable",
      ).map((route) => route.id),
    ),
    partialObservableRuntimeRouteIds: sortedUnique(
      AI_RUNTIME_ROUTES.filter(
        (route) => route.captureLevel === "partial-observable",
      ).map((route) => route.id),
    ),
    allRoutesHaveAuditContract: AI_RUNTIME_ROUTES.every(
      (route) => Boolean(route.auditTestRef) && Boolean(route.auditTestName),
    ),
    allRoutesHaveConsentContract: AI_RUNTIME_ROUTES.every(
      (route) =>
        Boolean(route.consentTestRef) && Boolean(route.consentTestName),
    ),
    ledgerUsageObservation: "not-derived-from-a-distinct-runtime-path-id",
    note: "Runtime routes are transport/deployment contracts for logical AI paths, not additional model roles or distinct ledger path IDs. This static registry coverage proves registration and named audit/consent contracts only; it does not claim that a route was used in this export. Actual logical-path executions remain in pathRegistryCoverage.",
  };
}

function capturePreservation(
  project: AiAuditCoverageReport,
  workspace: AiAuditCoverageReport,
): AiAuditBundleManifest["captureContract"]["modelVisibleContentPreservation"] {
  const reports = [project, workspace];
  const eventCount = reports.reduce(
    (sum, report) => sum + report.eventCount,
    0,
  );
  const declaredCount = reports.reduce(
    (sum, report) =>
      sum +
      Object.values(report.captureStates).reduce(
        (stateSum, count) => stateSum + count,
        0,
      ),
    0,
  );
  const completeCount = reports.reduce(
    (sum, report) => sum + report.captureStates.complete,
    0,
  );
  return {
    policy: "exact_when_capture_state_is_complete",
    allRecordedEventsDeclareCompleteCapture:
      eventCount === completeCount && eventCount === declaredCount,
    nonCompleteEventCount: declaredCount - completeCount,
    undeclaredCaptureStateEventCount: eventCount - declaredCount,
    note: "Exact preservation is claimed only per event and within its declared Grimodex observation boundary when captureState=complete. Renderer chat/stream events preserve normalized model-visible request arguments and application-observed parsed blocks/deltas, not provider raw HTTP envelopes or headers; native post-effect may additionally retain raw_response. Partial, redacted, truncated, legacy_missing, and unobservable_provider events carry explicit limitations.",
  };
}

function countJsonlRows(value: string): number {
  if (value === "") return 0;
  if (!value.endsWith("\n")) {
    throw new Error("Legacy evidence JSONL must end with a newline");
  }
  const lines = value.slice(0, -1).split("\n");
  for (const line of lines) {
    const parsed = JSON.parse(line) as unknown;
    if (
      parsed === null ||
      Array.isArray(parsed) ||
      typeof parsed !== "object"
    ) {
      throw new Error("Legacy evidence JSONL rows must be JSON objects");
    }
  }
  return lines.length;
}

function assertLegacyEvidenceContract(
  collection: LegacyEvidenceCollection,
  projectId: string,
): void {
  if (
    collection.schema !== LEGACY_EVIDENCE_COLLECTION_SCHEMA ||
    collection.projectId !== projectId
  ) {
    throw new Error("Legacy evidence violated its project identity contract");
  }
  if (
    collection.snapshot.atomic !== false ||
    collection.snapshot.consistency !== "guarded-sequential-queries" ||
    collection.snapshot.limitations.length === 0
  ) {
    throw new Error("Legacy evidence violated its snapshot contract");
  }
  if (
    collection.credentialPolicy.modelVisibleContentPreservedVerbatim !== true ||
    collection.credentialPolicy
      .modelVisibleContentMayContainUserSuppliedSecrets !== true ||
    collection.credentialPolicy.unclassifiableAbSlotJsonPreservedVerbatim !==
      true
  ) {
    throw new Error("Legacy evidence violated its credential policy contract");
  }

  const expected = new Set<string>(LEGACY_EVIDENCE_SOURCE_TABLES);
  const observed = new Set<string>();
  let totalRowCount = 0;
  for (const artifact of collection.artifacts) {
    const diagnostics = artifact.diagnostics;
    const diagnosticsValid =
      diagnostics === undefined ||
      (Number.isSafeInteger(diagnostics.examinedRowCount) &&
        diagnostics.examinedRowCount >= 0 &&
        Number.isSafeInteger(diagnostics.excludedNonAiRowCount) &&
        diagnostics.excludedNonAiRowCount >= 0 &&
        Number.isSafeInteger(diagnostics.malformedJsonExcludedRowCount) &&
        diagnostics.malformedJsonExcludedRowCount >= 0 &&
        diagnostics.examinedRowCount ===
          artifact.rowCount +
            diagnostics.excludedNonAiRowCount +
            diagnostics.malformedJsonExcludedRowCount);
    if (
      !expected.has(artifact.sourceTable) ||
      observed.has(artifact.sourceTable) ||
      artifact.file !== `legacy-evidence/${artifact.sourceTable}.jsonl` ||
      artifact.schema !==
        `grimodex/ai-use-legacy-evidence/${artifact.sourceTable}/v1` ||
      (artifact.captureClass !== "full" &&
        artifact.captureClass !== "partial") ||
      artifact.limitations.length === 0 ||
      !Number.isSafeInteger(artifact.rowCount) ||
      artifact.rowCount < 0 ||
      !diagnosticsValid ||
      (artifact.sourceTable === "trash_items") !==
        (artifact.diagnostics !== undefined) ||
      countJsonlRows(artifact.jsonl) !== artifact.rowCount
    ) {
      throw new Error(
        "Legacy evidence artifact contract is incomplete or invalid",
      );
    }
    observed.add(artifact.sourceTable);
    totalRowCount += artifact.rowCount;
  }
  if (
    collection.artifacts.some(
      (artifact, index) =>
        artifact.sourceTable !== LEGACY_EVIDENCE_SOURCE_TABLES[index],
    ) ||
    observed.size !== expected.size ||
    [...expected].some((sourceTable) => !observed.has(sourceTable)) ||
    totalRowCount !== collection.totalRowCount
  ) {
    throw new Error(
      "Legacy evidence artifact list is incomplete or inconsistent",
    );
  }
}

function legacyEvidenceManifest(
  collection: LegacyEvidenceCollection,
): AiAuditBundleManifest["legacyEvidence"] {
  const { artifacts, ...metadata } = collection;
  return {
    ...metadata,
    artifacts: artifacts.map(({ jsonl: _jsonl, ...artifact }) => artifact),
  };
}

function readme(manifest: Omit<AiAuditBundleManifest, "files">): string {
  const project = manifest.chains.project;
  const workspace = manifest.chains.workspace;
  const verificationFailed =
    project.verification.verificationFailed ||
    workspace.verification.verificationFailed;
  const verificationWarning = verificationFailed
    ? `\n## VERIFICATION FAILED\n\nThe structurally readable pinned ledger snapshot is still included verbatim. Do not treat this bundle as a clean integrity result. Scope, sequence, pagination, or snapshot-read contract failures stop export instead of producing a potentially misleading partial ledger.\n\n${[
        ...project.verification.warnings.map(
          (warning) => `- Project: ${warning}`,
        ),
        ...workspace.verification.warnings.map(
          (warning) => `- Workspace: ${warning}`,
        ),
      ].join("\n")}\n`
    : "\n## Integrity verification\n\nBoth pinned forward-ledger scopes passed the local hash-chain consistency check. Legacy evidence is a separate current-row snapshot and is not hash-chained.\n";
  const legacyArtifacts = manifest.legacyEvidence.artifacts
    .map(
      (artifact) =>
        `- \`${artifact.file}\`: source=\`${artifact.sourceTable}\`, schema=\`${artifact.schema}\`, rows=${artifact.rowCount}, captureClass=${artifact.captureClass}; limitations=${artifact.limitations.join(", ")}.`,
    )
    .join("\n");
  return `# Grimodex AI Use Audit Bundle

Generated: ${manifest.generatedAt}
Project: ${manifest.project.title} (${manifest.project.id})
${verificationWarning}

## Export consistency boundary

${manifest.exportConsistency.note}

## 1. Current remaining AI-derived manuscript content

- \`reports/authorship-report.json\`: body-text-only human/AI attribution snapshot.
- \`reports/provenance-disclosure.json\`: provenance and recoverable prompts for AI-attributed content still present at export time.

## 2. Forward AI execution ledger

- \`ledger/project-events.jsonl\`: project-scoped interactive, non-interactive, review, comment, synopsis, extraction, reranking, and other AI executions recorded after the forward ledger became available, including executions whose output was not inserted into the manuscript.
- \`ledger/workspace-events.jsonl\`: workspace-scoped AI executions made before a project was selected, such as real-model connection probes. These are disclosed separately and are not asserted to have contributed to this project.
- \`reports/execution-summary.json\`: human-readable lifecycle, dispatch, capture, registry-observation, and integrity summary for both ledgers.

Logical AI path usage is compared against \`AI_PATHS\`. Deployed runtime routes from \`AI_RUNTIME_ROUTES\` are disclosed separately as static registration/audit/consent contracts because they reuse logical path IDs rather than emitting a distinct runtime path ID. Static runtime-route coverage does not prove that a route was used in this export.

Project chain: ${project.highWaterSequence} events, high-water ${project.highWaterHash}, verify=${project.verify.ok}.
Workspace chain: ${workspace.highWaterSequence} events, high-water ${workspace.highWaterHash}, verify=${workspace.verify.ok}.

## 3. Selected surviving legacy evidence

The \`legacy-evidence/\` directory contains a deliberately selected set of surviving project-scoped rows from pre-ledger and parallel persistence. Selection uses explicit AI fields, canonical ownership joins, structured authorship marks, assistant-message links, tracked-write surfaces, or semantic-index ownership. It is not a full database archive and does not claim complete coverage before the forward ledger existed. It does not fabricate or reconstruct missing prompts, responses, execution attempts, or terminal outcomes. Deleted rows and AI activity that was never persisted cannot be recovered. Some rows may duplicate evidence also present in the forward ledger.

These artifacts were collected by guarded sequential queries, not one atomic multi-table database snapshot. The active workspace path was checked before and after every source-table query. ${manifest.exportConsistency.applicationMutationAdmissionFrozen ? "The user-triggered award-audit path blocked Grimodex renderer mutation and new AI admission, waited pre-existing audited executions through their durable terminal events, retained and drained pre-existing native read/derived work, completed strict persistence quiescence, and pinned Project/Workspace identity through all reads. External processes such as standalone MCP clients are outside that renderer-local boundary, so their concurrent writes can still create cross-table time skew." : "This low-level assembly did not receive a renderer frozen-read proof, so concurrent application or external-process writes can create cross-table time skew."}

Historical containers and generic cache/state tables are intentionally not collected as AI evidence: \`content_versions\`, named project snapshots (\`project_snapshots\` and \`project_snapshot_*\`), \`state_snapshots\`, \`impact_review_baselines\`, \`chat_session_pinned_codex\`, and generic project output/cache/state tables. Their omission means pre-ledger history is not complete; no origin is inferred from a generic container merely because it might contain AI-derived bytes.

\`prose_staging.jsonl\` preserves surviving AI prose proposals, including proposed, accepted, rejected, or stale rows whose text may no longer appear in the current manuscript. It is proposal evidence, not a complete prompt, provider receipt, or execution lifecycle.

\`change_events.jsonl\` contains every surviving project row from the separate operational change journal. It deliberately mixes human, AI, system, and external-tool events; payload meaning depends on domain/opType, and rows may duplicate forward-ledger or other legacy evidence. Its raw payload and independent hash-chain fields are retained, but this bundle does not classify every row as AI, does not verify that separate chain, and does not reconstruct standalone MCP-client prompts.

\`undo_journal.jsonl\` contains surviving successful tracked mutations whose surface is \`in-app-agent\` or \`mcp\`. Its before/after snapshots are mutation evidence, not a model dispatch or provider receipt. An \`mcp\` surface proves only an external tool invocation; it cannot reveal the external client's prompt, and workspace compaction may prune old rows.

The owner-content artifacts (\`tree_nodes\`, \`codex_entries\`, \`codex_detail_values\`, \`codex_entry_phases\`, \`snippets\`, and \`map_stickies\`) contain only rows with a surviving structural AI basis. They can include note and archived-node content, but later human edits may have changed the content. A user-role chat-message link is never treated as AI origin.

Semantic-index artifacts preserve the stored source/chunk text, model ID, content hash, dimensions, chunker version, and timestamps under strict owner joins. The realized ONNX document input was not persisted: document prefixing, tokenizer special tokens, and truncation cannot be reconstructed exactly from these rows. Raw embedding BLOBs and a separately attested embedding SHA are also unavailable through this renderer export, so these artifacts are partial.

\`trash_items.jsonl\` contains only rows whose parsed payload structurally confirms AI authorship. Malformed payload or nested ProseMirror JSON is excluded as unclassifiable and counted in the artifact diagnostics. Trash can be cleared or pruned after 60 days, capture can be disabled, and short fragments may never be persisted.

${legacyArtifacts}

Project ambiguous executions (start without one terminal): ${project.coverage.ambiguousExecutionCount}.
Workspace ambiguous executions: ${workspace.coverage.ambiguousExecutionCount}.
Project redacted/partial/truncated/unobservable executions: ${project.coverage.affectedExecutions.redacted}/${project.coverage.affectedExecutions.partial}/${project.coverage.affectedExecutions.truncated}/${project.coverage.affectedExecutions.unobservable_provider}.
Project request.prepared events/application dispatch events: ${project.coverage.requestPreparedCount}/${project.coverage.applicationDispatchEventCount}; application-dispatch executions: ${project.coverage.applicationDispatchExecutionCount}; application-dispatch executions missing request.prepared: ${project.coverage.applicationDispatchMissingRequestPreparedExecutionCount}; skipped/cache-hit without application dispatch: ${project.coverage.noApplicationDispatchTerminalExecutions.skipped}/${project.coverage.noApplicationDispatchTerminalExecutions.cacheHit}.
Project request.prepared credential-exclusion declaration violations: ${project.coverage.requestPreparedCredentialExclusionViolationCount}.
Project transport helper attempt starts/finishes: ${project.coverage.transportAttemptStartedCount}/${project.coverage.transportAttemptFinishedCount}; starts without finish: ${project.coverage.transportAttemptStartedWithoutFinishCount}; finishes without start: ${project.coverage.transportAttemptFinishedWithoutStartCount}; durable pre-send retry starts (transport.attempt.started with attemptNumber > 1): ${project.coverage.transportDerivedRetryCount}.
Project retry evidence: execution.retrying events=${project.coverage.executionRetryingEventCount}; HTTP 429 attempt finishes=${project.coverage.transportHttp429FinishedCount}; willRetry decisions=${project.coverage.transportWillRetryFinishedCount}; retryExhausted finishes=${project.coverage.transportRetryExhaustedFinishedCount}.
Project post-terminal lifecycle anomalies: events=${project.coverage.postTerminalEventCount}; executions=${project.coverage.postTerminalExecutionCount}; transport-attempt events=${project.coverage.postTerminalTransportAttemptCount}.
Workspace post-terminal lifecycle anomalies: events=${workspace.coverage.postTerminalEventCount}; executions=${workspace.coverage.postTerminalExecutionCount}; transport-attempt events=${workspace.coverage.postTerminalTransportAttemptCount}.
Events with unknown application runtime version (project/workspace): ${project.coverage.unknownAppVersionEventCount}/${workspace.coverage.unknownAppVersionEventCount}. An unknown value is retained truthfully when a native recorder cannot safely obtain the Electron application version; it is not replaced with a component or crate version.

## Scope and limitations

Forward-ledger transport credentials (authorization headers, API keys, cookies, process environment) are excluded. Within the declared Grimodex observation boundary, normalized model-visible request arguments, prompts, context, tool schemas/results, and application-observed parsed response blocks/deltas are retained exactly unless an event explicitly declares redacted, partial, truncated, legacy_missing, or unobservable_provider capture. Renderer chat/stream capture is not a raw provider HTTP-envelope/header archive; native post-effect events may separately include raw_response.

Legacy evidence follows a different credential policy. Credential-shaped text in diagnostic-only \`ai_usage.metadata\`, \`post_effect_runs.error_message\`, and classified failed A/B slot diagnostics is sanitized with irreversible hash/byte-length redaction records. Model-visible legacy prompts, context, messages, annotations, and successful outputs are preserved verbatim, so secrets supplied in model-visible content may be present. Review the legacy artifact limitations and every file before sharing.

request.dispatched records an application-to-selected transport dispatch event, not an HTTP send, attempt, or provider receipt. transport.attempt.started / transport.attempt.finished currently observe only the instrumented native HTTP 429 retry helper. A started event is durably appended immediately before its corresponding send call and therefore records a pre-send attempt start, not proof that the process survived to invoke the HTTP send. A finished event is appended after the send call returns a response, transport error, or locally observed cancellation. For a locally cancelled attempt, an integer actualHttpSendCount=N together with sendPhase=pre-send-cancelled means that this attempt's send was not invoked and N earlier sends occurred (normally attemptNumber - 1). actualHttpSendCount=null together with sendPhase=send-invoked means cancellation won while this attempt's send future was in flight, so the observer cannot prove whether the provider received it. transportDerivedRetryCount is defined as started events whose integer attemptNumber > 1; willRetry counts retry decisions and does not prove that the next attempt began. Provider routes outside this helper can make HTTP sends without these transport events, so the transport counts do not prove the total number of HTTP sends across all providers.

For cleanup terminals, transportAbortRequested records that Grimodex requested cancellation at its selected transport, and abortCommandAcknowledged records only that the local Electron, BrowserMock, CLI, or Codex command boundary acknowledged the cleanup command. It is not a provider cancellation receipt; providerAbortReceiptObserved remains false. Grimodex ends UI delivery on cleanup but retains the correlated audit observation until the transport terminal is observed. Every observed response and transport-attempt event must be durably appended before the execution's single terminal event.

postTerminalEventCount, postTerminalExecutionCount, and postTerminalTransportAttemptCount are expected to be zero. A nonzero value is a lifecycle/correlation integrity anomaly, not normal evidence from in-flight or retry-backoff work. The ledger rejects new events after the first terminal; an exported nonzero value indicates legacy or otherwise inconsistent data that requires investigation.

Provider-private reasoning, including hidden chain-of-thought, is not observable. External AI clients, imported or pasted AI text, and standalone MCP-client system/user prompts are not automatically observable because Grimodex does not dispatch those model calls. Existing authorship evidence is included through the body reports. The project-scoped \`change_events\` journal is included as mixed-origin operational evidence, not as an AI prompt log; it may retain MCP/tool/change evidence but cannot supply an external client's missing system/user prompts. The surviving-body provenance report and execution summary separately identify orphan/unknown evidence that can be recovered.

OpenRouter Fusion may let the provider select default panel models. Those provider-selected model identities are unobservable unless they are explicitly configured or returned through a captured boundary. Explicitly configured custom panel/judge models can be recorded, but their presence does not make an unreported provider-selected default panel observable.

Web Editor executions retain the logical renderer request and observed response. BrowserMock parses the exact bodyJson string passed to fetch, appends the resulting complete credential-free JSON value as an effective-request receipt to the same execution, and awaits its durable journal ACK before fetch. BrowserMock may normalize or drop renderer options, but the resulting provider JSON semantics are preserved. The original serialization whitespace, key order, and byte representation are not preserved; headers and runtime credentials remain excluded. The static runtime-route registry does not prove that the route was used in this export.

Model listing is control-plane activity, not automatically a model execution. For a selected cold Ollama model, Grimodex may issue the consent-gated prompt-free runner preload \`/api/generate\` with \`{model, stream:false}\`; it may load weights or allocate the runner but supplies no prompt and requests no token generation or model output, so it is outside this generative/inference ledger.

This ZIP can contain complete prompts, context, tool payloads/results, responses, and manuscript material from other scenes. Forward-ledger transport credentials and classified legacy diagnostics are sanitized as described above, but confidential story information and credentials typed into model-visible content are not automatically redacted. Review every file before sharing the bundle.

The execution ledger is forward-only from the feature's installation/use; earlier exact prompts and responses are not fabricated or backfilled into it. Selected surviving legacy evidence is disclosed separately as current database rows, not converted into synthetic ledger events. The first recorded event does not prove that no earlier AI use occurred.

Bundle assembly is currently in memory. An extremely large audit history can exhaust available memory and fail export; Grimodex does not emit a partial ZIP in that case.

The hash chain is a self-reported consistency diagnostic, not a certificate. This is a local self-attestation and accidental-integrity aid, not administrator-resistant or third-party notarized evidence. A full workspace backup restore can return the ledger to that older snapshot. Tail deletion is externally demonstrable only when an earlier exported high-water sequence/hash is retained for comparison.
`;
}

function executionSummary(
  manifest: Omit<AiAuditBundleManifest, "files">,
  provenance: ProvenanceDisclosureReport,
): Record<string, unknown> {
  const project = manifest.chains.project;
  const workspace = manifest.chains.workspace;
  return {
    schema: "grimodex/ai-use-audit-execution-summary/v1",
    generatedAt: manifest.generatedAt,
    project: manifest.project,
    exportConsistency: manifest.exportConsistency,
    overallIntegrityStatus: manifest.integrityLimitations.verificationFailed
      ? "verificationFailed"
      : "verified",
    interpretation: {
      currentRemainingAiContent:
        "Authorship and provenance reports describe AI-derived manuscript body content still present at export time.",
      forwardExecutionLedger:
        "The project ledger records observed interactive, non-interactive, indirect, adopted, and unadopted AI work after forward auditing became available; it is not a backfill of prior activity.",
      selectedSurvivingLegacyEvidence: manifest.exportConsistency
        .applicationMutationAdmissionFrozen
        ? "Legacy artifacts contain a selected set of surviving current database rows without reconstructing missing prompts, responses, or execution lifecycle. They are not a full pre-ledger database history. The user-triggered export freezes Grimodex renderer mutations after strict quiescence, but collection still uses guarded sequential queries rather than one atomic multi-table snapshot; external writers remain outside the boundary."
        : "Legacy artifacts contain a selected set of surviving current database rows without reconstructing missing prompts, responses, or execution lifecycle. They are not a full pre-ledger database history. This low-level assembly did not receive a renderer frozen-read proof, and collection uses guarded sequential queries rather than one atomic multi-table snapshot.",
      workspaceScope:
        "Workspace events are disclosed separately and are not asserted to have contributed to the selected project.",
      dispatchAndTransport:
        "request.dispatched counts application-to-selected transport dispatch events, not HTTP attempts or provider receipts. transport.attempt events cover only the instrumented native HTTP 429 retry helper. A started event is a durable pre-send observation and does not prove that the process survived to invoke the HTTP send; a finished event follows a response, transport error, or locally observed cancellation. For local cancellation, an integer actualHttpSendCount=N with sendPhase=pre-send-cancelled means this attempt's send was not invoked and N earlier sends occurred (normally attemptNumber - 1). actualHttpSendCount=null with sendPhase=send-invoked means this attempt's send was in flight, so provider receipt is unprovable. transportDerivedRetryCount is the number of started events with an integer attemptNumber greater than 1; willRetry is reported separately as a retry decision. These counts do not prove all provider HTTP sends. On cleanup, abortCommandAcknowledged records only a local command-boundary acknowledgement and providerAbortReceiptObserved remains false. All observed response and transport-attempt evidence must be durable before the single terminal. postTerminalEventCount, postTerminalExecutionCount, and postTerminalTransportAttemptCount are expected to be zero; any nonzero value is a lifecycle/correlation integrity anomaly requiring investigation.",
      integrity:
        "Hash-chain verification is a local consistency diagnostic, not third-party certification.",
    },
    chains: {
      project: {
        scopeId: project.scopeId,
        highWaterSequence: project.highWaterSequence,
        highWaterHash: project.highWaterHash,
        verification: project.verification,
        coverage: project.coverage,
      },
      workspace: {
        scopeId: workspace.scopeId,
        highWaterSequence: workspace.highWaterSequence,
        highWaterHash: workspace.highWaterHash,
        verification: workspace.verification,
        coverage: workspace.coverage,
      },
    },
    pathRegistryCoverage: manifest.pathRegistryCoverage,
    runtimeRouteRegistryCoverage: manifest.runtimeRouteRegistryCoverage,
    legacyEvidence: manifest.legacyEvidence,
    existingBodyProvenanceEvidence: {
      orphanChatCharacters: provenance.breakdown.orphanChat,
      unknownAiCharacters: provenance.breakdown.unknownAi,
      orphanChatCount: provenance.orphanChatCount,
      note: "These surviving-body categories preserve partial evidence when the original generation audit is unavailable. External MCP/import/paste activity may appear only as unknown authorship. Project-scoped change_events rows are included separately as mixed-origin operational evidence, but no missing external prompt is reconstructed.",
    },
    captureContract: manifest.captureContract,
    observabilityLimitations: manifest.observabilityLimitations,
    integrityLimitations: manifest.integrityLimitations,
  };
}

const DETERMINISTIC_ZIP_MTIME = "1980-01-01T00:00:00.000Z";

function deterministicZip(
  files: Readonly<Record<string, Uint8Array>>,
): Uint8Array {
  const archive: Zippable = {};
  for (const path of Object.keys(files).sort(compareUnicodeCodePoints)) {
    archive[path] = [
      files[path],
      {
        level: 6,
        mtime: DETERMINISTIC_ZIP_MTIME,
        os: 3,
        attrs: 0o644 << 16,
      },
    ];
  }
  return zipSync(archive, { level: 6 });
}

export async function buildAiAuditBundle(
  projectId: string,
  options: {
    readonly generatedAt?: string;
    readonly dependencies?: AiAuditBundleDependencies;
    readonly frozenReadProof?: AiAuditFrozenReadProof;
  } = {},
): Promise<AiAuditBundleBuildResult> {
  if (!projectId.trim()) throw new Error("projectId is required");
  const dependencies = options.dependencies ?? DEFAULT_DEPENDENCIES;
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const hasFrozenReadBoundary = options.frozenReadProof !== undefined;
  const assertFrozenReadBoundary = (): void => {
    if (options.frozenReadProof !== undefined) {
      assertAiAuditFrozenReadProofActive(options.frozenReadProof, projectId);
    }
  };
  assertFrozenReadBoundary();
  const expectedWorkspacePath =
    dependencies.snapshotWorkspacePath?.() ?? "dependency-pinned-workspace";
  const assertWorkspaceUnchanged = () => {
    assertFrozenReadBoundary();
    dependencies.assertWorkspaceUnchanged?.(expectedWorkspacePath);
    assertFrozenReadBoundary();
  };

  assertWorkspaceUnchanged();
  const authorship = await dependencies.buildAuthorship(projectId);
  assertWorkspaceUnchanged();
  const provenance = await dependencies.buildProvenance(projectId);
  assertWorkspaceUnchanged();
  const legacyEvidence = await dependencies.buildLegacyEvidence(projectId, {
    assertWorkspaceUnchanged,
  });
  assertWorkspaceUnchanged();
  assertLegacyEvidenceContract(legacyEvidence, projectId);
  assertWorkspaceUnchanged();
  const projectChain = await loadChain(
    projectId,
    dependencies,
    expectedWorkspacePath,
    assertWorkspaceUnchanged,
  );
  assertWorkspaceUnchanged();
  const workspaceChain = await loadChain(
    null,
    dependencies,
    expectedWorkspacePath,
    assertWorkspaceUnchanged,
  );
  assertWorkspaceUnchanged();
  const { eventsJsonl: projectEventsJsonl, ...projectChainManifest } =
    projectChain;
  const { eventsJsonl: workspaceEventsJsonl, ...workspaceChainManifest } =
    workspaceChain;
  const pathRegistryCoverage = registryCoverage(
    projectChain.coverage,
    workspaceChain.coverage,
  );
  const runtimeRouteCoverage = runtimeRouteRegistryCoverage();
  const legacyManifest = legacyEvidenceManifest(legacyEvidence);
  const verificationFailed =
    projectChain.verification.verificationFailed ||
    workspaceChain.verification.verificationFailed;

  const baseManifest: Omit<AiAuditBundleManifest, "files"> = {
    schema: AI_AUDIT_BUNDLE_SCHEMA,
    generatedAt,
    appVersion: packageJson.version,
    exportConsistency: {
      applicationMutationAdmissionFrozen: hasFrozenReadBoundary,
      strictQuiescenceCompletedBeforeFirstRead: hasFrozenReadBoundary,
      projectWorkspaceIdentityPinned: hasFrozenReadBoundary,
      nativeMultiTableSnapshot: false,
      externalWriterExclusion: false,
      note: hasFrozenReadBoundary
        ? "Grimodex renderer mutation and new AI admission were closed, pre-existing audited executions reached durable terminal events, pre-existing native read/derived tasks settled, strict persistence quiescence completed, and Project/Workspace identity remained pinned through every report and ledger read. This is not a native multi-table database snapshot and does not exclude writes from external processes such as standalone MCP clients."
        : "No renderer frozen-read proof was supplied to this low-level bundle assembly call. This is not a native multi-table database snapshot and does not exclude concurrent application or external-process writes.",
    },
    project: { id: projectId, title: authorship.projectTitle },
    sections: {
      currentRemainingAiContent: {
        scope: "body-text-only",
        authorshipFile: "reports/authorship-report.json",
        provenanceDisclosureFile: "reports/provenance-disclosure.json",
        note: "Snapshot of AI-derived content that remains in the manuscript at export time.",
      },
      forwardExecutionLedger: {
        projectLedgerFile: "ledger/project-events.jsonl",
        workspaceLedgerFile: "ledger/workspace-events.jsonl",
        executionSummaryFile: "reports/execution-summary.json",
        note: "Forward execution ledger includes observed AI work after auditing became available, even when it did not directly produce manuscript prose; it is not a prior-history backfill.",
      },
      selectedSurvivingLegacyEvidence: {
        directory: "legacy-evidence/",
        artifactCount: legacyEvidence.artifacts.length,
        totalRowCount: legacyEvidence.totalRowCount,
        snapshotAtomic: false,
        note: hasFrozenReadBoundary
          ? "A selected set of surviving current database rows is exported without synthesizing ledger events or reconstructing missing evidence. This is not a full database archive or a complete pre-ledger history. Grimodex renderer mutations were frozen after strict quiescence, but guarded sequential source-table reads remain non-atomic and external writers may still create cross-table time skew."
          : "A selected set of surviving current database rows is exported without synthesizing ledger events or reconstructing missing evidence. This is not a full database archive or a complete pre-ledger history. Guarded sequential source-table reads are non-atomic and may have cross-table time skew.",
      },
    },
    chains: {
      project: projectChainManifest,
      workspace: workspaceChainManifest,
    },
    legacyEvidence: legacyManifest,
    captureContract: {
      forwardLedgerTransportCredentialsExcluded: true,
      legacyEvidenceCredentialPolicy: legacyEvidence.credentialPolicy,
      modelVisibleContentPreservation: capturePreservation(
        projectChain.coverage,
        workspaceChain.coverage,
      ),
      priorHistoryNotBackfilled: true,
      projectScopeIncludesNonInteractiveAndIndirectAiPaths: true,
      workspaceScopePurpose:
        "Pre-project AI executions are included separately and are not attributed to the selected project.",
      observedVersions: unionVersions(
        projectChain.coverage,
        workspaceChain.coverage,
      ),
    },
    pathRegistryCoverage,
    runtimeRouteRegistryCoverage: runtimeRouteCoverage,
    observabilityLimitations: {
      providerPrivateReasoningObservable: false,
      externalAiClientPromptsAutomaticallyObservable: false,
      importedOrPastedAiPromptsAutomaticallyObservable: false,
      standaloneMcpClientPromptsAutomaticallyObservable: false,
      existingAuthorshipEvidenceIncluded: true,
      existingLegacyEvidenceIncluded: true,
      externalChangeEventEvidenceIncluded: true,
      externalChangeEventEvidenceMayRemainInWorkspace: true,
      changeEventEvidenceMixedOrigin: true,
      changeEventEvidenceIsAiPromptLog: false,
      changeEventEvidenceIndependentFromForwardLedger: true,
      providerSelectedFusionPanelModelsAutomaticallyObservable: false,
      browserEffectiveRequestReceiptObservable: true,
      browserEffectiveRequestJsonValueObservable: true,
      browserEffectiveRequestSerializedBytesObservable: false,
      browserRuntimeMayNormalizeOrDropRequestedOptions: true,
      ollamaPromptFreeRunnerPreloadIncludedInInferenceLedger: false,
      transportAttemptEventsCoverAllProviderHttpSends: false,
      transportAttemptObservationBoundary:
        "instrumented-native-http-429-retry-helper",
      note: "The forward audit ledger covers model calls Grimodex can observe after instrumentation became available. It cannot automatically capture prompts held by external AI/MCP clients or recover prompts for imported/pasted AI text. Selected surviving authorship, proposal, explicit legacy AI fields, owner content, tracked mutations, semantic inputs, and trash evidence are included separately; this is not a full database archive or complete pre-ledger history. The complete project change_events row set is included only as mixed-origin operational evidence on its independent chain; it is not an AI prompt log and no external prompt is reconstructed. Deleted or never-recorded evidence remains unavailable. Provider-selected OpenRouter Fusion panel models are unobservable unless explicitly configured or returned through a captured boundary. Web BrowserMock records the complete JSON value parsed from the exact fetch bodyJson before fetch while excluding transport credentials; serialization whitespace, key order, and bytes are not retained. A prompt-free Ollama runner preload can load weights without prompt, token generation, or model output and is classified as control-plane rather than a model execution. Transport attempt events currently cover only the instrumented native HTTP 429 retry helper, not every provider HTTP send.",
    },
    integrityLimitations: {
      localSelfAttestationOnly: true,
      administratorTamperResistance: false,
      detectsAccidentalInconsistency: true,
      backupRestoreMayRewindLedger: true,
      tailTruncationExternallyProvableOnlyWithPriorHighWaterReference: true,
      legacyEvidenceHashChained: false,
      changeEventEvidenceCarriesIndependentHashChainFields: true,
      changeEventEvidenceChainVerifiedByThisExport: false,
      legacyEvidenceSnapshotAtomic: false,
      verificationFailed,
      note: "Keep prior exported high-water sequence/hash values if later comparisons are required. Hash/tail verification failure for a structurally readable pinned forward-ledger snapshot does not suppress raw ledger export; scope, sequence, pagination, or snapshot-read contract failure stops export. Selected surviving legacy evidence is deterministic current-row JSONL protected by per-file ZIP hashes, but is not one atomic multi-table snapshot and is not one common hash chain. change_events rows retain their separate operational chain fields, which this export does not verify.",
    },
  };

  const contentFiles: Record<string, Uint8Array> = {
    "README.md": strToU8(readme(baseManifest)),
    "ledger/project-events.jsonl": strToU8(projectEventsJsonl),
    "ledger/workspace-events.jsonl": strToU8(workspaceEventsJsonl),
    "reports/authorship-report.json": strToU8(stableJson(authorship)),
    "reports/provenance-disclosure.json": strToU8(stableJson(provenance)),
    "reports/execution-summary.json": strToU8(
      stableJson(executionSummary(baseManifest, provenance)),
    ),
  };
  for (const artifact of legacyEvidence.artifacts) {
    contentFiles[artifact.file] = strToU8(artifact.jsonl);
  }
  assertWorkspaceUnchanged();
  const files: Record<string, { sha256: string; bytes: number }> = {};
  for (const path of Object.keys(contentFiles).sort(compareUnicodeCodePoints)) {
    const bytes = contentFiles[path];
    files[path] = { sha256: await sha256Bytes(bytes), bytes: bytes.byteLength };
    assertWorkspaceUnchanged();
  }
  assertWorkspaceUnchanged();
  const manifest: AiAuditBundleManifest = { ...baseManifest, files };
  const archiveFiles = {
    ...contentFiles,
    "manifest.json": strToU8(stableJson(manifest)),
  };
  const datestamp = generatedAt.slice(0, 10);
  const bytes = deterministicZip(archiveFiles);
  assertWorkspaceUnchanged();
  assertFrozenReadBoundary();
  return {
    bytes,
    filename: `ai-use-audit-${projectId.replace(/[^a-z0-9._-]+/giu, "-")}-${datestamp}.zip`,
    manifest,
  };
}

export function downloadAiAuditBundle(
  bytes: Uint8Array,
  filename: string,
): void {
  const blob = new Blob([bytes as BlobPart], { type: "application/zip" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** JSONL helper retained for focused page/export contract tests. */
export function parseAiAuditJsonl(value: string): AiAuditStoredEvent[] {
  if (!value.trim()) return [];
  return value
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line) as AiAuditStoredEvent);
}
