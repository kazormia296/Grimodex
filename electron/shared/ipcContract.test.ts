/**
 * ipcContract の純関数部の単体テスト（設計書 §8 S4:
 * allowlist / envelope / 引数アダプタ）。node 環境（vitest.electron.config.ts）。
 */
import { describe, expect, it, vi } from "vitest";

import {
  BACKEND_EVENT_CHANNEL_ALLOWLIST,
  clampZoomFactor,
  dispatchInvoke,
  EVENT_CHANNEL_ALLOWLIST,
  IPC_BACKEND_UNAVAILABLE_MARKER,
  IPC_UNIMPLEMENTED_MARKER,
  isAllowedBackendEventChannel,
  isAllowedEventChannel,
  isAllowedMainEventChannel,
  isAllowedRendererEventChannel,
  isSafeExternalUrl,
  MAIN_EVENT_CHANNEL_ALLOWLIST,
  NAPI_COMMANDS,
  RENDERER_EVENT_CHANNEL_ALLOWLIST,
  SHELL_COMMAND_NAMES,
  toErrorString,
  unimplementedError,
} from "./ipcContract.js";
import type { NapiBackendLike } from "./ipcContract.js";

// ─────────────────────────────────────────────────────────────────────────────
// フェイク Backend（呼び出し記録 + JSON 文字列返し = napi ワイヤと同形）
// ─────────────────────────────────────────────────────────────────────────────

interface Call {
  method: string;
  args: unknown[];
}

function mutationIdentity(requestId: string, projectId = "p1") {
  return {
    projectId,
    requestId,
    sessionId: "ipc-contract-session",
    eventUid: `event-${requestId}`,
    origin: "human",
    authorityRoute: "human-direct",
    caller: "manual-wrapper",
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
  } as const;
}

function scanPublishIdentity(
  requestId = "scan-publish-request-1",
  projectId = "project-1",
) {
  return {
    projectId,
    requestId,
    sessionId: "scan-publish-session-1",
    eventUid: "scan-publish-event-1",
    origin: "import",
    authorityRoute: "import-apply",
    caller: "import-session",
    controls: [
      "import-policy",
      "source-package-evidence",
      "typed-writer",
      "occ",
      "change-event",
      "change-feed",
    ],
    provenance: null,
    writesAuthorityProtectedField: false,
    originalTransactionId: null,
    undoJournalId: null,
  } as const;
}

/** 必須キー欠落ケースを組み立てる（テスト用の最小 omit）。 */
function omitKey<T extends Record<string, unknown>>(
  source: T,
  key: keyof T & string,
): Record<string, unknown> {
  const clone: Record<string, unknown> = { ...source };
  delete clone[key];
  return clone;
}

// Gate C2-T1 Attention typed writer の wire 契約
// （actor identity 必須 / requestId による idempotency / expectedVersion の OCC）。
const MAINTENANCE_ATTENTION_SET_PAYLOAD = {
  projectId: "project-1",
  findingKey: "finding-1",
  disposition: "snoozed",
  materialBasisDigest: "digest-1",
  actorId: "actor-1",
  requestId: "req-attention-1",
  expectedVersion: 0,
};

const MAINTENANCE_ATTENTION_CLEAR_PAYLOAD = {
  projectId: "project-1",
  findingKey: "finding-1",
  actorId: "actor-1",
  requestId: "req-attention-2",
  expectedVersion: 3,
};

// Gate C2 dependency-repair の wire 契約。run kind policy が
// requiredPreconditions: stable-request-id / sameRequestIdReuse:
// idempotent-replay を宣言しているので、preview / apply どちらでも
// requestId（再送の同一性）と actorId（承認者）が必須。
const REPAIR_DEPENDENCY_PREVIEW_PAYLOAD = {
  projectId: "project-1",
  verifyRunId: "verify-1",
  requestId: "req-repair-1",
  actorId: "actor-1",
};

const REPAIR_DEPENDENCY_APPLY_PAYLOAD = {
  ...REPAIR_DEPENDENCY_PREVIEW_PAYLOAD,
  apply: true,
  planDigest: "sha256:abc",
  leaseOwner: "renderer-session-1",
};

// agent_writes 系の代表返り値（AgentWriteResult / ProseStageResult、camelCase）。
const AGENT_WRITE_RESULT = Promise.resolve(
  '{"entityId":"e1","version":1,"changeEventUid":"ce1","undoJournalId":"uj1"}',
);
const CHRONICLE_BULK_RESULT = Promise.resolve(
  '{"eventResults":[],"sceneResults":[],"changeEventUid":"ce1","undoJournalId":"uj1"}',
);
const PROSE_STAGE_RESULT = Promise.resolve(
  '{"stagingId":"st1","sceneId":"s1","status":"proposed"}',
);
const IME_EXPORT_STATUS_VALUE = {
  rootPath: "/tmp/grimodex/ime",
  consumers: [],
  activeProjectId: "p1",
  exportedProjectCount: 1,
  effectiveEnabled: true,
};
const IME_EXPORT_STATUS = Promise.resolve(
  JSON.stringify(IME_EXPORT_STATUS_VALUE),
);

function fakeBackend(overrides: Partial<NapiBackendLike> = {}): {
  backend: NapiBackendLike;
  calls: Call[];
} {
  const calls: Call[] = [];
  const record =
    (method: string, result: unknown) =>
    (...args: unknown[]) => {
      calls.push({ method, args });
      return result;
    };
  const backend: NapiBackendLike = {
    dbExecute: record("dbExecute", Promise.resolve('{"rows":[[1]]}')) as never,
    dbExecuteBatch: record(
      "dbExecuteBatch",
      Promise.resolve('{"rows":[]}'),
    ) as never,
    narrativeRuntimePolicyGet: record(
      "narrativeRuntimePolicyGet",
      Promise.resolve(
        '{"runtimeMode":"review-only","maintenanceEnabled":false,"genericImportEnabled":false,"backgroundAiEnabled":false,"version":1,"effectiveMode":"review-only","maintenancePreviewAllowed":false}',
      ),
    ) as never,
    narrativeRuntimePolicySet: record(
      "narrativeRuntimePolicySet",
      Promise.resolve(
        '{"runtimeMode":"manual-apply","maintenanceEnabled":false,"genericImportEnabled":false,"backgroundAiEnabled":false,"version":2,"effectiveMode":"manual-apply","maintenancePreviewAllowed":false}',
      ),
    ) as never,
    saveSceneBodyBundle: record(
      "saveSceneBodyBundle",
      Promise.resolve(
        '{"placedBeatPreview":null,"unplacedBeatPreview":null,"contentVersion":2,"contentUpdatedAt":"2026-07-28T00:00:00.000Z","dbTransactionCount":1,"foreshadowRows":[]}',
      ),
    ) as never,
    runtimePerformanceSeed: record(
      "runtimePerformanceSeed",
      Promise.resolve(
        '{"fixtureId":"runtime-fixture","insertedRowCount":3,"dbTransactionCount":1,"historySideEffectCount":0}',
      ),
    ) as never,
    vacuumDatabase: record(
      "vacuumDatabase",
      Promise.resolve(undefined),
    ) as never,
    openWorkspace: record(
      "openWorkspace",
      Promise.resolve(
        '{"status":"ready","workspace":{"name":"ws","isExisting":true,"workspaceId":"workspace-id"}}',
      ),
    ) as never,
    validateWorkspacePath: record("validateWorkspacePath", true) as never,
    getGlobalSettings: record(
      "getGlobalSettings",
      Promise.resolve('{"uiScale":100}'),
    ) as never,
    saveGlobalSettings: record(
      "saveGlobalSettings",
      Promise.resolve(undefined),
    ) as never,
    timelapseAppendBatch: record(
      "timelapseAppendBatch",
      Promise.resolve('{"insertedCount":1,"tailSequence":2,"tailHash":"h"}'),
    ) as never,
    timelapseGenesisBaselinesAppend: record(
      "timelapseGenesisBaselinesAppend",
      Promise.resolve(
        '{"insertedCount":2,"skippedExistingBaselineCount":1,"skippedExistingBodyStepCount":1}',
      ),
    ) as never,
    timelapseBodyBaselinesAppend: record(
      "timelapseBodyBaselinesAppend",
      Promise.resolve(
        '{"insertedCount":2,"skippedExistingCount":1,"anchorSequence":7,"anchorTimestamp":1800000000000}',
      ),
    ) as never,
    timelapseHistoryPurge: record(
      "timelapseHistoryPurge",
      Promise.resolve(
        '{"deletedEventCount":3,"deletedSnapshotCount":2}',
      ),
    ) as never,
    timelapseEnabledSet: record(
      "timelapseEnabledSet",
      Promise.resolve('{"enabled":true}'),
    ) as never,
    timelapseLayoutSnapshotRecord: record(
      "timelapseLayoutSnapshotRecord",
      Promise.resolve(
        '{"inserted":true,"anchorSequence":7,"anchorTimestamp":1800000000000}',
      ),
    ) as never,
    aiAuditAppendBatch: record(
      "aiAuditAppendBatch",
      Promise.resolve(
        '{"insertedCount":2,"tailSequence":2,"tailHash":"audit-h"}',
      ),
    ) as never,
    aiAuditClaimCliDispatch: record(
      "aiAuditClaimCliDispatch",
      Promise.resolve(
        '{"insertedCount":1,"tailSequence":4,"tailHash":"claim-h"}',
      ),
    ) as never,
    aiAuditReadSnapshot: record(
      "aiAuditReadSnapshot",
      Promise.resolve(
        '{"scopeId":"project:p1","projectId":"p1","afterSequence":0,"highWaterSequence":2,"highWaterHash":"audit-h","nextAfterSequence":null,"events":[]}',
      ),
    ) as never,
    aiAuditVerify: record(
      "aiAuditVerify",
      Promise.resolve(
        '{"ok":true,"verifiedThroughSequence":2,"brokenAtSequence":null,"reason":null,"tailHash":"audit-h"}',
      ),
    ) as never,
    // IME 連携 Phase 2（Status DTO は JSON 文字列、clear/remove は unit）
    imeExportRefresh: record("imeExportRefresh", IME_EXPORT_STATUS) as never,
    imeExportSetActiveProject: record(
      "imeExportSetActiveProject",
      IME_EXPORT_STATUS,
    ) as never,
    imeExportDeactivateOnExit: record(
      "imeExportDeactivateOnExit",
      undefined,
    ) as never,
    imeExportGetStatus: record(
      "imeExportGetStatus",
      IME_EXPORT_STATUS,
    ) as never,
    imeExportClearAll: record(
      "imeExportClearAll",
      Promise.resolve(undefined),
    ) as never,
    imeExportRemoveProject: record(
      "imeExportRemoveProject",
      Promise.resolve(undefined),
    ) as never,
    // trash_bin commands（create/list は SELECT * の snake_case 生行）
    trashBinCreate: record(
      "trashBinCreate",
      Promise.resolve('{"id":"t1","preview_text":"消した文字屑"}'),
    ) as never,
    trashBinRestore: record(
      "trashBinRestore",
      Promise.resolve('{"newId":"restored-scene:t1","brokenLinks":[]}'),
    ) as never,
    trashBinList: record(
      "trashBinList",
      Promise.resolve('[{"id":"t1","preview_text":"消した文字屑"}]'),
    ) as never,
    trashBinDelete: record(
      "trashBinDelete",
      Promise.resolve(undefined),
    ) as never,
    trashBinClearAll: record(
      "trashBinClearAll",
      Promise.resolve(undefined),
    ) as never,
    trashBinPrune: record("trashBinPrune", Promise.resolve("42")) as never,
    // integrity / FTS 6 コマンド（Phase 3 バッチ1）
    ftsOptimize: record("ftsOptimize", Promise.resolve(undefined)) as never,
    ftsRebuild: record("ftsRebuild", Promise.resolve(undefined)) as never,
    ftsRebuildEn: record("ftsRebuildEn", Promise.resolve(undefined)) as never,
    ftsSearch: record(
      "ftsSearch",
      Promise.resolve('[{"sourceType":"scene","id":"s1"}]'),
    ) as never,
    integrityCheck: record(
      "integrityCheck",
      Promise.resolve('{"orphans":0}'),
    ) as never,
    repairIntegrity: record(
      "repairIntegrity",
      Promise.resolve('{"repaired":0}'),
    ) as never,
    // lint / reorder / fonts（Phase 3 バッチ1b）
    lintText: record(
      "lintText",
      Promise.resolve('{"diagnostics":[]}'),
    ) as never,
    segmentBunsetsu: record(
      "segmentBunsetsu",
      Promise.resolve('[{"start":0,"end":3,"surface":"走れ"}]'),
    ) as never,
    listSystemFonts: record(
      "listSystemFonts",
      Promise.resolve('["Noto Sans JP"]'),
    ) as never,
    // codex 名寄せマッチャ（Phase 3 バッチ1c）
    codexRebuildMatcher: record(
      "codexRebuildMatcher",
      Promise.resolve(undefined),
    ) as never,
    codexMatchText: record(
      "codexMatchText",
      Promise.resolve(
        '[{"entryId":"c1","entryName":"太郎","entryType":"character","from":0,"to":2}]',
      ),
    ) as never,
    extractCodexCandidates: record(
      "extractCodexCandidates",
      Promise.resolve(
        '[{"surface":"京都","lemma":"京都","count":2,"firstSceneId":"s1","context":"京都へ行った。"}]',
      ),
    ) as never,
    extractCodexEntitySeeds: record(
      "extractCodexEntitySeeds",
      Promise.resolve(
        JSON.stringify({
          schemaVersion: 1,
          seeds: [
            {
              seedId: "CES1-deadbeef",
              surface: "京都",
              normalizedSurface: "京都",
              occurrences: [
                {
                  sourceRef: "S000001",
                  quote: "京都",
                  canonicalRange: { start: 2, end: 4 },
                  context: { prefix: "🎉", suffix: "へ行った。" },
                },
              ],
              features: {
                occurrenceCount: 1,
                appearsAsProperName: true,
                appearsInDialogue: false,
                appearsInNarration: true,
              },
            },
          ],
        }),
      ),
    ) as never,
    // plot_threads 8 コマンド（Phase 3 バッチ1 — napi は SELECT * の生行 =
    // snake_case 列名 / Vec<Value> を返す）
    plotThreadCreate: record(
      "plotThreadCreate",
      Promise.resolve('{"id":"pt1","project_id":"p1","name":"糸"}'),
    ) as never,
    plotThreadUpdate: record(
      "plotThreadUpdate",
      Promise.resolve('{"id":"pt1","name":"改名"}'),
    ) as never,
    plotThreadDelete: record(
      "plotThreadDelete",
      Promise.resolve(
        '{"id":"pt1","deleted":true,"maintenanceTransactionId":"plot-delete-tx"}',
      ),
    ) as never,
    plotThreadList: record(
      "plotThreadList",
      Promise.resolve('[{"id":"pt1","name":"糸"}]'),
    ) as never,
    plotThreadLinkCreate: record(
      "plotThreadLinkCreate",
      Promise.resolve('{"id":"pl1","thread_id":"pt1","node_id":"s1"}'),
    ) as never,
    plotThreadBranchCreate: record(
      "plotThreadBranchCreate",
      Promise.resolve(
        '{"id":"pb1","project_id":"p1","from_thread_id":"pt1","to_thread_id":"pt2","at_node_id":"s1","kind":"branch"}',
      ),
    ) as never,
    plotThreadBranchUpdate: record(
      "plotThreadBranchUpdate",
      Promise.resolve(
        '{"id":"pb1","project_id":"p1","from_thread_id":"pt1","to_thread_id":"pt2","at_node_id":"s2","kind":"branch","version":1}',
      ),
    ) as never,
    plotThreadBranchDelete: record(
      "plotThreadBranchDelete",
      Promise.resolve('{"id":"pb1","deleted":true}'),
    ) as never,
    plotThreadMoveMarkerBundle: record(
      "plotThreadMoveMarkerBundle",
      Promise.resolve(
        '{"id":"move-1","marker":{"id":"pl1","threadId":"pt2","nodeId":"s2","phaseType":"turn","note":null,"sortOrder":null,"createdAt":"2026-01-01T00:00:00.000Z","updatedAt":"2026-01-02T00:00:00.000Z"},"branches":[],"deletedBranchIds":[],"__idempotency":{"replayed":false,"entityPresent":true}}',
      ),
    ) as never,
    plotThreadRestoreSnapshot: record(
      "plotThreadRestoreSnapshot",
      Promise.resolve(
        '{"id":"restore-1","thread":null,"links":[],"branches":[],"__idempotency":{"replayed":false,"entityPresent":true}}',
      ),
    ) as never,
    plotThreadDeleteSnapshot: record(
      "plotThreadDeleteSnapshot",
      Promise.resolve(
        '{"id":"delete-1","deleted":true,"__idempotency":{"replayed":false,"entityPresent":true}}',
      ),
    ) as never,
    plotThreadLinkUpdate: record(
      "plotThreadLinkUpdate",
      Promise.resolve('{"id":"pl1","thread_id":"pt2"}'),
    ) as never,
    plotThreadLinkDelete: record(
      "plotThreadLinkDelete",
      Promise.resolve(
        '{"id":"pl1","deleted":true,"maintenanceTransactionId":"plot-link-delete-tx"}',
      ),
    ) as never,
    plotThreadListLinks: record(
      "plotThreadListLinks",
      Promise.resolve('[{"id":"pl1","thread_id":"pt1"}]'),
    ) as never,
    // foreshadow 20 コマンド（Phase 3 バッチ1）
    foreshadowCreate: record(
      "foreshadowCreate",
      Promise.resolve('{"id":"f1","project_id":"p1","title":"伏線"}'),
    ) as never,
    foreshadowUpdate: record(
      "foreshadowUpdate",
      Promise.resolve(
        '{"id":"f1","project_id":"p1","title":"改名","version":1}',
      ),
    ) as never,
    foreshadowDelete: record(
      "foreshadowDelete",
      Promise.resolve(
        '{"entityId":"f1","projectId":"p1","version":1,"changeEventUid":"ce1","undoJournalId":"uj1","maintenanceTransactionId":"foreshadow-delete-tx"}',
      ),
    ) as never,
    foreshadowListWithLabels: record(
      "foreshadowListWithLabels",
      Promise.resolve('{"foreshadows":[],"setups":[]}'),
    ) as never,
    foreshadowListOpenForContext: record(
      "foreshadowListOpenForContext",
      Promise.resolve('{"foreshadows":[],"setups":[]}'),
    ) as never,
    foreshadowGetSceneInfo: record(
      "foreshadowGetSceneInfo",
      Promise.resolve('{"setupForeshadowIds":[],"payoffForeshadowIds":[]}'),
    ) as never,
    foreshadowGetSceneContext: record(
      "foreshadowGetSceneContext",
      Promise.resolve('{"setups":[],"payoffs":[],"setupSceneRows":[]}'),
    ) as never,
    foreshadowListByCodexEntry: record(
      "foreshadowListByCodexEntry",
      Promise.resolve('{"foreshadows":[],"setups":[]}'),
    ) as never,
    foreshadowGetChapterStats: record(
      "foreshadowGetChapterStats",
      Promise.resolve(
        '{"scenes":[],"setupsOnScenes":[],"payoffForeshadows":[],"relatedForeshadows":[],"relatedSetups":[]}',
      ),
    ) as never,
    foreshadowGetSetup: record(
      "foreshadowGetSetup",
      Promise.resolve('{"id":"su1","is_orphan":0}'),
    ) as never,
    foreshadowUpdateSetup: record(
      "foreshadowUpdateSetup",
      Promise.resolve('{"id":"f1","project_id":"p1","version":1}'),
    ) as never,
    foreshadowGet: record(
      "foreshadowGet",
      Promise.resolve('{"foreshadow":{"id":"f1"},"setups":[]}'),
    ) as never,
    foreshadowLinkCodex: record(
      "foreshadowLinkCodex",
      Promise.resolve('{"id":"f1","project_id":"p1","version":1}'),
    ) as never,
    foreshadowUnlinkCodex: record(
      "foreshadowUnlinkCodex",
      Promise.resolve('{"id":"f1","project_id":"p1","version":2}'),
    ) as never,
    foreshadowListLinkedCodex: record(
      "foreshadowListLinkedCodex",
      Promise.resolve('[{"id":"c1","name":"太郎"}]'),
    ) as never,
    foreshadowSetSetupStrength: record(
      "foreshadowSetSetupStrength",
      Promise.resolve('{"id":"f1","project_id":"p1","version":1}'),
    ) as never,
    foreshadowSetupCreateAi: record(
      "foreshadowSetupCreateAi",
      Promise.resolve('{"id":"f1","project_id":"p1","version":1}'),
    ) as never,
    foreshadowResolveOrphan: record(
      "foreshadowResolveOrphan",
      Promise.resolve(
        '{"setupId":"new-setup-id","foreshadow":{"id":"f1","project_id":"p1","version":1}}',
      ),
    ) as never,
    foreshadowSaveAnchorsForScene: record(
      "foreshadowSaveAnchorsForScene",
      Promise.resolve('[{"id":"f1","project_id":"p1","version":1}]'),
    ) as never,
    foreshadowLoadAnchorsForScene: record(
      "foreshadowLoadAnchorsForScene",
      Promise.resolve(
        '[{"from":10,"to":20,"markName":"foreshadowSetup","attrs":{"setupId":"su1","foreshadowId":"f1"}}]',
      ),
    ) as never,
    // agent_writes 19 コマンド（tracked write result は camelCase）
    agentCodexCreate: record("agentCodexCreate", AGENT_WRITE_RESULT) as never,
    agentCodexUpdate: record("agentCodexUpdate", AGENT_WRITE_RESULT) as never,
    agentCodexDelete: record("agentCodexDelete", AGENT_WRITE_RESULT) as never,
    codexCreate: record("codexCreate", AGENT_WRITE_RESULT) as never,
    codexUpdate: record("codexUpdate", AGENT_WRITE_RESULT) as never,
    codexDelete: record("codexDelete", AGENT_WRITE_RESULT) as never,
    codexMutate: record("codexMutate", AGENT_WRITE_RESULT) as never,
    agentCodexMutate: record("agentCodexMutate", AGENT_WRITE_RESULT) as never,
    agentWriteBundle: record("agentWriteBundle", AGENT_WRITE_RESULT) as never,
    agentSnippetCreate: record(
      "agentSnippetCreate",
      AGENT_WRITE_RESULT,
    ) as never,
    snippetCreate: record("snippetCreate", AGENT_WRITE_RESULT) as never,
    snippetUpdate: record("snippetUpdate", AGENT_WRITE_RESULT) as never,
    snippetDelete: record("snippetDelete", AGENT_WRITE_RESULT) as never,
    agentProposeSceneBody: record(
      "agentProposeSceneBody",
      PROSE_STAGE_RESULT,
    ) as never,
    agentAcceptProseStage: record(
      "agentAcceptProseStage",
      PROSE_STAGE_RESULT,
    ) as never,
    agentDiscardProseStage: record(
      "agentDiscardProseStage",
      PROSE_STAGE_RESULT,
    ) as never,
    agentApplyUndoJournal: record(
      "agentApplyUndoJournal",
      Promise.resolve('{"ok":true}'),
    ) as never,
    agentForeshadowCreate: record(
      "agentForeshadowCreate",
      AGENT_WRITE_RESULT,
    ) as never,
    agentForeshadowUpdate: record(
      "agentForeshadowUpdate",
      AGENT_WRITE_RESULT,
    ) as never,
    agentEventCreate: record("agentEventCreate", AGENT_WRITE_RESULT) as never,
    agentEventUpdate: record("agentEventUpdate", AGENT_WRITE_RESULT) as never,
    agentEventDelete: record("agentEventDelete", AGENT_WRITE_RESULT) as never,
    eventCreate: record("eventCreate", AGENT_WRITE_RESULT) as never,
    eventUpdate: record("eventUpdate", AGENT_WRITE_RESULT) as never,
    eventDelete: record("eventDelete", AGENT_WRITE_RESULT) as never,
    agentChronicleBulkMutate: record(
      "agentChronicleBulkMutate",
      CHRONICLE_BULK_RESULT,
    ) as never,
    chronicleBulkMutate: record(
      "chronicleBulkMutate",
      CHRONICLE_BULK_RESULT,
    ) as never,
    agentEventSetParticipants: record(
      "agentEventSetParticipants",
      AGENT_WRITE_RESULT,
    ) as never,
    eventParticipantsSet: record(
      "eventParticipantsSet",
      AGENT_WRITE_RESULT,
    ) as never,
    agentSceneEventLink: record(
      "agentSceneEventLink",
      AGENT_WRITE_RESULT,
    ) as never,
    sceneEventLink: record("sceneEventLink", AGENT_WRITE_RESULT) as never,
    agentSceneEventLinkBatch: record(
      "agentSceneEventLinkBatch",
      AGENT_WRITE_RESULT,
    ) as never,
    sceneEventLinkBatch: record(
      "sceneEventLinkBatch",
      AGENT_WRITE_RESULT,
    ) as never,
    agentSceneEventUnlink: record(
      "agentSceneEventUnlink",
      AGENT_WRITE_RESULT,
    ) as never,
    sceneEventUnlink: record("sceneEventUnlink", AGENT_WRITE_RESULT) as never,
    agentEventRelationAdd: record(
      "agentEventRelationAdd",
      AGENT_WRITE_RESULT,
    ) as never,
    eventRelationAdd: record("eventRelationAdd", AGENT_WRITE_RESULT) as never,
    agentEventRelationRemove: record(
      "agentEventRelationRemove",
      AGENT_WRITE_RESULT,
    ) as never,
    eventRelationRemove: record(
      "eventRelationRemove",
      AGENT_WRITE_RESULT,
    ) as never,
    aiTreePlanApply: record(
      "aiTreePlanApply",
      Promise.resolve(
        '{"versions":[{"id":"scene-1","version":2}],"changeEventUid":"event-1","maintenanceTransactionId":"tx-1","undoJournalId":"journal-1"}',
      ),
    ) as never,
    aiTreePlanUndo: record(
      "aiTreePlanUndo",
      Promise.resolve(
        '{"versions":[{"id":"scene-1","version":3}],"changeEventUid":"event-2","maintenanceTransactionId":"tx-2","undoJournalId":"journal-1"}',
      ),
    ) as never,
    treeNodeCreate: record(
      "treeNodeCreate",
      Promise.resolve('{"id":"node-1","projectId":"p1","version":0}'),
    ) as never,
    treeNodeDelete: record(
      "treeNodeDelete",
      Promise.resolve(undefined),
    ) as never,
    treeNodePatch: record(
      "treeNodePatch",
      Promise.resolve('{"id":"node-1","projectId":"p1","version":1}'),
    ) as never,
    temporalScenePatch: record(
      "temporalScenePatch",
      Promise.resolve('{"sceneId":"scene-1","version":1,"updatedAt":"now"}'),
    ) as never,
    narrativeExtractionCaptureWorkspaceBinding: record(
      "narrativeExtractionCaptureWorkspaceBinding",
      Promise.resolve(
        '{"authorityId":"workspace:a","generation":1,"authorityInstanceId":"1"}',
      ),
    ) as never,
    narrativeExtractionCreateRun: record(
      "narrativeExtractionCreateRun",
      Promise.resolve('{"runId":"r1","status":"running","taskIds":[]}'),
    ) as never,
    narrativeExtractionGetRun: record(
      "narrativeExtractionGetRun",
      Promise.resolve('{"run":{"runId":"r1"},"tasks":[],"taskCounts":{}}'),
    ) as never,
    narrativeExtractionListResumableRuns: record(
      "narrativeExtractionListResumableRuns",
      Promise.resolve(
        '[{"runId":"r1","projectId":"p1","surfacePathId":"chronicle.extract","status":"completed","snapshotDigest":null,"createdAt":"2026-01-01T00:00:00.000Z","startedAt":null,"completedAt":null}]',
      ),
    ) as never,
    narrativeExtractionIsRunResumableForReview: record(
      "narrativeExtractionIsRunResumableForReview",
      Promise.resolve(
        '{"runId":"r1","projectId":"p1","surfacePathId":"chronicle.extract","resumable":true}',
      ),
    ) as never,
    narrativeExtractionListChronicleTaskResumeCandidates: record(
      "narrativeExtractionListChronicleTaskResumeCandidates",
      Promise.resolve("[]"),
    ) as never,
    narrativeExtractionCancelRun: record(
      "narrativeExtractionCancelRun",
      Promise.resolve('{"runId":"r1","status":"cancelled"}'),
    ) as never,
    narrativeExtractionClaimTask: record(
      "narrativeExtractionClaimTask",
      Promise.resolve('{"claimed":false}'),
    ) as never,
    narrativeExtractionFinishTask: record(
      "narrativeExtractionFinishTask",
      Promise.resolve('{"taskId":"t1","attemptId":"a1","status":"completed"}'),
    ) as never,
    narrativeExtractionFailTask: record(
      "narrativeExtractionFailTask",
      Promise.resolve('{"taskId":"t1","attemptId":"a1","status":"failed"}'),
    ) as never,
    narrativeExtractionSaveProposalSet: record(
      "narrativeExtractionSaveProposalSet",
      Promise.resolve('{"proposalSetId":"ps1","proposals":[]}'),
    ) as never,
    narrativeExtractionCreateHumanDerivedRevision: record(
      "narrativeExtractionCreateHumanDerivedRevision",
      Promise.resolve(
        '{"proposalId":"p1","revisionId":"rv2","revisionNumber":2,"originKind":"enveloped","createdBy":"human","reconciliationEnvelopeDigest":"sha256:revision","currentRevisionId":"rv2","status":"unreviewed"}',
      ),
    ) as never,
    narrativeExtractionGetRunReviewBundle: record(
      "narrativeExtractionGetRunReviewBundle",
      Promise.resolve(
        '{"runId":"r1","projectId":"p1","artifacts":[],"proposalSet":null,"proposals":[]}',
      ),
    ) as never,
    narrativeExtractionAppendRevision: record(
      "narrativeExtractionAppendRevision",
      Promise.resolve(
        '{"proposalId":"p1","revisionId":"rv1","revisionNumber":2,"status":"unreviewed"}',
      ),
    ) as never,
    narrativeExtractionAppendDecision: record(
      "narrativeExtractionAppendDecision",
      Promise.resolve(
        '{"decisionId":"d1","proposalId":"p1","revisionId":"rv1","decision":"approved","status":"approved"}',
      ),
    ) as never,
    narrativeExtractionAppendHumanDecision: record(
      "narrativeExtractionAppendHumanDecision",
      Promise.resolve(
        '{"decisionId":"d1","proposalId":"p1","revisionId":"rv1","decision":"approved","status":"approved"}',
      ),
    ) as never,
    narrativeExtractionReviseAndDecide: record(
      "narrativeExtractionReviseAndDecide",
      Promise.resolve(
        '{"proposalId":"p1","revisionId":"rv2","revisionNumber":2,"decisionId":"d1","decision":"approved","status":"approved"}',
      ),
    ) as never,
    narrativeExtractionReviseAndDecideAsHuman: record(
      "narrativeExtractionReviseAndDecideAsHuman",
      Promise.resolve(
        '{"proposalId":"p1","revisionId":"rv2","revisionNumber":2,"decisionId":"d1","decision":"approved","status":"approved"}',
      ),
    ) as never,
    narrativeExtractionSetHumanFieldLock: record(
      "narrativeExtractionSetHumanFieldLock",
      Promise.resolve(
        '{"projectId":"p1","entityKind":"codex-entry","entityId":"e1","fieldPath":"/summary","locked":true,"version":1}',
      ),
    ) as never,
    narrativeExtractionPrepareCommit: record(
      "narrativeExtractionPrepareCommit",
      Promise.resolve(
        '{"ok":true,"requestId":"req1","planDigest":"d1","operationCount":1}',
      ),
    ) as never,
    narrativeExtractionApplyCommit: record(
      "narrativeExtractionApplyCommit",
      Promise.resolve(
        '{"commitId":"c1","requestId":"req1","planDigest":"d1","status":"applied"}',
      ),
    ) as never,
    narrativeExtractionGetCommitStatus: record(
      "narrativeExtractionGetCommitStatus",
      Promise.resolve('{"found":true,"status":"applied"}'),
    ) as never,
    narrativeExtractionUndoCommit: record(
      "narrativeExtractionUndoCommit",
      Promise.resolve(
        '{"commitId":"c1","requestId":"req1","planDigest":"d1","status":"undone"}',
      ),
    ) as never,
    narrativeExtractionRedoCommit: record(
      "narrativeExtractionRedoCommit",
      Promise.resolve(
        '{"commitId":"c1","requestId":"req1","planDigest":"d1","status":"redone"}',
      ),
    ) as never,
    // post_effect pure-db 7 コマンド
    listPostEffectRuns: record(
      "listPostEffectRuns",
      Promise.resolve('[{"id":"r1"}]'),
    ) as never,
    listSceneLensForProject: record(
      "listSceneLensForProject",
      Promise.resolve('[{"sceneId":"s1","runCompletedAt":"2026-07-10"}]'),
    ) as never,
    listAnnotationsForScene: record(
      "listAnnotationsForScene",
      Promise.resolve('{"annotations":[],"relations":[]}'),
    ) as never,
    listAnnotationsForProject: record(
      "listAnnotationsForProject",
      Promise.resolve('{"annotations":[]}'),
    ) as never,
    updateAnnotationStatus: record(
      "updateAnnotationStatus",
      Promise.resolve('{"id":"a1","status":"dismissed"}'),
    ) as never,
    replyToAnnotation: record(
      "replyToAnnotation",
      Promise.resolve('{"id":"a2","parent_id":"a1"}'),
    ) as never,
    savePostEffectAnnotations: record(
      "savePostEffectAnnotations",
      Promise.resolve(undefined),
    ) as never,
    getAiSettings: record(
      "getAiSettings",
      Promise.resolve('{"provider":"openai","model":"gpt-x"}'),
    ) as never,
    sendChatMessage: record(
      "sendChatMessage",
      Promise.resolve('{"blocks":[{"type":"text","content":"hi"}]}'),
    ) as never,
    sendChatMessageStream: record(
      "sendChatMessageStream",
      Promise.resolve(undefined),
    ) as never,
    abortChatStream: record("abortChatStream", Promise.resolve(true)) as never,
    onEvent: record("onEvent", undefined) as never,
    ...overrides,
  };
  return { backend, calls };
}

const noShell = Object.freeze({});

const LICENSED_LICENSE_STATE = {
  licensingEnabled: true,
  status: "licensed",
  trialDaysRemaining: null,
  graceDaysRemaining: null,
  keyTail: "1234",
  activatedAt: "2026-07-01T00:00:00Z",
  lastValidatedAt: "2026-07-11T00:00:00Z",
};

const TRIAL_LICENSE_STATE = {
  licensingEnabled: true,
  status: "trial",
  trialDaysRemaining: 23,
  graceDaysRemaining: null,
  keyTail: null,
  activatedAt: null,
  lastValidatedAt: null,
};

const STALE_LICENSE_STATE = {
  ...LICENSED_LICENSE_STATE,
  status: "license_stale",
};

function fakeLicenseBackend() {
  const base = fakeBackend();
  const methods = {
    getLicenseState: vi
      .fn()
      .mockResolvedValue(JSON.stringify(LICENSED_LICENSE_STATE)),
    activateLicense: vi
      .fn()
      .mockResolvedValue(JSON.stringify(LICENSED_LICENSE_STATE)),
    revalidateLicense: vi
      .fn()
      .mockResolvedValue(JSON.stringify(LICENSED_LICENSE_STATE)),
    deactivateLicense: vi
      .fn()
      .mockResolvedValue(JSON.stringify(TRIAL_LICENSE_STATE)),
  };
  return {
    ...base,
    backend: Object.assign(base.backend, methods),
    methods,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// イベント allowlist（列挙制）
// ─────────────────────────────────────────────────────────────────────────────

describe("EVENT_CHANNEL_ALLOWLIST", () => {
  it.each([
    // Rust 発ストリーミング系（代表）
    "chat:stream-chunk",
    "inline-ai:stream-error",
    "cli:stream-done",
    "license:state_changed",
    "post_effect:progress",
    "semantic:model_download_progress",
    "vivliostyle:preview-exited",
    "updater:download-progress",
    // renderer 発 codex 窓間同期（§7.1 Phase 2 受け入れ対象）
    "codex:data-changed",
    "codex:lock-event",
    "codex:select-entry",
    // external-mount watcher 4ch
    "external-mount://file-added",
    "external-mount://file-changed",
    "external-mount://file-removed",
    "external-mount://file-renamed",
    // napi Phase 2 実証チャネル
    "backend:ready",
    "workspace:opened",
  ])("allows %s", (channel) => {
    expect(isAllowedEventChannel(channel)).toBe(true);
  });

  it.each([
    "codex:evil", // codex:* でも列挙外は拒否（前方一致にしない — §5.4）
    "chat:stream-chunk2",
    "external-mount://file-added/../x",
    "grim:event", // ipc 内部チャネル名は流用不可
    "",
    "__proto__",
  ])("rejects %s", (channel) => {
    expect(isAllowedEventChannel(channel)).toBe(false);
  });

  it("列挙に重複がない", () => {
    expect(new Set(EVENT_CHANNEL_ALLOWLIST).size).toBe(
      EVENT_CHANNEL_ALLOWLIST.length,
    );
  });

  it("送信元別 allowlist に重複がない", () => {
    const channels = [
      ...BACKEND_EVENT_CHANNEL_ALLOWLIST,
      ...MAIN_EVENT_CHANNEL_ALLOWLIST,
      ...RENDERER_EVENT_CHANNEL_ALLOWLIST,
    ];
    expect(new Set(channels).size).toBe(channels.length);
  });

  it.each([
    "chat:stream-done",
    "license:state_changed",
    "backend:ready",
    "workspace:opened",
  ])("renderer 発ではない %s は renderer allowlist から除外する", (channel) => {
    expect(isAllowedRendererEventChannel(channel)).toBe(false);
  });

  it.each(["codex:data-changed", "updater:download-progress"])(
    "%s は backend allowlist から除外する",
    (channel) => {
      expect(isAllowedBackendEventChannel(channel)).toBe(false);
    },
  );

  it("updater event は main allowlist だけに属する", () => {
    expect(isAllowedMainEventChannel("updater:download-progress")).toBe(true);
    expect(isAllowedRendererEventChannel("updater:download-progress")).toBe(
      false,
    );
    expect(isAllowedBackendEventChannel("updater:download-progress")).toBe(
      false,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// エラー文字列契約（§5.2）
// ─────────────────────────────────────────────────────────────────────────────

describe("toErrorString", () => {
  it("Error は message のみ（'Error: ' プレフィックスでワイヤを汚さない）", () => {
    expect(toErrorString(new Error("No workspace is open"))).toBe(
      "No workspace is open",
    );
  });

  it("生文字列はそのまま", () => {
    expect(toErrorString("WORKSPACE_SWITCHING")).toBe("WORKSPACE_SWITCHING");
  });

  it("その他は String() に落とす", () => {
    expect(toErrorString(42)).toBe("42");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// dispatchInvoke（envelope ルーター本体）
// ─────────────────────────────────────────────────────────────────────────────

describe("dispatchInvoke", () => {
  const extractionWorkspaceBinding = {
    authorityId: "workspace:a",
    generation: 1,
    authorityInstanceId: "1",
  } as const;

  it("captures a Chronicle workspace binding only for the exact expected path", async () => {
    const { backend, calls } = fakeBackend();
    const result = await dispatchInvoke(
      "narrative_extraction_capture_workspace_binding",
      { expectedWorkspacePath: "/workspaces/a" },
      { backend, shell: noShell },
    );

    expect(result).toEqual({
      ok: true,
      value: extractionWorkspaceBinding,
    });
    expect(calls).toEqual([
      {
        method: "narrativeExtractionCaptureWorkspaceBinding",
        args: ["/workspaces/a"],
      },
    ]);

    const missingMethod = await dispatchInvoke(
      "narrative_extraction_capture_workspace_binding",
      { expectedWorkspacePath: "/workspaces/a" },
      {
        backend: {
          ...backend,
          narrativeExtractionCaptureWorkspaceBinding: undefined,
        },
        shell: noShell,
      },
    );
    expect(missingMethod).toMatchObject({
      ok: false,
      error: `${IPC_BACKEND_UNAVAILABLE_MARKER} native method narrativeExtractionCaptureWorkspaceBinding`,
    });

    for (const args of [
      {},
      { expectedWorkspacePath: "" },
      { expectedWorkspacePath: " /workspaces/a" },
      { expectedWorkspacePath: "/workspaces/a", extra: true },
    ]) {
      const invalid = await dispatchInvoke(
        "narrative_extraction_capture_workspace_binding",
        args,
        { backend, shell: noShell },
      );
      expect(invalid.ok).toBe(false);
    }
  });

  it("rejects missing or malformed Chronicle mutation workspace bindings", async () => {
    const { backend } = fakeBackend();
    for (const workspaceBinding of [
      undefined,
      { authorityId: "workspace:a", generation: 0, authorityInstanceId: "1" },
      { authorityId: "workspace:a", generation: 1, authorityInstanceId: "01" },
      {
        authorityId: "workspace:a",
        generation: 1,
        authorityInstanceId: "1",
        extra: true,
      },
    ]) {
      const result = await dispatchInvoke(
        "narrative_extraction_create_run",
        {
          payload: { projectId: "project-a" },
          ...(workspaceBinding === undefined ? {} : { workspaceBinding }),
        },
        { backend, shell: noShell },
      );
      expect(result.ok).toBe(false);
    }
  });

  it("forwards the typed historical Scope-authority companion unchanged", async () => {
    const { backend, calls } = fakeBackend();
    const payload = {
      runId: "run-scope-runtime",
      projectId: "project-scope-runtime",
      taskId: "task-scope-runtime",
      attemptId: "attempt-scope-runtime",
      leaseOwner: "scope-runtime-test",
      historicalScopeAuthorityBasis: {
        schemaVersion: 2,
        contractId: "narrative-scope-authority-basis/2",
        source: { sourceKey: "snapshot:run-scope-runtime" },
      },
    };

    const result = await dispatchInvoke(
      "narrative_extraction_finish_task",
      { payload, workspaceBinding: extractionWorkspaceBinding },
      { backend, shell: noShell },
    );

    expect(result).toMatchObject({ ok: true });
    expect(calls).toEqual([
      {
        method: "narrativeExtractionFinishTask",
        args: [payload, extractionWorkspaceBinding],
      },
    ]);
  });

  it("Chronicle task resume candidate discovery forwards only the strict project query", async () => {
    const { backend, calls } = fakeBackend();

    const result = await dispatchInvoke(
      "narrative_extraction_list_chronicle_task_resume_candidates",
      { payload: { projectId: "project-resume", limit: 5 } },
      { backend, shell: noShell },
    );

    expect(result).toEqual({ ok: true, value: [] });
    expect(calls).toEqual([
      {
        method: "narrativeExtractionListChronicleTaskResumeCandidates",
        args: [{ projectId: "project-resume", limit: 5 }],
      },
    ]);
  });

  it("exact Review resumability forwards all durable Run coordinates", async () => {
    const { backend, calls } = fakeBackend();
    const payload = {
      runId: "run-review",
      projectId: "project-review",
      surfacePathId: "chronicle.extract",
    };

    const result = await dispatchInvoke(
      "narrative_extraction_is_run_resumable_for_review",
      { payload },
      { backend, shell: noShell },
    );

    expect(result).toEqual({
      ok: true,
      value: {
        runId: "r1",
        projectId: "p1",
        surfacePathId: "chronicle.extract",
        resumable: true,
      },
    });
    expect(calls).toEqual([
      {
        method: "narrativeExtractionIsRunResumableForReview",
        args: [payload],
      },
    ]);
  });

  it("exact Review resumability rejects malformed coordinates and backend skew", async () => {
    const { backend, calls } = fakeBackend();
    for (const payload of [
      null,
      [],
      "payload",
      {},
      { runId: "run-review", projectId: "project-review" },
      {
        runId: "",
        projectId: "project-review",
        surfacePathId: "chronicle.extract",
      },
      {
        runId: " run-review",
        projectId: "project-review",
        surfacePathId: "chronicle.extract",
      },
      {
        runId: "run-review",
        projectId: "project-review ",
        surfacePathId: "chronicle.extract",
      },
      {
        runId: "run-review",
        projectId: "project-review",
        surfacePathId: " chronicle.extract",
      },
      {
        runId: "run-review",
        projectId: "project-review",
        surfacePathId: "chronicle.extract",
        unknown: true,
      },
    ]) {
      const result = await dispatchInvoke(
        "narrative_extraction_is_run_resumable_for_review",
        { payload },
        { backend, shell: noShell },
      );
      expect(result.ok).toBe(false);
    }
    expect(calls).toHaveLength(0);

    const missingMethod = await dispatchInvoke(
      "narrative_extraction_is_run_resumable_for_review",
      {
        payload: {
          runId: "run-review",
          projectId: "project-review",
          surfacePathId: "chronicle.extract",
        },
      },
      {
        backend: {
          ...backend,
          narrativeExtractionIsRunResumableForReview: undefined,
        },
        shell: noShell,
      },
    );
    expect(missingMethod).toMatchObject({
      ok: false,
      error: `${IPC_BACKEND_UNAVAILABLE_MARKER} native method narrativeExtractionIsRunResumableForReview`,
    });
  });

  it("Chronicle task resume candidate discovery rejects malformed scope and backend skew", async () => {
    const { backend, calls } = fakeBackend();
    for (const payload of [
      null,
      [],
      "payload",
      {},
      { projectId: "" },
      { projectId: "   " },
      { projectId: " project-resume" },
      { projectId: "project-resume " },
      { projectId: "project-resume", limit: 0 },
      { projectId: "project-resume", limit: 101 },
      { projectId: "project-resume", limit: 1.5 },
      { projectId: "project-resume", unknown: true },
    ]) {
      const result = await dispatchInvoke(
        "narrative_extraction_list_chronicle_task_resume_candidates",
        { payload },
        { backend, shell: noShell },
      );
      expect(result.ok).toBe(false);
    }
    expect(calls).toHaveLength(0);

    const missingMethod = await dispatchInvoke(
      "narrative_extraction_list_chronicle_task_resume_candidates",
      { payload: { projectId: "project-resume" } },
      {
        backend: {
          ...backend,
          narrativeExtractionListChronicleTaskResumeCandidates: undefined,
        },
        shell: noShell,
      },
    );
    expect(missingMethod).toMatchObject({
      ok: false,
      error: `${IPC_BACKEND_UNAVAILABLE_MARKER} native method narrativeExtractionListChronicleTaskResumeCandidates`,
    });
  });

  it("未知コマンドは IPC_UNIMPLEMENTED: マーカー付き envelope", async () => {
    const { backend } = fakeBackend();
    const command = "definitely_unknown_command";
    const env = await dispatchInvoke(command, {}, { backend, shell: noShell });
    expect(env).toEqual({
      ok: false,
      error: `IPC_UNIMPLEMENTED: ${command}`,
      errorInfo: {
        code: "IPC_UNIMPLEMENTED",
        message: `IPC_UNIMPLEMENTED: ${command}`,
        retryable: false,
        outcome: "failed",
      },
    });
    expect(
      unimplementedError(command).startsWith(IPC_UNIMPLEMENTED_MARKER),
    ).toBe(true);
  });

  it("CLI AI の検出は委譲されるが、送信は監査証跡なしで拒否される", async () => {
    const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
    const shell = Object.fromEntries(
      [
        "detect_cli_binary",
        "test_cli_connection",
        "list_cli_models",
        "send_cli_chat_stream",
        "abort_cli_chat_stream",
      ].map((command) => [
        command,
        async (args: Record<string, unknown>) => {
          calls.push({ command, args });
          return command === "detect_cli_binary" ? "/bin/claude" : null;
        },
      ]),
    );

    const detected = await dispatchInvoke(
      "detect_cli_binary",
      { cli: "claude" },
      { backend: null, shell },
    );
    const sent = await dispatchInvoke(
      "send_cli_chat_stream",
      { payload: { cli: "claude", prompt: "hi" } },
      { backend: null, shell },
    );

    expect(detected).toEqual({ ok: true, value: "/bin/claude" });
    expect(sent.ok).toBe(false);
    if (!sent.ok) {
      expect(sent.error).toContain("auditContext");
    }
    expect(calls).toEqual([
      { command: "detect_cli_binary", args: { cli: "claude" } },
    ]);
    expect(SHELL_COMMAND_NAMES).toEqual(
      expect.arrayContaining([
        "detect_cli_binary",
        "test_cli_connection",
        "list_cli_models",
        "send_cli_chat_stream",
        "abort_cli_chat_stream",
        "codex_app_update_history_revision",
        "vivliostyle_detect",
        "vivliostyle_build",
        "vivliostyle_abort_build",
        "vivliostyle_save_output",
        "vivliostyle_preview_start",
        "vivliostyle_preview_stop",
        "updater_check",
        "updater_download",
        "updater_install",
        "mozkey_download_and_install",
      ]),
    );
  });

  it("CLI send の main 監査claimはnativeの拒否をspawn前に伝播する", async () => {
    const context = {
      expectedWorkspacePath: "/workspace/test.gdx",
      projectId: "p1",
      operationId: "operation-cli",
      executionId: "execution-cli",
      parentExecutionId: null,
      pathId: "cli_chat_stream",
    } as const;
    const backend = fakeBackend().backend;
    const runner = vi.fn(async () => null);
    const shell = {
      send_cli_chat_stream: runner,
    };
    const payload = { payload: { cli: "claude", prompt: "hi" } };

    await expect(
      dispatchInvoke("send_cli_chat_stream", payload, {
        backend: null,
        shell,
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("auditContext"),
    });

    const forgedContext = {
      ...context,
      operationId: "forged-operation",
    };
    const rejectedBackend = fakeBackend({
      aiAuditClaimCliDispatch: () =>
        Promise.reject(
          new Error(
            "AI_AUDIT_DISPATCH_PRECONDITION_FAILED: durable execution identity mismatch",
          ),
        ),
    }).backend;
    await expect(
      dispatchInvoke(
        "send_cli_chat_stream",
        {
          ...payload,
          streamId: context.executionId,
          auditContext: forgedContext,
        },
        { backend: rejectedBackend, shell },
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("AI_AUDIT_DISPATCH_PRECONDITION_FAILED"),
    });

    const terminalBackend = fakeBackend({
      aiAuditClaimCliDispatch: () =>
        Promise.reject(
          new Error(
            "AI_AUDIT_DISPATCH_PRECONDITION_FAILED: execution already has a terminal event",
          ),
        ),
    }).backend;
    await expect(
      dispatchInvoke(
        "send_cli_chat_stream",
        {
          ...payload,
          streamId: context.executionId,
          auditContext: context,
        },
        { backend: terminalBackend, shell },
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("AI_AUDIT_DISPATCH_PRECONDITION_FAILED"),
    });

    expect(runner).not.toHaveBeenCalled();

    await expect(
      dispatchInvoke(
        "send_cli_chat_stream",
        {
          ...payload,
          streamId: context.executionId,
          auditContext: context,
        },
        { backend, shell },
      ),
    ).resolves.toEqual({ ok: true, value: null });
    expect(runner).toHaveBeenCalledOnce();
  });

  it("backend 不在の napi コマンドは IPC_BACKEND_UNAVAILABLE", async () => {
    const env = await dispatchInvoke(
      "db_execute",
      { sql: "SELECT 1", params: [], method: "all" },
      { backend: null, shell: noShell },
    );
    expect(env.ok).toBe(false);
    if (!env.ok) {
      expect(env.error).toBe(`${IPC_BACKEND_UNAVAILABLE_MARKER} db_execute`);
    }
  });

  it("napi エラーの reason は生文字列のまま envelope に載る（マーカー透過）", async () => {
    const { backend } = fakeBackend({
      dbExecute: () => Promise.reject(new Error("No workspace is open")),
    });
    const env = await dispatchInvoke(
      "db_execute",
      { sql: "SELECT 1", params: [], method: "all" },
      { backend, shell: noShell },
    );
    expect(env).toEqual({
      ok: false,
      error: "No workspace is open",
      errorInfo: {
        code: "NO_WORKSPACE_OPEN",
        message: "No workspace is open",
        retryable: true,
        outcome: "failed",
      },
    });
  });

  it("native Safe Mode active marker は WORKSPACE_SAFE_MODE typed envelope にする", async () => {
    const { backend } = fakeBackend({
      dbExecute: () =>
        Promise.reject(
          new Error(
            "WORKSPACE_SAFE_MODE: restore-only session is active; Database authority is not published",
          ),
        ),
    });
    const env = await dispatchInvoke(
      "db_execute",
      { sql: "SELECT 1", params: [], method: "all" },
      { backend, shell: noShell },
    );
    expect(env).toEqual({
      ok: false,
      error:
        "WORKSPACE_SAFE_MODE: restore-only session is active; Database authority is not published",
      errorInfo: {
        code: "WORKSPACE_SAFE_MODE",
        message:
          "WORKSPACE_SAFE_MODE: restore-only session is active; Database authority is not published",
        retryable: false,
        outcome: "failed",
      },
    });
  });

  it("同期 throw も envelope に畳む（決して reject しない）", async () => {
    const { backend } = fakeBackend({
      validateWorkspacePath: () => {
        throw new Error("WORKSPACE_SWITCHING");
      },
    });
    const env = await dispatchInvoke(
      "validate_workspace_path",
      { path: "/x" },
      { backend, shell: noShell },
    );
    expect(env).toEqual({
      ok: false,
      error: "WORKSPACE_SWITCHING",
      errorInfo: {
        code: "WORKSPACE_SWITCHING",
        message: "WORKSPACE_SWITCHING",
        retryable: true,
        outcome: "failed",
      },
    });
  });

  it("native derived cancellation は retryable typed envelope にする", async () => {
    const { backend } = fakeBackend({
      semanticReindexAll: () =>
        Promise.reject(
          new Error(
            "IPC_DERIVED_CANCELLED: semantic background indexing was cancelled",
          ),
        ),
    });
    const env = await dispatchInvoke(
      "semantic_reindex_all",
      {
        expectedWorkspacePath: "/workspace/project-1",
        projectId: "project-1",
      },
      { backend, shell: noShell },
    );

    expect(env).toEqual({
      ok: false,
      error:
        "IPC_DERIVED_CANCELLED: semantic background indexing was cancelled",
      errorInfo: {
        code: "IPC_DERIVED_CANCELLED",
        message:
          "IPC_DERIVED_CANCELLED: semantic background indexing was cancelled",
        retryable: true,
        outcome: "failed",
      },
    });
  });

  it("native reranker contention は待機させずretryable busy envelopeにする", async () => {
    const { backend } = fakeBackend({
      semanticRerankerShadowScore: () =>
        Promise.reject(
          new Error("RERANKER_BUSY: semantic reranker lane is occupied"),
        ),
    });
    const env = await dispatchInvoke(
      "semantic_reranker_shadow_score",
      {
        requestId: "request-1",
        expectedWorkspacePath: "/workspace/project-1",
        projectId: "project-1",
        auditPathId: "semantic_reranker_shadow",
        language: "ja",
        userMessage: "query",
        sceneTail: "",
        candidates: [{ candidateId: "scene-a:0:10", text: "candidate" }],
      },
      { backend, shell: noShell },
    );

    expect(env).toEqual({
      ok: false,
      error: "RERANKER_BUSY: semantic reranker lane is occupied",
      errorInfo: {
        code: "RERANKER_BUSY",
        message: "RERANKER_BUSY: semantic reranker lane is occupied",
        retryable: true,
        outcome: "failed",
      },
    });
  });

  it("native license commandは残存shell stubに遮られない", async () => {
    const { backend, methods } = fakeLicenseBackend();
    const getLicenseStateStub = vi.fn().mockResolvedValue({
      licensingEnabled: false,
      status: "disabled",
    });
    const env = await dispatchInvoke(
      "get_license_state",
      {},
      { backend, shell: { get_license_state: getLicenseStateStub } },
    );

    expect(env).toEqual({ ok: true, value: LICENSED_LICENSE_STATE });
    expect(methods.getLicenseState).toHaveBeenCalledExactlyOnceWith();
    expect(getLicenseStateStub).not.toHaveBeenCalled();
  });

  it("プロトタイプ経由のコマンド名（constructor 等）は未実装扱い", async () => {
    const { backend } = fakeBackend();
    for (const cmd of ["constructor", "toString", "hasOwnProperty"]) {
      const env = await dispatchInvoke(cmd, {}, { backend, shell: noShell });
      expect(env).toMatchObject({
        ok: false,
        error: `IPC_UNIMPLEMENTED: ${cmd}`,
      });
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 引数アダプタ（camelCase → napi シグネチャの明示写像、§5.2）
// ─────────────────────────────────────────────────────────────────────────────

describe("NAPI_COMMANDS 引数アダプタ", () => {
  it("C2B Human writer は typed payload を専用N-APIへ一度だけ渡す", async () => {
    const method = vi
      .fn()
      .mockResolvedValue(
        '{"proposalId":"p1","revisionId":"rv2","revisionNumber":2,"originKind":"enveloped","createdBy":"human","reconciliationEnvelopeDigest":"sha256:revision","currentRevisionId":"rv2","status":"unreviewed"}',
      );
    const { backend } = fakeBackend({
      narrativeExtractionCreateHumanDerivedRevision: method,
    });
    const payload = {
      projectId: "project-1",
      request: {
        proposalId: "p1",
        expectedCurrentRevisionId: "rv1",
        parentRevisionId: "rv1",
        expectedParentEnvelopeDigest: "sha256:parent",
        proposalPayload: { title: "Human title" },
        adapter: { id: "chronicle.scene-event", version: "1" },
        surfaceId: "chronicle-review",
      },
    };

    const env = await dispatchInvoke(
      "narrative_extraction_create_human_derived_revision",
      { payload },
      { backend, shell: noShell },
    );

    expect(env).toEqual({
      ok: true,
      value: {
        proposalId: "p1",
        revisionId: "rv2",
        revisionNumber: 2,
        originKind: "enveloped",
        createdBy: "human",
        reconciliationEnvelopeDigest: "sha256:revision",
        currentRevisionId: "rv2",
        status: "unreviewed",
      },
    });
    expect(method).toHaveBeenCalledExactlyOnceWith(payload);
  });

  it.each([{}, { payload: null }, { payload: 42 }])(
    "C2B Human writer は不正payloadをN-APIへ渡さず拒否する: %j",
    async (args) => {
      const method = vi.fn();
      const { backend } = fakeBackend({
        narrativeExtractionCreateHumanDerivedRevision: method,
      });

      const env = await dispatchInvoke(
        "narrative_extraction_create_human_derived_revision",
        args,
        { backend, shell: noShell },
      );

      expect(env.ok).toBe(false);
      expect(method).not.toHaveBeenCalled();
    },
  );

  it("C2B Human writer は旧native bindingでbackend unavailableを返す", async () => {
    const { backend } = fakeBackend();
    delete (backend as Partial<NapiBackendLike>)
      .narrativeExtractionCreateHumanDerivedRevision;

    const env = await dispatchInvoke(
      "narrative_extraction_create_human_derived_revision",
      { payload: { projectId: "p1", request: {} } },
      { backend, shell: noShell },
    );

    expect(env).toMatchObject({
      ok: false,
      error: `${IPC_BACKEND_UNAVAILABLE_MARKER} native method narrativeExtractionCreateHumanDerivedRevision`,
    });
  });

  it("semantic per-entity commands forward workspace/project authority before the entity id", async () => {
    const semanticIndexScene = vi.fn().mockResolvedValue("1");
    const codexIndexEntry = vi.fn().mockResolvedValue("2");
    const eventsIndexEntry = vi.fn().mockResolvedValue("3");
    const chatIndexMessage = vi.fn().mockResolvedValue("4");
    const { backend } = fakeBackend({
      semanticIndexScene: semanticIndexScene as never,
      codexIndexEntry: codexIndexEntry as never,
      eventsIndexEntry: eventsIndexEntry as never,
      chatIndexMessage: chatIndexMessage as never,
    });
    const authority = {
      expectedWorkspacePath: "/workspace/project-1",
      projectId: "project-1",
    };

    await dispatchInvoke(
      "semantic_index_scene",
      { ...authority, sceneId: "scene-1" },
      { backend, shell: noShell },
    );
    await dispatchInvoke(
      "codex_index_entry",
      { ...authority, entryId: "entry-1" },
      { backend, shell: noShell },
    );
    await dispatchInvoke(
      "events_index_entry",
      { ...authority, eventId: "event-1" },
      { backend, shell: noShell },
    );
    await dispatchInvoke(
      "chat_index_message",
      { ...authority, messageId: "message-1" },
      { backend, shell: noShell },
    );

    expect(semanticIndexScene).toHaveBeenCalledExactlyOnceWith(
      "/workspace/project-1",
      "project-1",
      "scene-1",
    );
    expect(codexIndexEntry).toHaveBeenCalledExactlyOnceWith(
      "/workspace/project-1",
      "project-1",
      "entry-1",
    );
    expect(eventsIndexEntry).toHaveBeenCalledExactlyOnceWith(
      "/workspace/project-1",
      "project-1",
      "event-1",
    );
    expect(chatIndexMessage).toHaveBeenCalledExactlyOnceWith(
      "/workspace/project-1",
      "project-1",
      "message-1",
    );
  });

  it.each([
    {
      command: "semantic_search",
      methodName: "semanticSearch",
      args: {
        expectedWorkspacePath: "/workspace/project-1",
        projectId: "project-1",
        query: "storm",
        limit: 5,
        sceneScope: null,
        descriptionMode: false,
      },
      expected: [
        "/workspace/project-1",
        "project-1",
        "storm",
        5,
        undefined,
        false,
      ],
    },
    {
      command: "semantic_reindex_all",
      methodName: "semanticReindexAll",
      args: {
        expectedWorkspacePath: "/workspace/project-1",
        projectId: "project-1",
        runId: "run-1",
      },
      expected: ["/workspace/project-1", "project-1", "run-1"],
    },
    {
      command: "codex_semantic_search",
      methodName: "codexSemanticSearch",
      args: {
        expectedWorkspacePath: "/workspace/project-1",
        projectId: "project-1",
        query: "hero",
        limit: 6,
      },
      expected: ["/workspace/project-1", "project-1", "hero", 6],
    },
    {
      command: "codex_reindex_all",
      methodName: "codexReindexAll",
      args: {
        expectedWorkspacePath: "/workspace/project-1",
        projectId: "project-1",
      },
      expected: ["/workspace/project-1", "project-1"],
    },
    {
      command: "events_semantic_search",
      methodName: "eventsSemanticSearch",
      args: {
        expectedWorkspacePath: "/workspace/project-1",
        projectId: "project-1",
        query: "storm",
        limit: 7,
      },
      expected: ["/workspace/project-1", "project-1", "storm", 7],
    },
    {
      command: "events_reindex_all",
      methodName: "eventsReindexAll",
      args: {
        expectedWorkspacePath: "/workspace/project-1",
        projectId: "project-1",
      },
      expected: ["/workspace/project-1", "project-1"],
    },
    {
      command: "chat_message_search",
      methodName: "chatMessageSearch",
      args: {
        expectedWorkspacePath: "/workspace/project-1",
        projectId: "project-1",
        query: "memory",
        limit: 8,
      },
      expected: ["/workspace/project-1", "project-1", "memory", 8],
    },
    {
      command: "chat_reindex_all",
      methodName: "chatReindexAll",
      args: {
        expectedWorkspacePath: "/workspace/project-1",
        projectId: "project-1",
      },
      expected: ["/workspace/project-1", "project-1"],
    },
  ])(
    "$command forwards the immutable workspace path before inference inputs",
    async ({ command, methodName, args, expected }) => {
      const method = vi.fn().mockResolvedValue("[]");
      const { backend } = fakeBackend({
        [methodName]: method,
      } as Partial<NapiBackendLike>);

      const env = await dispatchInvoke(command, args, {
        backend,
        shell: noShell,
      });

      expect(env.ok).toBe(true);
      expect(method).toHaveBeenCalledExactlyOnceWith(...expected);
    },
  );

  it.each([
    ["semantic_search", "semanticSearch", { query: "storm", limit: 5 }],
    ["semantic_reindex_all", "semanticReindexAll", {}],
    [
      "codex_semantic_search",
      "codexSemanticSearch",
      { query: "hero", limit: 5 },
    ],
    ["codex_reindex_all", "codexReindexAll", {}],
    [
      "events_semantic_search",
      "eventsSemanticSearch",
      { query: "storm", limit: 5 },
    ],
    ["events_reindex_all", "eventsReindexAll", {}],
    ["chat_message_search", "chatMessageSearch", { query: "memory", limit: 5 }],
    ["chat_reindex_all", "chatReindexAll", {}],
  ])(
    "%s rejects a missing workspace path before native inference",
    async (command, methodName, commandArgs) => {
      const method = vi.fn();
      const { backend } = fakeBackend({
        [methodName]: method,
      } as Partial<NapiBackendLike>);

      const env = await dispatchInvoke(
        command,
        { projectId: "project-1", ...commandArgs },
        { backend, shell: noShell },
      );

      expect(env.ok).toBe(false);
      expect(method).not.toHaveBeenCalled();
    },
  );

  it("db_execute: {sql, params, method} → 位置引数、JSON 文字列 → オブジェクト", async () => {
    const { backend, calls } = fakeBackend();
    const env = await dispatchInvoke(
      "db_execute",
      { sql: "SELECT ?", params: [1], method: "all" },
      { backend, shell: noShell },
    );
    expect(calls).toEqual([
      { method: "dbExecute", args: ["SELECT ?", [1], "all"] },
    ]);
    // Tauri ワイヤ同形: invoke<QueryResult> が {rows} オブジェクトを受け取る
    expect(env).toEqual({ ok: true, value: { rows: [[1]] } });
  });

  it("db_execute_batch: {statements} を素通しし最終文の rows を返す", async () => {
    const { backend, calls } = fakeBackend();
    const statements = [{ sql: "INSERT …", params: [], method: "run" }];
    const env = await dispatchInvoke(
      "db_execute_batch",
      { statements },
      { backend, shell: noShell },
    );
    expect(calls).toEqual([{ method: "dbExecuteBatch", args: [statements] }]);
    expect(env).toEqual({ ok: true, value: { rows: [] } });
  });

  it("narrative_runtime_policy_get: 引数なしで Native JSON を typed policy へ parse する", async () => {
    const { backend, calls } = fakeBackend();
    const env = await dispatchInvoke(
      "narrative_runtime_policy_get",
      {},
      { backend, shell: noShell },
    );
    expect(calls).toEqual([{ method: "narrativeRuntimePolicyGet", args: [] }]);
    expect(env).toEqual({
      ok: true,
      value: {
        runtimeMode: "review-only",
        maintenanceEnabled: false,
        genericImportEnabled: false,
        backgroundAiEnabled: false,
        version: 1,
        effectiveMode: "review-only",
        maintenancePreviewAllowed: false,
      },
    });
  });

  it("narrative_runtime_policy_set: deep-validated CAS payload だけを native adapter へ渡す", async () => {
    const { backend, calls } = fakeBackend();
    const payload = {
      expectedVersion: 1,
      runtimeMode: "manual-apply",
      maintenanceEnabled: false,
      genericImportEnabled: false,
      backgroundAiEnabled: false,
    };
    const env = await dispatchInvoke(
      "narrative_runtime_policy_set",
      { payload },
      { backend, shell: noShell },
    );
    expect(calls).toEqual([
      { method: "narrativeRuntimePolicySet", args: [payload] },
    ]);
    expect(env).toEqual({
      ok: true,
      value: {
        runtimeMode: "manual-apply",
        maintenanceEnabled: false,
        genericImportEnabled: false,
        backgroundAiEnabled: false,
        version: 2,
        effectiveMode: "manual-apply",
        maintenancePreviewAllowed: false,
      },
    });
  });

  it("narrative_runtime_policy_set は malformed payload と backend skew を明示拒否する", async () => {
    const { backend, calls } = fakeBackend();
    const valid = {
      expectedVersion: 1,
      runtimeMode: "review-only",
      maintenanceEnabled: false,
      genericImportEnabled: false,
      backgroundAiEnabled: false,
    };
    const invalidPayloads: unknown[] = [
      null,
      [],
      "payload",
      {},
      { ...valid, expectedVersion: -1 },
      { ...valid, expectedVersion: 1.5 },
      { ...valid, expectedVersion: "1" },
      { ...valid, runtimeMode: "full" },
      { ...valid, maintenanceEnabled: "true" },
      { ...valid, genericImportEnabled: 1 },
      { ...valid, backgroundAiEnabled: null },
      { ...valid, extra: true },
      {
        expectedVersion: 1,
        runtimeMode: "review-only",
        maintenanceEnabled: false,
        genericImportEnabled: false,
      },
    ];

    for (const payload of invalidPayloads) {
      const result = await dispatchInvoke(
        "narrative_runtime_policy_set",
        { payload },
        { backend, shell: noShell },
      );
      expect(result.ok).toBe(false);
    }
    expect(calls).toHaveLength(0);

    const missingPayload = await dispatchInvoke(
      "narrative_runtime_policy_set",
      {},
      { backend, shell: noShell },
    );
    expect(missingPayload.ok).toBe(false);

    const unavailable = await dispatchInvoke(
      "narrative_runtime_policy_set",
      { payload: valid },
      { backend: null, shell: noShell },
    );
    expect(unavailable).toMatchObject({
      ok: false,
      error: `${IPC_BACKEND_UNAVAILABLE_MARKER} narrative_runtime_policy_set`,
    });

    const missingMethod = await dispatchInvoke(
      "narrative_runtime_policy_set",
      { payload: valid },
      {
        backend: {
          ...backend,
          narrativeRuntimePolicySet: undefined,
        },
        shell: noShell,
      },
    );
    expect(missingMethod).toMatchObject({
      ok: false,
      error: `${IPC_BACKEND_UNAVAILABLE_MARKER} native method narrativeRuntimePolicySet`,
    });
  });

  it("narrative_runtime_policy_set は CAS conflict marker をそのまま伝播する", async () => {
    const { backend } = fakeBackend({
      narrativeRuntimePolicySet: vi
        .fn()
        .mockRejectedValue(
          new Error(
            "NARRATIVE_RUNTIME_POLICY_CONFLICT: runtime policy version conflict",
          ),
        ) as never,
    });
    const env = await dispatchInvoke(
      "narrative_runtime_policy_set",
      {
        payload: {
          expectedVersion: 1,
          runtimeMode: "manual-apply",
          maintenanceEnabled: false,
          genericImportEnabled: false,
          backgroundAiEnabled: false,
        },
      },
      { backend, shell: noShell },
    );
    expect(env).toMatchObject({
      ok: false,
      error:
        "NARRATIVE_RUNTIME_POLICY_CONFLICT: runtime policy version conflict",
    });
  });

  it("narrative_maintenance_attention_set: actor/idempotency/OCC 込みの payload を native adapter へ渡す", async () => {
    const narrativeMaintenanceAttentionSet = vi
      .fn()
      .mockResolvedValue('{"findingKey":"finding-1","version":1}');
    const { backend } = fakeBackend({
      narrativeMaintenanceAttentionSet:
        narrativeMaintenanceAttentionSet as never,
    });
    const payload = {
      ...MAINTENANCE_ATTENTION_SET_PAYLOAD,
      snoozedUntil: "2026-09-01T00:00:00.000Z",
      reason: "材料が揃うまで保留",
    };
    const env = await dispatchInvoke(
      "narrative_maintenance_attention_set",
      { payload },
      { backend, shell: noShell },
    );
    expect(narrativeMaintenanceAttentionSet).toHaveBeenCalledWith(payload);
    expect(env).toEqual({
      ok: true,
      value: { findingKey: "finding-1", version: 1 },
    });
  });

  it("narrative_maintenance_attention_set: 任意項目なし・expectedVersion=0（行未作成期待）を受理する", async () => {
    const narrativeMaintenanceAttentionSet = vi
      .fn()
      .mockResolvedValue('{"findingKey":"finding-1","version":1}');
    const { backend } = fakeBackend({
      narrativeMaintenanceAttentionSet:
        narrativeMaintenanceAttentionSet as never,
    });
    const env = await dispatchInvoke(
      "narrative_maintenance_attention_set",
      { payload: MAINTENANCE_ATTENTION_SET_PAYLOAD },
      { backend, shell: noShell },
    );
    expect(narrativeMaintenanceAttentionSet).toHaveBeenCalledWith(
      MAINTENANCE_ATTENTION_SET_PAYLOAD,
    );
    expect(env).toMatchObject({ ok: true });
  });

  it("narrative_maintenance_attention_set は必須 actor/requestId/OCC 欠落と旧 setBy を拒否する", async () => {
    const narrativeMaintenanceAttentionSet = vi
      .fn()
      .mockResolvedValue('{"findingKey":"finding-1","version":1}');
    const { backend } = fakeBackend({
      narrativeMaintenanceAttentionSet:
        narrativeMaintenanceAttentionSet as never,
    });
    const valid = MAINTENANCE_ATTENTION_SET_PAYLOAD;
    const invalidPayloads: unknown[] = [
      null,
      [],
      "payload",
      {},
      // 旧 wire: setBy は削除済みなので unknown field で落ちる
      { ...valid, setBy: "actor-1" },
      omitKey(valid, "actorId"),
      omitKey(valid, "requestId"),
      omitKey(valid, "expectedVersion"),
      omitKey(valid, "projectId"),
      omitKey(valid, "findingKey"),
      omitKey(valid, "disposition"),
      omitKey(valid, "materialBasisDigest"),
      { ...valid, actorId: "" },
      { ...valid, actorId: 1 },
      { ...valid, actorId: null },
      { ...valid, requestId: "" },
      { ...valid, requestId: 42 },
      { ...valid, projectId: "" },
      { ...valid, findingKey: "" },
      { ...valid, materialBasisDigest: "" },
      { ...valid, disposition: "ignored" },
      { ...valid, disposition: null },
      { ...valid, expectedVersion: -1 },
      { ...valid, expectedVersion: 1.5 },
      { ...valid, expectedVersion: "1" },
      { ...valid, expectedVersion: null },
      { ...valid, expectedVersion: Number.NaN },
      { ...valid, snoozedUntil: 1 },
      { ...valid, reason: 1 },
      { ...valid, extra: true },
    ];

    for (const payload of invalidPayloads) {
      const result = await dispatchInvoke(
        "narrative_maintenance_attention_set",
        { payload },
        { backend, shell: noShell },
      );
      expect(result.ok).toBe(false);
    }
    expect(narrativeMaintenanceAttentionSet).not.toHaveBeenCalled();

    const missingPayload = await dispatchInvoke(
      "narrative_maintenance_attention_set",
      {},
      { backend, shell: noShell },
    );
    expect(missingPayload.ok).toBe(false);

    const setByError = await dispatchInvoke(
      "narrative_maintenance_attention_set",
      { payload: { ...valid, setBy: "actor-1" } },
      { backend, shell: noShell },
    );
    expect(setByError).toMatchObject({
      ok: false,
      error:
        "invalid args `setBy` for command `narrative_maintenance_attention_set`: unknown field",
    });

    const occError = await dispatchInvoke(
      "narrative_maintenance_attention_set",
      { payload: { ...valid, expectedVersion: -1 } },
      { backend, shell: noShell },
    );
    expect(occError).toMatchObject({
      ok: false,
      error:
        "invalid args `expectedVersion` for command `narrative_maintenance_attention_set`: expected a non-negative safe integer",
    });

    const missingMethod = await dispatchInvoke(
      "narrative_maintenance_attention_set",
      { payload: valid },
      {
        backend: { ...backend, narrativeMaintenanceAttentionSet: undefined },
        shell: noShell,
      },
    );
    expect(missingMethod).toMatchObject({
      ok: false,
      error: `${IPC_BACKEND_UNAVAILABLE_MARKER} native method narrativeMaintenanceAttentionSet`,
    });
  });

  it("narrative_maintenance_attention_clear: actor/idempotency/OCC 必須の payload を native adapter へ渡す", async () => {
    const narrativeMaintenanceAttentionClear = vi
      .fn()
      .mockResolvedValue('{"findingKey":"finding-1","cleared":true}');
    const { backend } = fakeBackend({
      narrativeMaintenanceAttentionClear:
        narrativeMaintenanceAttentionClear as never,
    });
    const env = await dispatchInvoke(
      "narrative_maintenance_attention_clear",
      { payload: MAINTENANCE_ATTENTION_CLEAR_PAYLOAD },
      { backend, shell: noShell },
    );
    expect(narrativeMaintenanceAttentionClear).toHaveBeenCalledWith(
      MAINTENANCE_ATTENTION_CLEAR_PAYLOAD,
    );
    expect(env).toEqual({
      ok: true,
      value: { findingKey: "finding-1", cleared: true },
    });
  });

  it("narrative_maintenance_attention_clear は必須 actor/requestId/OCC を強制する", async () => {
    const narrativeMaintenanceAttentionClear = vi
      .fn()
      .mockResolvedValue('{"findingKey":"finding-1","cleared":true}');
    const { backend } = fakeBackend({
      narrativeMaintenanceAttentionClear:
        narrativeMaintenanceAttentionClear as never,
    });
    const valid = MAINTENANCE_ATTENTION_CLEAR_PAYLOAD;
    const invalidPayloads: unknown[] = [
      null,
      [],
      "payload",
      {},
      omitKey(valid, "projectId"),
      omitKey(valid, "findingKey"),
      omitKey(valid, "actorId"),
      omitKey(valid, "requestId"),
      omitKey(valid, "expectedVersion"),
      { ...valid, projectId: "" },
      { ...valid, findingKey: "" },
      { ...valid, actorId: "" },
      { ...valid, actorId: null },
      { ...valid, requestId: "" },
      { ...valid, requestId: 7 },
      { ...valid, expectedVersion: -1 },
      { ...valid, expectedVersion: 2.5 },
      { ...valid, expectedVersion: "2" },
      { ...valid, expectedVersion: null },
      { ...valid, setBy: "actor-1" },
      { ...valid, reason: "なんとなく" },
      { ...valid, extra: true },
    ];

    for (const payload of invalidPayloads) {
      const result = await dispatchInvoke(
        "narrative_maintenance_attention_clear",
        { payload },
        { backend, shell: noShell },
      );
      expect(result.ok).toBe(false);
    }
    expect(narrativeMaintenanceAttentionClear).not.toHaveBeenCalled();

    const missingActor = await dispatchInvoke(
      "narrative_maintenance_attention_clear",
      { payload: omitKey(valid, "actorId") },
      { backend, shell: noShell },
    );
    expect(missingActor).toMatchObject({
      ok: false,
      error:
        "invalid args `actorId` for command `narrative_maintenance_attention_clear`: expected a string",
    });

    const missingMethod = await dispatchInvoke(
      "narrative_maintenance_attention_clear",
      { payload: valid },
      {
        backend: { ...backend, narrativeMaintenanceAttentionClear: undefined },
        shell: noShell,
      },
    );
    expect(missingMethod).toMatchObject({
      ok: false,
      error: `${IPC_BACKEND_UNAVAILABLE_MARKER} native method narrativeMaintenanceAttentionClear`,
    });
  });

  it("editor sticky commands keep DTO validation and backend mapping typed", async () => {
    const editorStickyCreate = vi
      .fn()
      .mockResolvedValue(
        '{"id":"sticky-1","projectId":"project-1","documentKey":"tree:database:scene-1"}',
      );
    const { backend } = fakeBackend({
      editorStickyCreate: editorStickyCreate as never,
    });
    const payload = {
      projectId: "project-1",
      documentKey: "tree:database:scene-1",
      body: '{"type":"doc","content":[]}',
      paletteId: "post-it-playful",
      colorSlot: 0,
      inlineOffset: 12,
      blockOffset: 24,
      zIndex: 0,
    };
    const env = await dispatchInvoke(
      "editor_sticky_create",
      { payload },
      { backend, shell: noShell },
    );
    expect(editorStickyCreate).toHaveBeenCalledExactlyOnceWith(payload);
    expect(env).toEqual({
      ok: true,
      value: {
        id: "sticky-1",
        projectId: "project-1",
        documentKey: "tree:database:scene-1",
      },
    });

    const restorePayload = { ...payload, id: "sticky-restore" };
    const restored = await dispatchInvoke(
      "editor_sticky_create",
      { payload: restorePayload },
      { backend, shell: noShell },
    );
    expect(editorStickyCreate).toHaveBeenLastCalledWith(restorePayload);
    expect(restored.ok).toBe(true);

    const invalidId = await dispatchInvoke(
      "editor_sticky_create",
      { payload: { ...payload, id: "" } },
      { backend, shell: noShell },
    );
    expect(invalidId.ok).toBe(false);
    expect(editorStickyCreate).toHaveBeenCalledTimes(2);

    const invalid = await dispatchInvoke(
      "editor_sticky_create",
      { payload: { ...payload, colorSlot: "0" } },
      { backend, shell: noShell },
    );
    expect(invalid.ok).toBe(false);
    expect(editorStickyCreate).toHaveBeenCalledTimes(2);
    if (!invalid.ok) {
      expect(invalid.error).toContain(
        "invalid args `colorSlot` for command `editor_sticky_create`",
      );
    }
  });

  it("editor sticky list reports backend absence instead of falling through", async () => {
    const { backend } = fakeBackend();
    const env = await dispatchInvoke(
      "editor_sticky_list",
      { projectId: "project-1", documentKey: "tree:database:scene-1" },
      { backend, shell: noShell },
    );
    expect(env).toMatchObject({
      ok: false,
      error: "IPC_BACKEND_UNAVAILABLE: native method editorStickyList",
    });
  });

  it("lint_ignore_create: typed payload を位置引数のJSONへ写像する", async () => {
    const lintIgnoreCreate = vi
      .fn()
      .mockResolvedValue(
        '{"id":"ignore-1","ruleId":"style/repetition","sceneId":"scene-1","textSnippet":"x","contextBefore":"","contextAfter":"","note":null,"createdAt":1,"sceneTitle":"Scene"}',
      );
    const { backend } = fakeBackend({
      lintIgnoreCreate: lintIgnoreCreate as never,
    });
    const payload = {
      id: "ignore-1",
      projectId: "project-1",
      sceneId: "scene-1",
      ruleId: "style/repetition",
      textSnippet: "x",
      contextBefore: "",
      contextAfter: "",
      note: null,
      createdAt: 1,
    };
    const env = await dispatchInvoke(
      "lint_ignore_create",
      { payload },
      { backend, shell: noShell },
    );
    expect(lintIgnoreCreate).toHaveBeenCalledExactlyOnceWith(payload);
    expect(env).toEqual({
      ok: true,
      value: {
        id: "ignore-1",
        ruleId: "style/repetition",
        sceneId: "scene-1",
        textSnippet: "x",
        contextBefore: "",
        contextAfter: "",
        note: null,
        createdAt: 1,
        sceneTitle: "Scene",
      },
    });
  });

  it("lint_ignore_create: 必須フィールド不正時はbackendを呼ばない", async () => {
    const lintIgnoreCreate = vi.fn();
    const { backend } = fakeBackend({
      lintIgnoreCreate: lintIgnoreCreate as never,
    });
    const env = await dispatchInvoke(
      "lint_ignore_create",
      { payload: { id: "", projectId: "p1" } },
      { backend, shell: noShell },
    );
    expect(env.ok).toBe(false);
    expect(lintIgnoreCreate).not.toHaveBeenCalled();
    if (!env.ok) {
      expect(env.error).toContain("invalid args `id`");
    }
  });

  it("lint_term_dictionary_insert: typed payload を検証してJSONへ写像する", async () => {
    const lintTermDictionaryInsert = vi.fn().mockResolvedValue(
      JSON.stringify({
        id: "term-1",
        preferred: "子ども",
        variants: ["子供"],
        severity: "warning",
        note: null,
        enabled: true,
        sortOrder: 0,
        createdAt: 1,
        updatedAt: 1,
      }),
    );
    const { backend } = fakeBackend({
      lintTermDictionaryInsert: lintTermDictionaryInsert as never,
    });
    const payload = {
      id: "term-1",
      projectId: "project-1",
      preferred: "子ども",
      variants: ["子供"],
      severity: "warning",
      note: null,
      enabled: true,
      sortOrder: 0,
      createdAt: 1,
      updatedAt: 1,
    };
    const env = await dispatchInvoke(
      "lint_term_dictionary_insert",
      { payload },
      { backend, shell: noShell },
    );
    expect(lintTermDictionaryInsert).toHaveBeenCalledExactlyOnceWith(payload);
    expect(env).toEqual({
      ok: true,
      value: {
        id: "term-1",
        preferred: "子ども",
        variants: ["子供"],
        severity: "warning",
        note: null,
        enabled: true,
        sortOrder: 0,
        createdAt: 1,
        updatedAt: 1,
      },
    });
  });

  it("lint_term_dictionary_insert: 不正payloadと旧nativeを明示的に拒否する", async () => {
    const lintTermDictionaryInsert = vi.fn();
    const { backend } = fakeBackend({
      lintTermDictionaryInsert: lintTermDictionaryInsert as never,
    });
    const invalid = await dispatchInvoke(
      "lint_term_dictionary_insert",
      {
        payload: {
          id: "term-1",
          projectId: "project-1",
          preferred: "子ども",
          variants: [],
          severity: "warning",
          note: null,
          enabled: true,
          sortOrder: 0,
          createdAt: 1,
          updatedAt: 1,
        },
      },
      { backend, shell: noShell },
    );
    expect(invalid.ok).toBe(false);
    expect(lintTermDictionaryInsert).not.toHaveBeenCalled();

    const oldNative = await dispatchInvoke(
      "lint_term_dictionary_list",
      { projectId: "project-1" },
      { backend: fakeBackend().backend, shell: noShell },
    );
    expect(oldNative).toEqual({
      ok: false,
      error: "IPC_BACKEND_UNAVAILABLE: native method lintTermDictionaryList",
      errorInfo: {
        code: "IPC_BACKEND_UNAVAILABLE",
        message:
          "IPC_BACKEND_UNAVAILABLE: native method lintTermDictionaryList",
        retryable: false,
        outcome: "failed",
      },
    });
  });

  it("Chronicle typed commands は project/OCC payload を明示写像する", async () => {
    const eventGetVersion = vi.fn().mockResolvedValue("3");
    const eventSetParticipants = vi.fn().mockResolvedValue("4");
    const projectCalendarUpsert = vi.fn().mockResolvedValue(
      JSON.stringify({
        projectId: "project-1",
        daysPerYear: 360,
        version: 0,
      }),
    );
    const { backend } = fakeBackend({
      eventGetVersion: eventGetVersion as never,
      eventSetParticipants: eventSetParticipants as never,
      projectCalendarUpsert: projectCalendarUpsert as never,
    });
    const version = await dispatchInvoke(
      "event_get_version",
      { projectId: "project-1", eventId: "event-1" },
      { backend, shell: noShell },
    );
    expect(eventGetVersion).toHaveBeenCalledExactlyOnceWith(
      "project-1",
      "event-1",
    );
    expect(version).toEqual({ ok: true, value: 3 });

    const payload = {
      projectId: "project-1",
      requestId: "participants-request-1",
      sessionId: "chronicle-session-1",
      eventUid: "participants-event-1",
      eventId: "event-1",
      codexEntryIds: ["codex-1"],
      baseVersion: 3,
      updatedAt: "2026-07-30T00:00:00.000Z",
    };
    const participants = await dispatchInvoke(
      "event_set_participants",
      { payload },
      { backend, shell: noShell },
    );
    expect(eventSetParticipants).toHaveBeenCalledExactlyOnceWith(payload);
    expect(participants).toEqual({ ok: true, value: 4 });

    const calendarPayload = {
      projectId: "project-1",
      requestId: "calendar-request-1",
      sessionId: "chronicle-session-1",
      eventUid: "calendar-event-1",
      daysPerYear: 360,
      seasonBoundaries: "[]",
      startYear: 0,
      months: "[]",
      weekdayNames: "[]",
      weekdayStartIndex: 0,
      leapRule: '{"kind":"none"}',
      ageReckoning: "full",
      eras: "[]",
      reform: "null",
      timezone: "null",
      lunarTzMinutes: 540,
      baseVersion: null,
      updatedAt: "2026-07-30T00:00:00.000Z",
    };
    const calendar = await dispatchInvoke(
      "project_calendar_upsert",
      { payload: calendarPayload },
      { backend, shell: noShell },
    );
    expect(projectCalendarUpsert).toHaveBeenCalledExactlyOnceWith(
      calendarPayload,
    );
    expect(calendar).toEqual({
      ok: true,
      value: { projectId: "project-1", daysPerYear: 360, version: 0 },
    });
  });

  it("event_set_participants は不正payloadと旧nativeを拒否する", async () => {
    const eventSetParticipants = vi.fn();
    const { backend } = fakeBackend({
      eventSetParticipants: eventSetParticipants as never,
    });
    const invalid = await dispatchInvoke(
      "event_set_participants",
      {
        payload: {
          projectId: "project-1",
          requestId: "participants-request-1",
          sessionId: "chronicle-session-1",
          eventUid: "participants-event-1",
          eventId: "event-1",
          codexEntryIds: [""],
          baseVersion: 0,
          updatedAt: "2026-07-30T00:00:00.000Z",
        },
      },
      { backend, shell: noShell },
    );
    expect(invalid.ok).toBe(false);
    expect(eventSetParticipants).not.toHaveBeenCalled();

    const missingIdentity = await dispatchInvoke(
      "event_set_participants",
      {
        payload: {
          projectId: "project-1",
          eventId: "event-1",
          codexEntryIds: ["codex-1"],
          baseVersion: 0,
          updatedAt: "2026-07-30T00:00:00.000Z",
        },
      },
      { backend, shell: noShell },
    );
    expect(missingIdentity.ok).toBe(false);
    expect(eventSetParticipants).not.toHaveBeenCalled();

    const oldNative = await dispatchInvoke(
      "event_get_version",
      { projectId: "project-1", eventId: "event-1" },
      { backend: fakeBackend().backend, shell: noShell },
    );
    expect(oldNative).toMatchObject({
      ok: false,
      error: "IPC_BACKEND_UNAVAILABLE: native method eventGetVersion",
    });
  });

  it("AI tree plan writes は typed payload を検証してNativeへ渡す", async () => {
    const applyResult = {
      versions: [{ id: "scene-1", version: 2 }],
      changeEventUid: "event-1",
      maintenanceTransactionId: "tx-1",
      undoJournalId: "journal-1",
    };
    const undoResult = {
      versions: [{ id: "scene-1", version: 3 }],
      changeEventUid: "event-2",
      maintenanceTransactionId: "tx-2",
      undoJournalId: "journal-1",
    };
    const aiTreePlanApply = vi
      .fn()
      .mockResolvedValue(JSON.stringify(applyResult));
    const aiTreePlanUndo = vi
      .fn()
      .mockResolvedValue(JSON.stringify(undoResult));
    const { backend } = fakeBackend({
      aiTreePlanApply: aiTreePlanApply as never,
      aiTreePlanUndo: aiTreePlanUndo as never,
    });
    const applyPayload = {
      requestId: "tree-apply-request-1",
      projectId: "project-1",
      sessionId: "session-1",
      surface: "in-app-agent",
      kind: "scaffold",
      updatedAt: "2026-08-13T00:00:00.000Z",
      model: null,
      traceId: null,
      creates: [
        {
          id: "scene-1",
          parentId: null,
          nodeType: "scene",
          title: "Opening",
          sortOrder: "a0",
          synopsis: null,
        },
      ],
      updates: [],
      redo: false,
      originalTransactionId: null,
      undoJournalId: null,
    };
    const undoPayload = {
      requestId: "tree-undo-request-1",
      projectId: "project-1",
      sessionId: "session-1",
      updatedAt: "2026-08-13T00:01:00.000Z",
      originalTransactionId: "tx-1",
      undoJournalId: "journal-1",
      expectedVersions: [{ id: "scene-1", version: 2 }],
    };

    await expect(
      dispatchInvoke(
        "ai_tree_plan_apply",
        { payload: applyPayload },
        { backend, shell: noShell },
      ),
    ).resolves.toEqual({ ok: true, value: applyResult });
    await expect(
      dispatchInvoke(
        "ai_tree_plan_undo",
        { payload: undoPayload },
        { backend, shell: noShell },
      ),
    ).resolves.toEqual({ ok: true, value: undoResult });
    expect(aiTreePlanApply).toHaveBeenCalledExactlyOnceWith(applyPayload);
    expect(aiTreePlanUndo).toHaveBeenCalledExactlyOnceWith(undoPayload);
  });

  it("renderer aggregate writes は typed payload を native へ明示写像する", async () => {
    const authorshipReplaceLane = vi.fn().mockResolvedValue(undefined);
    const entityTagsSet = vi.fn().mockResolvedValue(undefined);
    const codexRenameUndoResult = {
      versions: [
        {
          kind: "node-title",
          refId: "scene-1",
          detailDefinitionId: null,
          baseVersion: 0,
          version: 1,
        },
      ],
    };
    const codexRenameUndo = vi
      .fn()
      .mockResolvedValue(JSON.stringify(codexRenameUndoResult));
    const scanStagingProjectCreate = vi.fn().mockResolvedValue(undefined);
    const scanStagingProjectPublish = vi.fn().mockResolvedValue(
      JSON.stringify({
        projectId: "project-1",
        semanticEpochId: null,
        __writeReceipt: {
          changeEventUid: "scan-publish-event-1",
          maintenanceTransactionId: "scan-publish-transaction-1",
        },
      }),
    );
    const projectDelete = vi.fn().mockResolvedValue(undefined);
    const mapWriteReceipt = {
      changeEventUid: "map-event-1",
      maintenanceTransactionId: "map-transaction-1",
      undoJournalId: "map-request-1",
    };
    const mapWriteBundle = vi
      .fn()
      .mockResolvedValue(JSON.stringify(mapWriteReceipt));
    const { backend } = fakeBackend({
      authorshipReplaceLane: authorshipReplaceLane as never,
      entityTagsSet: entityTagsSet as never,
      codexRenameUndo: codexRenameUndo as never,
      scanStagingProjectCreate: scanStagingProjectCreate as never,
      scanStagingProjectPublish: scanStagingProjectPublish as never,
      projectDelete: projectDelete as never,
      mapWriteBundle: mapWriteBundle as never,
    });
    const calls = [
      [
        "authorship_replace_lane",
        {
          payload: {
            lane: { kind: "node", nodeId: "scene-1" },
            spans: [
              {
                id: "span-1",
                fromPos: 1,
                toPos: 3,
                source: "ai",
                model: null,
                timestamp: "now",
                chatMsgId: null,
                traceId: null,
              },
            ],
          },
        },
        authorshipReplaceLane,
      ],
      [
        "entity_tags_set",
        {
          payload: {
            projectId: "project-1",
            entityKind: "codex",
            entityId: "codex-1",
            tagIds: ["tag-1"],
            updatedAt: "now",
            requestId: "tag-request-1",
            sessionId: "tag-session-1",
            eventUid: "tag-event-1",
            origin: "human",
            authorityRoute: "human-direct",
            caller: "manual-wrapper",
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
          },
        },
        entityTagsSet,
      ],
      [
        "codex_rename_undo",
        {
          payload: {
            requestId: "rename-undo-request-1",
            eventUid: "rename-undo-event-1",
            originalTransactionId: "rename-transaction-1",
            undoJournalId: "rename-journal-1",
            projectId: "project-1",
            updatedAt: "now",
            sessionId: "rename-session-1",
            updates: [
              {
                kind: "node-title",
                refId: "scene-1",
                detailDefinitionId: null,
                baseVersion: 0,
                value: "Old title",
                charCount: null,
                placedBeatPreview: null,
              },
            ],
          },
        },
        codexRenameUndo,
      ],
      [
        "scan_staging_project_create",
        {
          payload: {
            id: "project-1",
            title: "Import",
            language: "ja",
            createdAt: "now",
          },
        },
        scanStagingProjectCreate,
      ],
      [
        "scan_staging_project_publish",
        { payload: scanPublishIdentity() },
        scanStagingProjectPublish,
      ],
      [
        "project_delete",
        {
          payload: {
            ...mutationIdentity("project-delete-request-1", "project-1"),
          },
        },
        projectDelete,
      ],
      [
        "map_write_bundle",
        {
          payload: {
            kind: "erase-ai-branch",
            projectId: "project-1",
            requestId: "map-request-1",
            sessionId: "map-session-1",
            eventUid: "map-event-1",
            branchId: "branch-1",
            spanIds: [],
            stickyPositionIds: [],
            stickyIds: [],
          },
        },
        mapWriteBundle,
      ],
    ] as const;

    for (const [command, args, method] of calls) {
      await expect(
        dispatchInvoke(command, args, { backend, shell: noShell }),
      ).resolves.toEqual({
        ok: true,
        value:
          command === "codex_rename_undo"
            ? codexRenameUndoResult
            : command === "map_write_bundle"
              ? mapWriteReceipt
              : command === "scan_staging_project_publish"
                ? {
                    projectId: "project-1",
                    semanticEpochId: null,
                    __writeReceipt: {
                      changeEventUid: "scan-publish-event-1",
                      maintenanceTransactionId: "scan-publish-transaction-1",
                    },
                  }
                : null,
      });
      expect(method).toHaveBeenCalledExactlyOnceWith(args.payload);
    }
  });

  it("scan_staging_project_publish は exact import-apply authority を要求する", async () => {
    const scanStagingProjectPublish = vi
      .fn()
      .mockResolvedValue(JSON.stringify({ projectId: "project-1" }));
    const { backend } = fakeBackend({
      scanStagingProjectPublish: scanStagingProjectPublish as never,
    });

    await expect(
      dispatchInvoke(
        "scan_staging_project_publish",
        { payload: scanPublishIdentity() },
        { backend, shell: noShell },
      ),
    ).resolves.toEqual({ ok: true, value: { projectId: "project-1" } });
    expect(scanStagingProjectPublish).toHaveBeenCalledExactlyOnceWith(
      scanPublishIdentity(),
    );

    const rejected = await dispatchInvoke(
      "scan_staging_project_publish",
      {
        payload: {
          ...scanPublishIdentity("scan-publish-request-2"),
          origin: "human",
          authorityRoute: "human-direct",
          caller: "manual-wrapper",
        },
      },
      { backend, shell: noShell },
    );
    expect(rejected.ok).toBe(false);
    expect(scanStagingProjectPublish).toHaveBeenCalledOnce();
  });

  it("project_create は canonical identity と全Project入力を明示写像する", async () => {
    const projectResult = {
      id: "project-1",
      title: "Novel",
      language: "en",
      __writeReceipt: {
        changeEventUid: "project-event-1",
        maintenanceTransactionId: "project-transaction-1",
        undoJournalId: null,
      },
    };
    const projectCreate = vi
      .fn()
      .mockResolvedValue(JSON.stringify(projectResult));
    const { backend } = fakeBackend({ projectCreate: projectCreate as never });
    const payload = {
      projectId: "project-1",
      requestId: "project-request-1",
      sessionId: "project-session-1",
      eventUid: "project-event-1",
      origin: "human",
      authorityRoute: "human-direct",
      caller: "manual-wrapper",
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
      title: "Novel",
      genre: null,
      pov: null,
      tense: null,
      language: "en",
      styleGuide: null,
      aiInstructions: null,
      outline: null,
      targetReaders: null,
      createdAt: "2026-08-13T00:00:00.000Z",
      updatedAt: "2026-08-13T00:00:00.000Z",
    };

    await expect(
      dispatchInvoke(
        "project_create",
        { payload },
        { backend, shell: noShell },
      ),
    ).resolves.toEqual({ ok: true, value: projectResult });
    expect(projectCreate).toHaveBeenCalledExactlyOnceWith(payload);

    const invalid = await dispatchInvoke(
      "project_create",
      { payload: { ...payload, undoJournalId: undefined } },
      { backend, shell: noShell },
    );
    expect(invalid.ok).toBe(false);
    expect(projectCreate).toHaveBeenCalledTimes(1);

    const unavailable = await dispatchInvoke(
      "project_create",
      { payload },
      { backend: fakeBackend().backend, shell: noShell },
    );
    expect(unavailable).toMatchObject({
      ok: false,
      error: expect.stringContaining("IPC_BACKEND_UNAVAILABLE"),
    });
  });

  it("map promotion bundles は relation/position の原子payloadを検証する", async () => {
    const mapWriteReceipt = {
      changeEventUid: "event-1",
      maintenanceTransactionId: "map-transaction-1",
      undoJournalId: "request-1",
    };
    const mapWriteBundle = vi
      .fn()
      .mockResolvedValue(JSON.stringify(mapWriteReceipt));
    const { backend } = fakeBackend({
      mapWriteBundle: mapWriteBundle as never,
    });
    const relationPayload = {
      kind: "promote-user-edge-to-codex-relation",
      projectId: "project-1",
      requestId: "request-1",
      sessionId: "session-1",
      eventUid: "event-1",
      boardId: "board-1",
      edgeId: "edge-1",
      relationId: "relation-1",
      fromCodexId: "codex-1",
      toCodexId: "codex-2",
      relationType: "mentor",
      label: "Mentor",
      reuseExistingRelation: false,
      createdAt: "now",
      updatedAt: "now",
    };
    await expect(
      dispatchInvoke(
        "map_write_bundle",
        { payload: relationPayload },
        { backend, shell: noShell },
      ),
    ).resolves.toEqual({ ok: true, value: mapWriteReceipt });
    expect(mapWriteBundle).toHaveBeenCalledExactlyOnceWith(relationPayload);

    const invalid = await dispatchInvoke(
      "map_write_bundle",
      {
        payload: { ...relationPayload, reuseExistingRelation: "false" },
      },
      { backend, shell: noShell },
    );
    expect(invalid.ok).toBe(false);
    expect(mapWriteBundle).toHaveBeenCalledTimes(1);

    const missingReplayLineage = await dispatchInvoke(
      "map_write_bundle",
      {
        payload: {
          ...relationPayload,
          requestId: "request-undo",
          eventUid: "event-undo",
          origin: "undo",
        },
      },
      { backend, shell: noShell },
    );
    expect(missingReplayLineage.ok).toBe(false);
    expect(mapWriteBundle).toHaveBeenCalledTimes(1);
  });

  it("renderer aggregate writes は不正payloadと旧nativeを拒否する", async () => {
    const authorshipReplaceLane = vi.fn();
    const invalid = await dispatchInvoke(
      "authorship_replace_lane",
      {
        payload: {
          lane: { kind: "node", nodeId: "scene-1" },
          spans: [
            {
              id: "span-1",
              fromPos: 3,
              toPos: 1,
              source: "invalid",
              model: null,
              timestamp: null,
              chatMsgId: null,
              traceId: null,
            },
          ],
        },
      },
      {
        backend: fakeBackend({
          authorshipReplaceLane: authorshipReplaceLane as never,
        }).backend,
        shell: noShell,
      },
    );
    expect(invalid.ok).toBe(false);
    expect(authorshipReplaceLane).not.toHaveBeenCalled();

    for (const command of [
      "authorship_replace_lane",
      "codex_rename_undo",
      "entity_tags_set",
      "project_delete",
      "scan_staging_project_create",
      "scan_staging_project_publish",
      "map_write_bundle",
    ]) {
      const oldNative = await dispatchInvoke(
        command,
        command === "authorship_replace_lane"
          ? {
              payload: { lane: { kind: "node", nodeId: "scene-1" }, spans: [] },
            }
          : command === "codex_rename_undo"
            ? {
                payload: {
                  projectId: "project-1",
                  updatedAt: "now",
                  updates: [],
                },
              }
            : command === "entity_tags_set"
              ? {
                  payload: {
                    entityKind: "snippet",
                    entityId: "snippet-1",
                    tagIds: [],
                    updatedAt: null,
                  },
                }
              : command === "scan_staging_project_create"
                ? {
                    payload: {
                      id: "project-1",
                      title: "Import",
                      language: "en",
                      createdAt: "now",
                    },
                  }
                : command === "scan_staging_project_publish"
                  ? { payload: scanPublishIdentity("scan-publish-unavailable") }
                  : command === "project_delete"
                    ? {
                        payload: mutationIdentity(
                          "project-delete-request-2",
                          "project-1",
                        ),
                      }
                    : {
                        payload: {
                          kind: "erase-ai-branch",
                          projectId: "project-1",
                          branchId: "branch-1",
                          spanIds: [],
                          stickyPositionIds: [],
                          stickyIds: [],
                        },
                      },
        { backend: fakeBackend().backend, shell: noShell },
      );
      expect(oldNative).toMatchObject({
        ok: false,
        error: expect.stringContaining("IPC_BACKEND_UNAVAILABLE"),
      });
    }
  });

  it("project_delete rejects an empty projectId before native dispatch", async () => {
    const projectDelete = vi.fn().mockResolvedValue(undefined);
    const { backend } = fakeBackend({
      projectDelete: projectDelete as never,
    });

    const env = await dispatchInvoke(
      "project_delete",
      { payload: { projectId: "" } },
      { backend, shell: noShell },
    );

    expect(env.ok).toBe(false);
    expect(projectDelete).not.toHaveBeenCalled();
  });

  it("project snapshot typed commands は集約payloadを明示写像する", async () => {
    const projectSnapshotCreate = vi.fn().mockResolvedValue(undefined);
    const projectSnapshotRestoreContext = vi.fn().mockResolvedValue(
      JSON.stringify({
        structural: true,
        liveTables: ["tree_nodes"],
        treeRows: [],
        codexRows: [],
        snippetRows: [],
        auxRows: [],
        contentRows: [],
        liveCodexIds: [],
        liveCodexPhaseIds: [],
        liveTreeNodeIds: [],
        liveSnippetIds: [],
        liveEventIds: [],
        liveCodexTagIds: [],
      }),
    );
    const projectSnapshotApplyRestore = vi.fn().mockResolvedValue(
      JSON.stringify({
        canonicalSequence: 12,
        changeEventUid: "change-1",
        maintenanceTransactionId: "maintenance-1",
      }),
    );
    const { backend } = fakeBackend({
      projectSnapshotCreate: projectSnapshotCreate as never,
      projectSnapshotRestoreContext: projectSnapshotRestoreContext as never,
      projectSnapshotApplyRestore: projectSnapshotApplyRestore as never,
    });
    const createPayload = {
      projectId: "project-1",
      snapshotId: "snapshot-1",
      name: "Before edit",
      description: null,
      createdAt: "2026-07-30T00:00:00.000Z",
      treeRows: [
        {
          snapshot_id: "snapshot-1",
          node_id: "scene-1",
          char_count: 1,
        },
      ],
      codexRows: [],
      snippetRows: [],
      versionIds: ["version-1"],
    };
    const created = await dispatchInvoke(
      "project_snapshot_create",
      { payload: createPayload },
      { backend, shell: noShell },
    );
    expect(projectSnapshotCreate).toHaveBeenCalledExactlyOnceWith(
      createPayload,
    );
    expect(created).toEqual({ ok: true, value: null });

    const context = await dispatchInvoke(
      "project_snapshot_restore_context",
      {
        projectId: "project-1",
        snapshotId: "snapshot-1",
        scopes: ["body", "map"],
      },
      { backend, shell: noShell },
    );
    expect(projectSnapshotRestoreContext).toHaveBeenCalledExactlyOnceWith(
      "project-1",
      "snapshot-1",
      ["body", "map"],
    );
    expect(context).toMatchObject({
      ok: true,
      value: { structural: true, liveTables: ["tree_nodes"] },
    });

    const applyPayload = {
      requestId: "snapshot-restore-request-1",
      sessionId: "session-1",
      projectId: "project-1",
      snapshotId: "snapshot-1",
      scopes: ["body"],
      inserts: [
        {
          table: "tree_nodes",
          row: { id: "scene-1", project_id: "project-1" },
          mode: "insert",
        },
      ],
    };
    const applied = await dispatchInvoke(
      "project_snapshot_apply_restore",
      { payload: applyPayload },
      { backend, shell: noShell },
    );
    expect(projectSnapshotApplyRestore).toHaveBeenCalledExactlyOnceWith(
      applyPayload,
    );
    expect(applied).toEqual({
      ok: true,
      value: {
        canonicalSequence: 12,
        changeEventUid: "change-1",
        maintenanceTransactionId: "maintenance-1",
      },
    });
  });

  it("project snapshot commands は不正scope/tableと旧nativeを拒否する", async () => {
    const projectSnapshotApplyRestore = vi.fn();
    const { backend } = fakeBackend({
      projectSnapshotApplyRestore: projectSnapshotApplyRestore as never,
    });
    const invalidScope = await dispatchInvoke(
      "project_snapshot_restore_context",
      {
        projectId: "project-1",
        snapshotId: "snapshot-1",
        scopes: ["everything"],
      },
      { backend, shell: noShell },
    );
    expect(invalidScope.ok).toBe(false);

    const invalidTable = await dispatchInvoke(
      "project_snapshot_apply_restore",
      {
        payload: {
          requestId: "snapshot-restore-request-1",
          sessionId: "session-1",
          projectId: "project-1",
          snapshotId: "snapshot-1",
          scopes: ["body"],
          inserts: [
            {
              table: "projects",
              row: { id: "project-2" },
              mode: "insert",
            },
          ],
        },
      },
      { backend, shell: noShell },
    );
    expect(invalidTable.ok).toBe(false);
    expect(projectSnapshotApplyRestore).not.toHaveBeenCalled();

    const missingAuthority = await dispatchInvoke(
      "project_snapshot_apply_restore",
      {
        payload: {
          projectId: "project-1",
          snapshotId: "snapshot-1",
          scopes: ["body"],
          inserts: [],
        },
      },
      { backend, shell: noShell },
    );
    expect(missingAuthority.ok).toBe(false);
    expect(projectSnapshotApplyRestore).not.toHaveBeenCalled();

    const oldNative = await dispatchInvoke(
      "project_snapshot_restore_context",
      {
        projectId: "project-1",
        snapshotId: "snapshot-1",
        scopes: ["body"],
      },
      { backend: fakeBackend().backend, shell: noShell },
    );
    expect(oldNative).toMatchObject({
      ok: false,
      error:
        "IPC_BACKEND_UNAVAILABLE: native method projectSnapshotRestoreContext",
    });
  });

  it("revision_scene_restore は scene authority payload を検証してNative結果をparseする", async () => {
    const revisionSceneRestore = vi.fn().mockResolvedValue(
      JSON.stringify({
        sceneId: "scene-1",
        revisionId: "revision-1",
        safetyRevisionId: "safety-1",
        version: 5,
        updatedAt: "2026-08-13T00:00:00.000Z",
        changeEventUid: "change-1",
        canonicalSequence: 9,
        maintenanceTransactionId: "maintenance-1",
        replayed: false,
      }),
    );
    const { backend } = fakeBackend({
      revisionSceneRestore: revisionSceneRestore as never,
    });
    const payload = {
      requestId: "restore-request-1",
      sessionId: "session-1",
      projectId: "project-1",
      entityType: "scene",
      entityId: "scene-1",
      revisionId: "revision-1",
      content: '{"type":"doc"}',
      currentContent: '{"type":"doc","content":[]}',
      expectedVersion: 4,
      charCount: 0,
      placedBeatPreview: null,
    };

    const result = await dispatchInvoke(
      "revision_scene_restore",
      { payload },
      { backend, shell: noShell },
    );

    expect(revisionSceneRestore).toHaveBeenCalledExactlyOnceWith(payload);
    expect(result).toMatchObject({
      ok: true,
      value: {
        sceneId: "scene-1",
        safetyRevisionId: "safety-1",
        canonicalSequence: 9,
      },
    });
  });

  it("revision_scene_restore は非scene・負のversion・未知field・旧nativeをfail-closedにする", async () => {
    const revisionSceneRestore = vi.fn();
    const { backend } = fakeBackend({
      revisionSceneRestore: revisionSceneRestore as never,
    });
    const payload = {
      requestId: "restore-request-1",
      sessionId: "session-1",
      projectId: "project-1",
      entityType: "scene",
      entityId: "scene-1",
      revisionId: "revision-1",
      content: '{"type":"doc"}',
      currentContent: '{"type":"doc","content":[]}',
      expectedVersion: 4,
      charCount: 0,
      placedBeatPreview: null,
    };
    for (const invalid of [
      { ...payload, entityType: "snippet" },
      { ...payload, expectedVersion: -1 },
      { ...payload, rendererSql: "UPDATE tree_nodes" },
    ]) {
      const result = await dispatchInvoke(
        "revision_scene_restore",
        { payload: invalid },
        { backend, shell: noShell },
      );
      expect(result.ok).toBe(false);
    }
    expect(revisionSceneRestore).not.toHaveBeenCalled();

    const unavailableBackend = fakeBackend().backend;
    const unavailable = await dispatchInvoke(
      "revision_scene_restore",
      { payload },
      {
        backend: {
          ...unavailableBackend,
          revisionSceneRestore: undefined,
        } as NapiBackendLike,
        shell: noShell,
      },
    );
    expect(unavailable).toMatchObject({
      ok: false,
      error: expect.stringContaining(
        "IPC_BACKEND_UNAVAILABLE: native method revisionSceneRestore",
      ),
    });
  });

  it("save_scene_body_bundle: typed snapshot を1 payloadで渡して結果をparseする", async () => {
    const { backend, calls } = fakeBackend();
    const payload = {
      sceneId: "s1",
      projectId: "p1",
      requestId: "scene-request-1",
      sessionId: "scene-session-1",
      eventUid: "scene-event-1",
      origin: "human",
      timelapseSteps: [
        {
          stepType: "replace",
          from: 1,
          to: 1,
          slice: { content: [] },
        },
      ],
      includeSidecars: true,
      updatedAt: "2026-07-28T00:00:00.000Z",
      baseVersion: 4,
      contentJson: '{"type":"doc"}',
      charCount: 3,
      placedBeatPreview: null,
      unplacedBeatsDoc: "[]",
      unplacedBeatPreview: null,
      authorshipSpans: [],
      foreshadowSetups: [],
      foreshadowPayoffs: [],
      foreshadowBaseVersions: {},
      annotationAnchors: [],
      beatMentions: [],
      beatPovOverrides: [],
      docContentSize: 2,
    };
    const env = await dispatchInvoke(
      "save_scene_body_bundle",
      { payload },
      { backend, shell: noShell },
    );
    expect(calls).toEqual([{ method: "saveSceneBodyBundle", args: [payload] }]);
    expect(env).toEqual({
      ok: true,
      value: {
        placedBeatPreview: null,
        unplacedBeatPreview: null,
        contentVersion: 2,
        contentUpdatedAt: "2026-07-28T00:00:00.000Z",
        dbTransactionCount: 1,
        foreshadowRows: [],
      },
    });
  });

  it("save_scene_body_bundle: caller identity 欠落は native 前に拒否する", async () => {
    const { backend, calls } = fakeBackend();
    const env = await dispatchInvoke(
      "save_scene_body_bundle",
      {
        payload: {
          sceneId: "s1",
          projectId: "p1",
          requestId: "",
          sessionId: "scene-session-1",
          eventUid: "scene-event-1",
          includeSidecars: true,
          updatedAt: "2026-07-28T00:00:00.000Z",
          contentJson: "{}",
          charCount: 0,
          placedBeatPreview: null,
          unplacedBeatsDoc: "[]",
          unplacedBeatPreview: null,
          authorshipSpans: [],
          foreshadowSetups: [],
          foreshadowPayoffs: [],
          foreshadowBaseVersions: {},
          annotationAnchors: [],
          beatMentions: [],
          beatPovOverrides: [],
          docContentSize: 2,
        },
      },
      { backend, shell: noShell },
    );
    expect(env.ok).toBe(false);
    expect(calls).toEqual([]);
  });

  it("save_scene_body_bundle: invalid baseVersion は native 呼び出し前に拒否する", async () => {
    const { backend, calls } = fakeBackend();
    const env = await dispatchInvoke(
      "save_scene_body_bundle",
      {
        payload: {
          sceneId: "s1",
          projectId: "p1",
          requestId: "scene-request-1",
          sessionId: "scene-session-1",
          eventUid: "scene-event-1",
          includeSidecars: true,
          updatedAt: "2026-07-28T00:00:00.000Z",
          baseVersion: -1,
          contentJson: "{}",
          charCount: 0,
          placedBeatPreview: null,
          unplacedBeatsDoc: "[]",
          unplacedBeatPreview: null,
          authorshipSpans: [],
          foreshadowSetups: [],
          foreshadowPayoffs: [],
          annotationAnchors: [],
          beatMentions: [],
          beatPovOverrides: [],
          docContentSize: 2,
        },
      },
      { backend, shell: noShell },
    );
    expect(env.ok).toBe(false);
    expect(calls).toEqual([]);
  });

  it("save_scene_body_bundle: malformed arrays are rejected before native", async () => {
    const { backend, calls } = fakeBackend();
    const env = await dispatchInvoke(
      "save_scene_body_bundle",
      {
        payload: {
          sceneId: "s1",
          projectId: "p1",
          requestId: "scene-request-1",
          sessionId: "scene-session-1",
          eventUid: "scene-event-1",
          includeSidecars: true,
          updatedAt: "2026-07-28T00:00:00.000Z",
          contentJson: "{}",
          charCount: 0,
          placedBeatPreview: null,
          unplacedBeatsDoc: "[]",
          unplacedBeatPreview: null,
          authorshipSpans: "not-an-array",
          foreshadowSetups: [],
          foreshadowPayoffs: [],
          annotationAnchors: [],
          beatMentions: [],
          beatPovOverrides: [],
          docContentSize: 2,
        },
      },
      { backend, shell: noShell },
    );
    expect(env.ok).toBe(false);
    expect(calls).toEqual([]);
  });

  it("save_scene_body_bundle: malformed nested sidecars are rejected before native", async () => {
    const { backend, calls } = fakeBackend();
    const env = await dispatchInvoke(
      "save_scene_body_bundle",
      {
        payload: {
          sceneId: "s1",
          projectId: "p1",
          requestId: "scene-request-1",
          sessionId: "scene-session-1",
          eventUid: "scene-event-1",
          includeSidecars: true,
          updatedAt: "2026-07-28T00:00:00.000Z",
          contentJson: "{}",
          charCount: 0,
          placedBeatPreview: null,
          unplacedBeatsDoc: "[]",
          unplacedBeatPreview: null,
          authorshipSpans: [
            {
              fromPos: 4,
              toPos: 2,
              source: "human",
              model: null,
              timestamp: null,
              chatMsgId: null,
              traceId: null,
            },
          ],
          foreshadowSetups: [],
          foreshadowPayoffs: [],
          annotationAnchors: [],
          beatMentions: [],
          beatPovOverrides: [],
          docContentSize: 2,
        },
      },
      { backend, shell: noShell },
    );
    expect(env.ok).toBe(false);
    expect(calls).toEqual([]);
  });

  it("timelapse document coverage: strict proof shape and content dependencies are enforced", async () => {
    const proof = {
      eventUid: "coverage-event-1",
      sessionId: "coverage-session-1",
      contentDigest: `sha256:${"a".repeat(64)}`,
    };
    const codexPayload = {
      ...mutationIdentity("coverage-proof-1"),
      content: "body",
    };
    const { backend, calls } = fakeBackend();

    const accepted = await dispatchInvoke(
      "codex_update",
      { payload: { ...codexPayload, timelapseDocStepCoverage: proof } },
      { backend, shell: noShell },
    );
    expect(accepted.ok).toBe(true);
    expect(calls).toHaveLength(1);
    calls.length = 0;

    const invalidProofs: readonly Record<string, unknown>[] = [
      { ...codexPayload, timelapseDocStepCoverage: null },
      {
        ...codexPayload,
        timelapseDocStepCoverage: { ...omitKey(proof, "sessionId") },
      },
      {
        ...codexPayload,
        timelapseDocStepCoverage: { ...proof, extra: "reject" },
      },
      {
        ...codexPayload,
        timelapseDocStepCoverage: {
          ...proof,
          eventUid: 42,
        },
      },
      {
        ...codexPayload,
        timelapseDocStepCoverage: {
          ...proof,
          contentDigest: `SHA256:${"a".repeat(64)}`,
        },
      },
      {
        ...omitKey(codexPayload, "content"),
        timelapseDocStepCoverage: proof,
      },
    ];
    for (const payload of invalidProofs) {
      const rejected = await dispatchInvoke(
        "codex_update",
        { payload },
        { backend, shell: noShell },
      );
      expect(rejected.ok).toBe(false);
    }
    expect(calls).toEqual([]);

    const treePayload = {
      ...mutationIdentity("coverage-tree-1"),
      nodeId: "scene-1",
      patch: { content: "body", charCount: 4 },
      baseVersion: 1,
      bumpVersion: true,
      updatedAt: "2026-08-12T00:00:00.000Z",
      timelapseDocStepCoverage: proof,
    };
    const treeAccepted = await dispatchInvoke(
      "tree_node_patch",
      { payload: treePayload },
      { backend, shell: noShell },
    );
    expect(treeAccepted.ok).toBe(true);
    expect(calls).toHaveLength(1);
    calls.length = 0;

    const treeMetadataOnly = {
      ...treePayload,
      patch: { title: "metadata-only" },
    };
    const treeRejected = await dispatchInvoke(
      "tree_node_patch",
      { payload: treeMetadataOnly },
      { backend, shell: noShell },
    );
    expect(treeRejected.ok).toBe(false);
    expect(calls).toEqual([]);

    const scenePayload = {
      sceneId: "scene-1",
      projectId: "p1",
      requestId: "scene-coverage-request-1",
      sessionId: "scene-coverage-session-1",
      eventUid: "scene-coverage-event-1",
      origin: "human",
      timelapseSteps: [{ stepType: "replace" }],
      timelapseDocStepCoverage: proof,
      includeSidecars: true,
      updatedAt: "2026-08-12T00:00:00.000Z",
      contentJson: "{}",
      charCount: 0,
      placedBeatPreview: null,
      unplacedBeatsDoc: "[]",
      unplacedBeatPreview: null,
      authorshipSpans: [],
      foreshadowSetups: [],
      foreshadowPayoffs: [],
      foreshadowBaseVersions: {},
      annotationAnchors: [],
      beatMentions: [],
      beatPovOverrides: [],
      docContentSize: 2,
    };
    const sceneRejected = await dispatchInvoke(
      "save_scene_body_bundle",
      { payload: scenePayload },
      { backend, shell: noShell },
    );
    expect(sceneRejected.ok).toBe(false);
    expect(calls).toEqual([]);
  });

  it("runtime_performance_seed: owner tokenとtyped graphを1回のnative呼び出しへ写像する", async () => {
    const { backend, calls } = fakeBackend();
    const payload = {
      fixtureId: "runtime-fixture",
      projectId: "default-project",
      treeNodes: [{}],
      mapBoard: { id: "board" },
      projectSetting: { key: "editor.tabState", value: "{}" },
      mapNodePositions: [],
      mapEdges: [],
      plotThreads: [],
      plotThreadSceneLinks: [],
      events: [],
      eventRelations: [],
      chatSession: null,
      chatMessages: [],
    };
    const env = await dispatchInvoke(
      "runtime_performance_seed",
      { ownerToken: "owner-token", payload },
      { backend, shell: noShell },
    );

    expect(calls).toEqual([
      {
        method: "runtimePerformanceSeed",
        args: ["owner-token", payload],
      },
    ]);
    expect(env).toEqual({
      ok: true,
      value: {
        fixtureId: "runtime-fixture",
        insertedRowCount: 3,
        dbTransactionCount: 1,
        historySideEffectCount: 0,
      },
    });
  });

  it("runtime_performance_seed: token欠落とraw statement shapeをnative前に拒否する", async () => {
    const { backend, calls } = fakeBackend();
    for (const args of [
      { ownerToken: "", payload: {} },
      { ownerToken: "x".repeat(201), payload: {} },
      {
        ownerToken: "owner-token",
        payload: {
          fixtureId: "runtime-fixture",
          projectId: "default-project",
          statements: [{ sql: "INSERT INTO tree_nodes ..." }],
        },
      },
      {
        ownerToken: "owner-token",
        payload: {
          fixtureId: "runtime-fixture",
          projectId: "default-project",
          treeNodes: [{}],
          mapBoard: {},
          projectSetting: {},
          mapNodePositions: [],
          mapEdges: [],
          plotThreads: [],
          plotThreadSceneLinks: Array.from({ length: 6_001 }, () => ({})),
          events: [],
          eventRelations: [],
          chatSession: null,
          chatMessages: [],
        },
      },
    ]) {
      const env = await dispatchInvoke("runtime_performance_seed", args, {
        backend,
        shell: noShell,
      });
      expect(env.ok).toBe(false);
    }
    expect(calls).toEqual([]);
  });

  it("vacuum_database: renderer 引数を native へ渡さず null を返す", async () => {
    const { backend, calls } = fakeBackend();
    const env = await dispatchInvoke(
      "vacuum_database",
      { path: "/tmp/must-not-cross-the-boundary.db" },
      { backend, shell: noShell },
    );
    expect(calls).toEqual([{ method: "vacuumDatabase", args: [] }]);
    expect(env).toEqual({ ok: true, value: null });
  });

  it("open_workspace: {path} → openWorkspace(path)", async () => {
    const { backend, calls } = fakeBackend();
    const env = await dispatchInvoke(
      "open_workspace",
      { path: "/tmp/ws" },
      { backend, shell: noShell },
    );
    expect(calls).toEqual([{ method: "openWorkspace", args: ["/tmp/ws"] }]);
    expect(env).toEqual({
      ok: true,
      value: {
        status: "ready",
        workspace: {
          name: "ws",
          isExisting: true,
          workspaceId: "workspace-id",
        },
      },
    });
  });

  it("open_workspace: safe-mode outcome を discriminated union のまま返す", async () => {
    const { backend } = fakeBackend();
    Object.assign(backend, {
      openWorkspace: vi.fn().mockResolvedValue(
        JSON.stringify({
          status: "safe-mode",
          reason: "migration failed",
          candidates: [
            {
              id: "rc_migration_1",
              kind: "migration-snapshot",
              createdAt: "2026-08-10T00:00:00Z",
              schemaVersion: 27,
              appVersion: "0.1.0",
              sizeBytes: 123,
              checksumStatus: "verified",
            },
          ],
        }),
      ),
    });

    const env = await dispatchInvoke(
      "open_workspace",
      { path: "/tmp/ws" },
      { backend, shell: noShell },
    );

    expect(env).toEqual({
      ok: true,
      value: {
        status: "safe-mode",
        reason: "migration failed",
        candidates: [
          {
            id: "rc_migration_1",
            kind: "migration-snapshot",
            createdAt: "2026-08-10T00:00:00Z",
            schemaVersion: 27,
            appVersion: "0.1.0",
            sizeBytes: 123,
            checksumStatus: "verified",
          },
        ],
      },
    });
  });

  it("import_web_editor_workspace: {handoffJson} → importWebEditorWorkspace(handoffJson)", async () => {
    const { backend } = fakeBackend();
    const importWebEditorWorkspace = vi.fn(async (_handoffJson: string) =>
      JSON.stringify({
        path: "/app-data/web-editor-workspace-1",
        projectId: "project-1",
      }),
    );
    Object.assign(backend, { importWebEditorWorkspace });
    const handoffJson = JSON.stringify({
      schemaVersion: "grimodex/web-editor-workspace-handoff/1",
      workspace: { title: "Web Editor draft" },
    });

    const env = await dispatchInvoke(
      "import_web_editor_workspace",
      { handoffJson },
      { backend, shell: noShell },
    );

    expect(importWebEditorWorkspace).toHaveBeenCalledExactlyOnceWith(
      handoffJson,
    );
    expect(env).toEqual({
      ok: true,
      value: {
        path: "/app-data/web-editor-workspace-1",
        projectId: "project-1",
      },
    });
  });

  it.each([
    {},
    { handoffJson: null },
    { handoffJson: 42 },
    { handoffJson: {} },
    { handoffJson: [] },
  ])(
    "import_web_editor_workspace: handoffJsonが文字列でなければnative呼出し前に拒否する: %j",
    async (args) => {
      const { backend } = fakeBackend();
      const importWebEditorWorkspace = vi.fn(
        async (_handoffJson: string) => undefined,
      );
      Object.assign(backend, { importWebEditorWorkspace });

      const env = await dispatchInvoke("import_web_editor_workspace", args, {
        backend,
        shell: noShell,
      });

      expect(env.ok).toBe(false);
      if (!env.ok) {
        expect(env.error).toContain(
          "invalid args `handoffJson` for command `import_web_editor_workspace`",
        );
      }
      expect(importWebEditorWorkspace).not.toHaveBeenCalled();
    },
  );

  it("import_web_editor_workspace: backend不在はcommand単位の明示エラー", async () => {
    const env = await dispatchInvoke(
      "import_web_editor_workspace",
      { handoffJson: "{}" },
      { backend: null, shell: noShell },
    );

    expect(env).toMatchObject({
      ok: false,
      error: `${IPC_BACKEND_UNAVAILABLE_MARKER} import_web_editor_workspace`,
    });
  });

  it("import_web_editor_workspace: 旧native bindingのmethod欠落も明示エラー", async () => {
    const { backend } = fakeBackend();
    const env = await dispatchInvoke(
      "import_web_editor_workspace",
      { handoffJson: "{}" },
      { backend, shell: noShell },
    );

    expect(env).toMatchObject({
      ok: false,
      error: `${IPC_BACKEND_UNAVAILABLE_MARKER} native method importWebEditorWorkspace`,
    });
  });

  it("validate_workspace_path: boolean は parse せず素通し", async () => {
    const { backend } = fakeBackend();
    const env = await dispatchInvoke(
      "validate_workspace_path",
      { path: "/tmp/ws" },
      { backend, shell: noShell },
    );
    expect(env).toEqual({ ok: true, value: true });
  });

  it("list_backups: native JSON を BackupInfo 配列へ戻す", async () => {
    const { backend } = fakeBackend();
    const listBackups = vi.fn().mockResolvedValue(
      JSON.stringify([
        {
          fileName: "grimodex-20260711-120000.db.gz",
          sizeBytes: 1234,
          modifiedMs: 1_752_232_400_000,
          format: "db.gz",
        },
      ]),
    );
    Object.assign(backend, { listBackups });

    const env = await dispatchInvoke(
      "list_backups",
      {},
      { backend, shell: noShell },
    );

    expect(listBackups).toHaveBeenCalledOnce();
    expect(env).toEqual({
      ok: true,
      value: [
        {
          fileName: "grimodex-20260711-120000.db.gz",
          sizeBytes: 1234,
          modifiedMs: 1_752_232_400_000,
          format: "db.gz",
        },
      ],
    });
  });

  it("restore_backup: 安全な fileName だけを位置引数へ写像し unit を null にする", async () => {
    const { backend } = fakeBackend();
    const restoreBackup = vi.fn().mockResolvedValue(undefined);
    Object.assign(backend, { restoreBackup });

    for (const fileName of [
      "grimodex-20260711-120000.db",
      "grimodex-20260711-120000.db.gz",
    ]) {
      const env = await dispatchInvoke(
        "restore_backup",
        { fileName },
        { backend, shell: noShell },
      );
      expect(env).toEqual({ ok: true, value: null });
    }

    expect(restoreBackup.mock.calls).toEqual([
      ["grimodex-20260711-120000.db"],
      ["grimodex-20260711-120000.db.gz"],
    ]);
  });

  it.each([
    undefined,
    null,
    42,
    "",
    "../grimodex-20260711-120000.db",
    "sub/grimodex-20260711-120000.db",
    "grimodex\\20260711-120000.db",
    "grimodex-../escape.db",
    "backup-20260711-120000.db",
    "grimodex-20260711-120000.db.tmp",
  ])(
    "restore_backup: 不正な fileName=%j はnativeを呼ばず拒否する",
    async (fileName) => {
      const { backend } = fakeBackend();
      const restoreBackup = vi.fn().mockResolvedValue(undefined);
      Object.assign(backend, { restoreBackup });

      const env = await dispatchInvoke(
        "restore_backup",
        { fileName },
        { backend, shell: noShell },
      );

      expect(env.ok).toBe(false);
      if (!env.ok) {
        expect(env.error).toContain(
          "invalid args `fileName` for command `restore_backup`",
        );
      }
      expect(restoreBackup).not.toHaveBeenCalled();
    },
  );

  it("list_recovery_candidates: native JSON を RecoveryCandidate 配列へ戻す", async () => {
    const { backend } = fakeBackend();
    const listRecoveryCandidates = vi.fn().mockResolvedValue(
      JSON.stringify([
        {
          id: "rc_auto_1",
          kind: "automatic-backup",
          createdAt: "2026-08-10T00:00:00Z",
          schemaVersion: null,
          appVersion: null,
          sizeBytes: 456,
          checksumStatus: "unverified",
        },
      ]),
    );
    Object.assign(backend, { listRecoveryCandidates });

    const env = await dispatchInvoke(
      "list_recovery_candidates",
      {},
      { backend, shell: noShell },
    );

    expect(listRecoveryCandidates).toHaveBeenCalledOnce();
    expect(env).toEqual({
      ok: true,
      value: [
        {
          id: "rc_auto_1",
          kind: "automatic-backup",
          createdAt: "2026-08-10T00:00:00Z",
          schemaVersion: null,
          appVersion: null,
          sizeBytes: 456,
          checksumStatus: "unverified",
        },
      ],
    });
  });

  it("verify_recovery_candidate: rc_ candidateId だけを native へ渡す", async () => {
    const { backend } = fakeBackend();
    const verifyRecoveryCandidate = vi.fn().mockResolvedValue(
      JSON.stringify({
        id: "rc_manual_1",
        kind: "manual-backup",
        createdAt: "2026-08-10T00:00:00Z",
        schemaVersion: 27,
        appVersion: "0.1.0",
        sizeBytes: 789,
        checksumStatus: "verified",
      }),
    );
    Object.assign(backend, { verifyRecoveryCandidate });

    const env = await dispatchInvoke(
      "verify_recovery_candidate",
      { candidateId: "rc_manual_1" },
      { backend, shell: noShell },
    );

    expect(verifyRecoveryCandidate).toHaveBeenCalledExactlyOnceWith(
      "rc_manual_1",
    );
    expect(env).toEqual({
      ok: true,
      value: {
        id: "rc_manual_1",
        kind: "manual-backup",
        createdAt: "2026-08-10T00:00:00Z",
        schemaVersion: 27,
        appVersion: "0.1.0",
        sizeBytes: 789,
        checksumStatus: "verified",
      },
    });
  });

  it("restore_recovery_candidate: rc_ candidateId を写像し unit を null にする", async () => {
    const { backend } = fakeBackend();
    const restoreRecoveryCandidate = vi.fn().mockResolvedValue(undefined);
    Object.assign(backend, { restoreRecoveryCandidate });

    const env = await dispatchInvoke(
      "restore_recovery_candidate",
      { candidateId: "rc_auto_1" },
      { backend, shell: noShell },
    );

    expect(restoreRecoveryCandidate).toHaveBeenCalledExactlyOnceWith(
      "rc_auto_1",
    );
    expect(env).toEqual({ ok: true, value: null });
  });

  it("safe-mode recovery は renderer 由来の filesystem path を candidateId として拒否する", async () => {
    const { backend } = fakeBackend();
    const verifyRecoveryCandidate = vi.fn().mockResolvedValue("{}");
    const restoreRecoveryCandidate = vi.fn().mockResolvedValue(undefined);
    Object.assign(backend, {
      verifyRecoveryCandidate,
      restoreRecoveryCandidate,
    });

    for (const [command, method] of [
      ["verify_recovery_candidate", verifyRecoveryCandidate],
      ["restore_recovery_candidate", restoreRecoveryCandidate],
    ] as const) {
      for (const candidateId of [
        undefined,
        null,
        42,
        "",
        "backup-1",
        "../rc_escape",
        "rc_/tmp/grimodex.db",
        "rc_..\\escape",
      ]) {
        const env = await dispatchInvoke(
          command,
          { candidateId },
          { backend, shell: noShell },
        );

        expect(env.ok).toBe(false);
        if (!env.ok) {
          expect(env.error).toContain(
            `invalid args \`candidateId\` for command \`${command}\``,
          );
        }
      }
      expect(method).not.toHaveBeenCalled();
    }
  });

  it("safe-mode recovery file commands は JSON encoded string を文字列へ戻す", async () => {
    const { backend } = fakeBackend();
    const quarantineLiveDatabase = vi
      .fn()
      .mockResolvedValue(JSON.stringify("grimodex-quarantine-1.db"));
    const exportSafeModeDiagnostics = vi
      .fn()
      .mockResolvedValue(JSON.stringify("/tmp/ws/safe-mode-diagnostics.json"));
    Object.assign(backend, {
      quarantineLiveDatabase,
      exportSafeModeDiagnostics,
    });

    await expect(
      dispatchInvoke(
        "quarantine_live_database",
        {},
        { backend, shell: noShell },
      ),
    ).resolves.toEqual({
      ok: true,
      value: "grimodex-quarantine-1.db",
    });
    await expect(
      dispatchInvoke(
        "export_safe_mode_diagnostics",
        {},
        { backend, shell: noShell },
      ),
    ).resolves.toEqual({
      ok: true,
      value: "/tmp/ws/safe-mode-diagnostics.json",
    });
  });

  it("safe-mode recovery command は backend 不在を command 単位で明示する", async () => {
    const env = await dispatchInvoke(
      "list_recovery_candidates",
      {},
      { backend: null, shell: noShell },
    );

    expect(env).toMatchObject({
      ok: false,
      error: `${IPC_BACKEND_UNAVAILABLE_MARKER} list_recovery_candidates`,
    });
  });

  it("get_global_settings: 引数なし、JSON parse 済みで返す", async () => {
    const { backend, calls } = fakeBackend();
    const env = await dispatchInvoke(
      "get_global_settings",
      {},
      { backend, shell: noShell },
    );
    expect(calls).toEqual([{ method: "getGlobalSettings", args: [] }]);
    expect(env).toEqual({ ok: true, value: { uiScale: 100 } });
  });

  it("save_global_settings: unit 返りは null（Tauri ワイヤ同形）", async () => {
    const { backend, calls } = fakeBackend();
    const settings = { uiScale: 125 };
    const env = await dispatchInvoke(
      "save_global_settings",
      { settings },
      { backend, shell: noShell },
    );
    expect(calls).toEqual([{ method: "saveGlobalSettings", args: [settings] }]);
    expect(env).toEqual({ ok: true, value: null });
  });

  it("timelapse_append_batch: camelCase キーを位置引数へ明示写像", async () => {
    const { backend, calls } = fakeBackend();
    const events = [{ kind: "insert" }];
    const env = await dispatchInvoke(
      "timelapse_append_batch",
      { projectId: "p1", sessionId: "s1", events },
      { backend, shell: noShell },
    );
    expect(calls).toEqual([
      { method: "timelapseAppendBatch", args: ["p1", "s1", events] },
    ]);
    expect(env).toEqual({
      ok: true,
      value: { insertedCount: 1, tailSequence: 2, tailHash: "h" },
    });
  });

  it("timelapse_append_batch: Native-owned coverage rows are rejected before dispatch", async () => {
    const { backend, calls } = fakeBackend();
    const env = await dispatchInvoke(
      "timelapse_append_batch",
      {
        projectId: "p1",
        sessionId: "renderer-session",
        events: [
          {
            eventUid: "forged-coverage",
            domain: "timelapse-internal",
            opType: "doc.step.coverage",
            entityType: "scene",
            entityId: "scene-1",
            payload: JSON.stringify({
              resultContentDigest: `sha256:${"0".repeat(64)}`,
            }),
          },
        ],
      },
      { backend, shell: noShell },
    );

    if (env.ok) {
      throw new Error("expected public append to reject Native-owned coverage");
    }
    expect(env.error).toContain("TIMELAPSE_COVERAGE_RESERVED");
    expect(calls).toEqual([]);
  });

  it("timelapse_genesis_baselines_append: exact workspace-bound payloadを位置引数へ写像", async () => {
    const { backend, calls } = fakeBackend();
    const env = await dispatchInvoke(
      "timelapse_genesis_baselines_append",
      {
        expectedWorkspacePath: "/workspace/novel.gdx",
        projectId: "p1",
        kind: "scene",
        entityIds: ["scene-1", "scene-2", "scene-3", "scene-4"],
        anchorTimestamp: 1_800_000_000_000,
      },
      { backend, shell: noShell },
    );
    expect(calls).toEqual([
      {
        method: "timelapseGenesisBaselinesAppend",
        args: [
          "/workspace/novel.gdx",
          "p1",
          "scene",
          ["scene-1", "scene-2", "scene-3", "scene-4"],
          1_800_000_000_000,
        ],
      },
    ]);
    expect(env).toEqual({
      ok: true,
      value: {
        insertedCount: 2,
        skippedExistingBaselineCount: 1,
        skippedExistingBodyStepCount: 1,
      },
    });
  });

  it.each([
    [
      "missing path",
      { projectId: "p1", kind: "scene", entityIds: ["s1"], anchorTimestamp: 1 },
    ],
    [
      "blank path",
      {
        expectedWorkspacePath: "",
        projectId: "p1",
        kind: "scene",
        entityIds: ["s1"],
        anchorTimestamp: 1,
      },
    ],
    [
      "unknown kind",
      {
        expectedWorkspacePath: "/workspace/a",
        projectId: "p1",
        kind: "chapter",
        entityIds: ["s1"],
        anchorTimestamp: 1,
      },
    ],
    [
      "empty ids",
      {
        expectedWorkspacePath: "/workspace/a",
        projectId: "p1",
        kind: "scene",
        entityIds: [],
        anchorTimestamp: 1,
      },
    ],
    [
      "duplicate ids",
      {
        expectedWorkspacePath: "/workspace/a",
        projectId: "p1",
        kind: "scene",
        entityIds: ["s1", "s1"],
        anchorTimestamp: 1,
      },
    ],
    [
      "too many ids",
      {
        expectedWorkspacePath: "/workspace/a",
        projectId: "p1",
        kind: "scene",
        entityIds: Array.from({ length: 65 }, (_, index) => `s${index}`),
        anchorTimestamp: 1,
      },
    ],
    [
      "negative timestamp",
      {
        expectedWorkspacePath: "/workspace/a",
        projectId: "p1",
        kind: "scene",
        entityIds: ["s1"],
        anchorTimestamp: -1,
      },
    ],
    [
      "unknown field",
      {
        expectedWorkspacePath: "/workspace/a",
        projectId: "p1",
        kind: "scene",
        entityIds: ["s1"],
        anchorTimestamp: 1,
        content: "renderer-owned",
      },
    ],
  ])("timelapse genesis rejects %s before Native", async (_label, args) => {
    const method = vi.fn();
    const { backend } = fakeBackend({
      timelapseGenesisBaselinesAppend: method,
    });

    const env = await dispatchInvoke(
      "timelapse_genesis_baselines_append",
      args,
      { backend, shell: noShell },
    );

    expect(env.ok).toBe(false);
    expect(method).not.toHaveBeenCalled();
  });

  it("timelapse genesis reports backend version skew explicitly", async () => {
    const { backend } = fakeBackend({
      timelapseGenesisBaselinesAppend: undefined,
    });
    const env = await dispatchInvoke(
      "timelapse_genesis_baselines_append",
      {
        expectedWorkspacePath: "/workspace/a",
        projectId: "p1",
        kind: "snippet",
        entityIds: ["snippet-1"],
        anchorTimestamp: 1,
      },
      { backend, shell: noShell },
    );
    expect(env.ok).toBe(false);
    if (!env.ok) {
      expect(env.error).toContain(IPC_BACKEND_UNAVAILABLE_MARKER);
      expect(env.error).toContain("timelapseGenesisBaselinesAppend");
    }
  });

  it("timelapse_body_baselines_append: identity-only batch and OCC tail are mapped", async () => {
    const { backend, calls } = fakeBackend();
    const env = await dispatchInvoke(
      "timelapse_body_baselines_append",
      {
        expectedWorkspacePath: "/workspace/novel.gdx",
        projectId: "p1",
        targets: [
          { kind: "scene", id: "s1" },
          { kind: "codex", id: "c1" },
        ],
        expectedAnchorSequence: 7,
      },
      { backend, shell: noShell },
    );
    expect(calls).toEqual([
      {
        method: "timelapseBodyBaselinesAppend",
        args: [
          "/workspace/novel.gdx",
          "p1",
          [
            { kind: "scene", id: "s1" },
            { kind: "codex", id: "c1" },
          ],
          7,
        ],
      },
    ]);
    expect(env).toEqual({
      ok: true,
      value: {
        insertedCount: 2,
        skippedExistingCount: 1,
        anchorSequence: 7,
        anchorTimestamp: 1_800_000_000_000,
      },
    });
  });

  it.each([
    {
      targets: [{ kind: "scene", id: "s1", payload: "forged" }],
      expectedAnchorSequence: null,
    },
    {
      targets: [{ kind: "scene", id: "s1" }, { kind: "scene", id: "s1" }],
      expectedAnchorSequence: null,
    },
    {
      targets: [{ kind: "scene", id: "s1" }],
      expectedAnchorSequence: -1,
    },
  ])("timelapse body rejects forged target shape before Native: %j", async (input) => {
    const method = vi.fn();
    const { backend } = fakeBackend({ timelapseBodyBaselinesAppend: method });
    const env = await dispatchInvoke(
      "timelapse_body_baselines_append",
      {
        expectedWorkspacePath: "/workspace/novel.gdx",
        projectId: "p1",
        ...input,
      },
      { backend, shell: noShell },
    );
    expect(env.ok).toBe(false);
    expect(method).not.toHaveBeenCalled();
  });

  it("timelapse_history_purge: exact workspace/project maps to atomic Native command", async () => {
    const { backend, calls } = fakeBackend();
    const env = await dispatchInvoke(
      "timelapse_history_purge",
      {
        expectedWorkspacePath: "/workspace/novel.gdx",
        projectId: "p1",
      },
      { backend, shell: noShell },
    );
    expect(calls).toEqual([
      {
        method: "timelapseHistoryPurge",
        args: ["/workspace/novel.gdx", "p1"],
      },
    ]);
    expect(env).toEqual({
      ok: true,
      value: { deletedEventCount: 3, deletedSnapshotCount: 2 },
    });
  });

  it("timelapse_enabled_set: boolean flag is path-bound", async () => {
    const { backend, calls } = fakeBackend();
    const env = await dispatchInvoke(
      "timelapse_enabled_set",
      {
        expectedWorkspacePath: "/workspace/novel.gdx",
        projectId: "p1",
        enabled: false,
      },
      { backend, shell: noShell },
    );
    expect(calls).toEqual([
      {
        method: "timelapseEnabledSet",
        args: ["/workspace/novel.gdx", "p1", false],
      },
    ]);
    expect(env).toEqual({ ok: true, value: { enabled: true } });
  });

  it("timelapse_layout_snapshot_record: only fixed payload scope reaches Native", async () => {
    const { backend, calls } = fakeBackend();
    const env = await dispatchInvoke(
      "timelapse_layout_snapshot_record",
      {
        expectedWorkspacePath: "/workspace/novel.gdx",
        projectId: "p1",
        payload: {
          layout: { regions: {} },
          activePresetId: null,
          hiddenStripePanels: ["chat"],
        },
        expectedAnchorSequence: 7,
      },
      { backend, shell: noShell },
    );
    expect(calls).toEqual([
      {
        method: "timelapseLayoutSnapshotRecord",
        args: [
          "/workspace/novel.gdx",
          "p1",
          {
            layout: { regions: {} },
            activePresetId: null,
            hiddenStripePanels: ["chat"],
          },
          7,
        ],
      },
    ]);
    expect(env).toEqual({
      ok: true,
      value: {
        inserted: true,
        anchorSequence: 7,
        anchorTimestamp: 1_800_000_000_000,
      },
    });
  });

  it("timelapse layout rejects renderer-selected scope fields", async () => {
    const method = vi.fn();
    const { backend } = fakeBackend({
      timelapseLayoutSnapshotRecord: method,
    });
    const env = await dispatchInvoke(
      "timelapse_layout_snapshot_record",
      {
        expectedWorkspacePath: "/workspace/novel.gdx",
        projectId: "p1",
        payload: {
          layout: { regions: {} },
          domain: "forged",
        },
        expectedAnchorSequence: null,
      },
      { backend, shell: noShell },
    );
    expect(env.ok).toBe(false);
    expect(method).not.toHaveBeenCalled();
  });

  it("tree_node_patch: optional content eventを同じtyped payloadへ保持する", async () => {
    const { backend, calls } = fakeBackend();
    const payload = {
      projectId: "p1",
      requestId: "tree-patch-request-1",
      sessionId: "external-product-journey",
      eventUid: "external-event-1",
      origin: "human",
      authorityRoute: "human-direct",
      caller: "manual-wrapper",
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
      nodeId: "scene-1",
      patch: { content: '{"type":"doc"}', charCount: 4 },
      baseVersion: 3,
      bumpVersion: true,
      updatedAt: "2026-08-12T00:00:00.000Z",
      changeEvent: {
        eventUid: "external-event-1",
        sessionId: "external-product-journey",
        timestamp: 1_786_492_800_000,
      },
    };
    const env = await dispatchInvoke(
      "tree_node_patch",
      { payload },
      { backend, shell: noShell },
    );

    expect(calls).toContainEqual({ method: "treeNodePatch", args: [payload] });
    expect(env).toEqual({
      ok: true,
      value: { id: "node-1", projectId: "p1", version: 1 },
    });

    for (const invalidPayload of [
      { ...payload, baseVersion: undefined },
      { ...payload, bumpVersion: false },
      { ...payload, patch: { title: "not content" } },
      {
        ...payload,
        changeEvent: { ...payload.changeEvent, timestamp: -1 },
      },
    ]) {
      const rejected = await dispatchInvoke(
        "tree_node_patch",
        { payload: invalidPayload },
        { backend, shell: noShell },
      );
      expect(rejected.ok).toBe(false);
    }
  });

  it("AI audit commands: workspace identityと型検証済みイベントをnativeへ写像する", async () => {
    const { backend, calls } = fakeBackend();
    const events = [
      {
        eventId: "event-1",
        executionId: "execution-1",
        operationId: "operation-1",
        parentExecutionId: null,
        pathId: "chat.direct",
        eventType: "request.prepared",
        timestamp: 1_700_000_000_000,
        payload: {
          captureState: "complete",
          credentialsExcluded: true,
          request: { messages: [] },
        },
      },
    ];
    const append = await dispatchInvoke(
      "ai_audit_append_batch",
      {
        projectId: "p1",
        expectedWorkspacePath: "/workspaces/novel",
        events,
      },
      { backend, shell: noShell },
    );
    const read = await dispatchInvoke(
      "ai_audit_read_snapshot",
      {
        projectId: "p1",
        expectedWorkspacePath: "/workspaces/novel",
        afterSequence: 0,
        highWaterSequence: 2,
        limit: 500,
      },
      { backend, shell: noShell },
    );
    const verify = await dispatchInvoke(
      "ai_audit_verify",
      {
        projectId: "p1",
        expectedWorkspacePath: "/workspaces/novel",
        highWaterSequence: 2,
      },
      { backend, shell: noShell },
    );

    expect(calls).toEqual([
      {
        method: "aiAuditAppendBatch",
        args: ["/workspaces/novel", "p1", events],
      },
      {
        method: "aiAuditReadSnapshot",
        args: ["/workspaces/novel", "p1", 0, 2, 500],
      },
      {
        method: "aiAuditVerify",
        args: ["/workspaces/novel", "p1", 2],
      },
    ]);
    expect(append).toEqual({
      ok: true,
      value: {
        insertedCount: 2,
        tailSequence: 2,
        tailHash: "audit-h",
      },
    });
    expect(read).toMatchObject({
      ok: true,
      value: { highWaterSequence: 2, highWaterHash: "audit-h" },
    });
    expect(verify).toMatchObject({ ok: true, value: { ok: true } });
  });

  it("ai_audit_append_batch: allowlist外eventTypeとcredential-bearing payloadを拒否する", async () => {
    const { backend, calls } = fakeBackend();
    const base = {
      eventId: "event-1",
      executionId: "execution-1",
      operationId: "operation-1",
      parentExecutionId: null,
      pathId: "chat.direct",
      timestamp: 1_700_000_000_000,
      payload: { captureState: "complete", credentialsExcluded: true },
    };

    const forbiddenPayloads = [
      { authorization: "Bearer secret" },
      { request: { headers: { Authorization: "Bearer secret" } } },
      { request: { options: { apiKey: "secret" } } },
      { request: { options: { API_KEY: "secret" } } },
      { request: { headers: { "x-api-key": "secret" } } },
      { request: { headers: { Cookie: "session=secret" } } },
      { request: { headers: { "Set-Cookie": "session=secret" } } },
      { request: { process: { env: { TOKEN: "secret" } } } },
      { request: { auditMetadata: { apiKey: "secret" } } },
      { request: { context: { apiKey: "legacy-secret" } } },
    ];
    const events = [
      { ...base, eventType: "arbitrary.event" },
      ...forbiddenPayloads.map((forbidden) => ({
        ...base,
        eventType: "request.prepared",
        payload: {
          captureState: "complete",
          credentialsExcluded: true,
          ...forbidden,
        },
      })),
    ];

    for (const event of events) {
      const result = await dispatchInvoke(
        "ai_audit_append_batch",
        {
          projectId: "p1",
          expectedWorkspacePath: "/workspaces/novel",
          events: [event],
        },
        { backend, shell: noShell },
      );
      expect(result.ok).toBe(false);
    }
    expect(calls).toHaveLength(0);
  });

  it("ai_audit_append_batch: AI-visible tool schemaとuser contentのcredential同名キーはexactに保持する", async () => {
    const aiAuditAppendBatch = vi
      .fn()
      .mockResolvedValue('{"insertedCount":1,"tailSequence":1,"tailHash":"h"}');
    const { backend } = fakeBackend({
      aiAuditAppendBatch: aiAuditAppendBatch as never,
    });
    const event = {
      eventId: "event-visible-content",
      executionId: "execution-1",
      operationId: "operation-1",
      parentExecutionId: null,
      pathId: "chat.direct",
      eventType: "request.prepared",
      timestamp: 1_700_000_000_000,
      payload: {
        captureState: "complete",
        credentialsExcluded: true,
        request: {
          messages: [
            {
              role: "user",
              content: {
                apiKey: "this is fictional manuscript content",
                env: "a story setting",
              },
            },
          ],
          tools: [
            {
              type: "function",
              function: {
                name: "inspect_request",
                parameters: {
                  type: "object",
                  properties: {
                    headers: { type: "string" },
                    "x-api-key": { type: "string" },
                  },
                },
              },
            },
          ],
          modelVisibleContext: {
            apiKey: "fictional contextual key",
            authentication: "fictional contextual oath",
          },
        },
      },
    };

    const result = await dispatchInvoke(
      "ai_audit_append_batch",
      {
        projectId: "p1",
        expectedWorkspacePath: "/workspaces/novel",
        events: [event],
      },
      { backend, shell: noShell },
    );

    expect(result.ok).toBe(true);
    expect(aiAuditAppendBatch).toHaveBeenCalledWith("/workspaces/novel", "p1", [
      event,
    ]);

    const diagnosticResult = await dispatchInvoke(
      "ai_audit_append_batch",
      {
        projectId: "p1",
        expectedWorkspacePath: "/workspaces/novel",
        events: [
          {
            ...event,
            eventId: "event-runtime-diagnostic",
            eventType: "response.partial",
            payload: {
              captureState: "complete",
              response: {
                runtimeDiagnostic: {
                  content: { authentication: "must not persist" },
                },
              },
            },
          },
        ],
      },
      { backend, shell: noShell },
    );
    expect(diagnosticResult.ok).toBe(false);
  });

  it("ai_audit_append_batch: redaction record schemaを固定する", async () => {
    const aiAuditAppendBatch = vi
      .fn()
      .mockResolvedValue('{"insertedCount":1,"tailSequence":1,"tailHash":"h"}');
    const { backend } = fakeBackend({
      aiAuditAppendBatch: aiAuditAppendBatch as never,
    });
    const base = {
      eventId: "event-redacted",
      executionId: "execution-1",
      operationId: "operation-1",
      parentExecutionId: null,
      pathId: "chat.direct",
      eventType: "execution.failed",
      timestamp: 1_700_000_000_000,
    };
    const validRedaction = {
      path: "error.message",
      category: "credential",
      ruleId: "transport-bearer-v1",
      originalSha256: "a".repeat(64),
      originalByteLength: 19,
      placeholder: "[REDACTED:credential]",
      reversible: false,
    };

    const valid = await dispatchInvoke(
      "ai_audit_append_batch",
      {
        projectId: "p1",
        expectedWorkspacePath: "/workspaces/novel",
        events: [
          {
            ...base,
            payload: {
              captureState: "redacted",
              error: { message: "[REDACTED:credential]" },
              redactions: [validRedaction],
            },
          },
        ],
      },
      { backend, shell: noShell },
    );
    expect(valid.ok).toBe(true);

    for (const invalidRedaction of [
      { ...validRedaction, originalByteLength: -1 },
      { ...validRedaction, originalSha256: "A".repeat(64) },
      { ...validRedaction, reversible: true },
      { ...validRedaction, originalLength: 19 },
    ]) {
      const result = await dispatchInvoke(
        "ai_audit_append_batch",
        {
          projectId: "p1",
          expectedWorkspacePath: "/workspaces/novel",
          events: [
            {
              ...base,
              eventId: crypto.randomUUID(),
              payload: {
                captureState: "redacted",
                redactions: [invalidRedaction],
              },
            },
          ],
        },
        { backend, shell: noShell },
      );
      expect(result.ok).toBe(false);
    }
  });

  it("ime_export_refresh: workspace identityを含む引数を位置引数へ写像し Status DTO を parse する", async () => {
    const { backend, calls } = fakeBackend();
    const options = {
      mode: "auto",
      excludeHidden: true,
      includeProfile: false,
    };
    const env = await dispatchInvoke(
      "ime_export_refresh",
      {
        projectId: "p1",
        expectedWorkspacePath: "/workspaces/a",
        options,
      },
      { backend, shell: noShell },
    );

    expect(calls).toEqual([
      {
        method: "imeExportRefresh",
        args: ["p1", "/workspaces/a", options],
      },
    ]);
    expect(env).toEqual({ ok: true, value: IME_EXPORT_STATUS_VALUE });
  });

  it("ime_export_set_active_project: projectId の string / null を保持し Status DTO を parse する", async () => {
    const { backend, calls } = fakeBackend();
    const active = await dispatchInvoke(
      "ime_export_set_active_project",
      {
        projectId: "p1",
        expectedWorkspacePath: "/workspaces/a",
        mode: "auto",
      },
      { backend, shell: noShell },
    );
    const inactive = await dispatchInvoke(
      "ime_export_set_active_project",
      { projectId: null, expectedWorkspacePath: null, mode: "off" },
      { backend, shell: noShell },
    );

    expect(calls).toEqual([
      {
        method: "imeExportSetActiveProject",
        args: ["p1", "/workspaces/a", "auto"],
      },
      { method: "imeExportSetActiveProject", args: [null, null, "off"] },
    ]);
    const status = { ok: true, value: IME_EXPORT_STATUS_VALUE };
    expect(active).toEqual(status);
    expect(inactive).toEqual(status);
  });

  it("ime_export_set_active_project: projectId は null / string 以外を拒否する", async () => {
    const { backend, calls } = fakeBackend();
    const env = await dispatchInvoke(
      "ime_export_set_active_project",
      { projectId: 42, expectedWorkspacePath: "/workspaces/a", mode: "auto" },
      { backend, shell: noShell },
    );

    expect(env.ok).toBe(false);
    if (!env.ok) {
      expect(env.error).toContain(
        "invalid args `projectId` for command `ime_export_set_active_project`",
      );
    }
    expect(calls).toHaveLength(0);
  });

  it("ime_export_get_status: {mode} を写像し Status DTO を parse する", async () => {
    const { backend, calls } = fakeBackend();
    const env = await dispatchInvoke(
      "ime_export_get_status",
      { mode: "auto" },
      { backend, shell: noShell },
    );

    expect(calls).toEqual([{ method: "imeExportGetStatus", args: ["auto"] }]);
    expect(env).toEqual({ ok: true, value: IME_EXPORT_STATUS_VALUE });
  });

  it("ime_export_clear_all / remove_project: unit 返りは null（Tauri ワイヤ同形）", async () => {
    const { backend, calls } = fakeBackend();
    const clear = await dispatchInvoke(
      "ime_export_clear_all",
      {},
      { backend, shell: noShell },
    );
    const remove = await dispatchInvoke(
      "ime_export_remove_project",
      { projectId: "p1", expectedWorkspacePath: "/workspaces/a" },
      { backend, shell: noShell },
    );

    expect(calls).toEqual([
      { method: "imeExportClearAll", args: [] },
      {
        method: "imeExportRemoveProject",
        args: ["p1", "/workspaces/a"],
      },
    ]);
    expect(clear).toEqual({ ok: true, value: null });
    expect(remove).toEqual({ ok: true, value: null });
  });

  it("trash_bin_create: {payload}（struct 内 camelCase）を素通しし作成行を parse して返す", async () => {
    const { backend, calls } = fakeBackend();
    // Tauri 実装（trash_bin.rs）は payload struct の中身を serde rename_all の
    // camelCase で受ける — アダプタはキー変換せずそのまま渡すことが契約。
    const payload = {
      id: "trash-request-1",
      projectId: "p1",
      kind: "text-fragment",
      subKind: "text-fragment",
      originSceneId: null,
      originCodexId: null,
      previewText: "消した文字屑",
      previewMeta: null,
      payload: '{"text":"…"}',
      charCount: 6,
      isInteresting: false,
      deletedAt: "2026-07-10T00:00:00.000Z",
    };
    const env = await dispatchInvoke(
      "trash_bin_create",
      { payload },
      { backend, shell: noShell },
    );
    expect(calls).toEqual([{ method: "trashBinCreate", args: [payload] }]);
    expect(env).toEqual({
      ok: true,
      value: { id: "t1", preview_text: "消した文字屑" },
    });
  });

  it("trash_bin_restore: request/session/project authority payload を素通しし結果を parse する", async () => {
    const { backend, calls } = fakeBackend();
    const payload = {
      requestId: "restore-request-1",
      sessionId: "session-1",
      projectId: "p1",
      itemId: "t1",
      boardIdOverride: null,
      dropX: null,
      dropY: null,
    };
    const env = await dispatchInvoke(
      "trash_bin_restore",
      { payload },
      { backend, shell: noShell },
    );
    expect(calls).toEqual([{ method: "trashBinRestore", args: [payload] }]);
    expect(env).toEqual({
      ok: true,
      value: { newId: "restored-scene:t1", brokenLinks: [] },
    });
  });

  it("trash_bin_restore: payload 欠落は invalid args で backend を呼ばない", async () => {
    const { backend, calls } = fakeBackend();
    const env = await dispatchInvoke(
      "trash_bin_restore",
      {},
      { backend, shell: noShell },
    );
    expect(env.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("trash_bin_restore: authority identity欠落と非finite座標を拒否する", async () => {
    const { backend, calls } = fakeBackend();
    const missingSession = await dispatchInvoke(
      "trash_bin_restore",
      {
        payload: {
          requestId: "restore-request-1",
          projectId: "p1",
          itemId: "t1",
        },
      },
      { backend, shell: noShell },
    );
    const invalidCoordinate = await dispatchInvoke(
      "trash_bin_restore",
      {
        payload: {
          requestId: "restore-request-1",
          sessionId: "session-1",
          projectId: "p1",
          itemId: "t1",
          dropX: Number.NaN,
        },
      },
      { backend, shell: noShell },
    );
    expect(missingSession.ok).toBe(false);
    expect(invalidCoordinate.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("trash_bin_list: {projectId, limit} → 位置引数、行配列を parse して返す", async () => {
    const { backend, calls } = fakeBackend();
    const env = await dispatchInvoke(
      "trash_bin_list",
      { projectId: "p1", limit: 50 },
      { backend, shell: noShell },
    );
    expect(calls).toEqual([{ method: "trashBinList", args: ["p1", 50] }]);
    expect(env).toEqual({
      ok: true,
      value: [{ id: "t1", preview_text: "消した文字屑" }],
    });
  });

  it("trash_bin_list: limit 省略 / null は Option<i64> の None（undefined）に落ちる", async () => {
    const { backend, calls } = fakeBackend();
    await dispatchInvoke(
      "trash_bin_list",
      { projectId: "p1" },
      { backend, shell: noShell },
    );
    await dispatchInvoke(
      "trash_bin_list",
      { projectId: "p1", limit: null },
      { backend, shell: noShell },
    );
    expect(calls).toEqual([
      { method: "trashBinList", args: ["p1", undefined] },
      { method: "trashBinList", args: ["p1", undefined] },
    ]);
  });

  it("trash_bin_delete / trash_bin_clear_all: unit 返りは null（Tauri ワイヤ同形）", async () => {
    const { backend, calls } = fakeBackend();
    const del = await dispatchInvoke(
      "trash_bin_delete",
      { id: "t1" },
      { backend, shell: noShell },
    );
    const clear = await dispatchInvoke(
      "trash_bin_clear_all",
      { projectId: "p1" },
      { backend, shell: noShell },
    );
    expect(calls).toEqual([
      { method: "trashBinDelete", args: ["t1"] },
      { method: "trashBinClearAll", args: ["p1"] },
    ]);
    expect(del).toEqual({ ok: true, value: null });
    expect(clear).toEqual({ ok: true, value: null });
  });

  it("trash_bin_prune: camelCase キーを位置引数へ明示写像し残件数を parse して返す", async () => {
    const { backend, calls } = fakeBackend();
    const env = await dispatchInvoke(
      "trash_bin_prune",
      { projectId: "p1", retentionDays: 60, maxCount: 10000 },
      { backend, shell: noShell },
    );
    expect(calls).toEqual([
      { method: "trashBinPrune", args: ["p1", 60, 10000] },
    ]);
    expect(env).toEqual({ ok: true, value: 42 });
  });

  it("trash_bin_prune: 数値キー欠落は invalid args エラー envelope（backend は呼ばれない）", async () => {
    const { backend, calls } = fakeBackend();
    const env = await dispatchInvoke(
      "trash_bin_prune",
      { projectId: "p1", retentionDays: "60", maxCount: 10000 },
      { backend, shell: noShell },
    );
    expect(env.ok).toBe(false);
    if (!env.ok) {
      expect(env.error).toContain(
        "invalid args `retentionDays` for command `trash_bin_prune`",
      );
    }
    expect(calls).toHaveLength(0);
  });

  it("必須キー欠落は invalid args エラー envelope（backend は呼ばれない）", async () => {
    const { backend, calls } = fakeBackend();
    const env = await dispatchInvoke(
      "open_workspace",
      {},
      { backend, shell: noShell },
    );
    expect(env.ok).toBe(false);
    if (!env.ok) {
      expect(env.error).toContain(
        "invalid args `path` for command `open_workspace`",
      );
    }
    expect(calls).toHaveLength(0);
  });

  it("napi コマンド表が揃っている（Electron移行 + IME Phase 2）", () => {
    expect(Object.keys(NAPI_COMMANDS).sort()).toEqual([
      "abort_chat_stream",
      "abort_inline_ai_stream",
      "abort_post_effect_run",
      "activate_license",
      "agent_accept_prose_stage",
      "agent_apply_undo_journal",
      "agent_chronicle_bulk_mutate",
      "agent_codex_create",
      "agent_codex_delete",
      "agent_codex_mutate",
      "agent_codex_update",
      "agent_discard_prose_stage",
      "agent_event_create",
      "agent_event_delete",
      "agent_event_relation_add",
      "agent_event_relation_remove",
      "agent_event_set_participants",
      "agent_event_update",
      "agent_foreshadow_create",
      "agent_foreshadow_update",
      "agent_propose_scene_body",
      "agent_scene_event_link",
      "agent_scene_event_link_batch",
      "agent_scene_event_unlink",
      "agent_snippet_create",
      "agent_write_bundle",
      "ai_audit_append_batch",
      "ai_audit_read_snapshot",
      "ai_audit_verify",
      "ai_tree_plan_apply",
      "ai_tree_plan_undo",
      "authorship_replace_lane",
      "chat_index_message",
      "chat_index_status",
      "chat_message_search",
      "chat_reindex_all",
      "chronicle_bulk_mutate",
      "codex_create",
      "codex_delete",
      "codex_index_entry",
      "codex_index_status",
      "codex_match_text",
      "codex_mutate",
      "codex_rebuild_matcher",
      "codex_reindex_all",
      "codex_rename_apply",
      "codex_rename_undo",
      "codex_semantic_search",
      "codex_update",
      "db_execute",
      "db_execute_batch",
      "deactivate_license",
      "editor_sticky_create",
      "editor_sticky_delete",
      "editor_sticky_list",
      "editor_sticky_update",
      "entity_tags_set",
      "event_create",
      "event_delete",
      "event_get_version",
      "event_participants_set",
      "event_relation_add",
      "event_relation_remove",
      "event_set_participants",
      "event_update",
      "events_index_entry",
      "events_index_status",
      "events_reindex_all",
      "events_semantic_search",
      "export_safe_mode_diagnostics",
      "extract_codex_candidates",
      "extract_codex_entity_seeds",
      "foreshadow_create",
      "foreshadow_delete",
      "foreshadow_get",
      "foreshadow_get_chapter_stats",
      "foreshadow_get_scene_context",
      "foreshadow_get_scene_info",
      "foreshadow_get_setup",
      "foreshadow_link_codex",
      "foreshadow_list_by_codex_entry",
      "foreshadow_list_linked_codex",
      "foreshadow_list_open_for_context",
      "foreshadow_list_with_labels",
      "foreshadow_load_anchors_for_scene",
      "foreshadow_resolve_orphan",
      "foreshadow_save_anchors_for_scene",
      "foreshadow_set_setup_strength",
      "foreshadow_setup_create_ai",
      "foreshadow_unlink_codex",
      "foreshadow_update",
      "foreshadow_update_setup",
      "fts_optimize",
      "fts_rebuild",
      "fts_rebuild_en",
      "fts_search",
      "get_ai_settings",
      "get_global_settings",
      "get_license_state",
      "get_narrative_backfill_status",
      "ime_export_clear_all",
      "ime_export_get_status",
      "ime_export_refresh",
      "ime_export_remove_project",
      "ime_export_set_active_project",
      "import_web_editor_workspace",
      "integrity_check",
      "lint_ignore_copy",
      "lint_ignore_create",
      "lint_ignore_delete",
      "lint_ignore_list",
      "lint_ignore_list_scene",
      "lint_ignore_move",
      "lint_term_dictionary_delete",
      "lint_term_dictionary_insert",
      "lint_term_dictionary_list",
      "lint_term_dictionary_set_enabled",
      "lint_term_dictionary_update",
      "lint_text",
      "list_ai_models",
      "list_annotations_for_project",
      "list_annotations_for_scene",
      "list_backups",
      "list_post_effect_runs",
      "list_recovery_candidates",
      "list_scene_lens_for_project",
      "list_system_fonts",
      "map_write_bundle",
      "narrative_extraction_append_decision",
      "narrative_extraction_append_human_decision",
      "narrative_extraction_append_revision",
      "narrative_extraction_apply_commit",
      "narrative_extraction_cancel_run",
      "narrative_extraction_capture_workspace_binding",
      "narrative_extraction_claim_task",
      "narrative_extraction_create_human_derived_revision",
      "narrative_extraction_create_run",
      "narrative_extraction_fail_task",
      "narrative_extraction_finish_task",
      "narrative_extraction_get_commit_status",
      "narrative_extraction_get_run",
      "narrative_extraction_get_run_review_bundle",
      "narrative_extraction_is_run_resumable_for_review",
      "narrative_extraction_list_chronicle_task_resume_candidates",
      "narrative_extraction_list_resumable_runs",
      "narrative_extraction_prepare_commit",
      "narrative_extraction_redo_commit",
      "narrative_extraction_revise_and_decide",
      "narrative_extraction_revise_and_decide_as_human",
      "narrative_extraction_save_proposal_set",
      "narrative_extraction_set_human_field_lock",
      "narrative_extraction_undo_commit",
      "narrative_maintenance_attention_clear",
      "narrative_maintenance_attention_set",
      "narrative_maintenance_inbox_list",
      "narrative_runtime_policy_get",
      "narrative_runtime_policy_set",
      "nir1_evidence_qualify",
      "nir1_graph_query",
      "nir1_pack_context",
      "open_workspace",
      "plot_thread_branch_create",
      "plot_thread_branch_delete",
      "plot_thread_branch_update",
      "plot_thread_create",
      "plot_thread_delete",
      "plot_thread_delete_snapshot",
      "plot_thread_link_create",
      "plot_thread_link_delete",
      "plot_thread_link_update",
      "plot_thread_list",
      "plot_thread_list_links",
      "plot_thread_move_marker_bundle",
      "plot_thread_restore_snapshot",
      "plot_thread_update",
      "project_calendar_upsert",
      "project_create",
      "project_delete",
      "project_patch",
      "project_snapshot_apply_restore",
      "project_snapshot_create",
      "project_snapshot_restore_context",
      "quarantine_live_database",
      "rebuild_narrative_derived_state",
      "related_scenes_begin",
      "related_scenes_continue",
      "related_scenes_release",
      "repair_integrity",
      "repair_narrative_dependency_declarations",
      "reply_to_annotation",
      "restore_backup",
      "restore_recovery_candidate",
      "retry_narrative_legacy_backfill",
      "revalidate_license",
      "revision_scene_restore",
      "runtime_performance_seed",
      "save_ai_settings",
      "save_global_settings",
      "save_post_effect_annotations",
      "save_scene_body_bundle",
      "scan_staging_project_create",
      "scan_staging_project_publish",
      "scene_event_link",
      "scene_event_link_batch",
      "scene_event_unlink",
      "seed_sample_workspace",
      "segment_bunsetsu",
      "semantic_cancel_background",
      "semantic_chunk_context",
      "semantic_debug_dump",
      "semantic_download_model",
      "semantic_index_scene",
      "semantic_index_status",
      "semantic_reindex_all",
      "semantic_reranker_shadow_score",
      "semantic_search",
      "send_agent_message",
      "send_chat_message",
      "send_chat_message_stream",
      "send_inline_ai_stream",
      "snippet_create",
      "snippet_delete",
      "snippet_update",
      "start_post_effect_run",
      "start_post_effect_run_multi",
      "temporal_scene_patch",
      "test_ai_connection",
      "timelapse_append_batch",
      "timelapse_body_baselines_append",
      "timelapse_enabled_set",
      "timelapse_genesis_baselines_append",
      "timelapse_history_purge",
      "timelapse_layout_snapshot_record",
      "trash_bin_clear_all",
      "trash_bin_create",
      "trash_bin_delete",
      "trash_bin_list",
      "trash_bin_prune",
      "trash_bin_restore",
      "tree_node_create",
      "tree_node_delete",
      "tree_node_patch",
      "update_annotation_status",
      "vacuum_database",
      "validate_workspace_path",
      "verify_narrative_dependency_graph",
      "verify_recovery_candidate",
    ]);
  });

  describe("Gate C2 Run Kind Policy commands", () => {
    it("verify_narrative_dependency_graph: projectId だけの payload を native adapter へ渡す", async () => {
      const verifyNarrativeDependencyGraph = vi
        .fn()
        .mockResolvedValue(
          '{"runId":"run-verify-1","semanticEpochId":"epoch-1","reportDigest":"sha256:report","report":{"totalEdges":2,"edgeIdsWithMissingSource":[],"duplicateEdgeKeys":[],"edgeIdsWithCrossProjectConsumer":[],"edgeIdsWithMalformedKeys":[],"edgeStateIdsOutsideCurrentEpoch":[],"findingObservationIdsOutsideCurrentEpoch":[],"duplicateEdgeIdsToDeactivate":[]}}',
        ) as never;
      const { backend } = fakeBackend({ verifyNarrativeDependencyGraph });
      const payload = { projectId: "project-1" };
      const env = await dispatchInvoke(
        "verify_narrative_dependency_graph",
        { payload },
        { backend, shell: noShell },
      );
      expect(verifyNarrativeDependencyGraph).toHaveBeenCalledWith(payload);
      // Verify now runs under a real Run so `dependency-repair` can prove
      // which Verify result its sealed plan came from -- the report is
      // nested under the Run identity rather than being the whole response.
      expect(env).toMatchObject({
        ok: true,
        value: {
          runId: "run-verify-1",
          reportDigest: "sha256:report",
          report: { totalEdges: 2 },
        },
      });
    });

    it("verify_narrative_dependency_graph は malformed payload と backend skew を明示拒否する", async () => {
      const { backend, calls } = fakeBackend();
      for (const payload of [null, [], "payload", {}, { projectId: "" }]) {
        const result = await dispatchInvoke(
          "verify_narrative_dependency_graph",
          { payload },
          { backend, shell: noShell },
        );
        expect(result.ok).toBe(false);
      }
      expect(calls).toHaveLength(0);

      const unavailable = await dispatchInvoke(
        "verify_narrative_dependency_graph",
        { payload: { projectId: "project-1" } },
        { backend: null, shell: noShell },
      );
      expect(unavailable).toMatchObject({
        ok: false,
        error: `${IPC_BACKEND_UNAVAILABLE_MARKER} verify_narrative_dependency_graph`,
      });

      const missingMethod = await dispatchInvoke(
        "verify_narrative_dependency_graph",
        { payload: { projectId: "project-1" } },
        {
          backend: { ...backend, verifyNarrativeDependencyGraph: undefined },
          shell: noShell,
        },
      );
      expect(missingMethod).toMatchObject({
        ok: false,
        error: `${IPC_BACKEND_UNAVAILABLE_MARKER} native method verifyNarrativeDependencyGraph`,
      });
    });

    it("rebuild_narrative_derived_state: projectId だけの payload を native adapter へ渡す", async () => {
      const rebuildNarrativeDerivedState = vi
        .fn()
        .mockResolvedValue(
          '{"outcome":"ran","runId":"run-1","consumersEvaluated":1,"edgesEvaluated":3}',
        ) as never;
      const { backend } = fakeBackend({ rebuildNarrativeDerivedState });
      const payload = { projectId: "project-1" };
      const env = await dispatchInvoke(
        "rebuild_narrative_derived_state",
        { payload },
        { backend, shell: noShell },
      );
      expect(rebuildNarrativeDerivedState).toHaveBeenCalledWith(payload);
      expect(env).toMatchObject({
        ok: true,
        value: { outcome: "ran", runId: "run-1" },
      });
    });

    it("rebuild_narrative_derived_state は malformed payload と backend skew を明示拒否する", async () => {
      const { backend } = fakeBackend();
      const invalid = await dispatchInvoke(
        "rebuild_narrative_derived_state",
        { payload: { projectId: "" } },
        { backend, shell: noShell },
      );
      expect(invalid.ok).toBe(false);

      const unavailable = await dispatchInvoke(
        "rebuild_narrative_derived_state",
        { payload: { projectId: "project-1" } },
        { backend: null, shell: noShell },
      );
      expect(unavailable).toMatchObject({
        ok: false,
        error: `${IPC_BACKEND_UNAVAILABLE_MARKER} rebuild_narrative_derived_state`,
      });
    });

    it("get_narrative_backfill_status: projectId だけの payload を native adapter へ渡す", async () => {
      const getNarrativeBackfillStatus = vi
        .fn()
        .mockResolvedValue(
          '{"runId":"run-1","status":"completed","createdAt":"2026-08-15T00:00:00.000Z","startedAt":"2026-08-15T00:00:00.000Z","completedAt":"2026-08-15T00:01:00.000Z"}',
        ) as never;
      const { backend } = fakeBackend({ getNarrativeBackfillStatus });
      const payload = { projectId: "project-1" };
      const env = await dispatchInvoke(
        "get_narrative_backfill_status",
        { payload },
        { backend, shell: noShell },
      );
      expect(getNarrativeBackfillStatus).toHaveBeenCalledWith(payload);
      expect(env).toMatchObject({ ok: true, value: { status: "completed" } });
    });

    it("get_narrative_backfill_status は null（未実行）を素通しする", async () => {
      const { backend } = fakeBackend({
        getNarrativeBackfillStatus: vi.fn().mockResolvedValue("null") as never,
      });
      const env = await dispatchInvoke(
        "get_narrative_backfill_status",
        { payload: { projectId: "project-1" } },
        { backend, shell: noShell },
      );
      expect(env).toEqual({ ok: true, value: null });
    });

    it("retry_narrative_legacy_backfill: projectId だけの payload を native adapter へ渡す", async () => {
      const retryNarrativeLegacyBackfill = vi
        .fn()
        .mockResolvedValue('{"outcome":"alreadyRun","runId":"run-1"}') as never;
      const { backend } = fakeBackend({ retryNarrativeLegacyBackfill });
      const payload = { projectId: "project-1" };
      const env = await dispatchInvoke(
        "retry_narrative_legacy_backfill",
        { payload },
        { backend, shell: noShell },
      );
      expect(retryNarrativeLegacyBackfill).toHaveBeenCalledWith(payload);
      expect(env).toMatchObject({
        ok: true,
        value: { outcome: "alreadyRun" },
      });
    });

    it("retry_narrative_legacy_backfill は backend 不在を明示拒否する", async () => {
      const unavailable = await dispatchInvoke(
        "retry_narrative_legacy_backfill",
        { payload: { projectId: "project-1" } },
        { backend: null, shell: noShell },
      );
      expect(unavailable).toMatchObject({
        ok: false,
        error: `${IPC_BACKEND_UNAVAILABLE_MARKER} retry_narrative_legacy_backfill`,
      });
    });

    it("repair_narrative_dependency_declarations: apply 省略時は requestId/actorId 付き preview payload を渡す", async () => {
      const repairNarrativeDependencyDeclarations = vi
        .fn()
        .mockResolvedValue(
          '{"mode":"preview","plan":{"verifyRunId":"verify-1","semanticEpochId":"epoch-1","edgeIdsToDeactivate":[],"digest":"sha256:abc"}}',
        ) as never;
      const { backend } = fakeBackend({
        repairNarrativeDependencyDeclarations,
      });
      const env = await dispatchInvoke(
        "repair_narrative_dependency_declarations",
        { payload: REPAIR_DEPENDENCY_PREVIEW_PAYLOAD },
        { backend, shell: noShell },
      );
      expect(repairNarrativeDependencyDeclarations).toHaveBeenCalledWith(
        REPAIR_DEPENDENCY_PREVIEW_PAYLOAD,
      );
      expect(env).toMatchObject({ ok: true, value: { mode: "preview" } });
    });

    it("repair_narrative_dependency_declarations は requestId/actorId を preview でも必須とする", async () => {
      const repairNarrativeDependencyDeclarations = vi
        .fn()
        .mockResolvedValue('{"mode":"preview","plan":null}') as never;
      const { backend } = fakeBackend({
        repairNarrativeDependencyDeclarations,
      });
      const valid = REPAIR_DEPENDENCY_PREVIEW_PAYLOAD;
      const invalidPayloads: unknown[] = [
        null,
        [],
        "payload",
        {},
        omitKey(valid, "requestId"),
        omitKey(valid, "actorId"),
        omitKey(valid, "projectId"),
        omitKey(valid, "verifyRunId"),
        { ...valid, requestId: "" },
        { ...valid, requestId: 1 },
        { ...valid, requestId: null },
        { ...valid, requestId: {} },
        { ...valid, actorId: "" },
        { ...valid, actorId: 42 },
        { ...valid, actorId: null },
        { ...valid, actorId: [] },
        { ...valid, extra: true },
      ];

      for (const payload of invalidPayloads) {
        const result = await dispatchInvoke(
          "repair_narrative_dependency_declarations",
          { payload },
          { backend, shell: noShell },
        );
        expect(result.ok).toBe(false);
      }
      expect(repairNarrativeDependencyDeclarations).not.toHaveBeenCalled();

      const missingRequestId = await dispatchInvoke(
        "repair_narrative_dependency_declarations",
        { payload: omitKey(valid, "requestId") },
        { backend, shell: noShell },
      );
      expect(missingRequestId).toMatchObject({
        ok: false,
        error:
          "invalid args `requestId` for command `repair_narrative_dependency_declarations`: expected a string",
      });

      const emptyActorId = await dispatchInvoke(
        "repair_narrative_dependency_declarations",
        { payload: { ...valid, actorId: "" } },
        { backend, shell: noShell },
      );
      expect(emptyActorId).toMatchObject({
        ok: false,
        error:
          "invalid args `actorId` for command `repair_narrative_dependency_declarations`: expected a non-empty string",
      });

      const unknownField = await dispatchInvoke(
        "repair_narrative_dependency_declarations",
        { payload: { ...valid, setBy: "actor-1" } },
        { backend, shell: noShell },
      );
      expect(unknownField).toMatchObject({
        ok: false,
        error:
          "invalid args `setBy` for command `repair_narrative_dependency_declarations`: unknown field",
      });
    });

    it("repair_narrative_dependency_declarations: apply=true には planDigest/leaseOwner を必須とする", async () => {
      const repairNarrativeDependencyDeclarations = vi
        .fn()
        .mockResolvedValue('{"mode":"applied","outcome":null}') as never;
      const { backend } = fakeBackend({
        repairNarrativeDependencyDeclarations,
      });
      const base = REPAIR_DEPENDENCY_PREVIEW_PAYLOAD;
      const missingBoth = await dispatchInvoke(
        "repair_narrative_dependency_declarations",
        { payload: { ...base, apply: true } },
        { backend, shell: noShell },
      );
      expect(missingBoth.ok).toBe(false);

      const missingLeaseOwner = await dispatchInvoke(
        "repair_narrative_dependency_declarations",
        {
          payload: { ...base, apply: true, planDigest: "sha256:abc" },
        },
        { backend, shell: noShell },
      );
      expect(missingLeaseOwner.ok).toBe(false);

      const missingIdentity = await dispatchInvoke(
        "repair_narrative_dependency_declarations",
        { payload: omitKey(REPAIR_DEPENDENCY_APPLY_PAYLOAD, "actorId") },
        { backend, shell: noShell },
      );
      expect(missingIdentity.ok).toBe(false);
      expect(repairNarrativeDependencyDeclarations).not.toHaveBeenCalled();
    });

    it("repair_narrative_dependency_declarations: apply=true で planDigest/leaseOwner が揃っていれば実行する", async () => {
      const repairNarrativeDependencyDeclarations = vi
        .fn()
        .mockResolvedValue(
          '{"mode":"applied","outcome":{"edgesDeactivated":1,"backupArtifactPath":"/tmp/backup.db"}}',
        ) as never;
      const { backend } = fakeBackend({
        repairNarrativeDependencyDeclarations,
      });
      const env = await dispatchInvoke(
        "repair_narrative_dependency_declarations",
        { payload: REPAIR_DEPENDENCY_APPLY_PAYLOAD },
        { backend, shell: noShell },
      );
      expect(repairNarrativeDependencyDeclarations).toHaveBeenCalledWith(
        REPAIR_DEPENDENCY_APPLY_PAYLOAD,
      );
      expect(env).toMatchObject({ ok: true, value: { mode: "applied" } });
    });

    it("repair_narrative_dependency_declarations: 同じ requestId の再送も native へそのまま渡す（idempotent replay は native 側の判定）", async () => {
      const repairNarrativeDependencyDeclarations = vi
        .fn()
        .mockResolvedValue(
          '{"mode":"applied","outcome":{"edgesDeactivated":1,"backupArtifactPath":"/tmp/backup.db"}}',
        ) as never;
      const { backend } = fakeBackend({
        repairNarrativeDependencyDeclarations,
      });
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const env = await dispatchInvoke(
          "repair_narrative_dependency_declarations",
          { payload: REPAIR_DEPENDENCY_APPLY_PAYLOAD },
          { backend, shell: noShell },
        );
        expect(env).toMatchObject({ ok: true, value: { mode: "applied" } });
      }
      expect(repairNarrativeDependencyDeclarations).toHaveBeenCalledTimes(2);
      expect(repairNarrativeDependencyDeclarations).toHaveBeenNthCalledWith(
        2,
        REPAIR_DEPENDENCY_APPLY_PAYLOAD,
      );
    });

    it("repair_narrative_dependency_declarations はドメインエラーマーカーをそのまま伝播する", async () => {
      const { backend } = fakeBackend({
        repairNarrativeDependencyDeclarations: vi
          .fn()
          .mockRejectedValue(
            new Error(
              "NEX_REPAIR_EPOCH_MISMATCH: sealed plan's Semantic Epoch is no longer current",
            ),
          ) as never,
      });
      const env = await dispatchInvoke(
        "repair_narrative_dependency_declarations",
        { payload: REPAIR_DEPENDENCY_APPLY_PAYLOAD },
        { backend, shell: noShell },
      );
      expect(env).toMatchObject({
        ok: false,
        error:
          "NEX_REPAIR_EPOCH_MISMATCH: sealed plan's Semantic Epoch is no longer current",
      });
    });
  });

  describe("Semantic reranker shadow score command", () => {
    const args = {
      requestId: "request-1",
      expectedWorkspacePath: "/workspace/project-1",
      projectId: "project-1",
      auditPathId: "semantic_reranker_shadow",
      language: "ja",
      userMessage: "灯台の約束",
      sceneTail: "海霧の向こうで鐘が鳴った。",
      candidates: [
        {
          candidateId: "scene-a:0:10",
          text: "灯台の鐘を聞いた。",
        },
      ],
    };

    it("validated top-30 pair requestをnative位置引数へ写像してJSONをparseする", async () => {
      const method = vi.fn().mockResolvedValue(
        JSON.stringify({
          schemaVersion: 1,
          scores: [{ candidateId: "scene-a:0:10", score: 1.25 }],
        }),
      );
      const { backend } = fakeBackend({
        semanticRerankerShadowScore: method,
      });

      const env = await dispatchInvoke("semantic_reranker_shadow_score", args, {
        backend,
        shell: noShell,
      });

      expect(env).toMatchObject({
        ok: true,
        value: {
          schemaVersion: 1,
          scores: [{ candidateId: "scene-a:0:10", score: 1.25 }],
        },
      });
      expect(method).toHaveBeenCalledExactlyOnceWith(args);
    });

    it.each([
      { ...args, language: "fr" },
      { ...args, auditPathId: "semantic_unknown" },
      { ...args, userMessage: "", sceneTail: "" },
      { ...args, candidates: [] },
      {
        ...args,
        candidates: Array.from({ length: 31 }, (_, index) => ({
          candidateId: `scene-${index}:0:10`,
          text: "candidate",
        })),
      },
      {
        ...args,
        candidates: [{ candidateId: "scene-a:0:10", text: "" }],
      },
    ])("invalid requestをnativeへ渡さない: %#", async (invalidArgs) => {
      const method = vi.fn();
      const { backend } = fakeBackend({
        semanticRerankerShadowScore: method,
      });

      const env = await dispatchInvoke(
        "semantic_reranker_shadow_score",
        invalidArgs,
        { backend, shell: noShell },
      );

      expect(env.ok).toBe(false);
      expect(method).not.toHaveBeenCalled();
    });
  });

  describe("License Phase 3e コマンド", () => {
    const commandCases = [
      ["get_license_state", "getLicenseState", {}],
      ["activate_license", "activateLicense", { key: "GRIM-KEY-1234" }],
      ["revalidate_license", "revalidateLicense", {}],
      ["deactivate_license", "deactivateLicense", {}],
    ] as const;

    it("get_license_stateをmain-TS shell commandとして登録しない", () => {
      expect(SHELL_COMMAND_NAMES).not.toContain("get_license_state");
    });

    it("get_license_stateは引数なしでnativeを呼び、JSON DTOをparseする", async () => {
      const { backend, methods } = fakeLicenseBackend();

      const env = await dispatchInvoke(
        "get_license_state",
        {},
        {
          backend,
          shell: noShell,
        },
      );

      expect(env).toEqual({ ok: true, value: LICENSED_LICENSE_STATE });
      expect(methods.getLicenseState).toHaveBeenCalledExactlyOnceWith();
    });

    it("activate_licenseはkeyを位置引数へ写像し、JSON DTOをparseする", async () => {
      const { backend, methods } = fakeLicenseBackend();

      const env = await dispatchInvoke(
        "activate_license",
        { key: "GRIM-KEY-1234" },
        { backend, shell: noShell },
      );

      expect(env).toEqual({ ok: true, value: LICENSED_LICENSE_STATE });
      expect(methods.activateLicense).toHaveBeenCalledExactlyOnceWith(
        "GRIM-KEY-1234",
      );
    });

    it.each([
      ["revalidate_license", "revalidateLicense", LICENSED_LICENSE_STATE],
      ["deactivate_license", "deactivateLicense", TRIAL_LICENSE_STATE],
    ] as const)(
      "%sはbackendへ引数を渡さず、JSON DTOをparseする",
      async (cmd, methodName, expectedState) => {
        const { backend, methods } = fakeLicenseBackend();

        const env = await dispatchInvoke(
          cmd,
          { ignoredExtraArg: true },
          { backend, shell: noShell },
        );

        expect(env).toEqual({ ok: true, value: expectedState });
        expect(methods[methodName]).toHaveBeenCalledExactlyOnceWith();
      },
    );

    it.each([
      ["activate_license", { key: "GRIM-KEY-1234" }, LICENSED_LICENSE_STATE],
      ["revalidate_license", {}, LICENSED_LICENSE_STATE],
      ["deactivate_license", {}, TRIAL_LICENSE_STATE],
    ] as const)(
      "%s成功時は返却DTOをlicense:state_changedとして全窓broadcastへ渡す",
      async (cmd, args, expectedState) => {
        const { backend } = fakeLicenseBackend();
        const broadcast = vi.fn();

        const env = await dispatchInvoke(cmd, args, {
          backend,
          shell: noShell,
          broadcast,
        });

        expect(env).toEqual({ ok: true, value: expectedState });
        expect(broadcast).toHaveBeenCalledExactlyOnceWith(
          "license:state_changed",
          expectedState,
        );
      },
    );

    it("get_license_stateはreadだけなのでbroadcastしない", async () => {
      const { backend } = fakeLicenseBackend();
      const broadcast = vi.fn();

      await dispatchInvoke(
        "get_license_state",
        {},
        {
          backend,
          shell: noShell,
          broadcast,
        },
      );

      expect(broadcast).not.toHaveBeenCalled();
    });

    it("全窓broadcast失敗は成功済みlicense mutationをinvoke失敗へ反転しない", async () => {
      const { backend } = fakeLicenseBackend();
      const broadcast = vi.fn(() => {
        throw new Error("SECRET_NOVEL_SENTINEL");
      });
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

      const env = await dispatchInvoke(
        "activate_license",
        { key: "GRIM-KEY-1234" },
        { backend, shell: noShell, broadcast },
      );

      expect(env).toEqual({ ok: true, value: LICENSED_LICENSE_STATE });
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("license:state_changed broadcast failed"),
      );
      expect(JSON.stringify(warn.mock.calls)).not.toContain(
        "SECRET_NOVEL_SENTINEL",
      );
      warn.mockRestore();
    });

    it("手動revalidate失敗時も現在DTOをbroadcastして全窓のstaleConfirmedを同期する", async () => {
      const { backend, methods } = fakeLicenseBackend();
      methods.revalidateLicense.mockRejectedValueOnce(
        new Error("Polar unavailable"),
      );
      methods.getLicenseState.mockResolvedValueOnce(
        JSON.stringify(STALE_LICENSE_STATE),
      );
      const broadcast = vi.fn();

      const env = await dispatchInvoke(
        "revalidate_license",
        {},
        {
          backend,
          shell: noShell,
          broadcast,
        },
      );

      expect(env).toEqual({ ok: false, error: "Polar unavailable" });
      expect(methods.getLicenseState).toHaveBeenCalledExactlyOnceWith();
      expect(broadcast).toHaveBeenCalledExactlyOnceWith(
        "license:state_changed",
        STALE_LICENSE_STATE,
      );
    });

    it.each([{}, { key: null }, { key: 42 }, { key: [] }])(
      "activate_licenseは必須keyがstringでなければnative呼出し前に拒否する: %j",
      async (args) => {
        const { backend, methods } = fakeLicenseBackend();

        const env = await dispatchInvoke("activate_license", args, {
          backend,
          shell: noShell,
        });

        expect(env.ok).toBe(false);
        if (!env.ok) {
          expect(env.error).toContain(
            "invalid args `key` for command `activate_license`",
          );
        }
        expect(methods.activateLicense).not.toHaveBeenCalled();
      },
    );

    it.each(commandCases)(
      "%sは旧native bindingで%sが無ければ明示的なbackend unavailableを返す",
      async (cmd, methodName, args) => {
        const { backend } = fakeBackend();

        const env = await dispatchInvoke(cmd, args, {
          backend,
          shell: noShell,
        });

        expect(env).toMatchObject({
          ok: false,
          error: `${IPC_BACKEND_UNAVAILABLE_MARKER} native method ${methodName}`,
        });
      },
    );

    it.each(commandCases)(
      "%sはbackend自体がnullならcommand単位のbackend unavailableを返す",
      async (cmd, _methodName, args) => {
        const env = await dispatchInvoke(cmd, args, {
          backend: null,
          shell: noShell,
        });

        expect(env).toMatchObject({
          ok: false,
          error: `${IPC_BACKEND_UNAVAILABLE_MARKER} ${cmd}`,
        });
      },
    );
  });

  it("codex_rebuild_matcher は {entries} を素通しし null を resolve する", async () => {
    const { backend, calls } = fakeBackend();
    const entries = [
      {
        id: "c1",
        name: "太郎",
        entryType: "character",
        aliases: [],
        excludedAliases: [],
      },
    ];
    const env = await dispatchInvoke(
      "codex_rebuild_matcher",
      { entries },
      { backend, shell: noShell },
    );
    expect(env).toEqual({ ok: true, value: null });
    expect(calls).toEqual([{ method: "codexRebuildMatcher", args: [entries] }]);
  });

  it("codex_match_text は text + excludeEntryIds を写像し matches を parse して返す", async () => {
    const { backend, calls } = fakeBackend();
    const env = await dispatchInvoke(
      "codex_match_text",
      { text: "太郎は走った", excludeEntryIds: ["c2"] },
      { backend, shell: noShell },
    );
    expect(env).toEqual({
      ok: true,
      value: [
        {
          entryId: "c1",
          entryName: "太郎",
          entryType: "character",
          from: 0,
          to: 2,
        },
      ],
    });
    expect(calls).toEqual([
      { method: "codexMatchText", args: ["太郎は走った", ["c2"]] },
    ]);
  });

  it("extract_codex_candidates は projectId + minCount を写像し候補を parse する", async () => {
    const { backend, calls } = fakeBackend();
    const env = await dispatchInvoke(
      "extract_codex_candidates",
      { projectId: "p1", minCount: 2 },
      { backend, shell: noShell },
    );

    expect(env).toEqual({
      ok: true,
      value: [
        {
          surface: "京都",
          lemma: "京都",
          count: 2,
          firstSceneId: "s1",
          context: "京都へ行った。",
        },
      ],
    });
    expect(calls).toEqual([
      { method: "extractCodexCandidates", args: ["p1", 2] },
    ]);
  });

  it("extract_codex_candidates の minCount 省略は undefined として写像する", async () => {
    const { backend, calls } = fakeBackend();
    const env = await dispatchInvoke(
      "extract_codex_candidates",
      { projectId: "p1" },
      { backend, shell: noShell },
    );

    expect(env.ok).toBe(true);
    expect(calls).toEqual([
      { method: "extractCodexCandidates", args: ["p1", undefined] },
    ]);
  });

  it.each([-1, 1.5, "2", Number.NaN, Number.POSITIVE_INFINITY])(
    "extract_codex_candidates は不正な minCount=%j を native 前に拒否する",
    async (minCount) => {
      const { backend, calls } = fakeBackend();
      const env = await dispatchInvoke(
        "extract_codex_candidates",
        { projectId: "p1", minCount },
        { backend, shell: noShell },
      );

      expect(env).toEqual({
        ok: false,
        error:
          "invalid args `minCount` for command `extract_codex_candidates`: expected an unsigned integer or null",
      });
      expect(calls).toHaveLength(0);
    },
  );

  const validEntitySeedRequest = () => ({
    schemaVersion: 1,
    normalizerVersion: "gdx-canonical-text/1",
    language: "ja",
    minimumOccurrenceCount: 1,
    sources: [
      {
        sourceRef: "S000001",
        documentRef: "D000001",
        documentRange: { start: 0, end: 9 },
        text: "🎉京都へ行った。",
      },
    ],
  });

  it("extract_codex_entity_seeds はCanonical Source View requestを検証してnativeへ写像する", async () => {
    const { backend, calls } = fakeBackend();
    const request = validEntitySeedRequest();
    const env = await dispatchInvoke(
      "extract_codex_entity_seeds",
      { request },
      { backend, shell: noShell },
    );

    expect(env).toEqual({
      ok: true,
      value: expect.objectContaining({
        schemaVersion: 1,
        seeds: [expect.objectContaining({ seedId: "CES1-deadbeef" })],
      }),
    });
    expect(calls).toEqual([
      { method: "extractCodexEntitySeeds", args: [request] },
    ]);
  });

  it.each([
    ["unknown top-level field", { extra: true }],
    ["unknown schema", { schemaVersion: 2 }],
    ["invalid minimum", { minimumOccurrenceCount: 0 }],
  ])(
    "extract_codex_entity_seeds は%sをnative前に拒否する",
    async (_label, patch) => {
      const { backend, calls } = fakeBackend();
      const env = await dispatchInvoke(
        "extract_codex_entity_seeds",
        { request: { ...validEntitySeedRequest(), ...patch } },
        { backend, shell: noShell },
      );

      expect(env.ok).toBe(false);
      expect(calls).toHaveLength(0);
    },
  );

  it("extract_codex_entity_seeds は重複SourceRefをnative前に拒否する", async () => {
    const { backend, calls } = fakeBackend();
    const source = validEntitySeedRequest().sources[0];
    const env = await dispatchInvoke(
      "extract_codex_entity_seeds",
      {
        request: {
          ...validEntitySeedRequest(),
          sources: [source, { ...source }],
        },
      },
      { backend, shell: noShell },
    );

    expect(env.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it.each([
    {
      documentRange: { start: 0, end: 8 },
      text: "🎉京都へ行った。",
    },
    {
      documentRange: { start: 0, end: 1 },
      text: "\ud800",
    },
    {
      documentRange: { start: 0, end: 0 },
      text: "",
      extra: true,
    },
  ])(
    "extract_codex_entity_seeds は不正source %# をnative前に拒否する",
    async (sourcePatch) => {
      const { backend, calls } = fakeBackend();
      const env = await dispatchInvoke(
        "extract_codex_entity_seeds",
        {
          request: {
            ...validEntitySeedRequest(),
            sources: [
              {
                ...validEntitySeedRequest().sources[0],
                ...sourcePatch,
              },
            ],
          },
        },
        { backend, shell: noShell },
      );

      expect(env.ok).toBe(false);
      expect(calls).toHaveLength(0);
    },
  );

  it("extract_codex_entity_seeds は8 MiB超payloadをnative前に拒否する", async () => {
    const { backend, calls } = fakeBackend();
    const text = "語".repeat(3_000_000);
    const env = await dispatchInvoke(
      "extract_codex_entity_seeds",
      {
        request: {
          ...validEntitySeedRequest(),
          sources: [
            {
              ...validEntitySeedRequest().sources[0],
              documentRange: { start: 0, end: text.length },
              text,
            },
          ],
        },
      },
      { backend, shell: noShell },
    );

    expect(env.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("extract_codex_entity_seeds は8 MiB超responseをJSON parse前に拒否する", async () => {
    const oversizedWire = JSON.stringify({
      schemaVersion: 1,
      seeds: [],
      padding: "x".repeat(8 * 1024 * 1024),
    });
    const { backend } = fakeBackend({
      extractCodexEntitySeeds: () => Promise.resolve(oversizedWire),
    });

    const env = await dispatchInvoke(
      "extract_codex_entity_seeds",
      validEntitySeedRequest(),
      { backend, shell: noShell },
    );

    expect(env).toMatchObject({
      ok: false,
      error: "entity seed response exceeds the 8 MiB wire budget",
    });
  });

  it("lint_text は引数を写像し LintResponse を parse して返す", async () => {
    const { backend, calls } = fakeBackend();
    const env = await dispatchInvoke(
      "lint_text",
      {
        blocks: [{ id: "b1", text: "テスト。" }],
        language: "ja",
        scope: "paragraph",
        config: {},
        disables: [],
      },
      { backend, shell: noShell },
    );
    expect(env).toEqual({ ok: true, value: { diagnostics: [] } });
    expect(calls).toEqual([
      {
        method: "lintText",
        args: [[{ id: "b1", text: "テスト。" }], "ja", "paragraph", {}, []],
      },
    ]);
  });

  it("lint_text の LintError（{type,data} JSON reason）は errorValue へ復元される", async () => {
    const reason = '{"type":"InvalidLanguage","data":"fr"}';
    const { backend } = fakeBackend({
      lintText: () => Promise.reject(new Error(reason)),
    } as never);
    const env = await dispatchInvoke(
      "lint_text",
      { blocks: [], language: "fr", scope: "paragraph", config: {} },
      { backend, shell: noShell },
    );
    expect(env.ok).toBe(false);
    if (!env.ok) {
      expect(env.error).toBe(reason);
      expect(env.errorValue).toEqual({ type: "InvalidLanguage", data: "fr" });
    }
  });

  it("lint_text の非 JSON エラー（引数検証等）は従来どおり文字列ワイヤのまま", async () => {
    const { backend } = fakeBackend({
      lintText: () => Promise.reject(new Error("invalid blocks: boom")),
    } as never);
    const env = await dispatchInvoke(
      "lint_text",
      { blocks: [], language: "ja", scope: "paragraph", config: {} },
      { backend, shell: noShell },
    );
    expect(env).toEqual({ ok: false, error: "invalid blocks: boom" });
  });

  it("segment_bunsetsu / list_system_fonts は JSON 文字列を parse して返す", async () => {
    const { backend, calls } = fakeBackend();
    const seg = await dispatchInvoke(
      "segment_bunsetsu",
      { text: "走れメロス" },
      { backend, shell: noShell },
    );
    expect(seg).toEqual({
      ok: true,
      value: [{ start: 0, end: 3, surface: "走れ" }],
    });
    const fonts = await dispatchInvoke(
      "list_system_fonts",
      {},
      { backend, shell: noShell },
    );
    expect(fonts).toEqual({ ok: true, value: ["Noto Sans JP"] });
    expect(calls).toEqual([
      { method: "segmentBunsetsu", args: ["走れメロス"] },
      { method: "listSystemFonts", args: [] },
    ]);
  });

  it("fts_search は camelCase 引数を写像し、JSON 文字列を parse して返す", async () => {
    const { backend, calls } = fakeBackend();
    const env = await dispatchInvoke(
      "fts_search",
      { projectId: "p1", query: "唯一無二", scope: "scenes", limit: 10 },
      { backend, shell: noShell },
    );
    expect(env).toEqual({
      ok: true,
      value: [{ sourceType: "scene", id: "s1" }],
    });
    expect(calls).toEqual([
      { method: "ftsSearch", args: ["p1", "唯一無二", "scenes", 10] },
    ]);
  });

  it("unit 返りの fts_optimize / fts_rebuild / fts_rebuild_en は null を resolve する", async () => {
    for (const cmd of ["fts_optimize", "fts_rebuild", "fts_rebuild_en"]) {
      const { backend } = fakeBackend();
      const env = await dispatchInvoke(cmd, {}, { backend, shell: noShell });
      expect(env).toEqual({ ok: true, value: null });
    }
  });

  it("integrity_check / repair_integrity はレポート object を返す", async () => {
    const { backend, calls } = fakeBackend();
    const check = await dispatchInvoke(
      "integrity_check",
      { projectId: "p1" },
      { backend, shell: noShell },
    );
    expect(check).toEqual({ ok: true, value: { orphans: 0 } });
    const payload = {
      projectId: "p1",
      requestId: "repair-request-1",
      sessionId: "repair-session-1",
      eventUid: "repair-event-1",
      occurredAt: "2026-08-13T10:00:00.000Z",
    };
    const repair = await dispatchInvoke(
      "repair_integrity",
      { payload },
      { backend, shell: noShell },
    );
    expect(repair).toEqual({ ok: true, value: { repaired: 0 } });
    expect(calls).toEqual([
      { method: "integrityCheck", args: ["p1"] },
      { method: "repairIntegrity", args: [payload] },
    ]);
  });

  it("repair_integrity は canonical identity が欠けた payload を backend 前で拒否する", async () => {
    const { backend, calls } = fakeBackend();
    const result = await dispatchInvoke(
      "repair_integrity",
      { payload: { projectId: "p1" } },
      { backend, shell: noShell },
    );
    expect(result.ok).toBe(false);
    expect(calls).toEqual([]);
  });

  // plot_threads 8 コマンド（Phase 3 バッチ1）。payload / patch は素通し、
  // id / projectId はスカラ写像、unit 返りは null、生行/配列は parse して返す。
  it("plot_thread_create: {payload} 素通し、生行 snake_case を parse して返す", async () => {
    const { backend, calls } = fakeBackend();
    const payload = {
      ...mutationIdentity("plot-create"),
      name: "糸",
      color: null,
      description: null,
      sortOrder: "a0",
    };
    const env = await dispatchInvoke(
      "plot_thread_create",
      { payload },
      { backend, shell: noShell },
    );
    expect(calls).toEqual([{ method: "plotThreadCreate", args: [payload] }]);
    expect(env).toEqual({
      ok: true,
      value: { id: "pt1", project_id: "p1", name: "糸" },
    });
  });

  it("plot_thread_update / link_update: {id, patch} を位置引数へ写像し行を parse", async () => {
    const { backend, calls } = fakeBackend();
    const patch = {
      ...mutationIdentity("plot-update"),
      name: "改名",
      description: null,
      baseVersion: 3,
    };
    const upd = await dispatchInvoke(
      "plot_thread_update",
      { id: "pt1", patch },
      { backend, shell: noShell },
    );
    const linkPatch = {
      ...mutationIdentity("plot-link-update"),
      threadId: "pt2",
      baseVersion: 4,
    };
    const linkUpd = await dispatchInvoke(
      "plot_thread_link_update",
      { id: "pl1", patch: linkPatch },
      { backend, shell: noShell },
    );
    expect(calls).toEqual([
      { method: "plotThreadUpdate", args: ["pt1", patch] },
      { method: "plotThreadLinkUpdate", args: ["pl1", linkPatch] },
    ]);
    expect(upd).toEqual({ ok: true, value: { id: "pt1", name: "改名" } });
    expect(linkUpd).toEqual({
      ok: true,
      value: { id: "pl1", thread_id: "pt2" },
    });
  });

  it("plot nullable patches preserve explicit null across the IPC contract", async () => {
    const { backend, calls } = fakeBackend();
    const threadPatch = {
      ...mutationIdentity("plot-nullable-update"),
      color: null,
      description: null,
      baseVersion: 5,
    };
    const linkPatch = {
      ...mutationIdentity("plot-nullable-link-update"),
      note: null,
      sortOrder: null,
      baseVersion: 8,
    };

    await dispatchInvoke(
      "plot_thread_update",
      { id: "pt-nullable", patch: threadPatch },
      { backend, shell: noShell },
    );
    await dispatchInvoke(
      "plot_thread_link_update",
      { id: "pl-nullable", patch: linkPatch },
      { backend, shell: noShell },
    );

    expect(calls).toEqual([
      {
        method: "plotThreadUpdate",
        args: ["pt-nullable", threadPatch],
      },
      {
        method: "plotThreadLinkUpdate",
        args: ["pl-nullable", linkPatch],
      },
    ]);
  });

  it("plot_thread_list / list_links: {projectId} → 位置引数、行配列を parse", async () => {
    const { backend, calls } = fakeBackend();
    const list = await dispatchInvoke(
      "plot_thread_list",
      { projectId: "p1" },
      { backend, shell: noShell },
    );
    const links = await dispatchInvoke(
      "plot_thread_list_links",
      { projectId: "p1" },
      { backend, shell: noShell },
    );
    expect(calls).toEqual([
      { method: "plotThreadList", args: ["p1"] },
      { method: "plotThreadListLinks", args: ["p1"] },
    ]);
    expect(list).toEqual({ ok: true, value: [{ id: "pt1", name: "糸" }] });
    expect(links).toEqual({
      ok: true,
      value: [{ id: "pl1", thread_id: "pt1" }],
    });
  });

  it("plot_thread_delete / link_delete: Native receipt を parse する", async () => {
    const { backend, calls } = fakeBackend();
    const deletePayload = {
      ...mutationIdentity("plot-delete"),
      id: "pt1",
      baseVersion: 3,
    };
    const del = await dispatchInvoke(
      "plot_thread_delete",
      { payload: deletePayload },
      { backend, shell: noShell },
    );
    const linkDeletePayload = {
      ...mutationIdentity("plot-link-delete"),
      id: "pl1",
      baseVersion: 4,
    };
    const linkDel = await dispatchInvoke(
      "plot_thread_link_delete",
      { payload: linkDeletePayload },
      { backend, shell: noShell },
    );
    expect(calls).toEqual([
      { method: "plotThreadDelete", args: [deletePayload] },
      { method: "plotThreadLinkDelete", args: [linkDeletePayload] },
    ]);
    expect(del).toEqual({
      ok: true,
      value: {
        id: "pt1",
        deleted: true,
        maintenanceTransactionId: "plot-delete-tx",
      },
    });
    expect(linkDel).toEqual({
      ok: true,
      value: {
        id: "pl1",
        deleted: true,
        maintenanceTransactionId: "plot-link-delete-tx",
      },
    });
  });

  it("plot_thread_link_create: {payload} 素通し、作成行を parse して返す", async () => {
    const { backend, calls } = fakeBackend();
    const payload = {
      ...mutationIdentity("plot-link-create"),
      threadId: "pt1",
      nodeId: "s1",
      phaseType: "introduce",
      note: null,
      sortOrder: null,
    };
    const env = await dispatchInvoke(
      "plot_thread_link_create",
      { payload },
      { backend, shell: noShell },
    );
    expect(calls).toEqual([
      { method: "plotThreadLinkCreate", args: [payload] },
    ]);
    expect(env).toEqual({
      ok: true,
      value: { id: "pl1", thread_id: "pt1", node_id: "s1" },
    });
  });

  it("plot_thread_branch_create: typed payload を native adapter へ渡し行を parse する", async () => {
    const { backend, calls } = fakeBackend();
    const payload = {
      ...mutationIdentity("plot-branch-create"),
      id: "pb1",
      fromThreadId: "pt1",
      toThreadId: "pt2",
      atNodeId: "s1",
      kind: "branch",
    };
    const env = await dispatchInvoke(
      "plot_thread_branch_create",
      { payload },
      { backend, shell: noShell },
    );
    expect(calls).toEqual([
      { method: "plotThreadBranchCreate", args: [payload] },
    ]);
    expect(env).toEqual({
      ok: true,
      value: {
        id: "pb1",
        project_id: "p1",
        from_thread_id: "pt1",
        to_thread_id: "pt2",
        at_node_id: "s1",
        kind: "branch",
      },
    });
  });

  it("plot_thread_branch_create は payload 欠落と backend/version skew を明示拒否する", async () => {
    const { backend, calls } = fakeBackend();
    const invalid = await dispatchInvoke(
      "plot_thread_branch_create",
      {},
      { backend, shell: noShell },
    );
    expect(invalid.ok).toBe(false);
    expect(calls).toHaveLength(0);

    const unavailable = await dispatchInvoke(
      "plot_thread_branch_create",
      { payload: {} },
      { backend: null, shell: noShell },
    );
    expect(unavailable).toMatchObject({
      ok: false,
      error: `${IPC_BACKEND_UNAVAILABLE_MARKER} plot_thread_branch_create`,
    });

    const missingMethod = await dispatchInvoke(
      "plot_thread_branch_create",
      { payload: {} },
      {
        backend: {
          ...backend,
          plotThreadBranchCreate: undefined,
        },
        shell: noShell,
      },
    );
    expect(missingMethod).toMatchObject({
      ok: false,
      error: `${IPC_BACKEND_UNAVAILABLE_MARKER} native method plotThreadBranchCreate`,
    });
  });

  it("plot_thread_branch_create は malformed nested payload を main で拒否する", async () => {
    const { backend, calls } = fakeBackend();
    const valid = {
      ...mutationIdentity("plot-branch-create-valid"),
      fromThreadId: "pt1",
      toThreadId: "pt2",
      atNodeId: "s1",
      kind: "branch",
    };
    const invalidPayloads: unknown[] = [
      null,
      [],
      "payload",
      {},
      { ...valid, id: "" },
      { ...valid, id: null },
      { ...valid, projectId: "" },
      { ...valid, fromThreadId: 1 },
      { ...valid, toThreadId: undefined },
      { ...valid, atNodeId: [] },
      { ...valid, kind: "fork" },
    ];

    for (const payload of invalidPayloads) {
      const result = await dispatchInvoke(
        "plot_thread_branch_create",
        { payload },
        { backend, shell: noShell },
      );
      expect(result.ok).toBe(false);
    }
    expect(calls).toHaveLength(0);

    const withoutOptionalId = await dispatchInvoke(
      "plot_thread_branch_create",
      { payload: valid },
      { backend, shell: noShell },
    );
    expect(withoutOptionalId.ok).toBe(true);
    expect(calls).toEqual([
      { method: "plotThreadBranchCreate", args: [valid] },
    ]);
  });

  it("plot_thread_move_marker_bundle は deep-validated atomic payload だけを native adapter へ渡す", async () => {
    const { backend, calls } = fakeBackend();
    const markerBefore = {
      id: "pl1",
      threadId: "pt1",
      nodeId: "s1",
      phaseType: "turn",
      note: null,
      sortOrder: null,
      version: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
    };
    const markerAfter = {
      ...markerBefore,
      threadId: "pt2",
      nodeId: "s2",
      version: 1,
      updatedAt: "2026-01-03T00:00:00.000Z",
    };
    const branchAfter = {
      id: "pb1",
      projectId: "p1",
      fromThreadId: "pt1",
      toThreadId: "pt2",
      atNodeId: "s2",
      kind: "branch",
      version: 0,
      createdAt: "2026-01-03T00:00:00.000Z",
      updatedAt: "2026-01-03T00:00:00.000Z",
    };
    const payload = {
      ...mutationIdentity("move-1"),
      markerBefore,
      markerAfter,
      branchTransitions: [{ before: null, after: branchAfter }],
    };
    const moved = await dispatchInvoke(
      "plot_thread_move_marker_bundle",
      { payload },
      { backend, shell: noShell },
    );
    expect(calls).toEqual([
      { method: "plotThreadMoveMarkerBundle", args: [payload] },
    ]);
    expect(moved).toMatchObject({
      ok: true,
      value: {
        id: "move-1",
        marker: { id: "pl1", threadId: "pt2" },
        __idempotency: { entityPresent: true },
      },
    });

    calls.length = 0;
    for (const invalid of [
      { ...payload, requestId: "" },
      {
        ...payload,
        markerAfter: { ...markerAfter, id: "different" },
      },
      {
        ...payload,
        branchTransitions: [{ before: null, after: null }],
      },
      {
        ...payload,
        branchTransitions: [
          { before: null, after: branchAfter },
          { before: null, after: branchAfter },
        ],
      },
      {
        ...payload,
        branchTransitions: [
          {
            before: null,
            after: { ...branchAfter, projectId: "other" },
          },
        ],
      },
    ]) {
      const result = await dispatchInvoke(
        "plot_thread_move_marker_bundle",
        { payload: invalid },
        { backend, shell: noShell },
      );
      expect(result.ok).toBe(false);
    }
    expect(calls).toHaveLength(0);

    const unavailable = await dispatchInvoke(
      "plot_thread_move_marker_bundle",
      { payload },
      {
        backend: { ...backend, plotThreadMoveMarkerBundle: undefined },
        shell: noShell,
      },
    );
    expect(unavailable).toMatchObject({
      ok: false,
      error: `${IPC_BACKEND_UNAVAILABLE_MARKER} native method plotThreadMoveMarkerBundle`,
    });
  });

  it("plot snapshot restore/delete は deep-validated payload を native adapter へ渡す", async () => {
    const { backend, calls } = fakeBackend();
    const restorePayload = {
      ...mutationIdentity("restore-1"),
      thread: {
        id: "pt1",
        projectId: "p1",
        name: "thread",
        color: null,
        description: null,
        sortOrder: "a0",
        startNodeId: null,
        endNodeId: null,
        version: 0,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-02T00:00:00.000Z",
      },
      links: [],
      branches: [],
    };
    const deletePayload = {
      ...mutationIdentity("delete-1"),
      link: {
        id: "link-1",
        threadId: "pt1",
        nodeId: "scene-1",
        phaseType: "turn",
        note: "marker",
        sortOrder: "a0",
        version: 0,
        createdAt: "2026-01-01T01:00:00.000Z",
        updatedAt: "2026-01-02T01:00:00.000Z",
      },
      branches: [
        {
          id: "branch-1",
          projectId: "p1",
          fromThreadId: "source",
          toThreadId: "pt1",
          atNodeId: "scene-1",
          kind: "branch",
          version: 0,
          createdAt: "2026-01-01T02:00:00.000Z",
          updatedAt: "2026-01-02T02:00:00.000Z",
        },
      ],
    };

    const restored = await dispatchInvoke(
      "plot_thread_restore_snapshot",
      { payload: restorePayload },
      { backend, shell: noShell },
    );
    const deleted = await dispatchInvoke(
      "plot_thread_delete_snapshot",
      { payload: deletePayload },
      { backend, shell: noShell },
    );

    expect(calls).toEqual([
      { method: "plotThreadRestoreSnapshot", args: [restorePayload] },
      { method: "plotThreadDeleteSnapshot", args: [deletePayload] },
    ]);
    expect(restored).toMatchObject({
      ok: true,
      value: {
        id: "restore-1",
        __idempotency: { entityPresent: true },
      },
    });
    expect(deleted).toMatchObject({
      ok: true,
      value: {
        id: "delete-1",
        deleted: true,
        __idempotency: { entityPresent: true },
      },
    });
  });

  it("plot snapshot commands reject empty row identity/timestamps and malformed delete rows in main", async () => {
    const { backend, calls } = fakeBackend();
    const validThread = {
      id: "pt1",
      projectId: "p1",
      name: "thread",
      color: null,
      description: null,
      sortOrder: "a0",
      startNodeId: null,
      endNodeId: null,
      version: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
    };
    const invalidRestorePayloads = [
      null,
      {},
      {
        ...mutationIdentity("restore-invalid-id"),
        thread: { ...validThread, id: "" },
        links: [],
        branches: [],
      },
      {
        ...mutationIdentity("restore-invalid-timestamp"),
        thread: { ...validThread, createdAt: "" },
        links: [],
        branches: [],
      },
      {
        ...mutationIdentity("restore-empty"),
        thread: null,
        links: [],
        branches: [],
      },
    ];
    for (const payload of invalidRestorePayloads) {
      const result = await dispatchInvoke(
        "plot_thread_restore_snapshot",
        { payload },
        { backend, shell: noShell },
      );
      expect(result.ok).toBe(false);
    }
    const validLink = {
      id: "link",
      threadId: "pt1",
      nodeId: "scene",
      phaseType: "turn",
      note: null,
      sortOrder: null,
      version: 0,
      createdAt: "2026-01-01T01:00:00.000Z",
      updatedAt: "2026-01-02T01:00:00.000Z",
    };
    const validBranch = {
      id: "branch",
      projectId: "p1",
      fromThreadId: "source",
      toThreadId: "pt1",
      atNodeId: "scene",
      kind: "branch",
      version: 0,
      createdAt: "2026-01-01T02:00:00.000Z",
      updatedAt: "2026-01-02T02:00:00.000Z",
    };
    const invalidDeletes = [
      { link: { ...validLink, id: "" }, branches: [] },
      { link: { ...validLink, updatedAt: "" }, branches: [] },
      {
        link: validLink,
        branches: [{ ...validBranch, createdAt: "" }],
      },
      { link: validLink, branches: [validBranch, validBranch] },
      { link: validLink, branches: "branch" },
    ];
    for (const invalid of invalidDeletes) {
      const result = await dispatchInvoke(
        "plot_thread_delete_snapshot",
        {
          payload: {
            ...mutationIdentity("delete-invalid"),
            ...invalid,
          },
        },
        { backend, shell: noShell },
      );
      expect(result.ok).toBe(false);
    }
    expect(calls).toHaveLength(0);
  });

  it("plot snapshot commands report native backend version skew", async () => {
    const { backend } = fakeBackend();
    const restore = await dispatchInvoke(
      "plot_thread_restore_snapshot",
      {
        payload: {
          ...mutationIdentity("restore"),
          thread: null,
          links: [
            {
              id: "link",
              threadId: "thread",
              nodeId: "scene",
              phaseType: "turn",
              note: null,
              sortOrder: null,
              version: 0,
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-02T00:00:00.000Z",
            },
          ],
          branches: [],
        },
      },
      {
        backend: { ...backend, plotThreadRestoreSnapshot: undefined },
        shell: noShell,
      },
    );
    const deleted = await dispatchInvoke(
      "plot_thread_delete_snapshot",
      {
        payload: {
          ...mutationIdentity("delete"),
          link: {
            id: "link",
            threadId: "thread",
            nodeId: "scene",
            phaseType: "turn",
            note: null,
            sortOrder: null,
            version: 0,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-02T00:00:00.000Z",
          },
          branches: [],
        },
      },
      {
        backend: { ...backend, plotThreadDeleteSnapshot: undefined },
        shell: noShell,
      },
    );
    expect(restore).toMatchObject({
      ok: false,
      error: `${IPC_BACKEND_UNAVAILABLE_MARKER} native method plotThreadRestoreSnapshot`,
    });
    expect(deleted).toMatchObject({
      ok: false,
      error: `${IPC_BACKEND_UNAVAILABLE_MARKER} native method plotThreadDeleteSnapshot`,
    });
  });

  it("plot_thread_update: id 欠落は invalid args エラー（backend は呼ばれない）", async () => {
    const { backend, calls } = fakeBackend();
    const env = await dispatchInvoke(
      "plot_thread_update",
      { patch: {} },
      { backend, shell: noShell },
    );
    expect(calls).toHaveLength(0);
    expect(env.ok).toBe(false);
  });

  it.each([
    [
      "plot_thread_update",
      {
        id: "pt1",
        patch: { ...mutationIdentity("missing-thread-version"), name: "stale" },
      },
    ],
    [
      "plot_thread_delete",
      {
        payload: {
          ...mutationIdentity("missing-thread-delete-version"),
          id: "pt1",
        },
      },
    ],
    [
      "plot_thread_link_update",
      {
        id: "pl1",
        patch: { ...mutationIdentity("missing-link-version"), note: "stale" },
      },
    ],
    [
      "plot_thread_link_delete",
      {
        payload: {
          ...mutationIdentity("missing-link-delete-version"),
          id: "pl1",
        },
      },
    ],
    [
      "plot_thread_branch_update",
      {
        id: "pb1",
        patch: {
          ...mutationIdentity("missing-branch-version"),
          atNodeId: "s2",
        },
      },
    ],
    [
      "plot_thread_branch_delete",
      {
        payload: {
          ...mutationIdentity("missing-branch-delete-version"),
          id: "pb1",
        },
      },
    ],
  ] as const)(
    "%s requires a baseVersion before calling native",
    async (command, args) => {
      const { backend, calls } = fakeBackend();
      const env = await dispatchInvoke(command, args, {
        backend,
        shell: noShell,
      });
      expect(calls).toHaveLength(0);
      expect(env).toMatchObject({ ok: false });
      if (!env.ok) expect(env.error).toContain("baseVersion");
    },
  );

  // ── foreshadow 20 コマンド（Phase 3 バッチ1） ──────────────────────────
  it("foreshadow_create / update / delete: payload・id+patch 写像、unit→null", async () => {
    const { backend, calls } = fakeBackend();
    const payload = {
      ...mutationIdentity("foreshadow-request-1"),
      id: "foreshadow-request-1",
      title: "伏線",
      intent: null,
    };
    const created = await dispatchInvoke(
      "foreshadow_create",
      { payload },
      { backend, shell: noShell },
    );
    const patch = {
      ...mutationIdentity("foreshadow-update"),
      baseVersion: 0,
      title: "改名",
      intent: null,
    };
    const updated = await dispatchInvoke(
      "foreshadow_update",
      { id: "f1", patch },
      { backend, shell: noShell },
    );
    const deletePayload = {
      ...mutationIdentity("foreshadow-delete"),
      id: "f1",
      baseVersion: 1,
    };
    const deleted = await dispatchInvoke(
      "foreshadow_delete",
      { payload: deletePayload },
      { backend, shell: noShell },
    );
    expect(calls).toEqual([
      { method: "foreshadowCreate", args: [payload] },
      { method: "foreshadowUpdate", args: ["f1", patch] },
      {
        method: "foreshadowDelete",
        args: [deletePayload],
      },
    ]);
    expect(created).toEqual({
      ok: true,
      value: { id: "f1", project_id: "p1", title: "伏線" },
    });
    expect(updated).toEqual({
      ok: true,
      value: { id: "f1", project_id: "p1", title: "改名", version: 1 },
    });
    expect(deleted).toEqual({
      ok: true,
      value: {
        entityId: "f1",
        projectId: "p1",
        version: 1,
        changeEventUid: "ce1",
        undoJournalId: "uj1",
        maintenanceTransactionId: "foreshadow-delete-tx",
      },
    });
  });

  it("foreshadow の read 系: projectId / sceneId / chapterId / codexEntryId を写像し struct を parse", async () => {
    const { backend, calls } = fakeBackend();
    await dispatchInvoke(
      "foreshadow_list_with_labels",
      { projectId: "p1" },
      { backend, shell: noShell },
    );
    await dispatchInvoke(
      "foreshadow_get_scene_info",
      { sceneId: "s1" },
      { backend, shell: noShell },
    );
    await dispatchInvoke(
      "foreshadow_get_scene_context",
      { sceneId: "s1" },
      { backend, shell: noShell },
    );
    await dispatchInvoke(
      "foreshadow_list_by_codex_entry",
      { codexEntryId: "c1" },
      { backend, shell: noShell },
    );
    const stats = await dispatchInvoke(
      "foreshadow_get_chapter_stats",
      { chapterId: "ch1" },
      { backend, shell: noShell },
    );
    expect(calls).toEqual([
      { method: "foreshadowListWithLabels", args: ["p1"] },
      { method: "foreshadowGetSceneInfo", args: ["s1"] },
      { method: "foreshadowGetSceneContext", args: ["s1"] },
      { method: "foreshadowListByCodexEntry", args: ["c1"] },
      { method: "foreshadowGetChapterStats", args: ["ch1"] },
    ]);
    expect(stats.ok).toBe(true);
  });

  it("foreshadow_get_setup / get: setupId・id を写像し行 or {foreshadow,setups} を parse", async () => {
    const { backend, calls } = fakeBackend();
    const setup = await dispatchInvoke(
      "foreshadow_get_setup",
      { setupId: "su1" },
      { backend, shell: noShell },
    );
    const detail = await dispatchInvoke(
      "foreshadow_get",
      { id: "f1" },
      { backend, shell: noShell },
    );
    expect(calls).toEqual([
      { method: "foreshadowGetSetup", args: ["su1"] },
      { method: "foreshadowGet", args: ["f1"] },
    ]);
    expect(setup).toEqual({ ok: true, value: { id: "su1", is_orphan: 0 } });
    expect(detail).toEqual({
      ok: true,
      value: { foreshadow: { id: "f1" }, setups: [] },
    });
  });

  it("foreshadow_link_codex / unlink_codex: foreshadowId+codexId 写像、unit→null", async () => {
    const { backend, calls } = fakeBackend();
    const linkPayload = {
      ...mutationIdentity("foreshadow-link"),
      foreshadowId: "f1",
      codexId: "c1",
      baseVersion: 0,
    };
    const link = await dispatchInvoke(
      "foreshadow_link_codex",
      { payload: linkPayload },
      { backend, shell: noShell },
    );
    const unlinkPayload = {
      ...mutationIdentity("foreshadow-unlink"),
      foreshadowId: "f1",
      codexId: "c1",
      baseVersion: 1,
    };
    await dispatchInvoke(
      "foreshadow_unlink_codex",
      { payload: unlinkPayload },
      { backend, shell: noShell },
    );
    expect(calls).toEqual([
      { method: "foreshadowLinkCodex", args: [linkPayload] },
      { method: "foreshadowUnlinkCodex", args: [unlinkPayload] },
    ]);
    expect(link).toEqual({
      ok: true,
      value: { id: "f1", project_id: "p1", version: 1 },
    });
  });

  it("foreshadow_set_setup_strength: mandatory payload は文字列と null を保持する", async () => {
    const { backend, calls } = fakeBackend();
    const strongPayload = {
      ...mutationIdentity("foreshadow-strength-set"),
      setupId: "su1",
      strength: "critical",
      baseVersion: 0,
    };
    await dispatchInvoke(
      "foreshadow_set_setup_strength",
      { payload: strongPayload },
      { backend, shell: noShell },
    );
    const clearPayload = {
      ...mutationIdentity("foreshadow-strength-clear"),
      setupId: "su1",
      strength: null,
      baseVersion: 1,
    };
    await dispatchInvoke(
      "foreshadow_set_setup_strength",
      { payload: clearPayload },
      { backend, shell: noShell },
    );
    expect(calls).toEqual([
      {
        method: "foreshadowSetSetupStrength",
        args: [strongPayload],
      },
      {
        method: "foreshadowSetSetupStrength",
        args: [clearPayload],
      },
    ]);
  });

  it("foreshadow_setup_create_ai: 12 個の flat 引数オブジェクトをそのまま渡す", async () => {
    const { backend, calls } = fakeBackend();
    const args = {
      ...mutationIdentity("foreshadow-setup-create"),
      id: "su1",
      foreshadowId: "f1",
      baseVersion: 0,
      sceneId: "s1",
      fromPos: 3,
      toPos: 7,
      kind: "designated_existing",
      strength: null,
      aiStrength: null,
      attribution: "ai",
      aiRationale: null,
      aiReasoning: null,
      lastEvaluatedAt: 1783664540830,
    };
    const env = await dispatchInvoke("foreshadow_setup_create_ai", args, {
      backend,
      shell: noShell,
    });
    expect(calls).toEqual([
      { method: "foreshadowSetupCreateAi", args: [args] },
    ]);
    expect(env).toEqual({
      ok: true,
      value: { id: "f1", project_id: "p1", version: 1 },
    });
  });

  it("foreshadow_resolve_orphan: {payload} を写像し Option<String> を parse（reinsert の new_id）", async () => {
    const { backend, calls } = fakeBackend();
    const payload = {
      ...mutationIdentity("foreshadow-orphan-reinsert"),
      setupId: "su1",
      baseVersion: 0,
      action: "reinsert",
    };
    const env = await dispatchInvoke(
      "foreshadow_resolve_orphan",
      { payload },
      { backend, shell: noShell },
    );
    expect(calls).toEqual([
      { method: "foreshadowResolveOrphan", args: [payload] },
    ]);
    expect(env).toEqual({
      ok: true,
      value: {
        setupId: "new-setup-id",
        foreshadow: { id: "f1", project_id: "p1", version: 1 },
      },
    });
  });

  it("foreshadow_save_anchors_for_scene: sceneId+setups+payoffs+docContentSize(number) を写像", async () => {
    const { backend, calls } = fakeBackend();
    const setups = [
      {
        id: "su1",
        foreshadowId: "f1",
        baseVersion: 0,
        sceneId: "s1",
        fromPos: 1,
        toPos: 5,
      },
    ];
    const payoffs: unknown[] = [];
    const baseVersions = { f1: 0 };
    const payload = {
      ...mutationIdentity("foreshadow-anchors-save"),
      sceneId: "s1",
      setups,
      payoffs,
      baseVersions,
      docContentSize: 2,
    };
    const env = await dispatchInvoke(
      "foreshadow_save_anchors_for_scene",
      { payload },
      { backend, shell: noShell },
    );
    expect(calls).toEqual([
      {
        method: "foreshadowSaveAnchorsForScene",
        args: [payload],
      },
    ]);
    expect(env).toEqual({
      ok: true,
      value: [{ id: "f1", project_id: "p1", version: 1 }],
    });
  });

  it("foreshadow_load_anchors_for_scene: sceneId を写像し camelCase mark 配列を parse", async () => {
    const { backend, calls } = fakeBackend();
    const env = await dispatchInvoke(
      "foreshadow_load_anchors_for_scene",
      { sceneId: "s1" },
      { backend, shell: noShell },
    );
    expect(calls).toEqual([
      { method: "foreshadowLoadAnchorsForScene", args: ["s1"] },
    ]);
    expect(env).toEqual({
      ok: true,
      value: [
        {
          from: 10,
          to: 20,
          markName: "foreshadowSetup",
          attrs: { setupId: "su1", foreshadowId: "f1" },
        },
      ],
    });
  });

  it("foreshadow_save_anchors_for_scene: docContentSize 非 number は invalid args（backend 未呼び出し）", async () => {
    const { backend, calls } = fakeBackend();
    const env = await dispatchInvoke(
      "foreshadow_save_anchors_for_scene",
      { sceneId: "s1", setups: [], payoffs: [] },
      { backend, shell: noShell },
    );
    expect(calls).toHaveLength(0);
    expect(env.ok).toBe(false);
  });

  // ── agent_writes 20 コマンド（Phase 3 バッチ1） ────────────────────────
  it("agent_writes: すべて単一 {payload} を素通しし AgentWriteResult を parse", async () => {
    const { backend, calls } = fakeBackend();
    const payload = {
      requestId: "codex-request-1",
      eventUid: "codex-event-1",
      origin: "ai-apply",
      authorityRoute: "interactive-agent-command",
      caller: "chat-tool-executor",
      controls: [
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
      provenance: {
        requestId: "codex-request-1",
        traceId: "codex-trace-1",
      },
      writesAuthorityProtectedField: false,
      originalTransactionId: null,
      undoJournalId: null,
      entryId: "codex-request-1",
      projectId: "p1",
      sessionId: "s1",
      name: "太郎",
    };
    const created = await dispatchInvoke(
      "agent_codex_create",
      { payload },
      { backend, shell: noShell },
    );
    // link/unlink・relation add/remove も FE 側は同じ {payload} 契約。
    const linked = await dispatchInvoke(
      "agent_scene_event_link",
      {
        payload: {
          requestId: "scene-link-request-1",
          projectId: "p1",
          sessionId: "s1",
          eventId: "e1",
          sceneId: "sc1",
        },
      },
      { backend, shell: noShell },
    );
    expect(calls).toEqual([
      { method: "agentCodexCreate", args: [payload] },
      {
        method: "agentSceneEventLink",
        args: [
          {
            requestId: "scene-link-request-1",
            projectId: "p1",
            sessionId: "s1",
            eventId: "e1",
            sceneId: "sc1",
          },
        ],
      },
    ]);
    expect(created).toEqual({
      ok: true,
      value: {
        entityId: "e1",
        version: 1,
        changeEventUid: "ce1",
        undoJournalId: "uj1",
      },
    });
    expect(linked.ok).toBe(true);
  });

  it("renderer Codex alias: human-direct writer is mapped separately from Agent command", async () => {
    const { backend, calls } = fakeBackend();
    const payload = {
      ...mutationIdentity("renderer-codex-create"),
      entryId: "renderer-entry-1",
      typeSlug: "character",
      name: "太郎",
    };
    const created = await dispatchInvoke(
      "codex_create",
      { payload },
      { backend, shell: noShell },
    );
    expect(calls).toEqual([{ method: "codexCreate", args: [payload] }]);
    expect(created).toEqual({
      ok: true,
      value: {
        entityId: "e1",
        version: 1,
        changeEventUid: "ce1",
        undoJournalId: "uj1",
      },
    });
  });

  it("renderer Chronicle aliases dispatch to their non-Agent N-API methods", async () => {
    const { backend, calls } = fakeBackend();
    const identity = mutationIdentity("renderer-chronicle-1");
    const cases = [
      {
        command: "codex_mutate",
        method: "codexMutate",
        payload: { ...identity, operation: "relation.create" },
      },
      {
        command: "event_create",
        method: "eventCreate",
        payload: {
          requestId: "renderer-event-create-1",
          projectId: "p1",
          sessionId: "s1",
          eventId: "e1",
        },
      },
      {
        command: "event_update",
        method: "eventUpdate",
        payload: {
          requestId: "renderer-event-update-1",
          projectId: "p1",
          sessionId: "s1",
          eventId: "e1",
          baseVersion: 0,
        },
      },
      {
        command: "event_delete",
        method: "eventDelete",
        payload: {
          requestId: "renderer-event-delete-1",
          projectId: "p1",
          sessionId: "s1",
          eventId: "e1",
          baseVersion: 0,
        },
      },
      {
        command: "chronicle_bulk_mutate",
        method: "chronicleBulkMutate",
        payload: {
          requestId: "renderer-bulk-1",
          projectId: "p1",
          sessionId: "s1",
          operations: [{ kind: "eventDelete", eventId: "e1", baseVersion: 0 }],
        },
      },
      {
        command: "event_participants_set",
        method: "eventParticipantsSet",
        payload: {
          requestId: "renderer-participants-1",
          projectId: "p1",
          sessionId: "s1",
          eventId: "e1",
          baseVersion: 0,
          codexEntryIds: [],
        },
      },
      {
        command: "scene_event_link",
        method: "sceneEventLink",
        payload: {
          requestId: "renderer-link-1",
          projectId: "p1",
          sessionId: "s1",
          eventId: "e1",
          sceneId: "s1",
        },
      },
      {
        command: "scene_event_link_batch",
        method: "sceneEventLinkBatch",
        payload: {
          requestId: "renderer-link-batch-1",
          projectId: "p1",
          sessionId: "s1",
          eventId: "e1",
          sceneIds: ["s1"],
        },
      },
      {
        command: "scene_event_unlink",
        method: "sceneEventUnlink",
        payload: {
          requestId: "renderer-unlink-1",
          projectId: "p1",
          sessionId: "s1",
          eventId: "e1",
          sceneId: "s1",
        },
      },
      {
        command: "event_relation_add",
        method: "eventRelationAdd",
        payload: {
          requestId: "renderer-relation-add-1",
          projectId: "p1",
          sessionId: "s1",
          causeEventId: "e1",
          effectEventId: "e2",
        },
      },
      {
        command: "event_relation_remove",
        method: "eventRelationRemove",
        payload: {
          requestId: "renderer-relation-remove-1",
          projectId: "p1",
          sessionId: "s1",
          causeEventId: "e1",
          effectEventId: "e2",
        },
      },
    ] as const;

    for (const testCase of cases) {
      const result = await dispatchInvoke(
        testCase.command,
        { payload: testCase.payload },
        { backend, shell: noShell },
      );
      expect(result.ok).toBe(true);
      expect(calls).toContainEqual({
        method: testCase.method,
        args: [testCase.payload],
      });
    }
  });

  it("agent_event_create: required identity を検証して N-API へ渡す", async () => {
    const { backend, calls } = fakeBackend();
    const payload = {
      requestId: "event-create-request-1",
      projectId: "p1",
      sessionId: "s1",
      eventId: "event-1",
      title: "Arrival",
    };
    const env = await dispatchInvoke(
      "agent_event_create",
      { payload },
      { backend, shell: noShell },
    );

    expect(env.ok).toBe(true);
    expect(calls).toContainEqual({
      method: "agentEventCreate",
      args: [payload],
    });
  });

  it.each([
    "agent_event_update",
    "agent_event_delete",
    "agent_event_set_participants",
  ])("%s: baseVersion 欠落は N-API を呼ばず拒否する", async (command) => {
    const { backend, calls } = fakeBackend();
    const env = await dispatchInvoke(
      command,
      {
        payload: {
          requestId: `${command}-request-1`,
          projectId: "p1",
          sessionId: "s1",
          eventId: "e1",
          ...(command === "agent_event_set_participants"
            ? { codexEntryIds: [] }
            : {}),
        },
      },
      { backend, shell: noShell },
    );

    expect(env.ok).toBe(false);
    if (!env.ok) expect(env.error).toContain("baseVersion");
    expect(calls).toHaveLength(0);
  });

  it("agent_event_update: 非負整数 baseVersion を N-API へ渡す", async () => {
    const { backend, calls } = fakeBackend();
    const payload = {
      requestId: "event-update-request-1",
      projectId: "p1",
      sessionId: "s1",
      eventId: "e1",
      baseVersion: 7,
      title: "updated",
    };
    const env = await dispatchInvoke(
      "agent_event_update",
      { payload },
      { backend, shell: noShell },
    );

    expect(env.ok).toBe(true);
    expect(calls).toContainEqual({
      method: "agentEventUpdate",
      args: [payload],
    });
  });

  it("agent_foreshadow_update: stable requestId を必須化して N-API へ渡す", async () => {
    const { backend, calls } = fakeBackend();
    const payload = {
      requestId: "foreshadow-update-request-1",
      eventUid: "foreshadow-update-event-1",
      origin: "ai-apply",
      authorityRoute: "interactive-agent-command",
      caller: "chat-tool-executor",
      controls: [
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
      provenance: {
        requestId: "foreshadow-update-request-1",
        traceId: "foreshadow-update-trace-1",
      },
      writesAuthorityProtectedField: false,
      originalTransactionId: null,
      undoJournalId: null,
      projectId: "p1",
      sessionId: "s1",
      foreshadowId: "f1",
      baseVersion: 2,
      title: "updated",
    };
    const accepted = await dispatchInvoke(
      "agent_foreshadow_update",
      { payload },
      { backend, shell: noShell },
    );
    expect(accepted.ok).toBe(true);
    expect(calls).toContainEqual({
      method: "agentForeshadowUpdate",
      args: [payload],
    });

    const rejected = fakeBackend();
    const missingRequest = await dispatchInvoke(
      "agent_foreshadow_update",
      { payload: { ...payload, requestId: undefined } },
      { backend: rejected.backend, shell: noShell },
    );
    expect(missingRequest.ok).toBe(false);
    if (!missingRequest.ok) expect(missingRequest.error).toContain("requestId");
    expect(rejected.calls).toHaveLength(0);
  });

  it("agent_foreshadow_create: stable requestId を必須化して N-API へ渡す", async () => {
    const { backend, calls } = fakeBackend();
    const payload = {
      requestId: "foreshadow-create-request-1",
      projectId: "p1",
      sessionId: "s1",
      eventUid: "foreshadow-create-event-1",
      origin: "ai-apply",
      authorityRoute: "interactive-agent-command",
      caller: "chat-tool-executor",
      controls: [
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
      provenance: {
        requestId: "foreshadow-create-request-1",
        traceId: "foreshadow-create-trace-1",
      },
      writesAuthorityProtectedField: false,
      originalTransactionId: null,
      undoJournalId: null,
      foreshadowId: "f1",
      title: "created",
      secret: true,
    };
    const accepted = await dispatchInvoke(
      "agent_foreshadow_create",
      { payload },
      { backend, shell: noShell },
    );
    expect(accepted.ok).toBe(true);
    expect(calls).toContainEqual({
      method: "agentForeshadowCreate",
      args: [payload],
    });

    const rejected = fakeBackend();
    const missingRequest = await dispatchInvoke(
      "agent_foreshadow_create",
      { payload: { ...payload, requestId: undefined } },
      { backend: rejected.backend, shell: noShell },
    );
    expect(missingRequest.ok).toBe(false);
    if (!missingRequest.ok) expect(missingRequest.error).toContain("requestId");
    expect(rejected.calls).toHaveLength(0);
  });

  it("agent_snippet_create: stable requestId を必須化して N-API へ渡す", async () => {
    const { backend, calls } = fakeBackend();
    const payload = {
      requestId: "snippet-create-request-1",
      eventUid: "snippet-create-request-1:event",
      origin: "ai-apply",
      authorityRoute: "interactive-agent-command",
      caller: "chat-tool-executor",
      controls: [
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
      provenance: {
        requestId: "snippet-create-request-1",
        traceId: "snippet-create-request-1:trace",
      },
      writesAuthorityProtectedField: false,
      originalTransactionId: null,
      undoJournalId: null,
      projectId: "p1",
      sessionId: "s1",
      snippetId: "snippet-1",
      title: "Excerpt",
    };
    const accepted = await dispatchInvoke(
      "agent_snippet_create",
      { payload },
      { backend, shell: noShell },
    );
    expect(accepted.ok).toBe(true);
    expect(calls).toContainEqual({
      method: "agentSnippetCreate",
      args: [payload],
    });

    const rejected = fakeBackend();
    const missingRequest = await dispatchInvoke(
      "agent_snippet_create",
      { payload: { ...payload, requestId: undefined } },
      { backend: rejected.backend, shell: noShell },
    );
    expect(missingRequest.ok).toBe(false);
    if (!missingRequest.ok) expect(missingRequest.error).toContain("requestId");
    expect(rejected.calls).toHaveLength(0);
  });

  it.each([
    [
      "snippet_create",
      "snippetCreate",
      { title: "Excerpt", content: "{}", contentSource: "human" },
    ],
    ["snippet_update", "snippetUpdate", { baseVersion: 1, title: "Revised" }],
    ["snippet_delete", "snippetDelete", { baseVersion: 1 }],
  ] as const)(
    "%s: canonical identity と typed payload を検証して N-API へ渡す",
    async (command, method, operationPayload) => {
      const { backend, calls } = fakeBackend();
      const payload = {
        requestId: `${command}-request-1`,
        projectId: "p1",
        sessionId: "s1",
        eventUid: `${command}-event-1`,
        origin: "human",
        authorityRoute: "human-direct",
        caller: "manual-wrapper",
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
        snippetId: "snippet-1",
        ...operationPayload,
      };
      const accepted = await dispatchInvoke(
        command,
        { payload },
        { backend, shell: noShell },
      );
      expect(accepted.ok).toBe(true);
      expect(calls).toContainEqual({ method, args: [payload] });

      const rejected = fakeBackend();
      const historyPayload = {
        ...payload,
        origin: "undo",
        originalTransactionId: "maintenance-tx-1",
        undoJournalId: "journal-1",
      };
      const history = await dispatchInvoke(
        command,
        { payload: historyPayload },
        { backend: rejected.backend, shell: noShell },
      );
      expect(history.ok).toBe(false);
      if (!history.ok) expect(history.error).toContain("Native Undo Journal");
      expect(rejected.calls).toHaveLength(0);
    },
  );

  it("snippet_update: empty patch と負の OCC token を fail-closed に拒否する", async () => {
    const canonical = {
      requestId: "snippet-update-request-1",
      projectId: "p1",
      sessionId: "s1",
      eventUid: "snippet-update-event-1",
      origin: "human",
      authorityRoute: "human-direct",
      caller: "manual-wrapper",
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
      snippetId: "snippet-1",
      baseVersion: 1,
    };
    const empty = fakeBackend();
    const emptyResult = await dispatchInvoke(
      "snippet_update",
      { payload: canonical },
      { backend: empty.backend, shell: noShell },
    );
    expect(emptyResult.ok).toBe(false);
    expect(empty.calls).toHaveLength(0);

    const negative = fakeBackend();
    const negativeResult = await dispatchInvoke(
      "snippet_update",
      { payload: { ...canonical, baseVersion: -1, title: "x" } },
      { backend: negative.backend, shell: noShell },
    );
    expect(negativeResult.ok).toBe(false);
    expect(negative.calls).toHaveLength(0);
  });

  it.each([
    "agent_event_create",
    "agent_event_update",
    "agent_event_delete",
    "agent_event_set_participants",
    "agent_scene_event_link",
    "agent_scene_event_unlink",
    "agent_event_relation_add",
    "agent_event_relation_remove",
  ])("%s: requestId 欠落は N-API を呼ばず拒否する", async (command) => {
    const { backend, calls } = fakeBackend();
    const env = await dispatchInvoke(
      command,
      {
        payload: {
          projectId: "p1",
          sessionId: "s1",
          eventId: "e1",
          baseVersion: 0,
          sceneId: "scene-1",
          causeEventId: "event-a",
          effectEventId: "event-b",
          ...(command === "agent_event_set_participants"
            ? { codexEntryIds: [] }
            : {}),
        },
      },
      { backend, shell: noShell },
    );

    expect(env.ok).toBe(false);
    if (!env.ok) expect(env.error).toContain("requestId");
    expect(calls).toHaveLength(0);
  });

  it("agent_scene_event_link_batch: validated payloadを1回だけN-APIへ渡す", async () => {
    const { backend, calls } = fakeBackend();
    const payload = {
      requestId: "scene-link-batch-request-1",
      projectId: "p1",
      sessionId: "session-1",
      surface: "manual",
      eventId: "event-1",
      // Domain writers canonicalize order and duplicates for stable retries.
      sceneIds: ["scene-2", "scene-1", "scene-2"],
    };

    const env = await dispatchInvoke(
      "agent_scene_event_link_batch",
      { payload },
      { backend, shell: noShell },
    );

    expect(env).toEqual({
      ok: true,
      value: {
        entityId: "e1",
        version: 1,
        changeEventUid: "ce1",
        undoJournalId: "uj1",
      },
    });
    expect(calls).toContainEqual({
      method: "agentSceneEventLinkBatch",
      args: [payload],
    });
  });

  it.each([
    [
      "requestId欠落",
      { projectId: "p1", sessionId: "s1", eventId: "e1", sceneIds: ["sc1"] },
    ],
    [
      "空sceneIds",
      {
        requestId: "r1",
        projectId: "p1",
        sessionId: "s1",
        eventId: "e1",
        sceneIds: [],
      },
    ],
    [
      "空sceneId",
      {
        requestId: "r1",
        projectId: "p1",
        sessionId: "s1",
        eventId: "e1",
        sceneIds: [""],
      },
    ],
  ])(
    "agent_scene_event_link_batch: %sはbackendを呼ばず拒否する",
    async (_label, payload) => {
      const { backend, calls } = fakeBackend();
      const env = await dispatchInvoke(
        "agent_scene_event_link_batch",
        { payload },
        { backend, shell: noShell },
      );

      expect(env.ok).toBe(false);
      expect(calls).toHaveLength(0);
    },
  );

  it("agent_scene_event_link_batch: 10000件を超えるpayloadはbackend前に拒否する", async () => {
    const { backend, calls } = fakeBackend();
    const env = await dispatchInvoke(
      "agent_scene_event_link_batch",
      {
        payload: {
          requestId: "r-oversized",
          projectId: "p1",
          sessionId: "s1",
          eventId: "e1",
          sceneIds: Array.from({ length: 10_001 }, (_, index) => `sc-${index}`),
        },
      },
      { backend, shell: noShell },
    );

    expect(env.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("agent_scene_event_link_batch: backend不在を明示エラーにする", async () => {
    const env = await dispatchInvoke(
      "agent_scene_event_link_batch",
      {
        payload: {
          requestId: "r1",
          projectId: "p1",
          sessionId: "s1",
          eventId: "e1",
          sceneIds: ["sc1"],
        },
      },
      { backend: null, shell: noShell },
    );

    expect(env).toEqual({
      ok: false,
      error: `${IPC_BACKEND_UNAVAILABLE_MARKER} agent_scene_event_link_batch`,
      errorInfo: {
        code: "IPC_BACKEND_UNAVAILABLE",
        message: `${IPC_BACKEND_UNAVAILABLE_MARKER} agent_scene_event_link_batch`,
        outcome: "failed",
        retryable: false,
      },
    });
  });

  it("agent_scene_event_link_batch: 旧native bindingのmethod欠落を明示エラーにする", async () => {
    const { backend, calls } = fakeBackend({
      agentSceneEventLinkBatch: undefined,
    });
    const env = await dispatchInvoke(
      "agent_scene_event_link_batch",
      {
        payload: {
          requestId: "r1",
          projectId: "p1",
          sessionId: "s1",
          eventId: "e1",
          sceneIds: ["sc1"],
        },
      },
      { backend, shell: noShell },
    );

    expect(env).toMatchObject({
      ok: false,
      error: `${IPC_BACKEND_UNAVAILABLE_MARKER} native method agentSceneEventLinkBatch`,
    });
    expect(calls).toHaveLength(0);
  });

  it("agent_chronicle_bulk_mutate: mixed operations を検証して N-API へ渡す", async () => {
    const { backend, calls } = fakeBackend();
    const payload = {
      requestId: "chronicle-bulk-request-1",
      projectId: "p1",
      sessionId: "s1",
      surface: "manual",
      operations: [
        { kind: "eventDelete", eventId: "e1", baseVersion: 7 },
        {
          kind: "eventSetLane",
          eventId: "e2",
          baseVersion: 2,
          primaryCodexId: "c1",
          laneGroup: null,
        },
        {
          kind: "sceneSetPov",
          sceneId: "sc1",
          baseUpdatedAt: "2026-07-29T00:00:00.000Z",
          povCharacterId: null,
        },
        {
          kind: "eventSetDate",
          eventId: "e3",
          baseVersion: 4,
          startTime: -2,
          startMinute: 1439,
          startGranularity: "time",
          endTime: null,
          endMinute: null,
          endGranularity: "none",
        },
        {
          kind: "sceneSetDate",
          sceneId: "sc2",
          baseUpdatedAt: "2026-07-29T00:00:01.000Z",
          startTime: 12,
          startMinute: null,
          startGranularity: "day",
          endTime: 13,
          endMinute: null,
          endGranularity: "day",
        },
      ],
    };
    const env = await dispatchInvoke(
      "agent_chronicle_bulk_mutate",
      { payload },
      { backend, shell: noShell },
    );

    expect(env.ok).toBe(true);
    expect(calls).toContainEqual({
      method: "agentChronicleBulkMutate",
      args: [payload],
    });
  });

  it("agent_chronicle_bulk_mutate: 501 operationsも一つのpayloadとして通す", async () => {
    const { backend, calls } = fakeBackend();
    const payload = {
      requestId: "chronicle-bulk-501",
      projectId: "p1",
      sessionId: "s1",
      surface: "manual",
      operations: Array.from({ length: 501 }, (_, index) => ({
        kind: "eventDelete",
        eventId: `event-${index}`,
        baseVersion: 1,
      })),
    };

    const env = await dispatchInvoke(
      "agent_chronicle_bulk_mutate",
      { payload },
      { backend, shell: noShell },
    );

    expect(env.ok).toBe(true);
    expect(calls).toContainEqual({
      method: "agentChronicleBulkMutate",
      args: [payload],
    });
  });

  it("agent_chronicle_bulk_mutate: 8 MiB超のpayloadはbackend前に拒否する", async () => {
    const { backend, calls } = fakeBackend();
    const env = await dispatchInvoke(
      "agent_chronicle_bulk_mutate",
      {
        payload: {
          requestId: "chronicle-bulk-oversized",
          projectId: "p1",
          sessionId: "s1",
          operations: [
            {
              kind: "eventDelete",
              eventId: "e".repeat(8 * 1024 * 1024),
              baseVersion: 1,
            },
          ],
        },
      },
      { backend, shell: noShell },
    );

    expect(env.ok).toBe(false);
    if (!env.ok) expect(env.error).toContain("8 MiB");
    expect(calls).toHaveLength(0);
  });

  it("agent_chronicle_bulk_mutate: 旧native bindingのmethod欠落を明示エラーにする", async () => {
    const { backend, calls } = fakeBackend({
      agentChronicleBulkMutate: undefined,
    });
    const env = await dispatchInvoke(
      "agent_chronicle_bulk_mutate",
      {
        payload: {
          requestId: "chronicle-bulk-old-binding-request",
          projectId: "p1",
          sessionId: "s1",
          operations: [{ kind: "eventDelete", eventId: "e1", baseVersion: 7 }],
        },
      },
      { backend, shell: noShell },
    );

    expect(env).toMatchObject({
      ok: false,
      error: `${IPC_BACKEND_UNAVAILABLE_MARKER} native method agentChronicleBulkMutate`,
    });
    expect(calls).toHaveLength(0);
  });

  it.each([
    ["empty operations", { operations: [] }],
    [
      "missing event version",
      { operations: [{ kind: "eventDelete", eventId: "e1" }] },
    ],
    [
      "duplicate target",
      {
        operations: [
          { kind: "eventDelete", eventId: "e1", baseVersion: 1 },
          { kind: "eventClearDate", eventId: "e1", baseVersion: 1 },
        ],
      },
    ],
    [
      "missing scene token",
      {
        operations: [
          {
            kind: "sceneClearDate",
            sceneId: "sc1",
          },
        ],
      },
    ],
    [
      "missing lane field",
      {
        operations: [
          {
            kind: "eventSetLane",
            eventId: "e1",
            baseVersion: 1,
            primaryCodexId: null,
          },
        ],
      },
    ],
    [
      "invalid pov",
      {
        operations: [
          {
            kind: "sceneSetPov",
            sceneId: "sc1",
            baseUpdatedAt: "2026-07-29T00:00:00.000Z",
            povCharacterId: "",
          },
        ],
      },
    ],
    [
      "invalid absolute date minute",
      {
        operations: [
          {
            kind: "eventSetDate",
            eventId: "e1",
            baseVersion: 1,
            startTime: 10,
            startMinute: 1440,
            startGranularity: "time",
            endTime: null,
            endMinute: null,
            endGranularity: "none",
          },
        ],
      },
    ],
    [
      "missing absolute scene date field",
      {
        operations: [
          {
            kind: "sceneSetDate",
            sceneId: "sc1",
            baseUpdatedAt: "2026-07-29T00:00:00.000Z",
            startTime: 10,
            startMinute: null,
            startGranularity: "day",
            endTime: null,
            endMinute: null,
          },
        ],
      },
    ],
  ])(
    "agent_chronicle_bulk_mutate: %s は backend を呼ばず拒否する",
    async (_label, invalid) => {
      const { backend, calls } = fakeBackend();
      const env = await dispatchInvoke(
        "agent_chronicle_bulk_mutate",
        {
          payload: {
            requestId: "chronicle-bulk-invalid-request",
            projectId: "p1",
            sessionId: "s1",
            ...invalid,
          },
        },
        { backend, shell: noShell },
      );

      expect(env.ok).toBe(false);
      expect(calls).toHaveLength(0);
    },
  );

  it("agent_apply_undo_journal: retry requestId と方向を検証して N-API へ渡す", async () => {
    const { backend, calls } = fakeBackend();
    const payload = {
      requestId: "chronicle-bulk-undo-request-1",
      projectId: "p1",
      sessionId: "s1",
      journalId: "journal-1",
      direction: "undo",
      authorityRoute: "history-replay",
      origin: "undo",
      caller: "undo-redo-command",
      controls: [
        "original-transaction",
        "journal-lineage",
        "typed-writer",
        "occ",
        "change-event",
        "change-feed",
      ],
    };

    const env = await dispatchInvoke(
      "agent_apply_undo_journal",
      { payload },
      { backend, shell: noShell },
    );

    expect(env.ok).toBe(true);
    expect(calls).toContainEqual({
      method: "agentApplyUndoJournal",
      args: [payload],
    });
  });

  it.each([
    ["missing requestId", { requestId: undefined, direction: "undo" }],
    ["invalid direction", { requestId: "undo-request", direction: "back" }],
  ])(
    "agent_apply_undo_journal: %s は backend を呼ばず拒否する",
    async (_label, invalid) => {
      const { backend, calls } = fakeBackend();
      const env = await dispatchInvoke(
        "agent_apply_undo_journal",
        {
          payload: Object.assign(
            {
              requestId: "undo-request-default",
              projectId: "p1",
              sessionId: "s1",
              journalId: "journal-1",
            },
            invalid,
          ),
        },
        { backend, shell: noShell },
      );

      expect(env.ok).toBe(false);
      expect(calls).toHaveLength(0);
    },
  );

  it.each([
    ["authority route", { authorityRoute: "interactive-agent-command" }],
    ["origin", { origin: "redo" }],
    ["caller", { caller: "history-controller" }],
    [
      "original-transaction control",
      {
        controls: [
          "journal-lineage",
          "typed-writer",
          "occ",
          "change-event",
          "change-feed",
        ],
      },
    ],
    [
      "journal-lineage control",
      {
        controls: [
          "original-transaction",
          "typed-writer",
          "occ",
          "change-event",
          "change-feed",
        ],
      },
    ],
    [
      "typed-writer control",
      {
        controls: [
          "original-transaction",
          "journal-lineage",
          "occ",
          "change-event",
          "change-feed",
        ],
      },
    ],
    [
      "occ control",
      {
        controls: [
          "original-transaction",
          "journal-lineage",
          "typed-writer",
          "change-event",
          "change-feed",
        ],
      },
    ],
    [
      "change-event control",
      {
        controls: [
          "original-transaction",
          "journal-lineage",
          "typed-writer",
          "occ",
          "change-feed",
        ],
      },
    ],
    [
      "change-feed control",
      {
        controls: [
          "original-transaction",
          "journal-lineage",
          "typed-writer",
          "occ",
          "change-event",
        ],
      },
    ],
  ])(
    "agent_apply_undo_journal: %s は単独の権限要素欠落を拒否する",
    async (_label, invalid) => {
      const { backend, calls } = fakeBackend();
      const env = await dispatchInvoke(
        "agent_apply_undo_journal",
        {
          payload: {
            requestId: "undo-authority-request",
            projectId: "p1",
            sessionId: "s1",
            journalId: "journal-1",
            direction: "undo",
            authorityRoute: "history-replay",
            origin: "undo",
            caller: "undo-redo-command",
            controls: [
              "original-transaction",
              "journal-lineage",
              "typed-writer",
              "occ",
              "change-event",
              "change-feed",
            ],
            ...invalid,
          },
        },
        { backend, shell: noShell },
      );

      expect(env.ok).toBe(false);
      expect(calls).toHaveLength(0);
    },
  );

  it.each([
    ["narrative_extraction_undo_commit", "narrativeExtractionUndoCommit"],
    ["narrative_extraction_redo_commit", "narrativeExtractionRedoCommit"],
  ])(
    "%s: commitId と retry requestId を必須にして backend へ渡す",
    async (command, method) => {
      const payload = {
        projectId: "p1",
        sessionId: "s1",
        commitId: "commit-1",
        requestId: `${command}-request-1`,
      };
      const valid = fakeBackend();
      const accepted = await dispatchInvoke(
        command,
        { payload },
        { backend: valid.backend, shell: noShell },
      );
      expect(accepted.ok).toBe(true);
      expect(valid.calls).toContainEqual({ method, args: [payload] });

      for (const invalid of [
        { ...payload, requestId: "" },
        { ...payload, commitId: "" },
      ]) {
        const rejected = fakeBackend();
        const result = await dispatchInvoke(
          command,
          { payload: invalid },
          { backend: rejected.backend, shell: noShell },
        );
        expect(result.ok).toBe(false);
        expect(rejected.calls).toHaveLength(0);
      }
    },
  );

  it.each([
    ["negative", -1],
    ["fractional", 1.5],
    ["unsafe", Number.MAX_SAFE_INTEGER + 1],
    ["NaN", Number.NaN],
    ["infinite", Number.POSITIVE_INFINITY],
  ])(
    "agent_event_update: %s baseVersion は N-API を呼ばず拒否する",
    async (_label, baseVersion) => {
      const { backend, calls } = fakeBackend();
      const env = await dispatchInvoke(
        "agent_event_update",
        {
          payload: {
            requestId: "event-update-invalid-version-request-1",
            projectId: "p1",
            sessionId: "s1",
            eventId: "e1",
            baseVersion,
          },
        },
        { backend, shell: noShell },
      );

      expect(env.ok).toBe(false);
      if (!env.ok) expect(env.error).toContain("baseVersion");
      expect(calls).toHaveLength(0);
    },
  );

  it("agent_propose_scene_body: payload 欠落は invalid args（backend 未呼び出し）", async () => {
    const { backend, calls } = fakeBackend();
    const env = await dispatchInvoke(
      "agent_propose_scene_body",
      {},
      { backend, shell: noShell },
    );
    expect(calls).toHaveLength(0);
    expect(env.ok).toBe(false);
  });

  // ── post_effect pure-db 7 コマンド（Phase 3 バッチ1） ──────────────────
  it("list_post_effect_runs: effectType(null→undefined) / limit / offset を写像", async () => {
    const { backend, calls } = fakeBackend();
    await dispatchInvoke(
      "list_post_effect_runs",
      { projectId: "p1", effectType: null, limit: 20, offset: 0 },
      { backend, shell: noShell },
    );
    await dispatchInvoke(
      "list_post_effect_runs",
      { projectId: "p1", effectType: "proofread", limit: null, offset: null },
      { backend, shell: noShell },
    );
    expect(calls).toEqual([
      { method: "listPostEffectRuns", args: ["p1", undefined, 20, 0] },
      {
        method: "listPostEffectRuns",
        args: ["p1", "proofread", undefined, undefined],
      },
    ]);
  });

  it("list_annotations_for_scene / update_annotation_status を写像し parse", async () => {
    const { backend, calls } = fakeBackend();
    const list = await dispatchInvoke(
      "list_annotations_for_scene",
      { projectId: "p1", sceneId: "s1", status: null },
      { backend, shell: noShell },
    );
    const upd = await dispatchInvoke(
      "update_annotation_status",
      { annotationId: "a1", status: "dismissed", projectId: "p1" },
      { backend, shell: noShell },
    );
    expect(calls).toEqual([
      { method: "listAnnotationsForScene", args: ["p1", "s1", undefined] },
      { method: "updateAnnotationStatus", args: ["a1", "dismissed", "p1"] },
    ]);
    expect(list).toEqual({
      ok: true,
      value: { annotations: [], relations: [] },
    });
    expect(upd).toEqual({ ok: true, value: { id: "a1", status: "dismissed" } });
  });

  it("reply_to_annotation: snake_case の {args} をネストしたまま素通し", async () => {
    const { backend, calls } = fakeBackend();
    const args = {
      parent_id: "a1",
      content: "返信",
      author_role: "human",
      project_id: "p1",
    };
    const env = await dispatchInvoke(
      "reply_to_annotation",
      { args },
      { backend, shell: noShell },
    );
    expect(calls).toEqual([{ method: "replyToAnnotation", args: [args] }]);
    expect(env).toEqual({ ok: true, value: { id: "a2", parent_id: "a1" } });
  });

  it("save_post_effect_annotations: unit 返りは null（annotations 配列を素通し）", async () => {
    const { backend, calls } = fakeBackend();
    const annotations = [
      { id: "a1", range_start: 3, range_end: 7, text_snapshot: "…" },
    ];
    const env = await dispatchInvoke(
      "save_post_effect_annotations",
      { projectId: "p1", sceneId: "s1", annotations },
      { backend, shell: noShell },
    );
    expect(calls).toEqual([
      {
        method: "savePostEffectAnnotations",
        args: ["p1", "s1", annotations],
      },
    ]);
    expect(env).toEqual({ ok: true, value: null });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// openExternal スキーム検証 / zoom クランプ
// ─────────────────────────────────────────────────────────────────────────────

describe("isSafeExternalUrl", () => {
  it.each([
    "https://example.com/path",
    "http://localhost:1430/",
    "mailto:someone@example.com",
  ])("allows %s", (url) => {
    expect(isSafeExternalUrl(url)).toBe(true);
  });

  it.each([
    "javascript:alert(1)",
    "file:///etc/passwd",
    "data:text/html,<script>1</script>",
    "vbscript:x",
    "app://bundle/index.html",
    "/relative/path",
    "not a url",
  ])("rejects %s", (url) => {
    expect(isSafeExternalUrl(url)).toBe(false);
  });
});

describe("clampZoomFactor", () => {
  it("有効範囲はそのまま", () => {
    expect(clampZoomFactor(1.25)).toBe(1.25);
  });
  it("範囲外はクランプ", () => {
    expect(clampZoomFactor(100)).toBe(4);
    expect(clampZoomFactor(0)).toBe(0.25);
  });
  it("非数・非有限は 1", () => {
    expect(clampZoomFactor("2")).toBe(1);
    expect(clampZoomFactor(Number.NaN)).toBe(1);
    expect(clampZoomFactor(Number.POSITIVE_INFINITY)).toBe(1);
    expect(clampZoomFactor(undefined)).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AI チャット（Phase 3 バッチ3a — キー注入 + secrets 経由の解決）
// ─────────────────────────────────────────────────────────────────────────────

const nativeAiAuditContext = {
  expectedWorkspacePath: "/workspaces/novel",
  projectId: "project-1",
  operationId: "operation-1",
  executionId: "execution-1",
  parentExecutionId: null,
  pathId: "chat",
};

describe("AI チャットコマンド", () => {
  const fakeSecrets = (key = "sk-resolved") => ({
    resolveApiKeyForRequest: vi.fn().mockReturnValue(key),
  });

  it("get_ai_settings は backend.getAiSettings を parse して返す", async () => {
    const { backend, calls } = fakeBackend();
    const env = await dispatchInvoke(
      "get_ai_settings",
      {},
      { backend, shell: noShell },
    );
    expect(env).toEqual({
      ok: true,
      value: { provider: "openai", model: "gpt-x" },
    });
    expect(calls.some((c) => c.method === "getAiSettings")).toBe(true);
  });

  it("send_chat_message は設定を読み secrets でキー解決して注入する", async () => {
    const { backend, calls } = fakeBackend();
    const secrets = fakeSecrets("sk-abc");
    const args = {
      messages: [{ role: "user", content: "hi" }],
      provider: "openai",
      expectedOllamaEndpoint: null,
      auditContext: nativeAiAuditContext,
    };
    const env = await dispatchInvoke("send_chat_message", args, {
      backend,
      shell: noShell,
      secrets,
    });
    expect(env).toEqual({
      ok: true,
      value: { blocks: [{ type: "text", content: "hi" }] },
    });
    // 設定 → secrets(settings, provider, endpointId) →
    // sendChatMessage(args, settings, key) の順。
    expect(secrets.resolveApiKeyForRequest).toHaveBeenCalledWith(
      { provider: "openai", model: "gpt-x" },
      "openai",
      undefined,
    );
    // 送信は「キー解決に使った同一 settings スナップショット」を napi へ渡す（原子性）。
    expect(calls).toContainEqual({
      method: "sendChatMessage",
      args: [args, { provider: "openai", model: "gpt-x" }, "sk-abc"],
    });
    // TOCTOU 回避: settings 読み込みは 1 回だけ（napi は再読込しない）。
    expect(calls.filter((c) => c.method === "getAiSettings")).toHaveLength(1);
  });

  it("send_chat_message は削除済み OpenAI 互換 endpoint override を native 前に拒否する", async () => {
    const { backend, calls } = fakeBackend({
      getAiSettings: vi.fn().mockResolvedValue(
        JSON.stringify({
          provider: "openai-compatible",
          model: "local-model",
          openaiCompatible: { baseUrl: "" },
          openaiCompatibleEndpoints: [
            { id: "endpoint-b", label: "B", baseUrl: "http://b/v1" },
          ],
          activeOpenaiCompatibleEndpointId: "endpoint-b",
        }),
      ),
    });
    const secrets = fakeSecrets("sk-compat");
    const env = await dispatchInvoke(
      "send_chat_message",
      {
        messages: [{ role: "user", content: "must not retarget" }],
        provider: "openai-compatible",
        model: "local-model",
        endpointId: "endpoint-a",
        auditContext: nativeAiAuditContext,
      },
      { backend, shell: noShell, secrets },
    );

    expect(env).toMatchObject({
      ok: false,
      error: expect.stringMatching(/endpoint.*configured/i),
    });
    expect(secrets.resolveApiKeyForRequest).not.toHaveBeenCalled();
    expect(calls.some((call) => call.method === "sendChatMessage")).toBe(false);
  });

  it("send_chat_message keeps a known explicit endpoint and preserves no-override compatibility", async () => {
    const settings = {
      provider: "openai-compatible",
      model: "local-model",
      openaiCompatible: { baseUrl: "" },
      openaiCompatibleEndpoints: [
        { id: "endpoint-a", label: "A", baseUrl: "http://a/v1" },
        { id: "endpoint-b", label: "B", baseUrl: "http://b/v1" },
      ],
      activeOpenaiCompatibleEndpointId: "endpoint-b",
    };
    const { backend, calls } = fakeBackend({
      getAiSettings: vi.fn().mockResolvedValue(JSON.stringify(settings)),
    });
    const secrets = fakeSecrets("sk-compat");
    const args = {
      messages: [{ role: "user", content: "known endpoint" }],
      provider: "openai-compatible",
      model: "local-model",
      endpointId: "endpoint-a",
      auditContext: nativeAiAuditContext,
    };
    const env = await dispatchInvoke("send_chat_message", args, {
      backend,
      shell: noShell,
      secrets,
    });

    expect(env.ok).toBe(true);
    expect(secrets.resolveApiKeyForRequest).toHaveBeenCalledWith(
      settings,
      "openai-compatible",
      "endpoint-a",
    );
    expect(calls).toContainEqual({
      method: "sendChatMessage",
      args: [args, settings, "sk-compat"],
    });
  });

  it("send_chat_message_stream はキーを注入し null を resolve する", async () => {
    const { backend, calls } = fakeBackend();
    const secrets = fakeSecrets("sk-stream");
    const args = {
      messages: [{ role: "user", content: "yo" }],
      endpointId: "ep2",
      requestMaxOutputTokens: 32_000,
      expectedOllamaEndpoint: "http://127.0.0.1:11434",
      streamId: nativeAiAuditContext.executionId,
      auditContext: nativeAiAuditContext,
    };
    const env = await dispatchInvoke("send_chat_message_stream", args, {
      backend,
      shell: noShell,
      secrets,
    });
    expect(env).toEqual({ ok: true, value: null });
    expect(secrets.resolveApiKeyForRequest).toHaveBeenCalledWith(
      { provider: "openai", model: "gpt-x" },
      undefined,
      "ep2",
    );
    expect(calls).toContainEqual({
      method: "sendChatMessageStream",
      args: [args, { provider: "openai", model: "gpt-x" }, "sk-stream"],
    });
  });

  it("send_chat_message_stream は削除済み OpenAI 互換 endpoint を native 前に拒否する", async () => {
    const { backend, calls } = fakeBackend({
      getAiSettings: vi.fn().mockResolvedValue(
        JSON.stringify({
          provider: "openai-compatible",
          model: "local-model",
          openaiCompatible: { baseUrl: "" },
          openaiCompatibleEndpoints: [
            { id: "endpoint-b", label: "B", baseUrl: "http://b/v1" },
          ],
          activeOpenaiCompatibleEndpointId: "endpoint-b",
        }),
      ),
    });
    const env = await dispatchInvoke(
      "send_chat_message_stream",
      {
        messages: [{ role: "user", content: "must not stream elsewhere" }],
        provider: "openai-compatible",
        endpointId: "endpoint-a",
        streamId: nativeAiAuditContext.executionId,
        auditContext: nativeAiAuditContext,
      },
      { backend, shell: noShell, secrets: fakeSecrets() },
    );

    expect(env).toMatchObject({
      ok: false,
      error: expect.stringMatching(/endpoint.*configured/i),
    });
    expect(calls.some((call) => call.method === "sendChatMessageStream")).toBe(
      false,
    );
  });

  it("send_chat_message_stream は不正な requestMaxOutputTokens を main 境界で拒否する", async () => {
    const { backend, calls } = fakeBackend();
    const env = await dispatchInvoke(
      "send_chat_message_stream",
      {
        messages: [{ role: "user", content: "yo" }],
        requestMaxOutputTokens: 0,
      },
      { backend, shell: noShell, secrets: fakeSecrets() },
    );

    expect(env.ok).toBe(false);
    expect(env).toMatchObject({
      error: expect.stringMatching(/requestMaxOutputTokens/),
    });
    expect(calls.some((call) => call.method === "sendChatMessageStream")).toBe(
      false,
    );
  });

  it.each([
    undefined,
    { ...nativeAiAuditContext, projectId: undefined },
    { ...nativeAiAuditContext, apiKey: "must-not-cross" },
    { ...nativeAiAuditContext, executionId: "  " },
  ])(
    "native AI送信は欠落・余剰・空のauditContextをmain境界で拒否する: %j",
    async (auditContext) => {
      const { backend, calls } = fakeBackend();
      const env = await dispatchInvoke(
        "send_chat_message",
        {
          messages: [{ role: "user", content: "hi" }],
          auditContext,
        },
        { backend, shell: noShell, secrets: fakeSecrets() },
      );

      expect(env.ok).toBe(false);
      if (!env.ok) expect(env.error).toContain("auditContext");
      expect(calls.some((call) => call.method === "sendChatMessage")).toBe(
        false,
      );
    },
  );

  it("abort_chat_stream は streamId をbackendへ渡しquiescence receiptを返す", async () => {
    const { backend, calls } = fakeBackend();
    const env = await dispatchInvoke(
      "abort_chat_stream",
      { streamId: "execution-1" },
      { backend, shell: noShell },
    );
    expect(env).toEqual({
      ok: true,
      value: {
        abortCommandAcknowledged: true,
        transportTerminationObserved: true,
      },
    });
    expect(calls).toContainEqual({
      method: "abortChatStream",
      args: ["execution-1"],
    });
  });

  it("secrets 未注入のチャット送信は IPC_SECRETS_UNAVAILABLE で reject する", async () => {
    const { backend } = fakeBackend();
    const env = await dispatchInvoke(
      "send_chat_message",
      { messages: [], auditContext: nativeAiAuditContext },
      { backend, shell: noShell }, // secrets 無し
    );
    expect(env).toMatchObject({
      ok: false,
      error: "IPC_SECRETS_UNAVAILABLE: send_chat_message",
    });
  });

  it("キー未設定（secrets が throw）は生文字列 reject に解封される", async () => {
    const { backend } = fakeBackend();
    const secrets = {
      resolveApiKeyForRequest: vi.fn(() => {
        throw new Error("No API key configured for anthropic");
      }),
    };
    const env = await dispatchInvoke(
      "send_chat_message",
      {
        messages: [],
        provider: "anthropic",
        auditContext: nativeAiAuditContext,
      },
      { backend, shell: noShell, secrets },
    );
    expect(env).toEqual({
      ok: false,
      error: "No API key configured for anthropic",
    });
  });

  it("has/save/delete_api_key は shell ハンドラへ委譲される", async () => {
    const { backend } = fakeBackend();
    const shellCalls: Array<{ cmd: string; args: unknown }> = [];
    const shell = {
      has_api_key: (a: Record<string, unknown>) => {
        shellCalls.push({ cmd: "has_api_key", args: a });
        return Promise.resolve(true);
      },
      save_api_key: (a: Record<string, unknown>) => {
        shellCalls.push({ cmd: "save_api_key", args: a });
        return Promise.resolve(null);
      },
      delete_api_key: (a: Record<string, unknown>) => {
        shellCalls.push({ cmd: "delete_api_key", args: a });
        return Promise.resolve(null);
      },
    };
    const has = await dispatchInvoke(
      "has_api_key",
      { provider: "openai" },
      { backend, shell },
    );
    expect(has).toEqual({ ok: true, value: true });
    const saved = await dispatchInvoke(
      "save_api_key",
      { provider: "openai", key: "sk-1" },
      { backend, shell },
    );
    expect(saved).toEqual({ ok: true, value: null });
    const del = await dispatchInvoke(
      "delete_api_key",
      { provider: "openai" },
      { backend, shell },
    );
    expect(del).toEqual({ ok: true, value: null });
    expect(shellCalls.map((c) => c.cmd)).toEqual([
      "has_api_key",
      "save_api_key",
      "delete_api_key",
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AI Phase 3b（inline / agent / settings / models / connection）
// ─────────────────────────────────────────────────────────────────────────────

describe("AI Phase 3b コマンド", () => {
  function makeBackend() {
    const base = fakeBackend();
    const methods = {
      saveAiSettings: vi.fn().mockResolvedValue(undefined),
      sendInlineAiStream: vi.fn().mockResolvedValue(undefined),
      abortInlineAiStream: vi.fn().mockResolvedValue(true),
      sendAgentMessage: vi
        .fn()
        .mockResolvedValue(
          '{"blocks":[{"type":"tool_use","id":"t1","name":"search","input":{}}],"stopReason":"tool_use"}',
        ),
      listAiModels: vi.fn().mockResolvedValue('[{"id":"m1","name":"Model 1"}]'),
      testAiConnection: vi.fn().mockResolvedValue("Connection OK"),
    };
    return {
      ...base,
      backend: Object.assign(base.backend, methods),
      methods,
    };
  }

  function secrets(
    requiredKey = "sk-required",
    optionalKey: string | null = null,
  ) {
    return {
      resolveApiKeyForRequest: vi.fn().mockReturnValue(requiredKey),
      getApiKeyForRequest: vi.fn().mockReturnValue(optionalKey),
    };
  }

  it("save_ai_settings は渡された設定を保存し、secrets を要求しない", async () => {
    const { backend, methods } = makeBackend();
    const settings = { provider: "openai", model: "gpt-x" };
    const env = await dispatchInvoke(
      "save_ai_settings",
      { settings },
      { backend, shell: noShell },
    );
    expect(env).toEqual({ ok: true, value: null });
    expect(methods.saveAiSettings).toHaveBeenCalledWith(settings);
  });

  it("save_ai_settings の settings 欠落は backend を呼ばず reject する", async () => {
    const { backend, methods } = makeBackend();
    const env = await dispatchInvoke(
      "save_ai_settings",
      {},
      { backend, shell: noShell },
    );
    expect(env.ok).toBe(false);
    if (!env.ok) expect(env.error).toMatch(/invalid args `settings`/);
    expect(methods.saveAiSettings).not.toHaveBeenCalled();
  });

  it("send_inline_ai_stream は1回の設定snapshotと必須キーを注入する", async () => {
    const { backend, calls, methods } = makeBackend();
    const keyStore = secrets("sk-inline");
    const args = {
      messages: [{ role: "user", content: "continue" }],
      provider: "openai-compatible",
      endpointId: "ep2",
      streamId: nativeAiAuditContext.executionId,
      auditContext: nativeAiAuditContext,
    };
    const env = await dispatchInvoke("send_inline_ai_stream", args, {
      backend,
      shell: noShell,
      secrets: keyStore,
    });
    const settings = { provider: "openai", model: "gpt-x" };
    expect(env).toEqual({ ok: true, value: null });
    expect(keyStore.resolveApiKeyForRequest).toHaveBeenCalledWith(
      settings,
      "openai-compatible",
      "ep2",
    );
    expect(methods.sendInlineAiStream).toHaveBeenCalledWith(
      args,
      settings,
      "sk-inline",
    );
    expect(calls.filter((c) => c.method === "getAiSettings")).toHaveLength(1);
  });

  it("abort_inline_ai_stream は専用 backend メソッドを呼ぶ", async () => {
    const { backend, methods } = makeBackend();
    const env = await dispatchInvoke(
      "abort_inline_ai_stream",
      { streamId: "execution-1" },
      { backend, shell: noShell },
    );
    expect(env).toEqual({
      ok: true,
      value: {
        abortCommandAcknowledged: true,
        transportTerminationObserved: true,
      },
    });
    expect(methods.abortInlineAiStream).toHaveBeenCalledExactlyOnceWith(
      "execution-1",
    );
  });

  it("send_agent_message はtool payloadを保ち、応答JSONをparseする", async () => {
    const { backend, methods } = makeBackend();
    const keyStore = secrets("sk-agent");
    const args = {
      messages: [{ role: "user", content: "find it" }],
      tools: [
        {
          name: "search",
          description: "search",
          inputSchema: { type: "object", properties: {}, required: [] },
        },
      ],
      webSearch: { enabled: true, agentic: true },
      resolvedToolProtocol: "hermes",
      expectedOllamaEndpoint: "http://127.0.0.1:11434",
      auditContext: nativeAiAuditContext,
    };
    const env = await dispatchInvoke("send_agent_message", args, {
      backend,
      shell: noShell,
      secrets: keyStore,
    });
    expect(env).toEqual({
      ok: true,
      value: {
        blocks: [{ type: "tool_use", id: "t1", name: "search", input: {} }],
        stopReason: "tool_use",
      },
    });
    expect(methods.sendAgentMessage).toHaveBeenCalledWith(
      args,
      { provider: "openai", model: "gpt-x" },
      "sk-agent",
    );
  });

  it("send_agent_message は不正な resolvedToolProtocol を main 境界で拒否する", async () => {
    const { backend, methods } = makeBackend();
    const env = await dispatchInvoke(
      "send_agent_message",
      {
        messages: [{ role: "user", content: "find it" }],
        tools: [],
        resolvedToolProtocol: "auto",
      },
      { backend, shell: noShell, secrets: secrets() },
    );

    expect(env.ok).toBe(false);
    expect(env).toMatchObject({
      error: expect.stringMatching(/resolvedToolProtocol/),
    });
    expect(methods.sendAgentMessage).not.toHaveBeenCalled();
  });

  it.each([
    [
      "send_chat_message",
      { messages: [], expectedOllamaEndpoint: 42 },
      "sendChatMessage",
    ],
    [
      "send_chat_message_stream",
      { messages: [], expectedOllamaEndpoint: 42 },
      "sendChatMessageStream",
    ],
    [
      "send_agent_message",
      { messages: [], tools: [], expectedOllamaEndpoint: 42 },
      "sendAgentMessage",
    ],
    [
      "list_ai_models",
      { provider: "ollama", expectedOllamaEndpoint: 42 },
      "listAiModels",
    ],
  ] as const)(
    "%s は不正な expectedOllamaEndpoint を main 境界で拒否する",
    async (command, args, method) => {
      const { backend, calls } = makeBackend();
      const env = await dispatchInvoke(command, args, {
        backend,
        shell: noShell,
        secrets: secrets(),
      });

      expect(env).toMatchObject({
        ok: false,
        error: expect.stringMatching(/expectedOllamaEndpoint/),
      });
      expect(calls.some((call) => call.method === method)).toBe(false);
    },
  );

  it("list_ai_models はキー未設定を空文字にし、必須キー解決を使わない", async () => {
    const { backend, methods } = makeBackend();
    const keyStore = secrets("must-not-use", null);
    const args = {
      provider: "anthropic",
      endpointId: null,
      selectedModelId: "gemma4:latest",
      expectedOllamaEndpoint: "http://127.0.0.1:11434",
    };
    const env = await dispatchInvoke("list_ai_models", args, {
      backend,
      shell: noShell,
      secrets: keyStore,
    });
    expect(env).toEqual({
      ok: true,
      value: [{ id: "m1", name: "Model 1" }],
    });
    expect(keyStore.getApiKeyForRequest).toHaveBeenCalledWith(
      { provider: "openai", model: "gpt-x" },
      "anthropic",
      null,
    );
    expect(keyStore.resolveApiKeyForRequest).not.toHaveBeenCalled();
    expect(methods.listAiModels).toHaveBeenCalledWith(
      args,
      { provider: "openai", model: "gpt-x" },
      "",
    );
  });

  it("test_ai_connection は必須キーを注入し、文字列をそのまま返す", async () => {
    const { backend, methods } = makeBackend();
    const keyStore = secrets("sk-test");
    const args = {
      provider: "openai-compatible",
      model: "model-x",
      apiVariant: "v1",
      endpointId: "ep2",
      auditContext: nativeAiAuditContext,
    };
    const env = await dispatchInvoke("test_ai_connection", args, {
      backend,
      shell: noShell,
      secrets: keyStore,
    });
    expect(env).toEqual({ ok: true, value: "Connection OK" });
    expect(methods.testAiConnection).toHaveBeenCalledWith(
      args,
      { provider: "openai", model: "gpt-x" },
      "sk-test",
    );
  });

  it.each([
    "send_inline_ai_stream",
    "send_agent_message",
    "list_ai_models",
    "test_ai_connection",
  ])("%s は secrets 未注入を明示エラーにする", async (cmd) => {
    const { backend } = makeBackend();
    const env = await dispatchInvoke(
      cmd,
      {
        provider: "openai",
        messages: [],
        tools: [],
        model: "m",
        streamId: nativeAiAuditContext.executionId,
        auditContext: nativeAiAuditContext,
      },
      { backend, shell: noShell },
    );
    expect(env).toMatchObject({
      ok: false,
      error: `IPC_SECRETS_UNAVAILABLE: ${cmd}`,
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Post-effect run（Phase 3d — fire-and-forget + optional secret snapshot）
// ─────────────────────────────────────────────────────────────────────────────

describe("Post-effect Phase 3d コマンド", () => {
  const expectedWorkspacePath = "/workspaces/novel";

  function startArgs<T extends Record<string, unknown>>(args: T) {
    return { expectedWorkspacePath, args };
  }

  function scopedNativeArgs<T extends Record<string, unknown>>(args: T) {
    return { ...args, expectedWorkspacePath };
  }

  const singleArgs = {
    project_id: "p1",
    effect_type: "review",
    scope_type: "scene",
    scope_target_id: "s1",
    model: "base-model",
    model_override: "review-model",
    provider_override: "openai-compatible",
    api_variant_override: "v1",
    endpoint_id_override: "review-endpoint",
    prompt_version: "review_v1.1",
    input_hash: "hash-single",
    codex_payload_json: "[]",
    scene_text: "本文",
    system_prompt: "校閲してください",
  };

  const multiArgs = {
    project_id: "p1",
    effect_type: "timeline_consistency",
    scope_type: "project",
    scope_target_id: null,
    model: "base-model",
    model_override: "timeline-model",
    provider_override: "anthropic",
    api_variant_override: null,
    endpoint_id_override: null,
    prompt_version: "timeline_consistency_v1.0",
    input_hash: "hash-multi",
    scenes: [
      {
        scene_id: "s1",
        codex_payload_json: "[]",
        scene_text: "第一場面",
      },
      {
        scene_id: "s2",
        codex_payload_json: "[]",
        scene_text: "第二場面",
      },
    ],
    system_prompt: "時系列を確認してください",
  };

  function makeBackend() {
    const base = fakeBackend();
    const methods = {
      startPostEffectRun: vi
        .fn()
        .mockResolvedValue('{"run_id":"r-single","from_cache":false}'),
      startPostEffectRunMulti: vi
        .fn()
        .mockResolvedValue('{"run_id":"r-multi","from_cache":true}'),
      abortPostEffectRun: vi.fn().mockResolvedValue(undefined),
    };
    return {
      ...base,
      backend: Object.assign(base.backend, methods),
      methods,
    };
  }

  function secrets(optionalKey: string | null) {
    return {
      // post-effect は cache 判定後に背景 task が送信するため、必須キー解決
      //（未登録で throw）ではなく optional snapshot を注入する。
      resolveApiKeyForRequest: vi.fn(() => {
        throw new Error("post-effect must not use required key lookup");
      }),
      getApiKeyForRequest: vi.fn().mockReturnValue(optionalKey),
    };
  }

  it("start_post_effect_run は nested snake_case args を保持し、設定を1回だけ読んで結果JSONをparseする", async () => {
    const { backend, calls, methods } = makeBackend();
    const keyStore = secrets("sk-review");

    const env = await dispatchInvoke(
      "start_post_effect_run",
      startArgs(singleArgs),
      { backend, shell: noShell, secrets: keyStore },
    );

    const settings = { provider: "openai", model: "gpt-x" };
    expect(env).toEqual({
      ok: true,
      value: { run_id: "r-single", from_cache: false },
    });
    expect(keyStore.getApiKeyForRequest).toHaveBeenCalledExactlyOnceWith(
      settings,
      "openai-compatible",
      "review-endpoint",
    );
    expect(keyStore.resolveApiKeyForRequest).not.toHaveBeenCalled();
    expect(methods.startPostEffectRun).toHaveBeenCalledExactlyOnceWith(
      scopedNativeArgs(singleArgs),
      settings,
      "sk-review",
      null,
    );
    expect(
      calls.filter((call) => call.method === "getAiSettings"),
    ).toHaveLength(1);
  });

  it("start_post_effect_run_multi は scenes を含むsnake_case argsを保持し、optional key=nullでも開始する", async () => {
    const { backend, calls, methods } = makeBackend();
    const keyStore = secrets(null);

    const env = await dispatchInvoke(
      "start_post_effect_run_multi",
      startArgs(multiArgs),
      { backend, shell: noShell, secrets: keyStore },
    );

    const settings = { provider: "openai", model: "gpt-x" };
    expect(env).toEqual({
      ok: true,
      value: { run_id: "r-multi", from_cache: true },
    });
    expect(keyStore.getApiKeyForRequest).toHaveBeenCalledExactlyOnceWith(
      settings,
      "anthropic",
      null,
    );
    expect(methods.startPostEffectRunMulti).toHaveBeenCalledExactlyOnceWith(
      scopedNativeArgs(multiArgs),
      settings,
      null,
      null,
    );
    expect(
      calls.filter((call) => call.method === "getAiSettings"),
    ).toHaveLength(1);
  });

  it("start_post_effect_run_multi は Impact Review の SQLite source_guard をそのまま保持する", async () => {
    const { backend, methods } = makeBackend();
    const guardedArgs = {
      ...multiArgs,
      effect_type: "impact_review",
      source_guard: {
        kind: "sqlite_revision_v1",
        expected_connection_epoch: "5c469be0-51e3-4f31-95e0-9bf457806c56",
        expected_total_changes: "42",
        expected_data_version: "7",
      },
    };

    const env = await dispatchInvoke(
      "start_post_effect_run_multi",
      startArgs(guardedArgs),
      { backend, shell: noShell, secrets: secrets(null) },
    );

    expect(env.ok).toBe(true);
    expect(methods.startPostEffectRunMulti).toHaveBeenCalledWith(
      scopedNativeArgs(guardedArgs),
      expect.any(Object),
      null,
      null,
    );
  });

  it.each([
    ["missing", undefined, "impact_review"],
    ["null", null, "impact_review"],
    ["array", [], "impact_review"],
    [
      "wrong effect",
      {
        kind: "sqlite_revision_v1",
        expected_connection_epoch: "5c469be0-51e3-4f31-95e0-9bf457806c56",
        expected_total_changes: "1",
        expected_data_version: "1",
      },
      "timeline_consistency",
    ],
    [
      "wrong kind",
      {
        kind: "other",
        expected_connection_epoch: "5c469be0-51e3-4f31-95e0-9bf457806c56",
        expected_total_changes: "1",
        expected_data_version: "1",
      },
      "impact_review",
    ],
    [
      "missing epoch",
      {
        kind: "sqlite_revision_v1",
        expected_total_changes: "1",
        expected_data_version: "1",
      },
      "impact_review",
    ],
    [
      "number total",
      {
        kind: "sqlite_revision_v1",
        expected_connection_epoch: "5c469be0-51e3-4f31-95e0-9bf457806c56",
        expected_total_changes: 1,
        expected_data_version: "1",
      },
      "impact_review",
    ],
    [
      "leading zero",
      {
        kind: "sqlite_revision_v1",
        expected_connection_epoch: "5c469be0-51e3-4f31-95e0-9bf457806c56",
        expected_total_changes: "01",
        expected_data_version: "1",
      },
      "impact_review",
    ],
    [
      "u64 overflow",
      {
        kind: "sqlite_revision_v1",
        expected_connection_epoch: "5c469be0-51e3-4f31-95e0-9bf457806c56",
        expected_total_changes: "18446744073709551616",
        expected_data_version: "1",
      },
      "impact_review",
    ],
    [
      "extra key",
      {
        kind: "sqlite_revision_v1",
        expected_connection_epoch: "5c469be0-51e3-4f31-95e0-9bf457806c56",
        expected_total_changes: "1",
        expected_data_version: "1",
        extra: true,
      },
      "impact_review",
    ],
  ])(
    "source_guard の不正値を native 呼出し前に拒否する: %s",
    async (_name, sourceGuard, effectType) => {
      const { backend, methods, calls } = makeBackend();
      const keyStore = secrets(null);

      const env = await dispatchInvoke(
        "start_post_effect_run_multi",
        {
          expectedWorkspacePath,
          args: {
            ...multiArgs,
            effect_type: effectType,
            source_guard: sourceGuard,
          },
        },
        { backend, shell: noShell, secrets: keyStore },
      );

      expect(env.ok).toBe(false);
      expect(methods.startPostEffectRunMulti).not.toHaveBeenCalled();
      expect(
        calls.filter((call) => call.method === "getAiSettings"),
      ).toHaveLength(0);
      expect(keyStore.getApiKeyForRequest).not.toHaveBeenCalled();
    },
  );

  it("safeStorage lookup失敗はinvoke rejectにせずsecret snapshotへ保存してnativeに渡す", async () => {
    const { backend, calls, methods } = makeBackend();
    const lookupError = "保存済み API キーを復号できません";
    const keyStore = {
      resolveApiKeyForRequest: vi.fn(),
      getApiKeyForRequest: vi.fn(() => {
        throw new Error(lookupError);
      }),
    };

    const env = await dispatchInvoke(
      "start_post_effect_run",
      startArgs(singleArgs),
      { backend, shell: noShell, secrets: keyStore },
    );

    expect(env).toEqual({
      ok: true,
      value: { run_id: "r-single", from_cache: false },
    });
    expect(methods.startPostEffectRun).toHaveBeenCalledExactlyOnceWith(
      scopedNativeArgs(singleArgs),
      { provider: "openai", model: "gpt-x" },
      null,
      lookupError,
    );
    expect(
      calls.filter((call) => call.method === "getAiSettings"),
    ).toHaveLength(1);
  });

  it.each([
    ["start_post_effect_run", "consistency"],
    ["start_post_effect_run", "review"],
    ["start_post_effect_run", "intent_drift"],
    ["start_post_effect_run", "pseudo_comment"],
    ["start_post_effect_run_multi", "timeline_consistency"],
  ])(
    "%s の effect=%s は role provider/endpoint override でキーをlookupする",
    async (cmd, effectType) => {
      const { backend, methods } = makeBackend();
      const keyStore = secrets("sk-role");
      const baseArgs = cmd.endsWith("_multi") ? multiArgs : singleArgs;
      const args = {
        ...baseArgs,
        effect_type: effectType,
        provider_override: "openai-compatible",
        endpoint_id_override: "role-endpoint",
      };

      const env = await dispatchInvoke(cmd, startArgs(args), {
        backend,
        shell: noShell,
        secrets: keyStore,
      });

      expect(env.ok).toBe(true);
      expect(keyStore.getApiKeyForRequest).toHaveBeenCalledExactlyOnceWith(
        { provider: "openai", model: "gpt-x" },
        "openai-compatible",
        "role-endpoint",
      );
      const method = cmd.endsWith("_multi")
        ? methods.startPostEffectRunMulti
        : methods.startPostEffectRun;
      expect(method).toHaveBeenCalledExactlyOnceWith(
        scopedNativeArgs(args),
        { provider: "openai", model: "gpt-x" },
        "sk-role",
        null,
      );
    },
  );

  it("単発 impact_review は guard 必須の multi 経路へ寄せ、secret 解決前に拒否する", async () => {
    const { backend, methods, calls } = makeBackend();
    const keyStore = secrets("sk-role");

    const env = await dispatchInvoke(
      "start_post_effect_run",
      {
        expectedWorkspacePath,
        args: {
          ...singleArgs,
          effect_type: "impact_review",
          prompt_version: "impact_review_v1.1",
        },
      },
      { backend, shell: noShell, secrets: keyStore },
    );

    expect(env.ok).toBe(false);
    expect(methods.startPostEffectRun).not.toHaveBeenCalled();
    expect(
      calls.filter((call) => call.method === "getAiSettings"),
    ).toHaveLength(0);
    expect(keyStore.getApiKeyForRequest).not.toHaveBeenCalled();
  });

  it.each(["typo_detection", "intra_scene_consistency", "meta_structure"])(
    "effect=%s はrequestにoverrideがあってもdefault provider/endpointでキーをlookupする",
    async (effectType) => {
      const { backend, methods } = makeBackend();
      const keyStore = secrets("sk-default");
      const args = {
        ...singleArgs,
        effect_type: effectType,
        provider_override: "anthropic",
        endpoint_id_override: "must-be-ignored",
      };

      const env = await dispatchInvoke(
        "start_post_effect_run",
        startArgs(args),
        { backend, shell: noShell, secrets: keyStore },
      );

      expect(env.ok).toBe(true);
      expect(keyStore.getApiKeyForRequest).toHaveBeenCalledExactlyOnceWith(
        { provider: "openai", model: "gpt-x" },
        undefined,
        undefined,
      );
      expect(methods.startPostEffectRun).toHaveBeenCalledExactlyOnceWith(
        scopedNativeArgs(args),
        { provider: "openai", model: "gpt-x" },
        "sk-default",
        null,
      );
    },
  );

  it("abort_post_effect_run は runId/projectId をpositional引数へ写像しunitをnullで返す", async () => {
    const { backend, methods } = makeBackend();

    const env = await dispatchInvoke(
      "abort_post_effect_run",
      { runId: "r1", projectId: "p1" },
      { backend, shell: noShell },
    );

    expect(env).toEqual({ ok: true, value: null });
    expect(methods.abortPostEffectRun).toHaveBeenCalledExactlyOnceWith(
      "r1",
      "p1",
    );
  });

  it.each(["start_post_effect_run", "start_post_effect_run_multi"])(
    "%s は outer args の欠落・null・配列・文字列をbackend呼出し前に拒否する",
    async (cmd) => {
      for (const invokeArgs of [
        {},
        { args: null },
        { args: [] },
        { args: "not-an-object" },
      ]) {
        const { backend, methods } = makeBackend();
        const env = await dispatchInvoke(cmd, invokeArgs, {
          backend,
          shell: noShell,
          secrets: secrets(null),
        });

        expect(env.ok).toBe(false);
        if (!env.ok) {
          expect(env.error).toContain(
            `invalid args \`args\` for command \`${cmd}\``,
          );
        }
        expect(methods.startPostEffectRun).not.toHaveBeenCalled();
        expect(methods.startPostEffectRunMulti).not.toHaveBeenCalled();
      }
    },
  );

  it.each(["start_post_effect_run", "start_post_effect_run_multi"])(
    "%s は workspace path の欠落・不正値を設定/secret/native参照前に拒否する",
    async (cmd) => {
      for (const invokeArgs of [
        { args: singleArgs },
        { expectedWorkspacePath: null, args: singleArgs },
        { expectedWorkspacePath: "", args: singleArgs },
        { expectedWorkspacePath: 42, args: singleArgs },
      ]) {
        const { backend, methods, calls } = makeBackend();
        const keyStore = secrets(null);
        const env = await dispatchInvoke(cmd, invokeArgs, {
          backend,
          shell: noShell,
          secrets: keyStore,
        });

        expect(env.ok).toBe(false);
        if (!env.ok) {
          expect(env.error).toContain(
            `invalid args \`expectedWorkspacePath\` for command \`${cmd}\``,
          );
        }
        expect(
          calls.filter((call) => call.method === "getAiSettings"),
        ).toHaveLength(0);
        expect(keyStore.getApiKeyForRequest).not.toHaveBeenCalled();
        expect(methods.startPostEffectRun).not.toHaveBeenCalled();
        expect(methods.startPostEffectRunMulti).not.toHaveBeenCalled();
      }
    },
  );

  it.each([
    [{ projectId: "p1" }, "runId"],
    [{ runId: "r1" }, "projectId"],
    [{ runId: 42, projectId: "p1" }, "runId"],
    [{ runId: "r1", projectId: [] }, "projectId"],
  ])(
    "abort_post_effect_run は不正な $1 をbackend呼出し前に拒否する",
    async (invokeArgs, invalidKey) => {
      const { backend, methods } = makeBackend();
      const env = await dispatchInvoke("abort_post_effect_run", invokeArgs, {
        backend,
        shell: noShell,
      });

      expect(env.ok).toBe(false);
      if (!env.ok) {
        expect(env.error).toContain(
          `invalid args \`${invalidKey}\` for command \`abort_post_effect_run\``,
        );
      }
      expect(methods.abortPostEffectRun).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["start_post_effect_run", startArgs(singleArgs), "startPostEffectRun"],
    [
      "start_post_effect_run_multi",
      startArgs(multiArgs),
      "startPostEffectRunMulti",
    ],
    [
      "abort_post_effect_run",
      { runId: "r1", projectId: "p1" },
      "abortPostEffectRun",
    ],
  ])(
    "%s は旧native bindingでmethodが無ければ明示的なbackend unavailableを返す",
    async (cmd, invokeArgs, methodName) => {
      const { backend } = fakeBackend();
      const env = await dispatchInvoke(cmd, invokeArgs, {
        backend,
        shell: noShell,
        secrets: secrets(null),
      });

      expect(env).toMatchObject({
        ok: false,
        error: `${IPC_BACKEND_UNAVAILABLE_MARKER} native method ${methodName}`,
      });
    },
  );

  it.each(["start_post_effect_run", "start_post_effect_run_multi"])(
    "%s はsecrets未注入を明示エラーにする",
    async (cmd) => {
      const { backend, methods } = makeBackend();
      const invokeArgs = cmd.endsWith("_multi") ? multiArgs : singleArgs;
      const env = await dispatchInvoke(cmd, startArgs(invokeArgs), {
        backend,
        shell: noShell,
      });

      expect(env).toMatchObject({
        ok: false,
        error: `IPC_SECRETS_UNAVAILABLE: ${cmd}`,
      });
      expect(methods.startPostEffectRun).not.toHaveBeenCalled();
      expect(methods.startPostEffectRunMulti).not.toHaveBeenCalled();
    },
  );
});

describe("NIR-1 two-result command boundary", () => {
  const ownerKey = "related-scenes-owner:main-issued";
  const begin = {
    ownerKey,
    expectedWorkspacePath: "/workspace",
    projectId: "project",
    currentSceneId: "s2",
    query: "saved tail",
  };

  it("maps only validated begin fields and keeps operation ownership on follow-ups", async () => {
    const relatedScenesBegin = vi.fn().mockResolvedValue('{"status":"raw-ready"}');
    const relatedScenesContinue = vi.fn().mockResolvedValue('{"status":"available","scenes":[]}');
    const relatedScenesRelease = vi.fn().mockResolvedValue('{"status":"released"}');
    const nir1EvidenceQualify = vi.fn().mockResolvedValue('{"status":"unavailable","reason":"invalidated"}');
    const deps = { backend: { relatedScenesBegin, relatedScenesContinue, relatedScenesRelease, nir1EvidenceQualify } as unknown as NapiBackendLike, shell: {} };
    expect(await dispatchInvoke("related_scenes_begin", { ...begin, arbitraryDb: "/other" }, deps)).toMatchObject({ ok: true });
    expect(relatedScenesBegin).toHaveBeenCalledExactlyOnceWith(begin);
    await dispatchInvoke("related_scenes_continue", { ownerKey, operationTicket: "ticket", projectId: "cannot-rebind" }, deps);
    expect(relatedScenesContinue).toHaveBeenCalledExactlyOnceWith(ownerKey, "ticket");
    await dispatchInvoke("related_scenes_release", { ownerKey, operationTicket: "ticket" }, deps);
    expect(relatedScenesRelease).toHaveBeenCalledExactlyOnceWith(ownerKey, "ticket");
    await dispatchInvoke("nir1_evidence_qualify", { ownerKey, navigationIdentity: "handle", sceneId: "cannot-rebind" }, deps);
    expect(nir1EvidenceQualify).toHaveBeenCalledExactlyOnceWith(ownerKey, "handle");
  });

  it("rejects malformed begin bindings before Native execution", async () => {
    const relatedScenesBegin = vi.fn();
    const deps = { backend: { relatedScenesBegin } as unknown as NapiBackendLike, shell: {} };
    for (const invalid of [
      { ...begin, ownerKey: "" },
      { ...begin, expectedWorkspacePath: "" },
      { ...begin, projectId: "" },
      { ...begin, currentSceneId: "" },
      { ...begin, query: " " },
      { ...begin, query: "x".repeat(501) },
      { ...begin, query: 7 },
    ]) expect((await dispatchInvoke("related_scenes_begin", invalid, deps)).ok).toBe(false);
    expect(relatedScenesBegin).not.toHaveBeenCalled();
  });

  it("exposes explicit backend/version-skew errors, and never exposes owner release to renderer", async () => {
    for (const command of ["related_scenes_begin", "related_scenes_continue", "related_scenes_release", "nir1_evidence_qualify"]) {
      expect(await dispatchInvoke(command, begin, { backend: null, shell: {} })).toMatchObject({ ok: false, error: expect.stringContaining("IPC_BACKEND_UNAVAILABLE") });
      expect(await dispatchInvoke(command, begin, { backend: {} as NapiBackendLike, shell: {} })).toMatchObject({ ok: false });
    }
    expect(NAPI_COMMANDS).not.toHaveProperty("related_scenes_release_owner");
  });
});
