// @vitest-environment happy-dom
/**
 * Electron 分岐（設計書 §3.4 / §5.2、Phase 2 S5）:
 * ① isTauri → isElectron → browser-mock のディスパッチ順
 * ② envelope 解封が typed error になりつつ旧文字列表示を保つこと
 * ③ read-only allowlist だけに caller timeout が適用されること
 * ④ listen / emit のブリッジ写像
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

type AnyWindow = Record<string, unknown>;

function bridgeMock(overrides: Record<string, unknown> = {}) {
  return {
    shell: "electron",
    invoke: vi.fn().mockResolvedValue({ ok: true, value: null }),
    listen: vi.fn().mockReturnValue(() => {}),
    emit: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function installBridge(overrides: Record<string, unknown> = {}) {
  const bridge = bridgeMock(overrides);
  (window as unknown as AnyWindow).grimodex = bridge;
  return bridge;
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  delete (window as unknown as AnyWindow).__TAURI_INTERNALS__;
  delete (window as unknown as AnyWindow).grimodex;
  vi.useRealTimers();
});

describe("isElectron", () => {
  it("window.grimodex が在れば true / 無ければ false", async () => {
    const { isElectron } = await import("./tauri");
    expect(isElectron()).toBe(false);
    installBridge();
    expect(isElectron()).toBe(true);
  });
});

describe("invoke のディスパッチ順（isTauri → isElectron → browser-mock）", () => {
  it("両方在るときは Tauri が勝つ", async () => {
    (window as unknown as AnyWindow).__TAURI_INTERNALS__ = {};
    const bridge = installBridge();

    const tauriInvoke = vi.fn().mockResolvedValue("tauri-result");
    vi.doMock("@tauri-apps/api/core", () => ({ invoke: tauriInvoke }));

    const { invoke } = await import("./tauri");
    await expect(invoke("some_command")).resolves.toBe("tauri-result");
    expect(tauriInvoke).toHaveBeenCalledOnce();
    expect(bridge.invoke).not.toHaveBeenCalled();
  });

  it("grimodex のみ在るときは bridge.invoke に行く（browser-mock に落ちない）", async () => {
    const bridge = installBridge({
      invoke: vi.fn().mockResolvedValue({ ok: true, value: "bridge-result" }),
    });
    const { invoke } = await import("./tauri");
    await expect(invoke("some_command", { key: "v" })).resolves.toBe(
      "bridge-result",
    );
    expect(bridge.invoke).toHaveBeenCalledWith("some_command", { key: "v" });
  });

  it("どちらも無ければ従来どおり browser-mock", async () => {
    const { invoke } = await import("./tauri");
    await expect(invoke("get_global_settings")).resolves.toBeDefined();
  });
});

describe("envelope 解封 = typed error + legacy wire compatibility", () => {
  it("legacy error 文字列を code 付き IpcInvokeError に正規化する", async () => {
    installBridge({
      invoke: vi
        .fn()
        .mockResolvedValue({ ok: false, error: "No workspace is open" }),
    });
    const { invoke, IpcInvokeError } = await import("./tauri");
    let caught: unknown = null;
    try {
      await invoke("db_execute", {
        sql: "SELECT 1",
        params: [],
        method: "all",
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(IpcInvokeError);
    expect(caught).toMatchObject({
      code: "NO_WORKSPACE_OPEN",
      message: "No workspace is open",
      retryable: true,
      outcome: "failed",
    });
    // Existing String(error).includes(...) checks keep seeing the raw message.
    expect(String(caught)).toBe("No workspace is open");
  });

  it("WORKSPACE_SWITCHING マーカーの部分一致判定（String(err)）が成立する", async () => {
    installBridge({
      invoke: vi.fn().mockResolvedValue({
        ok: false,
        error: "WORKSPACE_SWITCHING: workspace is being switched",
      }),
    });
    const { invoke, IpcInvokeError } = await import("./tauri");
    let caught: unknown = null;
    try {
      await invoke("db_execute", {
        sql: "SELECT 1",
        params: [],
        method: "all",
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(IpcInvokeError);
    expect(caught).toMatchObject({
      code: "WORKSPACE_SWITCHING",
      retryable: true,
      outcome: "failed",
    });
    expect(String(caught)).toContain("WORKSPACE_SWITCHING");
  });

  it("RERANKER_BUSYをretryableなtyped errorへ正規化する", async () => {
    installBridge({
      invoke: vi.fn().mockResolvedValue({
        ok: false,
        error: "RERANKER_BUSY: semantic reranker lane is occupied",
      }),
    });
    const { invoke, IpcInvokeError } = await import("./tauri");

    await expect(
      invoke("semantic_reranker_shadow_score", {
        requestId: "request-1",
      }),
    ).rejects.toMatchObject({
      name: IpcInvokeError.name,
      code: "RERANKER_BUSY",
      retryable: true,
      outcome: "failed",
    });
  });

  it("errorInfo があれば legacy error 文字列の推測より優先する", async () => {
    installBridge({
      invoke: vi.fn().mockResolvedValue({
        ok: false,
        error: "legacy transport message",
        errorInfo: {
          code: "WORKSPACE_SWITCHING",
          message: "workspace transition in progress",
          retryable: true,
          outcome: "failed",
        },
      }),
    });
    const { invoke } = await import("./tauri");

    await expect(invoke("db_execute")).rejects.toMatchObject({
      name: "IpcInvokeError",
      code: "WORKSPACE_SWITCHING",
      message: "legacy transport message",
      retryable: true,
      outcome: "failed",
    });
  });

  it("errorValue があれば object をそのまま reject 値にする（lint_text の LintError 契約）", async () => {
    installBridge({
      invoke: vi.fn().mockResolvedValue({
        ok: false,
        error: '{"type":"InvalidLanguage","data":"fr"}',
        errorValue: { type: "InvalidLanguage", data: "fr" },
      }),
    });
    const { invoke } = await import("./tauri");
    let caught: unknown = null;
    try {
      await invoke("lint_text", {
        blocks: [],
        language: "fr",
        scope: "paragraph",
        config: {},
      });
    } catch (e) {
      caught = e;
    }
    // formatLintError（lintStore.ts）の {type, data} 分岐がそのまま成立する形
    expect(caught).toEqual({ type: "InvalidLanguage", data: "fr" });
  });

  it("ok:true は value をそのまま resolve する", async () => {
    installBridge({
      invoke: vi
        .fn()
        .mockResolvedValue({ ok: true, value: { rows: [["こんにちは"]] } }),
    });
    const { invoke } = await import("./tauri");
    await expect(invoke("db_execute")).resolves.toEqual({
      rows: [["こんにちは"]],
    });
  });
});

describe("caller timeout policy（electron 分岐）", () => {
  it("明示された通常 read-only コマンドは 10s でタイムアウトする", async () => {
    vi.useFakeTimers();
    installBridge({
      invoke: vi.fn().mockReturnValue(new Promise(() => {})),
    });
    const { invoke } = await import("./tauri");
    const promise = invoke("validate_workspace_path", { path: "/tmp/ws" });
    const caught = promise.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(11_000);
    await expect(caught).resolves.toMatchObject({
      name: "IpcInvokeError",
      code: "IPC_TIMEOUT",
      retryable: false,
      outcome: "unknown",
      command: "validate_workspace_path",
      details: { timeoutMs: 10_000 },
    });
  });

  it.each(["foreshadow_load_anchors_for_scene", "list_annotations_for_scene"])(
    "%s は Editor sidecar read lane の10s枠を使う",
    async (command) => {
      vi.useFakeTimers();
      installBridge({
        invoke: vi.fn().mockReturnValue(new Promise(() => {})),
      });
      const { invoke } = await import("./tauri");
      const caught = invoke(command).catch((error: unknown) => error);

      await vi.advanceTimersByTimeAsync(11_000);
      await expect(caught).resolves.toMatchObject({
        name: "IpcInvokeError",
        code: "IPC_TIMEOUT",
        command,
        details: { timeoutMs: 10_000 },
      });
    },
  );

  it.each([
    ["SELECT * FROM projects", "all"],
    ["WITH current AS (SELECT 1 AS id) SELECT * FROM current", "all"],
    ["SELECT '/* UPDATE scenes */' AS harmless_marker", "get"],
  ])(
    "read-only db_execute (%s) は read lane の10s枠を使う",
    async (sql, method) => {
      vi.useFakeTimers();
      installBridge({
        invoke: vi.fn().mockReturnValue(new Promise(() => {})),
      });
      const { invoke } = await import("./tauri");
      const caught = invoke("db_execute", {
        sql,
        params: [],
        method,
      }).catch((error: unknown) => error);

      await vi.advanceTimersByTimeAsync(11_000);
      await expect(caught).resolves.toMatchObject({
        name: "IpcInvokeError",
        code: "IPC_TIMEOUT",
        command: "db_execute",
        details: { timeoutMs: 10_000 },
      });
    },
  );

  it("lifecycle quiescence cancels an active read caller with a retryable typed error", async () => {
    let resolveBridge!: (value: { ok: true; value: null }) => void;
    installBridge({
      invoke: vi.fn().mockReturnValue(
        new Promise<{ ok: true; value: null }>((resolve) => {
          resolveBridge = resolve;
        }),
      ),
    });
    const [
      { invoke, isIpcLifecycleCancellation },
      { flushQuiescenceProviderStage },
    ] = await Promise.all([import("./tauri"), import("./quiescenceProviders")]);
    const read = invoke("db_execute", {
      sql: "SELECT * FROM projects",
      params: [],
      method: "all",
    });

    await Promise.resolve();
    await flushQuiescenceProviderStage("ipc-actual-tasks");
    const cancellation = await read.catch((error: unknown) => error);
    expect(cancellation).toMatchObject({
      name: "IpcInvokeError",
      code: "IPC_READ_CANCELLED",
      retryable: true,
      outcome: "failed",
    });
    expect(isIpcLifecycleCancellation(cancellation)).toBe(true);
    const wrappedCancellation = new Error("query adapter failed");
    Object.defineProperty(wrappedCancellation, "cause", {
      value: cancellation,
    });
    expect(isIpcLifecycleCancellation(wrappedCancellation)).toBe(true);
    const queryAdapterCancellation = new Error("query adapter failed");
    Object.defineProperty(queryAdapterCancellation, "cause", {
      value: {
        name: "IpcInvokeError",
        code: "IPC_READ_CANCELLED",
        retryable: true,
        outcome: "failed",
      },
    });
    expect(isIpcLifecycleCancellation(queryAdapterCancellation)).toBe(true);
    expect(isIpcLifecycleCancellation(new Error("ordinary failure"))).toBe(
      false,
    );

    resolveBridge({ ok: true, value: null });
    await Promise.resolve();
  });

  it("a failed update check in flight does not veto document quiescence", async () => {
    let rejectBridge!: (error: Error) => void;
    installBridge({
      invoke: vi.fn().mockReturnValue(
        new Promise((_resolve, reject) => {
          rejectBridge = reject;
        }),
      ),
    });
    const [{ invoke }, { flushQuiescenceProviderStage }] = await Promise.all([
      import("./tauri"),
      import("./quiescenceProviders"),
    ]);
    const checkOutcome = invoke("updater_check").catch(
      (error: unknown) => error,
    );
    await Promise.resolve();

    const quiescence = flushQuiescenceProviderStage("ipc-actual-tasks");
    rejectBridge(
      new Error("Electron updater is unavailable in development builds"),
    );

    await expect(quiescence).resolves.toBeUndefined();
    await expect(checkOutcome).resolves.toMatchObject({
      name: "IpcInvokeError",
      code: "IPC_READ_CANCELLED",
    });
  });

  it.each(["updater_download", "updater_install"])(
    "%s failure still vetoes document quiescence",
    async (command) => {
      let rejectBridge!: (error: Error) => void;
      installBridge({
        invoke: vi.fn().mockReturnValue(
          new Promise((_resolve, reject) => {
            rejectBridge = reject;
          }),
        ),
      });
      const [{ invoke }, { flushQuiescenceProviderStage }] = await Promise.all([
        import("./tauri"),
        import("./quiescenceProviders"),
      ]);
      const updateOutcome = invoke(command).catch((error: unknown) => error);
      await Promise.resolve();

      const quiescence = flushQuiescenceProviderStage("ipc-actual-tasks");
      rejectBridge(new Error("update operation failed"));

      await expect(quiescence).rejects.toMatchObject({
        name: "QuiescenceProviderStageError",
      });
      await expect(updateOutcome).resolves.toMatchObject({
        name: "IpcInvokeError",
      });
    },
  );

  it.each([
    "fts_search",
    "nir1_evidence_qualify",
    "nir1_entity_relation_revision_read",
    "nir1_entity_relation_revision_read_current",
    "nir1_entity_relation_revision_restore",
  ])(
    "%s は lifecycle quiescence を保持せず read caller を cancel する",
    async (command) => {
      let resolveBridge!: (value: { ok: true; value: null }) => void;
      installBridge({
        invoke: vi.fn().mockReturnValue(
          new Promise<{ ok: true; value: null }>((resolve) => {
            resolveBridge = resolve;
          }),
        ),
      });
      const [{ invoke }, { flushQuiescenceProviderStage }] = await Promise.all([
        import("./tauri"),
        import("./quiescenceProviders"),
      ]);
      const readResult = invoke(command).catch((error: unknown) => error);

      await Promise.resolve();
      await expect(
        flushQuiescenceProviderStage("ipc-actual-tasks"),
      ).resolves.toBeUndefined();
      await expect(readResult).resolves.toMatchObject({
        name: "IpcInvokeError",
        code: "IPC_READ_CANCELLED",
        command,
        retryable: true,
        outcome: "failed",
      });

      resolveBridge({ ok: true, value: null });
      await Promise.resolve();
    },
  );

  it("semantic derived index は実処理を継続しても strict quiescence を保持しない", async () => {
    let resolveBridge!: (value: { ok: true; value: number }) => void;
    installBridge({
      invoke: vi.fn().mockReturnValue(
        new Promise<{ ok: true; value: number }>((resolve) => {
          resolveBridge = resolve;
        }),
      ),
    });
    const [{ invoke }, { flushQuiescenceProviderStage }] = await Promise.all([
      import("./tauri"),
      import("./quiescenceProviders"),
    ]);
    const derived = invoke<number>("semantic_reindex_all", {
      projectId: "project-1",
    });

    await Promise.resolve();
    await expect(
      flushQuiescenceProviderStage("ipc-actual-tasks"),
    ).resolves.toBeUndefined();

    resolveBridge({ ok: true, value: 42 });
    await expect(derived).resolves.toBe(42);
  });

  it.each(["semantic_reindex_all", "related_scenes_continue"])(
    "%s は lifecycle quiescence を保持せず derived caller を cancel する",
    async (command) => {
      let resolveBridge!: (value: { ok: true; value: number }) => void;
      installBridge({
        invoke: vi.fn().mockReturnValue(
          new Promise<{ ok: true; value: number }>((resolve) => {
            resolveBridge = resolve;
          }),
        ),
      });
      const [
        { invoke },
        { cancelDerivedIpcCallersForLifecycle },
        { flushQuiescenceProviderStage },
      ] = await Promise.all([
        import("./tauri"),
        import("./ipcQueue"),
        import("./quiescenceProviders"),
      ]);
      const derived = invoke<number>(command, { projectId: "project-1" });
      await Promise.resolve();

      await expect(
        flushQuiescenceProviderStage("ipc-actual-tasks"),
      ).resolves.toBeUndefined();
      cancelDerivedIpcCallersForLifecycle();
      await expect(derived).rejects.toMatchObject({
        name: "IpcInvokeError",
        code: "IPC_DERIVED_CANCELLED",
        command,
        retryable: true,
        outcome: "failed",
      });

      resolveBridge({ ok: true, value: 0 });
      await Promise.resolve();
    },
  );

  it("cancel 後に完了した related_scenes_begin の ticket を一度だけ release する", async () => {
    let resolveBegin!: (value: {
      ok: true;
      value: {
        status: "raw-ready";
        denseHits: [];
        snapshot: {
          queryBinding: string;
          originalSnapshotUsable: true;
          supportedProfile: true;
        };
        ir: { status: "pending"; operationTicket: string };
      };
    }) => void;
    const beginResult = new Promise<Parameters<typeof resolveBegin>[0]>(
      (resolve) => {
        resolveBegin = resolve;
      },
    );
    const bridge = installBridge({
      invoke: vi.fn((command: string) => {
        if (command === "related_scenes_begin") return beginResult;
        if (command === "related_scenes_release") {
          return Promise.resolve({
            ok: true as const,
            value: { status: "released" as const },
          });
        }
        throw new Error(`Unexpected command: ${command}`);
      }),
    });
    const [
      { invoke },
      { cancelDerivedIpcCallersForLifecycle },
      { flushQuiescenceProviderStage },
    ] = await Promise.all([
      import("./tauri"),
      import("./ipcQueue"),
      import("./quiescenceProviders"),
    ]);
    const callerResult = invoke("related_scenes_begin", {
      expectedWorkspacePath: "/workspace",
      projectId: "project-1",
      currentSceneId: "scene-1",
      query: "saved prose",
    }).catch((error: unknown) => error);
    await Promise.resolve();

    await expect(
      flushQuiescenceProviderStage("ipc-actual-tasks"),
    ).resolves.toBeUndefined();
    cancelDerivedIpcCallersForLifecycle();
    await expect(callerResult).resolves.toMatchObject({
      name: "IpcInvokeError",
      code: "IPC_DERIVED_CANCELLED",
      command: "related_scenes_begin",
      retryable: true,
      outcome: "failed",
    });

    resolveBegin({
      ok: true,
      value: {
        status: "raw-ready",
        denseHits: [],
        snapshot: {
          queryBinding: "query-1",
          originalSnapshotUsable: true,
          supportedProfile: true,
        },
        ir: { status: "pending", operationTicket: "ticket-late" },
      },
    });
    await vi.waitFor(() => expect(bridge.invoke).toHaveBeenCalledTimes(2));
    await expect(
      flushQuiescenceProviderStage("ipc-actual-tasks"),
    ).resolves.toBeUndefined();
    expect(bridge.invoke.mock.calls).toEqual([
      [
        "related_scenes_begin",
        {
          expectedWorkspacePath: "/workspace",
          projectId: "project-1",
          currentSceneId: "scene-1",
          query: "saved prose",
        },
      ],
      ["related_scenes_release", { operationTicket: "ticket-late" }],
    ]);
  });

  it("begin result と同じ turn に cancel しても late ticket を一度だけ release する", async () => {
    let resolveBegin!: (value: {
      ok: true;
      value: {
        ir: { status: "pending"; operationTicket: string };
      };
    }) => void;
    const beginResult = new Promise<Parameters<typeof resolveBegin>[0]>(
      (resolve) => {
        resolveBegin = resolve;
      },
    );
    const bridge = installBridge({
      invoke: vi.fn((command: string) =>
        command === "related_scenes_begin"
          ? beginResult
          : Promise.resolve({ ok: true, value: { status: "released" } }),
      ),
    });
    const [{ invoke }, { cancelDerivedIpcCallersForLifecycle }] =
      await Promise.all([import("./tauri"), import("./ipcQueue")]);
    const callerResult = invoke("related_scenes_begin").catch(
      (error: unknown) => error,
    );
    await Promise.resolve();

    resolveBegin({
      ok: true,
      value: { ir: { status: "pending", operationTicket: "ticket-race" } },
    });
    queueMicrotask(cancelDerivedIpcCallersForLifecycle);

    await expect(callerResult).resolves.toMatchObject({
      code: "IPC_DERIVED_CANCELLED",
    });
    await vi.waitFor(() => expect(bridge.invoke).toHaveBeenCalledTimes(2));
    expect(bridge.invoke.mock.calls[1]).toEqual([
      "related_scenes_release",
      { operationTicket: "ticket-race" },
    ]);
  });

  it.each([
    ["null response", null],
    ["array response", []],
    ["missing ir", { status: "raw-ready" }],
    ["non-pending ir", { ir: { status: "unavailable" } }],
    ["blank ticket", { ir: { status: "pending", operationTicket: "  " } }],
  ])("cancel 後の %s は release しない", async (_label, value) => {
    let resolveBegin!: (value: { ok: true; value: unknown }) => void;
    const beginResult = new Promise<Parameters<typeof resolveBegin>[0]>(
      (resolve) => {
        resolveBegin = resolve;
      },
    );
    const bridge = installBridge({
      invoke: vi.fn(() => beginResult),
    });
    const [{ invoke }, { cancelDerivedIpcCallersForLifecycle }] =
      await Promise.all([import("./tauri"), import("./ipcQueue")]);
    const callerResult = invoke("related_scenes_begin").catch(
      (error: unknown) => error,
    );
    await Promise.resolve();

    cancelDerivedIpcCallersForLifecycle();
    await expect(callerResult).resolves.toMatchObject({
      code: "IPC_DERIVED_CANCELLED",
    });
    resolveBegin({ ok: true, value });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(bridge.invoke).toHaveBeenCalledOnce();
  });

  it("late ticket の release failure を処理済み rejection として記録する", async () => {
    let resolveBegin!: (value: {
      ok: true;
      value: { ir: { status: "pending"; operationTicket: string } };
    }) => void;
    const beginResult = new Promise<Parameters<typeof resolveBegin>[0]>(
      (resolve) => {
        resolveBegin = resolve;
      },
    );
    const bridge = installBridge({
      invoke: vi.fn((command: string) =>
        command === "related_scenes_begin"
          ? beginResult
          : Promise.resolve({ ok: false, error: "release failed" }),
      ),
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const [{ invoke }, { cancelDerivedIpcCallersForLifecycle }] =
      await Promise.all([import("./tauri"), import("./ipcQueue")]);
    const callerResult = invoke("related_scenes_begin").catch(
      (error: unknown) => error,
    );
    await Promise.resolve();

    cancelDerivedIpcCallersForLifecycle();
    await expect(callerResult).resolves.toMatchObject({
      code: "IPC_DERIVED_CANCELLED",
    });
    resolveBegin({
      ok: true,
      value: { ir: { status: "pending", operationTicket: "ticket-fails" } },
    });

    await vi.waitFor(() => expect(warn).toHaveBeenCalledOnce());
    expect(bridge.invoke.mock.calls[1]).toEqual([
      "related_scenes_release",
      { operationTicket: "ticket-fails" },
    ]);
    warn.mockRestore();
  });

  it("related_scenes_release は実処理が完了するまで lifecycle quiescence を保持する", async () => {
    let resolveBridge!: (value: { ok: true; value: null }) => void;
    installBridge({
      invoke: vi.fn().mockReturnValue(
        new Promise<{ ok: true; value: null }>((resolve) => {
          resolveBridge = resolve;
        }),
      ),
    });
    const [{ invoke }, { flushQuiescenceProviderStage }] = await Promise.all([
      import("./tauri"),
      import("./quiescenceProviders"),
    ]);
    const release = invoke("related_scenes_release", {
      operationTicket: "ticket-1",
    });
    await Promise.resolve();

    let flushSettled = false;
    const flush = flushQuiescenceProviderStage("ipc-actual-tasks").then(() => {
      flushSettled = true;
    });
    await Promise.resolve();
    expect(flushSettled).toBe(false);

    resolveBridge({ ok: true, value: null });
    await expect(release).resolves.toBeNull();
    await expect(flush).resolves.toBeUndefined();
  });

  it.each([
    ["open_workspace", { path: "/tmp/ws" }, 301_000],
    [
      "db_execute",
      { sql: "UPDATE scenes SET title = ?", params: ["x"], method: "run" },
      11_000,
    ],
    [
      "db_execute",
      {
        sql: "INSERT INTO scenes (id) VALUES (?) RETURNING id",
        params: ["scene-1"],
        method: "all",
      },
      11_000,
    ],
    [
      "db_execute",
      {
        sql: "WITH marker(v) AS (SELECT '/*') UPDATE scenes SET title = '*/' WHERE id = ? RETURNING id",
        params: ["scene-1"],
        method: "all",
      },
      11_000,
    ],
    ["events_index_entry", { eventId: "event-1" }, 301_000],
    ["activate_license", { key: "GRIM-KEY-1234" }, 301_000],
    ["unknown_mutating_command", undefined, 11_000],
  ] as const)(
    "%s は旧 caller timeout を超えても実処理の結果を待つ",
    async (command, args, elapsedMs) => {
      vi.useFakeTimers();
      let resolveBridge!: (envelope: { ok: true; value: string }) => void;
      const bridgeResult = new Promise<{ ok: true; value: string }>(
        (resolve) => {
          resolveBridge = resolve;
        },
      );
      installBridge({
        invoke: vi.fn().mockReturnValue(bridgeResult),
      });
      const { invoke } = await import("./tauri");

      let settled = false;
      const promise = invoke<string>(command, args);
      void promise.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );

      await vi.advanceTimersByTimeAsync(elapsedMs);
      expect(settled).toBe(false);

      resolveBridge({ ok: true, value: "late success" });
      await expect(promise).resolves.toBe("late success");
    },
  );

  it.each([
    "semantic_search",
    "codex_semantic_search",
    "events_semantic_search",
    "chat_message_search",
  ])("%s は read-only semantic 検索用の300s枠を使う", async (command) => {
    vi.useFakeTimers();
    installBridge({
      invoke: vi.fn().mockReturnValue(new Promise(() => {})),
    });
    const { invoke } = await import("./tauri");

    let settled = false;
    const promise = invoke(command);
    void promise.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await vi.advanceTimersByTimeAsync(11_000);
    expect(settled).toBe(false);

    const expectation = expect(promise).rejects.toThrow(
      /IPC timeout after 300000ms/,
    );
    await vi.advanceTimersByTimeAsync(290_000);
    await expectation;
  });

  it("detect_cli_binary は read-only 探索用の300s枠を使う", async () => {
    vi.useFakeTimers();
    installBridge({
      invoke: vi.fn().mockReturnValue(new Promise(() => {})),
    });
    const { invoke } = await import("./tauri");

    let settled = false;
    const promise = invoke("detect_cli_binary", { cli: "claude" });
    void promise.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    await vi.advanceTimersByTimeAsync(11_000);
    expect(settled).toBe(false);
    const expectation = expect(promise).rejects.toThrow(
      /IPC timeout after 300000ms/,
    );
    await vi.advanceTimersByTimeAsync(290_000);
    await expectation;
  });
});

describe("local chat capture wrappers", () => {
  it("dispatches exact capture and cancellation commands with typed receipts", async () => {
    const submission = {
      submissionId: "submission-1",
      messageId: "message-1",
      chatSessionId: "session-1",
      sceneId: "scene-1",
      content: "exact local user input",
      createdAt: "2026-09-28T10:00:00.000Z",
    };
    const cancelSubmission = {
      submissionId: submission.submissionId,
      messageId: submission.messageId,
      chatSessionId: submission.chatSessionId,
      sceneId: submission.sceneId,
    };
    const bridge = installBridge({
      invoke: vi.fn(async (command: string) => ({
        ok: true,
        value:
          command === "capture_current_chat_input"
            ? {
                status: "accepted",
                projectId: "project-1",
                chatSessionId: submission.chatSessionId,
                sceneId: submission.sceneId,
                messageId: submission.messageId,
              }
            : command === "cancel_current_chat_input"
              ? {
                  status: "cancelled",
                  submissionId: submission.submissionId,
                  messageId: submission.messageId,
                }
              : { status: "retired", chatSessionId: submission.chatSessionId },
      })),
    });
    const {
      captureCurrentChatInput,
      cancelCurrentChatInput,
      retireCurrentChatInput,
    } = await import("./tauri");

    await expect(captureCurrentChatInput(submission)).resolves.toEqual({
      status: "accepted",
      projectId: "project-1",
      chatSessionId: submission.chatSessionId,
      sceneId: submission.sceneId,
      messageId: submission.messageId,
    });
    await expect(cancelCurrentChatInput(cancelSubmission)).resolves.toEqual({
      status: "cancelled",
      submissionId: submission.submissionId,
      messageId: submission.messageId,
    });
    await expect(
      retireCurrentChatInput(submission.chatSessionId),
    ).resolves.toEqual({
      status: "retired",
      chatSessionId: submission.chatSessionId,
    });
    expect(bridge.invoke).toHaveBeenNthCalledWith(
      1,
      "capture_current_chat_input",
      {
        submission,
      },
    );
    expect(bridge.invoke).toHaveBeenNthCalledWith(
      2,
      "cancel_current_chat_input",
      {
        submission: cancelSubmission,
      },
    );
    expect(bridge.invoke).toHaveBeenNthCalledWith(
      3,
      "retire_current_chat_input",
      { chatSessionId: submission.chatSessionId },
    );
  });
});

describe("listen / emit の electron 分岐", () => {
  it("listen は bridge.listen へ写像し、payload をそのまま handler に渡す", async () => {
    const unlistenSpy = vi.fn();
    const capturedCbs: Array<(payload: unknown) => void> = [];
    installBridge({
      listen: vi.fn((_ch: string, cb: (payload: unknown) => void) => {
        capturedCbs.push(cb);
        return unlistenSpy;
      }),
    });
    const { listen } = await import("./tauri");

    const received: unknown[] = [];
    const unlisten = await listen<{ chunk: string }>(
      "chat:stream-chunk",
      (p) => {
        received.push(p);
      },
    );

    expect(capturedCbs).toHaveLength(1);
    capturedCbs[0]({ chunk: "断章" });
    expect(received).toEqual([{ chunk: "断章" }]);

    unlisten();
    expect(unlistenSpy).toHaveBeenCalledOnce();
  });

  it("emit は bridge.emit へ写像する", async () => {
    const bridge = installBridge();
    const { emit } = await import("./tauri");
    await emit("codex:data-changed", { projectId: "p1" });
    expect(bridge.emit).toHaveBeenCalledWith("codex:data-changed", {
      projectId: "p1",
    });
  });

  it("Tauri 窓では listen/emit は bridge に触れない（分岐順）", async () => {
    (window as unknown as AnyWindow).__TAURI_INTERNALS__ = {};
    const bridge = installBridge();
    const tauriListen = vi.fn().mockResolvedValue(() => {});
    const tauriEmit = vi.fn().mockResolvedValue(undefined);
    vi.doMock("@tauri-apps/api/event", () => ({
      listen: tauriListen,
      emit: tauriEmit,
    }));

    const { listen, emit } = await import("./tauri");
    await listen("chat:stream-chunk", () => {});
    await emit("codex:data-changed", {});
    expect(tauriListen).toHaveBeenCalledOnce();
    expect(tauriEmit).toHaveBeenCalledOnce();
    expect(bridge.listen).not.toHaveBeenCalled();
    expect(bridge.emit).not.toHaveBeenCalled();
  });
});
