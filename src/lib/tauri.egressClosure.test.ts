// @vitest-environment happy-dom
/**
 * DA-2b の PUB-G 前の必須 3（DR-DA2B-R22）：`invoke` の先頭の局所の拒否。定数が true で
 * 閉鎖の状態が閉なら、Main の拒否の台帳の command を IPC に出さず、Main と同じ文の
 * typed な error で拒否する。定数が false なら閉でも今のまま IPC に出す。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { d2aRouteLedgersForTest } from "../../electron/main/profileEgress";

type AnyWindow = Record<string, unknown>;

function installBridge() {
  const bridge = {
    shell: "electron",
    invoke: vi.fn().mockResolvedValue({ ok: true, value: "from-main" }),
    listen: vi.fn().mockReturnValue(() => {}),
    emit: vi.fn().mockResolvedValue(undefined),
  };
  (window as unknown as AnyWindow).grimodex = bridge;
  return bridge;
}

async function load(enabled: boolean) {
  vi.doMock("@/features/profile-egress/profileActivationAvailability", () => ({
    PROFILE_ACTIVATION_UI_ENABLED: enabled,
  }));
  // The real writer (the status display's lazy chunk calls it).
  const { closeProfileEgressEntrances: markProfileEgressClosed } =
    await import("@/features/chat/closeProfileEgressEntrances");
  const tauri = await import("./tauri");
  return { markProfileEgressClosed, ...tauri };
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  delete (window as unknown as AnyWindow).grimodex;
  vi.doUnmock("@/features/profile-egress/profileActivationAvailability");
});

// 閉は一方向（global は戻せない property。DR-DA2B-R27）なので、開を確かめる試験を先に
// 置く（vitest は file ごとに global を分ける）。

describe("開のとき（定数 true）", () => {
  it("台帳の command も IPC に出す", async () => {
    const bridge = installBridge();
    const { invoke } = await load(true);

    await expect(invoke("send_inline_ai_stream")).resolves.toBe("from-main");
    expect(bridge.invoke).toHaveBeenCalledOnce();
  });
});

describe("定数が false の間（今の製品）", () => {
  it("閉の状態でも今のまま IPC に出す", async () => {
    const bridge = installBridge();
    const { invoke, markProfileEgressClosed } = await load(false);
    markProfileEgressClosed();

    await expect(invoke("send_inline_ai_stream")).resolves.toBe("from-main");
    expect(bridge.invoke).toHaveBeenCalledOnce();
  });
});

describe("閉のとき（定数 true）", () => {
  it("台帳の command を IPC に出さず、Main と同じ文で拒否する", async () => {
    const bridge = installBridge();
    const {
      invoke,
      markProfileEgressClosed,
      IpcInvokeError,
      isD2aEgressDenied,
    } = await load(true);
    markProfileEgressClosed();

    const error = await invoke("send_inline_ai_stream", { request: {} }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(IpcInvokeError);
    expect((error as Error).message).toBe(
      "D2A_EGRESS_DENIED: old-local-ai: route send_inline_ai_stream is unavailable in profile local-only mode",
    );
    expect((error as InstanceType<typeof IpcInvokeError>).command).toBe(
      "send_inline_ai_stream",
    );
    expect((error as InstanceType<typeof IpcInvokeError>).code).toBe("UNKNOWN");
    expect(isD2aEgressDenied(error)).toBe(true);
    for (const command of d2aRouteLedgersForTest().denied) {
      await expect(invoke(command), command).rejects.toThrow(
        new RegExp(`^D2A_EGRESS_DENIED: [a-z-]+: route ${command} `),
      );
    }
    expect(bridge.invoke).not.toHaveBeenCalled();
  });

  it("停止と own-data-read の command は全部 IPC に出す", async () => {
    const bridge = installBridge();
    const { invoke, markProfileEgressClosed } = await load(true);
    markProfileEgressClosed();

    const passed = [
      ...d2aRouteLedgersForTest().stop,
      ...d2aRouteLedgersForTest().ownDataRead,
      "get_profile_egress_status",
    ];
    for (const command of passed) {
      await expect(invoke(command), command).resolves.toBe("from-main");
    }
    expect(bridge.invoke.mock.calls.map(([command]) => command)).toEqual(
      passed,
    );
  });
});
