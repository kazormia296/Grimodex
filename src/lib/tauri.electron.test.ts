// @vitest-environment happy-dom
/**
 * Electron 分岐（設計書 §3.4 / §5.2、Phase 2 S5）:
 * ① isTauri → isElectron → browser-mock のディスパッチ順
 * ② envelope 解封が**生文字列 reject**になること（Tauri ワイヤ契約）
 * ③ SLOW_COMMANDS のタイムアウト値選択が electron 分岐でも効くこと
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

describe("envelope 解封 = 生文字列 reject（Tauri ワイヤ契約 §5.2）", () => {
  it("ok:false は error 文字列そのものを reject 値にする（Error に包まない）", async () => {
    installBridge({
      invoke: vi
        .fn()
        .mockResolvedValue({ ok: false, error: "No workspace is open" }),
    });
    const { invoke } = await import("./tauri");
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
    expect(caught).toBe("No workspace is open");
    expect(typeof caught).toBe("string");
  });

  it("WORKSPACE_SWITCHING マーカーの部分一致判定（String(err)）が成立する", async () => {
    installBridge({
      invoke: vi.fn().mockResolvedValue({
        ok: false,
        error: "WORKSPACE_SWITCHING: workspace is being switched",
      }),
    });
    const { invoke } = await import("./tauri");
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
    expect(String(caught)).toContain("WORKSPACE_SWITCHING");
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

describe("SLOW_COMMANDS のタイムアウト選択（electron 分岐）", () => {
  it("通常コマンドは 10s でタイムアウトする", async () => {
    vi.useFakeTimers();
    installBridge({
      invoke: vi.fn().mockReturnValue(new Promise(() => {})),
    });
    const { invoke } = await import("./tauri");
    const promise = invoke("hanging_command");
    const expectation = expect(promise).rejects.toThrow(
      /IPC timeout after 10000ms/,
    );
    await vi.advanceTimersByTimeAsync(11_000);
    await expectation;
  });

  it("SLOW_COMMANDS（open_workspace）は 10s では落ちず 300s で落ちる", async () => {
    vi.useFakeTimers();
    installBridge({
      invoke: vi.fn().mockReturnValue(new Promise(() => {})),
    });
    const { invoke } = await import("./tauri");

    let settled = false;
    const promise = invoke("open_workspace", { path: "/tmp/ws" });
    promise.catch(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(11_000);
    expect(settled).toBe(false);

    const expectation = expect(promise).rejects.toThrow(
      /IPC timeout after 300000ms/,
    );
    await vi.advanceTimersByTimeAsync(290_000);
    await expectation;
    expect(settled).toBe(true);
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
