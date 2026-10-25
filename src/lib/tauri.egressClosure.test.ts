// @vitest-environment happy-dom
/**
 * DA-2b の PUB-G 前の必須 3（DR-DA2B-R22）：`invoke` の先頭の局所の拒否。定数が true で
 * 閉鎖の状態が閉なら、Main の拒否の台帳の command を IPC に出さず、Main と同じ文の
 * typed な error で拒否する。定数が false なら閉でも今のまま IPC に出す。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  globalThis.__grimodexProfileEgressLocalRefusal = undefined;
  vi.doUnmock("@/features/profile-egress/profileActivationAvailability");
});

describe("invoke の手前の局所の拒否（定数 true）", () => {
  it("閉なら台帳の command を IPC に出さず、Main と同じ文で拒否する", async () => {
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
    await expect(invoke("list_ai_models")).rejects.toThrow(
      /^D2A_EGRESS_DENIED: old-external-ai: route list_ai_models /,
    );
    expect(bridge.invoke).not.toHaveBeenCalled();
  });

  it("閉でも停止と台帳の外の command は IPC に出す", async () => {
    const bridge = installBridge();
    const { invoke, markProfileEgressClosed } = await load(true);
    markProfileEgressClosed();

    await expect(invoke("abort_inline_ai_stream")).resolves.toBe("from-main");
    await expect(invoke("get_profile_egress_status")).resolves.toBe(
      "from-main",
    );
    expect(bridge.invoke).toHaveBeenCalledTimes(2);
  });

  it("開なら台帳の command も IPC に出す", async () => {
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
