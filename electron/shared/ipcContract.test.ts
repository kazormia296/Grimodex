/**
 * ipcContract の純関数部の単体テスト（設計書 §8 S4:
 * allowlist / envelope / 引数アダプタ）。node 環境（vitest.electron.config.ts）。
 */
import { describe, expect, it, vi } from "vitest";

import {
  clampZoomFactor,
  DISABLED_LICENSE_STATE,
  dispatchInvoke,
  EVENT_CHANNEL_ALLOWLIST,
  IPC_BACKEND_UNAVAILABLE_MARKER,
  IPC_UNIMPLEMENTED_MARKER,
  isAllowedEventChannel,
  isSafeExternalUrl,
  NAPI_COMMANDS,
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
    openWorkspace: record(
      "openWorkspace",
      Promise.resolve('{"name":"ws","isExisting":true}'),
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
    onEvent: record("onEvent", undefined) as never,
    ...overrides,
  };
  return { backend, calls };
}

const noShell = Object.freeze({});

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
    const env = await dispatchInvoke("lint_text", {}, { backend, shell: noShell });
    expect(env).toEqual({ ok: false, error: "IPC_UNIMPLEMENTED: lint_text" });
    expect(unimplementedError("lint_text").startsWith(IPC_UNIMPLEMENTED_MARKER)).toBe(
      true,
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
    expect(env).toEqual({ ok: false, error: "No workspace is open" });
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
    expect(env).toEqual({ ok: false, error: "WORKSPACE_SWITCHING" });
  });

  it("shell ハンドラが napi 表より優先される", async () => {
    const { backend, calls } = fakeBackend();
    const shell = {
      get_license_state: vi.fn(() => Promise.resolve({ ...DISABLED_LICENSE_STATE })),
    };
    const env = await dispatchInvoke("get_license_state", {}, { backend, shell });
    expect(env).toEqual({
      ok: true,
      value: {
        licensingEnabled: false,
        status: "disabled",
        trialDaysRemaining: null,
        graceDaysRemaining: null,
        keyTail: null,
        activatedAt: null,
        lastValidatedAt: null,
      },
    });
    expect(calls).toHaveLength(0);
  });

  it("プロトタイプ経由のコマンド名（constructor 等）は未実装扱い", async () => {
    const { backend } = fakeBackend();
    for (const cmd of ["constructor", "toString", "hasOwnProperty"]) {
      const env = await dispatchInvoke(cmd, {}, { backend, shell: noShell });
      expect(env).toEqual({ ok: false, error: `IPC_UNIMPLEMENTED: ${cmd}` });
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
    expect(calls).toEqual([{ method: "dbExecute", args: ["SELECT ?", [1], "all"] }]);
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

  it("open_workspace: {path} → openWorkspace(path)", async () => {
    const { backend, calls } = fakeBackend();
    const env = await dispatchInvoke(
      "open_workspace",
      { path: "/tmp/ws" },
      { backend, shell: noShell },
    );
    expect(calls).toEqual([{ method: "openWorkspace", args: ["/tmp/ws"] }]);
    expect(env).toEqual({ ok: true, value: { name: "ws", isExisting: true } });
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

  it("必須キー欠落は invalid args エラー envelope（backend は呼ばれない）", async () => {
    const { backend, calls } = fakeBackend();
    const env = await dispatchInvoke(
      "open_workspace",
      {},
      { backend, shell: noShell },
    );
    expect(env.ok).toBe(false);
    if (!env.ok) {
      expect(env.error).toContain("invalid args `path` for command `open_workspace`");
    }
    expect(calls).toHaveLength(0);
  });

  it("垂直スライス 7 コマンドが揃っている（§4.3）", () => {
    expect(Object.keys(NAPI_COMMANDS).sort()).toEqual([
      "db_execute",
      "db_execute_batch",
      "get_global_settings",
      "open_workspace",
      "save_global_settings",
      "timelapse_append_batch",
      "validate_workspace_path",
    ]);
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
