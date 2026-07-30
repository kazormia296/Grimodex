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
    saveSceneBodyBundle: record(
      "saveSceneBodyBundle",
      Promise.resolve(
        '{"placedBeatPreview":null,"unplacedBeatPreview":null,"contentVersion":2,"contentUpdatedAt":"2026-07-28T00:00:00.000Z","dbTransactionCount":1}',
      ),
    ) as never,
    vacuumDatabase: record(
      "vacuumDatabase",
      Promise.resolve(undefined),
    ) as never,
    openWorkspace: record(
      "openWorkspace",
      Promise.resolve(
        '{"name":"ws","isExisting":true,"workspaceId":"workspace-id"}',
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
    // trash_bin 5 コマンド（napi は SELECT * の生行 = snake_case 列名を返す）
    trashBinCreate: record(
      "trashBinCreate",
      Promise.resolve('{"id":"t1","preview_text":"消した文字屑"}'),
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
      Promise.resolve(undefined),
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
      Promise.resolve(undefined),
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
      Promise.resolve('{"id":"f1","title":"改名"}'),
    ) as never,
    foreshadowDelete: record(
      "foreshadowDelete",
      Promise.resolve(undefined),
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
      Promise.resolve(undefined),
    ) as never,
    foreshadowGet: record(
      "foreshadowGet",
      Promise.resolve('{"foreshadow":{"id":"f1"},"setups":[]}'),
    ) as never,
    foreshadowLinkCodex: record(
      "foreshadowLinkCodex",
      Promise.resolve(undefined),
    ) as never,
    foreshadowUnlinkCodex: record(
      "foreshadowUnlinkCodex",
      Promise.resolve(undefined),
    ) as never,
    foreshadowListLinkedCodex: record(
      "foreshadowListLinkedCodex",
      Promise.resolve('[{"id":"c1","name":"太郎"}]'),
    ) as never,
    foreshadowSetSetupStrength: record(
      "foreshadowSetSetupStrength",
      Promise.resolve(undefined),
    ) as never,
    foreshadowSetupCreateAi: record(
      "foreshadowSetupCreateAi",
      Promise.resolve(undefined),
    ) as never,
    foreshadowResolveOrphan: record(
      "foreshadowResolveOrphan",
      Promise.resolve('"new-setup-id"'),
    ) as never,
    foreshadowSaveAnchorsForScene: record(
      "foreshadowSaveAnchorsForScene",
      Promise.resolve(undefined),
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
    agentWriteBundle: record("agentWriteBundle", AGENT_WRITE_RESULT) as never,
    agentSnippetCreate: record(
      "agentSnippetCreate",
      AGENT_WRITE_RESULT,
    ) as never,
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
    agentChronicleBulkMutate: record(
      "agentChronicleBulkMutate",
      CHRONICLE_BULK_RESULT,
    ) as never,
    agentEventSetParticipants: record(
      "agentEventSetParticipants",
      AGENT_WRITE_RESULT,
    ) as never,
    agentSceneEventLink: record(
      "agentSceneEventLink",
      AGENT_WRITE_RESULT,
    ) as never,
    agentSceneEventUnlink: record(
      "agentSceneEventUnlink",
      AGENT_WRITE_RESULT,
    ) as never,
    agentEventRelationAdd: record(
      "agentEventRelationAdd",
      AGENT_WRITE_RESULT,
    ) as never,
    agentEventRelationRemove: record(
      "agentEventRelationRemove",
      AGENT_WRITE_RESULT,
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
    abortChatStream: record("abortChatStream", undefined) as never,
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

  it("CLI AI 5コマンドはbackend不在でもmain shell handlerへ委譲される", async () => {
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
    expect(sent).toEqual({ ok: true, value: null });
    expect(calls).toEqual([
      { command: "detect_cli_binary", args: { cli: "claude" } },
      {
        command: "send_cli_chat_stream",
        args: { payload: { cli: "claude", prompt: "hi" } },
      },
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
      ]),
    );
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
      { projectId: "project-1" },
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
    const { backend } = fakeBackend({
      eventGetVersion: eventGetVersion as never,
      eventSetParticipants: eventSetParticipants as never,
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

  it("renderer aggregate writes は typed payload を native へ明示写像する", async () => {
    const authorshipReplaceLane = vi.fn().mockResolvedValue(undefined);
    const entityTagsSet = vi.fn().mockResolvedValue(undefined);
    const codexRenameUndo = vi.fn().mockResolvedValue(undefined);
    const scanStagingProjectCreate = vi.fn().mockResolvedValue(undefined);
    const treePlanUndo = vi.fn().mockResolvedValue(undefined);
    const mapWriteBundle = vi.fn().mockResolvedValue(undefined);
    const { backend } = fakeBackend({
      authorshipReplaceLane: authorshipReplaceLane as never,
      entityTagsSet: entityTagsSet as never,
      codexRenameUndo: codexRenameUndo as never,
      scanStagingProjectCreate: scanStagingProjectCreate as never,
      treePlanUndo: treePlanUndo as never,
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
            entityKind: "codex",
            entityId: "codex-1",
            tagIds: ["tag-1"],
            updatedAt: "now",
          },
        },
        entityTagsSet,
      ],
      [
        "codex_rename_undo",
        {
          payload: {
            projectId: "project-1",
            updatedAt: "now",
            updates: [
              {
                kind: "node-title",
                refId: "scene-1",
                detailDefinitionId: null,
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
        "tree_plan_undo",
        {
          payload: {
            projectId: "project-1",
            beforeStates: [
              {
                id: "scene-1",
                parentId: null,
                sortOrder: "a0",
                title: "Scene",
              },
            ],
            createdIds: ["folder-1"],
            updatedAt: "now",
          },
        },
        treePlanUndo,
      ],
      [
        "map_write_bundle",
        {
          payload: {
            kind: "erase-ai-branch",
            projectId: "project-1",
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
      ).resolves.toEqual({ ok: true, value: null });
      expect(method).toHaveBeenCalledExactlyOnceWith(args.payload);
    }
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
      "scan_staging_project_create",
      "tree_plan_undo",
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
                : command === "map_write_bundle"
                  ? {
                      payload: {
                        kind: "erase-ai-branch",
                        projectId: "project-1",
                        branchId: "branch-1",
                        spanIds: [],
                        stickyPositionIds: [],
                        stickyIds: [],
                      },
                    }
                  : {
                      payload: {
                        projectId: "project-1",
                        beforeStates: [],
                        createdIds: [],
                        updatedAt: "now",
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
        liveTreeNodeIds: [],
        liveCodexTagIds: [],
      }),
    );
    const projectSnapshotApplyRestore = vi.fn().mockResolvedValue(undefined);
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
    expect(applied).toEqual({ ok: true, value: null });
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

  it("save_scene_body_bundle: typed snapshot を1 payloadで渡して結果をparseする", async () => {
    const { backend, calls } = fakeBackend();
    const payload = {
      sceneId: "s1",
      projectId: "p1",
      includeSidecars: true,
      contentJson: '{"type":"doc"}',
      charCount: 3,
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
      },
    });
  });

  it("save_scene_body_bundle: malformed arrays are rejected before native", async () => {
    const { backend, calls } = fakeBackend();
    const env = await dispatchInvoke(
      "save_scene_body_bundle",
      {
        payload: {
          sceneId: "s1",
          projectId: "p1",
          includeSidecars: true,
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
          includeSidecars: true,
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
        name: "ws",
        isExisting: true,
        workspaceId: "workspace-id",
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
      "agent_scene_event_unlink",
      "agent_snippet_create",
      "agent_write_bundle",
      "authorship_replace_lane",
      "chat_index_message",
      "chat_index_status",
      "chat_message_search",
      "chat_reindex_all",
      "codex_index_entry",
      "codex_index_status",
      "codex_match_text",
      "codex_rebuild_matcher",
      "codex_reindex_all",
      "codex_rename_undo",
      "codex_semantic_search",
      "db_execute",
      "db_execute_batch",
      "deactivate_license",
      "entity_tags_set",
      "event_get_version",
      "event_set_participants",
      "events_index_entry",
      "events_index_status",
      "events_reindex_all",
      "events_semantic_search",
      "extract_codex_candidates",
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
      "list_scene_lens_for_project",
      "list_system_fonts",
      "map_write_bundle",
      "open_workspace",
      "plot_thread_branch_create",
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
      "project_snapshot_apply_restore",
      "project_snapshot_create",
      "project_snapshot_restore_context",
      "repair_integrity",
      "reply_to_annotation",
      "restore_backup",
      "revalidate_license",
      "save_ai_settings",
      "save_global_settings",
      "save_post_effect_annotations",
      "save_scene_body_bundle",
      "scan_staging_project_create",
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
      "start_post_effect_run",
      "start_post_effect_run_multi",
      "test_ai_connection",
      "timelapse_append_batch",
      "trash_bin_clear_all",
      "trash_bin_create",
      "trash_bin_delete",
      "trash_bin_list",
      "trash_bin_prune",
      "tree_plan_undo",
      "update_annotation_status",
      "vacuum_database",
      "validate_workspace_path",
    ]);
  });

  describe("Semantic reranker shadow score command", () => {
    const args = {
      requestId: "request-1",
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

      const env = await dispatchInvoke(
        "semantic_reranker_shadow_score",
        args,
        { backend, shell: noShell },
      );

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
    const { backend } = fakeBackend();
    const check = await dispatchInvoke(
      "integrity_check",
      {},
      { backend, shell: noShell },
    );
    expect(check).toEqual({ ok: true, value: { orphans: 0 } });
    const repair = await dispatchInvoke(
      "repair_integrity",
      {},
      { backend, shell: noShell },
    );
    expect(repair).toEqual({ ok: true, value: { repaired: 0 } });
  });

  // plot_threads 8 コマンド（Phase 3 バッチ1）。payload / patch は素通し、
  // id / projectId はスカラ写像、unit 返りは null、生行/配列は parse して返す。
  it("plot_thread_create: {payload} 素通し、生行 snake_case を parse して返す", async () => {
    const { backend, calls } = fakeBackend();
    const payload = {
      projectId: "p1",
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
    const patch = { name: "改名", description: null };
    const upd = await dispatchInvoke(
      "plot_thread_update",
      { id: "pt1", patch },
      { backend, shell: noShell },
    );
    const linkPatch = { threadId: "pt2" };
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

  it("plot_thread_delete / link_delete: unit 返りは null（Tauri ワイヤ同形）", async () => {
    const { backend, calls } = fakeBackend();
    const del = await dispatchInvoke(
      "plot_thread_delete",
      { id: "pt1" },
      { backend, shell: noShell },
    );
    const linkDel = await dispatchInvoke(
      "plot_thread_link_delete",
      { id: "pl1" },
      { backend, shell: noShell },
    );
    expect(calls).toEqual([
      { method: "plotThreadDelete", args: ["pt1"] },
      { method: "plotThreadLinkDelete", args: ["pl1"] },
    ]);
    expect(del).toEqual({ ok: true, value: null });
    expect(linkDel).toEqual({ ok: true, value: null });
  });

  it("plot_thread_link_create: {payload} 素通し、作成行を parse して返す", async () => {
    const { backend, calls } = fakeBackend();
    const payload = {
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
      id: "pb1",
      projectId: "p1",
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
      projectId: "p1",
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
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
    };
    const markerAfter = {
      ...markerBefore,
      threadId: "pt2",
      nodeId: "s2",
      updatedAt: "2026-01-03T00:00:00.000Z",
    };
    const branchAfter = {
      id: "pb1",
      projectId: "p1",
      fromThreadId: "pt1",
      toThreadId: "pt2",
      atNodeId: "s2",
      kind: "branch",
      createdAt: "2026-01-03T00:00:00.000Z",
      updatedAt: "2026-01-03T00:00:00.000Z",
    };
    const payload = {
      requestId: "move-1",
      projectId: "p1",
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
      requestId: "restore-1",
      projectId: "p1",
      thread: {
        id: "pt1",
        projectId: "p1",
        name: "thread",
        color: null,
        description: null,
        sortOrder: "a0",
        startNodeId: null,
        endNodeId: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-02T00:00:00.000Z",
      },
      links: [],
      branches: [],
    };
    const deletePayload = {
      requestId: "delete-1",
      projectId: "p1",
      link: {
        id: "link-1",
        threadId: "pt1",
        nodeId: "scene-1",
        phaseType: "turn",
        note: "marker",
        sortOrder: "a0",
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
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
    };
    const invalidRestorePayloads = [
      null,
      {},
      {
        requestId: "restore",
        projectId: "p1",
        thread: { ...validThread, id: "" },
        links: [],
        branches: [],
      },
      {
        requestId: "restore",
        projectId: "p1",
        thread: { ...validThread, createdAt: "" },
        links: [],
        branches: [],
      },
      {
        requestId: "restore",
        projectId: "p1",
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
            requestId: "delete",
            projectId: "p1",
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
          requestId: "restore",
          projectId: "p1",
          thread: null,
          links: [
            {
              id: "link",
              threadId: "thread",
              nodeId: "scene",
              phaseType: "turn",
              note: null,
              sortOrder: null,
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
          requestId: "delete",
          projectId: "p1",
          link: {
            id: "link",
            threadId: "thread",
            nodeId: "scene",
            phaseType: "turn",
            note: null,
            sortOrder: null,
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

  // ── foreshadow 20 コマンド（Phase 3 バッチ1） ──────────────────────────
  it("foreshadow_create / update / delete: payload・id+patch 写像、unit→null", async () => {
    const { backend, calls } = fakeBackend();
    const payload = {
      id: "foreshadow-request-1",
      projectId: "p1",
      title: "伏線",
      intent: null,
    };
    const created = await dispatchInvoke(
      "foreshadow_create",
      { payload },
      { backend, shell: noShell },
    );
    const patch = { title: "改名", intent: null };
    const updated = await dispatchInvoke(
      "foreshadow_update",
      { id: "f1", patch },
      { backend, shell: noShell },
    );
    const deleted = await dispatchInvoke(
      "foreshadow_delete",
      { id: "f1" },
      { backend, shell: noShell },
    );
    expect(calls).toEqual([
      { method: "foreshadowCreate", args: [payload] },
      { method: "foreshadowUpdate", args: ["f1", patch] },
      { method: "foreshadowDelete", args: ["f1"] },
    ]);
    expect(created).toEqual({
      ok: true,
      value: { id: "f1", project_id: "p1", title: "伏線" },
    });
    expect(updated).toEqual({ ok: true, value: { id: "f1", title: "改名" } });
    expect(deleted).toEqual({ ok: true, value: null });
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
    const link = await dispatchInvoke(
      "foreshadow_link_codex",
      { foreshadowId: "f1", codexId: "c1" },
      { backend, shell: noShell },
    );
    await dispatchInvoke(
      "foreshadow_unlink_codex",
      { foreshadowId: "f1", codexId: "c1" },
      { backend, shell: noShell },
    );
    expect(calls).toEqual([
      { method: "foreshadowLinkCodex", args: ["f1", "c1"] },
      { method: "foreshadowUnlinkCodex", args: ["f1", "c1"] },
    ]);
    expect(link).toEqual({ ok: true, value: null });
  });

  it("foreshadow_set_setup_strength: 文字列は Some、null / 省略は None(undefined)", async () => {
    const { backend, calls } = fakeBackend();
    await dispatchInvoke(
      "foreshadow_set_setup_strength",
      { setupId: "su1", strength: "critical" },
      { backend, shell: noShell },
    );
    await dispatchInvoke(
      "foreshadow_set_setup_strength",
      { setupId: "su1", strength: null },
      { backend, shell: noShell },
    );
    await dispatchInvoke(
      "foreshadow_set_setup_strength",
      { setupId: "su1" },
      { backend, shell: noShell },
    );
    expect(calls).toEqual([
      { method: "foreshadowSetSetupStrength", args: ["su1", "critical"] },
      { method: "foreshadowSetSetupStrength", args: ["su1", undefined] },
      { method: "foreshadowSetSetupStrength", args: ["su1", undefined] },
    ]);
  });

  it("foreshadow_setup_create_ai: 12 個の flat 引数オブジェクトをそのまま渡す", async () => {
    const { backend, calls } = fakeBackend();
    const args = {
      id: "su1",
      foreshadowId: "f1",
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
    expect(env).toEqual({ ok: true, value: null });
  });

  it("foreshadow_resolve_orphan: {payload} を写像し Option<String> を parse（reinsert の new_id）", async () => {
    const { backend, calls } = fakeBackend();
    const payload = { setupId: "su1", action: "reinsert" };
    const env = await dispatchInvoke(
      "foreshadow_resolve_orphan",
      { payload },
      { backend, shell: noShell },
    );
    expect(calls).toEqual([
      { method: "foreshadowResolveOrphan", args: [payload] },
    ]);
    expect(env).toEqual({ ok: true, value: "new-setup-id" });
  });

  it("foreshadow_save_anchors_for_scene: sceneId+setups+payoffs+docContentSize(number) を写像", async () => {
    const { backend, calls } = fakeBackend();
    const setups = [
      { id: "su1", foreshadowId: "f1", sceneId: "s1", fromPos: 1, toPos: 5 },
    ];
    const payoffs: unknown[] = [];
    const env = await dispatchInvoke(
      "foreshadow_save_anchors_for_scene",
      { sceneId: "s1", setups, payoffs, docContentSize: 2 },
      { backend, shell: noShell },
    );
    expect(calls).toEqual([
      {
        method: "foreshadowSaveAnchorsForScene",
        args: ["s1", setups, payoffs, 2],
      },
    ]);
    expect(env).toEqual({ ok: true, value: null });
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

  // ── agent_writes 19 コマンド（Phase 3 バッチ1） ────────────────────────
  it("agent_writes: すべて単一 {payload} を素通しし AgentWriteResult を parse", async () => {
    const { backend, calls } = fakeBackend();
    const payload = {
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
          payload: {
            projectId: "p1",
            sessionId: "s1",
            journalId: "journal-1",
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

  it("send_chat_message_stream はキーを注入し null を resolve する", async () => {
    const { backend, calls } = fakeBackend();
    const secrets = fakeSecrets("sk-stream");
    const args = {
      messages: [{ role: "user", content: "yo" }],
      endpointId: "ep2",
      requestMaxOutputTokens: 32_000,
      expectedOllamaEndpoint: "http://127.0.0.1:11434",
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

  it("abort_chat_stream は backend.abortChatStream を呼び null を返す（secrets 不要）", async () => {
    const { backend, calls } = fakeBackend();
    const env = await dispatchInvoke(
      "abort_chat_stream",
      {},
      { backend, shell: noShell },
    );
    expect(env).toEqual({ ok: true, value: null });
    expect(calls).toContainEqual({ method: "abortChatStream", args: [] });
  });

  it("secrets 未注入のチャット送信は IPC_SECRETS_UNAVAILABLE で reject する", async () => {
    const { backend } = fakeBackend();
    const env = await dispatchInvoke(
      "send_chat_message",
      { messages: [] },
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
      { messages: [], provider: "anthropic" },
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
      abortInlineAiStream: vi.fn(),
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
      {},
      { backend, shell: noShell },
    );
    expect(env).toEqual({ ok: true, value: null });
    expect(methods.abortInlineAiStream).toHaveBeenCalledOnce();
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
      { provider: "openai", messages: [], tools: [], model: "m" },
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
      { args: singleArgs },
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
      singleArgs,
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
      { args: multiArgs },
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
      multiArgs,
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
      { args: guardedArgs },
      { backend, shell: noShell, secrets: secrets(null) },
    );

    expect(env.ok).toBe(true);
    expect(methods.startPostEffectRunMulti).toHaveBeenCalledWith(
      guardedArgs,
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
      { args: singleArgs },
      { backend, shell: noShell, secrets: keyStore },
    );

    expect(env).toEqual({
      ok: true,
      value: { run_id: "r-single", from_cache: false },
    });
    expect(methods.startPostEffectRun).toHaveBeenCalledExactlyOnceWith(
      singleArgs,
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

      const env = await dispatchInvoke(
        cmd,
        { args },
        { backend, shell: noShell, secrets: keyStore },
      );

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
        args,
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
        { args },
        { backend, shell: noShell, secrets: keyStore },
      );

      expect(env.ok).toBe(true);
      expect(keyStore.getApiKeyForRequest).toHaveBeenCalledExactlyOnceWith(
        { provider: "openai", model: "gpt-x" },
        undefined,
        undefined,
      );
      expect(methods.startPostEffectRun).toHaveBeenCalledExactlyOnceWith(
        args,
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
    ["start_post_effect_run", { args: singleArgs }, "startPostEffectRun"],
    [
      "start_post_effect_run_multi",
      { args: multiArgs },
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
      const env = await dispatchInvoke(
        cmd,
        { args: invokeArgs },
        { backend, shell: noShell },
      );

      expect(env).toMatchObject({
        ok: false,
        error: `IPC_SECRETS_UNAVAILABLE: ${cmd}`,
      });
      expect(methods.startPostEffectRun).not.toHaveBeenCalled();
      expect(methods.startPostEffectRunMulti).not.toHaveBeenCalled();
    },
  );
});
