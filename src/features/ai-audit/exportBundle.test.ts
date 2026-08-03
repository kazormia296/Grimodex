import { strFromU8, unzipSync } from "fflate";
import { describe, expect, it, vi } from "vitest";

import type { ProjectAuthorshipReport } from "@/features/attribution/projectAuthorship";
import type { ProvenanceDisclosureReport } from "@/features/attribution/provenance";
import {
  AI_AUDIT_EXPORT_PAGE_SIZE,
  buildAiAuditBundle,
  parseAiAuditJsonl,
  type AiAuditBundleDependencies,
  type AiAuditBundleManifest,
} from "./exportBundle";
import {
  createEmptyLegacyEvidenceCollection,
  type LegacyEvidenceCollection,
} from "./legacyEvidence";
import type { AiAuditStoredEvent } from "./types";

const PROJECT_EVENT_COUNT = 10_000;

function event(sequence: number): AiAuditStoredEvent {
  const executionNumber = Math.ceil(sequence / 2);
  return {
    sequence,
    eventId: `event-${sequence}`,
    scopeId: "project:project-1",
    projectId: "project-1",
    executionId: `execution-${executionNumber}`,
    operationId: `operation-${executionNumber}`,
    parentExecutionId: null,
    pathId: executionNumber % 2 === 0 ? "review.comment" : "synopsis.generate",
    eventType: sequence % 2 === 1 ? "execution.started" : "execution.succeeded",
    timestamp: 1_700_000_000_000 + sequence,
    recordedAt: 1_700_000_000_100 + sequence,
    payload: {
      captureState: "complete",
      auditSchemaVersion: 1,
      captureContractVersion: 1,
      recorder: "grimodex-ai-audit",
      appVersion: "2.0.10",
      exactPrompt: `prompt-${sequence}`,
    },
    payloadSha256: sequence.toString(16).padStart(64, "0"),
    prevHash: (sequence - 1).toString(16).padStart(64, "0"),
    hash: sequence.toString(16).padStart(64, "0"),
  };
}

const authorship: ProjectAuthorshipReport = {
  projectId: "project-1",
  projectTitle: "Contest Novel",
  generatedAt: "2026-08-03T00:00:00.000Z",
  scope: "body-text-only",
  totals: {
    human: 90,
    ai: 10,
    unknown: 0,
    unmarked: 0,
    total: 100,
    humanRatio: 0.9,
  },
  chapters: [],
  unparentedScenes: [],
};

const provenance = {
  projectId: "project-1",
  projectTitle: "Contest Novel",
  generatedAt: "2026-08-03T00:00:00.000Z",
  scope: "body-text-only",
  totals: authorship.totals,
  breakdown: {
    chat: 10,
    inlineAi: 0,
    beat: 0,
    orphanChat: 0,
    unknownAi: 0,
  },
  orphanChatCount: 0,
} as ProvenanceDisclosureReport;

function legacyEvidenceFixture(
  projectId: string = "project-1",
): LegacyEvidenceCollection {
  const empty = createEmptyLegacyEvidenceCollection(projectId);
  return {
    ...empty,
    totalRowCount: 1,
    artifacts: empty.artifacts.map((artifact) =>
      artifact.sourceTable === "chat_messages"
        ? {
            ...artifact,
            rowCount: 1,
            jsonl:
              '{"content":"legacy prompt and response evidence","id":"legacy-message-1"}\n',
          }
        : artifact,
    ),
  };
}

describe("AI audit bundle export", () => {
  it("paginates 10k events under one pinned high-water and packages project/workspace ledgers separately", async () => {
    const readCalls: Array<{
      projectId: string | null;
      afterSequence: number | undefined;
      highWaterSequence: number | undefined;
      limit: number | undefined;
      expectedWorkspacePath: string;
    }> = [];
    const dependencies: AiAuditBundleDependencies = {
      readSnapshot: vi.fn(async (projectId, options) => {
        readCalls.push({ projectId, ...options });
        if (projectId === null) {
          return {
            scopeId: "workspace",
            projectId: null,
            afterSequence: options.afterSequence ?? 0,
            highWaterSequence: 0,
            highWaterHash: "0".repeat(64),
            nextAfterSequence: null,
            events: [],
          };
        }
        const pinned = options.highWaterSequence ?? PROJECT_EVENT_COUNT;
        const after = options.afterSequence ?? 0;
        const end = Math.min(
          after + (options.limit ?? AI_AUDIT_EXPORT_PAGE_SIZE),
          pinned,
        );
        const events = Array.from(
          { length: Math.max(0, end - after) },
          (_, index) => event(after + index + 1),
        );
        return {
          scopeId: "project:project-1",
          projectId: "project-1",
          afterSequence: after,
          highWaterSequence: pinned,
          highWaterHash: PROJECT_EVENT_COUNT.toString(16).padStart(64, "0"),
          nextAfterSequence: end < pinned ? end : null,
          events,
        };
      }),
      verifyChain: vi.fn(async (projectId, options) => ({
        ok: true,
        verifiedThroughSequence: options.highWaterSequence ?? 0,
        brokenAtSequence: null,
        reason: null,
        tailHash:
          projectId === null
            ? "0".repeat(64)
            : PROJECT_EVENT_COUNT.toString(16).padStart(64, "0"),
      })),
      buildAuthorship: vi.fn(async () => authorship),
      buildProvenance: vi.fn(async () => provenance),
      buildLegacyEvidence: vi.fn(async (projectId) =>
        legacyEvidenceFixture(projectId),
      ),
    };

    const result = await buildAiAuditBundle("project-1", {
      generatedAt: "2026-08-03T03:00:00.000Z",
      dependencies,
    });
    const archive = unzipSync(result.bytes);
    const manifest = JSON.parse(
      strFromU8(archive["manifest.json"]),
    ) as AiAuditBundleManifest;
    const projectEvents = parseAiAuditJsonl(
      strFromU8(archive["ledger/project-events.jsonl"]),
    );

    expect(projectEvents).toHaveLength(PROJECT_EVENT_COUNT);
    expect(projectEvents.at(-1)?.sequence).toBe(PROJECT_EVENT_COUNT);
    expect(strFromU8(archive["ledger/workspace-events.jsonl"])).toBe("");
    expect(manifest.chains.project).toMatchObject({
      scopeId: "project:project-1",
      highWaterSequence: PROJECT_EVENT_COUNT,
      verify: { ok: true, verifiedThroughSequence: PROJECT_EVENT_COUNT },
      coverage: {
        eventCount: PROJECT_EVENT_COUNT,
        executionCount: PROJECT_EVENT_COUNT / 2,
        ambiguousExecutionCount: 0,
      },
    });
    expect(manifest.chains.workspace).toMatchObject({
      scopeId: "workspace",
      highWaterSequence: 0,
      coverage: { priorHistoryStatus: "no_recorded_events" },
    });
    expect(manifest.integrityLimitations).toMatchObject({
      localSelfAttestationOnly: true,
      administratorTamperResistance: false,
      backupRestoreMayRewindLedger: true,
      legacyEvidenceHashChained: false,
      changeEventEvidenceCarriesIndependentHashChainFields: true,
      changeEventEvidenceChainVerifiedByThisExport: false,
    });
    expect(manifest.observabilityLimitations).toMatchObject({
      externalChangeEventEvidenceIncluded: true,
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
    });
    expect(manifest.sections.currentRemainingAiContent.scope).toBe(
      "body-text-only",
    );
    expect(archive["reports/authorship-report.json"]).toBeDefined();
    expect(archive["reports/provenance-disclosure.json"]).toBeDefined();
    expect(archive["reports/execution-summary.json"]).toBeDefined();
    expect(archive["legacy-evidence/chat_messages.jsonl"]).toBeDefined();
    expect(archive["legacy-evidence/foreshadow_setups.jsonl"]).toBeDefined();
    expect(archive["legacy-evidence/prose_staging.jsonl"]).toBeDefined();
    expect(archive["legacy-evidence/change_events.jsonl"]).toBeDefined();
    expect(archive["legacy-evidence/undo_journal.jsonl"]).toBeDefined();
    expect(archive["legacy-evidence/authorship_spans.jsonl"]).toBeDefined();
    expect(archive["legacy-evidence/tree_nodes.jsonl"]).toBeDefined();
    expect(archive["legacy-evidence/codex_entries.jsonl"]).toBeDefined();
    expect(archive["legacy-evidence/codex_detail_values.jsonl"]).toBeDefined();
    expect(archive["legacy-evidence/codex_entry_phases.jsonl"]).toBeDefined();
    expect(archive["legacy-evidence/snippets.jsonl"]).toBeDefined();
    expect(archive["legacy-evidence/scene_chunks.jsonl"]).toBeDefined();
    expect(archive["legacy-evidence/codex_chunks.jsonl"]).toBeDefined();
    expect(archive["legacy-evidence/event_chunks.jsonl"]).toBeDefined();
    expect(archive["legacy-evidence/chat_message_chunks.jsonl"]).toBeDefined();
    expect(archive["legacy-evidence/trash_items.jsonl"]).toBeDefined();
    expect(strFromU8(archive["legacy-evidence/chat_messages.jsonl"])).toContain(
      "legacy prompt and response evidence",
    );
    expect(manifest.sections.forwardExecutionLedger).toMatchObject({
      projectLedgerFile: "ledger/project-events.jsonl",
      workspaceLedgerFile: "ledger/workspace-events.jsonl",
    });
    expect(manifest.sections.selectedSurvivingLegacyEvidence).toMatchObject({
      directory: "legacy-evidence/",
      artifactCount: 31,
      totalRowCount: 1,
      snapshotAtomic: false,
    });
    expect(manifest.legacyEvidence.artifacts).toHaveLength(31);
    expect(manifest.legacyEvidence.artifacts).toContainEqual(
      expect.objectContaining({
        file: "legacy-evidence/chat_messages.jsonl",
        sourceTable: "chat_messages",
        rowCount: 1,
        captureClass: "full",
      }),
    );
    expect(manifest.files["legacy-evidence/chat_messages.jsonl"]).toMatchObject(
      { bytes: expect.any(Number), sha256: expect.any(String) },
    );
    expect(Object.keys(manifest.files).sort()).toEqual(
      Object.keys(archive)
        .filter((path) => path !== "manifest.json")
        .sort(),
    );
    for (const [path, file] of Object.entries(manifest.files)) {
      const bytes = archive[path]!;
      expect(bytes, path).toBeDefined();
      const copy = new Uint8Array(bytes.byteLength);
      copy.set(bytes);
      const digest = await crypto.subtle.digest("SHA-256", copy.buffer);
      const sha256 = Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join("");
      expect(file, path).toEqual({ sha256, bytes: bytes.byteLength });
    }
    const executionSummary = JSON.parse(
      strFromU8(archive["reports/execution-summary.json"]),
    ) as {
      overallIntegrityStatus: string;
      pathRegistryCoverage: { observedUnregisteredPathIds: string[] };
      interpretation: { dispatchAndTransport: string };
    };
    expect(executionSummary.overallIntegrityStatus).toBe("verified");
    expect(
      executionSummary.pathRegistryCoverage.observedUnregisteredPathIds,
    ).toEqual(["review.comment", "synopsis.generate"]);
    expect(strFromU8(archive["README.md"])).toContain(
      "including executions whose output was not inserted into the manuscript",
    );
    expect(strFromU8(archive["README.md"])).toContain(
      "Selected surviving legacy evidence",
    );
    expect(strFromU8(archive["README.md"])).toContain(
      "not a full database archive",
    );
    expect(strFromU8(archive["README.md"])).toContain("content_versions");
    expect(strFromU8(archive["README.md"])).toContain("project_snapshot_*");
    expect(strFromU8(archive["README.md"])).toContain("state_snapshots");
    expect(strFromU8(archive["README.md"])).toContain(
      "impact_review_baselines",
    );
    expect(strFromU8(archive["README.md"])).toContain(
      "chat_session_pinned_codex",
    );
    expect(strFromU8(archive["README.md"])).toContain(
      "extremely large audit history can exhaust available memory",
    );
    expect(strFromU8(archive["README.md"])).toContain(
      "does not emit a partial ZIP",
    );
    expect(strFromU8(archive["README.md"])).toContain(
      "user-role chat-message link is never treated as AI origin",
    );
    expect(strFromU8(archive["README.md"])).toContain("Raw embedding BLOBs");
    expect(strFromU8(archive["README.md"])).toContain(
      "Malformed payload or nested ProseMirror JSON is excluded",
    );
    expect(strFromU8(archive["README.md"])).toContain(
      "not one atomic multi-table database snapshot",
    );
    expect(strFromU8(archive["README.md"])).toContain(
      "secrets supplied in model-visible content may be present",
    );
    expect(strFromU8(archive["README.md"])).toContain(
      "including proposed, accepted, rejected, or stale rows",
    );
    expect(strFromU8(archive["README.md"])).toContain(
      "mixes human, AI, system, and external-tool events",
    );
    expect(strFromU8(archive["README.md"])).toContain(
      "does not verify that separate chain",
    );
    expect(strFromU8(archive["README.md"])).not.toContain(
      "## 2. All recorded AI executions",
    );
    expect(strFromU8(archive["README.md"])).toContain(
      "application-to-selected transport dispatch event, not an HTTP send, attempt, or provider receipt",
    );
    expect(strFromU8(archive["README.md"])).toContain("attemptNumber > 1");
    expect(strFromU8(archive["README.md"])).toContain(
      "durable pre-send retry starts",
    );
    expect(strFromU8(archive["README.md"])).toContain(
      "not proof that the process survived",
    );
    expect(strFromU8(archive["README.md"])).toContain(
      "complete credential-free JSON value",
    );
    expect(strFromU8(archive["README.md"])).toContain(
      "serialization whitespace, key order, and byte representation are not preserved",
    );
    expect(strFromU8(archive["README.md"])).toContain(
      "durable journal ACK before fetch",
    );
    expect(strFromU8(archive["README.md"])).toContain(
      "prompt-free runner preload",
    );
    expect(strFromU8(archive["README.md"])).toContain(
      "provider-selected model identities are unobservable",
    );
    expect(strFromU8(archive["README.md"])).toContain(
      "abortCommandAcknowledged records only that the local",
    );
    expect(strFromU8(archive["README.md"])).toContain(
      "Every observed response and transport-attempt event must be durably appended before the execution's single terminal event",
    );
    expect(strFromU8(archive["README.md"])).toContain(
      "Project post-terminal lifecycle anomalies: events=0; executions=0; transport-attempt events=0",
    );
    expect(strFromU8(archive["README.md"])).toContain(
      "A nonzero value is a lifecycle/correlation integrity anomaly",
    );
    expect(strFromU8(archive["README.md"])).toContain(
      "sendPhase=pre-send-cancelled",
    );
    expect(strFromU8(archive["README.md"])).toContain(
      "normally attemptNumber - 1",
    );
    expect(strFromU8(archive["README.md"])).not.toContain(
      "may be appended after that terminal",
    );
    expect(executionSummary.interpretation.dispatchAndTransport).toContain(
      "do not prove all provider HTTP sends",
    );
    expect(executionSummary.interpretation.dispatchAndTransport).toContain(
      "application-to-selected transport",
    );
    expect(executionSummary.interpretation.dispatchAndTransport).toContain(
      "not HTTP attempts or provider receipts",
    );
    expect(executionSummary.interpretation.dispatchAndTransport).toContain(
      "abortCommandAcknowledged records only a local command-boundary acknowledgement",
    );
    expect(executionSummary.interpretation.dispatchAndTransport).toContain(
      "durable pre-send observation",
    );
    expect(executionSummary.interpretation.dispatchAndTransport).toContain(
      "expected to be zero",
    );
    expect(executionSummary.interpretation.dispatchAndTransport).toContain(
      "lifecycle/correlation integrity anomaly",
    );
    expect(executionSummary.interpretation.dispatchAndTransport).toContain(
      "sendPhase=pre-send-cancelled",
    );
    expect(executionSummary.interpretation.dispatchAndTransport).toContain(
      "attemptNumber - 1",
    );
    expect(executionSummary.interpretation.dispatchAndTransport).not.toContain(
      "may be appended after the terminal",
    );

    const projectReads = readCalls.filter(
      (call) => call.projectId === "project-1",
    );
    expect(projectReads).toHaveLength(10);
    expect(projectReads[0].highWaterSequence).toBeUndefined();
    expect(
      projectReads
        .slice(1)
        .every((call) => call.highWaterSequence === PROJECT_EVENT_COUNT),
    ).toBe(true);
    expect(projectReads.every((call) => call.limit === 1_000)).toBe(true);
    expect(
      readCalls.every(
        (call) => call.expectedWorkspacePath === "dependency-pinned-workspace",
      ),
    ).toBe(true);
  });

  function emptyDependencies(
    verifyTailHash: string = "0".repeat(64),
  ): AiAuditBundleDependencies {
    return {
      readSnapshot: vi.fn(async (projectId, options) => ({
        scopeId: projectId === null ? "workspace" : `project:${projectId}`,
        projectId,
        afterSequence: options.afterSequence ?? 0,
        highWaterSequence: 0,
        highWaterHash: "0".repeat(64),
        nextAfterSequence: null,
        events: [],
      })),
      verifyChain: vi.fn(async () => ({
        ok: true,
        verifiedThroughSequence: 0,
        brokenAtSequence: null,
        reason: null,
        tailHash: verifyTailHash,
      })),
      buildAuthorship: vi.fn(async () => authorship),
      buildProvenance: vi.fn(async () => provenance),
      buildLegacyEvidence: vi.fn(async (projectId) =>
        legacyEvidenceFixture(projectId),
      ),
    };
  }

  it("keeps partial-observable paths audit-required without classifying observations as unregistered", async () => {
    const partialEvent = {
      ...event(1),
      pathId: "semantic_search",
    } satisfies AiAuditStoredEvent;
    const dependencies: AiAuditBundleDependencies = {
      ...emptyDependencies(),
      readSnapshot: vi.fn(async (projectId, options) => {
        if (projectId === null) {
          return {
            scopeId: "workspace",
            projectId: null,
            afterSequence: options.afterSequence ?? 0,
            highWaterSequence: 0,
            highWaterHash: "0".repeat(64),
            nextAfterSequence: null,
            events: [],
          };
        }
        return {
          scopeId: `project:${projectId}`,
          projectId,
          afterSequence: options.afterSequence ?? 0,
          highWaterSequence: 1,
          highWaterHash: partialEvent.hash,
          nextAfterSequence: null,
          events: [partialEvent],
        };
      }),
      verifyChain: vi.fn(async (projectId) => ({
        ok: true,
        verifiedThroughSequence: projectId === null ? 0 : 1,
        brokenAtSequence: null,
        reason: null,
        tailHash: projectId === null ? "0".repeat(64) : partialEvent.hash,
      })),
    };

    const result = await buildAiAuditBundle("project-1", { dependencies });
    const coverage = result.manifest.pathRegistryCoverage;

    expect(coverage.fullObservablePathIds).not.toContain("semantic_search");
    expect(coverage.fullObservablePathIds).toContain("ai_connection_test");
    expect(coverage.partialObservablePathIds).toEqual(
      expect.arrayContaining(["semantic_embedding_index", "semantic_search"]),
    );
    expect(coverage.auditRequiredPathIds).toContain("semantic_search");
    expect(coverage.observedAuditRequiredPathIds).toContain("semantic_search");
    expect(coverage.auditRequiredButUnobservedPathIds).not.toContain(
      "semantic_search",
    );
    expect(coverage.observedUnregisteredPathIds).not.toContain(
      "semantic_search",
    );
    expect(coverage.auditRequiredPathIds).not.toContain("browser_byok_web");
    expect(result.manifest.runtimeRouteRegistryCoverage).toMatchObject({
      registeredRuntimeRouteIds: ["browser_byok_web"],
      allRoutesHaveAuditContract: true,
      allRoutesHaveConsentContract: true,
      ledgerUsageObservation: "not-derived-from-a-distinct-runtime-path-id",
    });
    expect(
      result.manifest.runtimeRouteRegistryCoverage
        .fullObservableRuntimeRouteIds,
    ).toContain("browser_byok_web");
    expect(
      result.manifest.runtimeRouteRegistryCoverage
        .partialObservableRuntimeRouteIds,
    ).not.toContain("browser_byok_web");
  });

  it("creates byte-identical ZIPs for the same generatedAt and inputs", async () => {
    const dependencies = emptyDependencies();
    const options = {
      generatedAt: "2026-08-03T03:00:00.000Z",
      dependencies,
    } as const;
    const first = await buildAiAuditBundle("project-1", options);
    const second = await buildAiAuditBundle("project-1", options);

    expect(second.bytes).toEqual(first.bytes);
  });

  it("rejects a legacy-evidence fixture whose declared project differs from the export", async () => {
    const dependencies: AiAuditBundleDependencies = {
      ...emptyDependencies(),
      buildLegacyEvidence: vi.fn(async () =>
        createEmptyLegacyEvidenceCollection("project-2"),
      ),
    };

    await expect(
      buildAiAuditBundle("project-1", { dependencies }),
    ).rejects.toThrow(/legacy evidence.*project/i);
  });

  it("rejects an incomplete or duplicate legacy-evidence artifact list", async () => {
    const incomplete = createEmptyLegacyEvidenceCollection("project-1");
    const dependencies: AiAuditBundleDependencies = {
      ...emptyDependencies(),
      buildLegacyEvidence: vi.fn(async () => ({
        ...incomplete,
        artifacts: [incomplete.artifacts[0]!, incomplete.artifacts[0]!],
      })),
    };

    await expect(
      buildAiAuditBundle("project-1", { dependencies }),
    ).rejects.toThrow(/legacy evidence.*artifact/i);
  });

  it("exports raw ledgers while making a verify tail mismatch prominent", async () => {
    const result = await buildAiAuditBundle("project-1", {
      generatedAt: "2026-08-03T03:00:00.000Z",
      dependencies: emptyDependencies("f".repeat(64)),
    });
    const archive = unzipSync(result.bytes);

    expect(result.manifest.integrityLimitations.verificationFailed).toBe(true);
    expect(result.manifest.chains.project.verification).toMatchObject({
      status: "verificationFailed",
      verificationFailed: true,
    });
    expect(strFromU8(archive["README.md"])).toContain("VERIFICATION FAILED");
    expect(strFromU8(archive["README.md"])).toContain(
      "Scope, sequence, pagination, or snapshot-read contract failures stop export",
    );
    expect(strFromU8(archive["ledger/project-events.jsonl"])).toBe("");
  });

  it("rejects a first snapshot page with the wrong scope identity", async () => {
    const dependencies: AiAuditBundleDependencies = {
      ...emptyDependencies(),
      readSnapshot: vi.fn(async (projectId, options) => ({
        scopeId: "workspace",
        projectId,
        afterSequence: options.afterSequence ?? 0,
        highWaterSequence: 0,
        highWaterHash: "0".repeat(64),
        nextAfterSequence: null,
        events: [],
      })),
    };

    await expect(
      buildAiAuditBundle("project-1", { dependencies }),
    ).rejects.toThrow("first snapshot page violated its scope contract");
  });

  it("rejects a page that skips a sequence before its pinned high-water", async () => {
    const dependencies: AiAuditBundleDependencies = {
      ...emptyDependencies(),
      readSnapshot: vi.fn(async (projectId, options) => {
        if (projectId === null) {
          return {
            scopeId: "workspace",
            projectId: null,
            afterSequence: 0,
            highWaterSequence: 0,
            highWaterHash: "0".repeat(64),
            nextAfterSequence: null,
            events: [],
          };
        }
        return {
          scopeId: `project:${projectId}`,
          projectId,
          afterSequence: options.afterSequence ?? 0,
          highWaterSequence: 500,
          highWaterHash: "f".repeat(64),
          nextAfterSequence: null,
          events: [event(1), event(500)],
        };
      }),
    };

    await expect(
      buildAiAuditBundle("project-1", { dependencies }),
    ).rejects.toThrow("event violated its pinned snapshot scope contract");
  });

  it("aborts instead of mixing data when the active workspace changes", async () => {
    let currentWorkspacePath = "/workspaces/original";
    const base = emptyDependencies();
    const dependencies: AiAuditBundleDependencies = {
      ...base,
      snapshotWorkspacePath: () => currentWorkspacePath,
      assertWorkspaceUnchanged: (expectedWorkspacePath) => {
        if (currentWorkspacePath !== expectedWorkspacePath) {
          throw new Error("AI_AUDIT_WORKSPACE_CHANGED");
        }
      },
      buildAuthorship: vi.fn(async () => {
        currentWorkspacePath = "/workspaces/other";
        return authorship;
      }),
    };

    await expect(
      buildAiAuditBundle("project-1", { dependencies }),
    ).rejects.toThrow("AI_AUDIT_WORKSPACE_CHANGED");
    expect(base.readSnapshot).not.toHaveBeenCalled();
  });
});
