// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetIpcQueueForTests } from "@/lib/ipcQueue";
import { resolveModelCapabilities } from "./modelLimits";
import {
  __resetRegistryModelCapsForTests,
  getRegistryModelCaps,
  startRegistryModelCapsLoad,
} from "./registryModelCaps";

/**
 * PR-C3：写しは renderer が 1 回だけ読む（読み取り専用の typed IPC `get_model_capability_snapshot`）。
 * 読めなかったとき・Web 版のときは、registry の層が無い扱い（今の挙動のまま）。通知の event は無い。
 */

const VIEW = {
  origin: "bundled",
  source: "grimodex",
  generatedAt: "2026-11-18T15:28:51Z",
  models: {
    "openai/gpt-6-astra": {
      contextWindow: 1_050_000,
      maxOutputTokens: 128_000,
      toolCall: true,
      reasoning: true,
    },
  },
};

function installBridge(invoke: ReturnType<typeof vi.fn>): void {
  (window as unknown as Record<string, unknown>).grimodex = {
    shell: "electron",
    invoke,
  };
}

const OPENAI = { provider: "openai" };

beforeEach(() => {
  resetIpcQueueForTests();
  __resetRegistryModelCapsForTests();
});

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).grimodex;
});

describe("registry の写しの読み込み（startRegistryModelCapsLoad）", () => {
  it("Electron：読み取り専用の IPC を引数なしで 1 回だけ呼び、保持して、読めたと 1 回だけ知らせる", async () => {
    const invoke = vi.fn().mockResolvedValue({ ok: true, value: VIEW });
    installBridge(invoke);
    const onLoaded = vi.fn();
    const before = resolveModelCapabilities("gpt-6-astra", OPENAI);

    await expect(startRegistryModelCapsLoad(onLoaded)).resolves.toBe(true);

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith(
      "get_model_capability_snapshot",
      undefined,
    );
    expect(onLoaded).toHaveBeenCalledTimes(1);
    expect(getRegistryModelCaps("openai", "gpt-6-astra")).toEqual({
      contextWindow: 1_050_000,
      maxOutputTokens: 128_000,
      toolCall: true,
    });
    const after = resolveModelCapabilities("gpt-6-astra", OPENAI);
    expect(after.contextWindow).toBe(1_050_000);
    expect(after).not.toEqual(before);

    // 2 回目以降は読み直さず、知らせも出さない（single-flight）。
    const onLoadedAgain = vi.fn();
    await expect(startRegistryModelCapsLoad(onLoadedAgain)).resolves.toBe(true);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(onLoadedAgain).not.toHaveBeenCalled();
  });

  it("同時に始めても IPC は 1 回（同じ promise）", async () => {
    const invoke = vi.fn().mockResolvedValue({ ok: true, value: VIEW });
    installBridge(invoke);
    const [a, b] = await Promise.all([
      startRegistryModelCapsLoad(),
      startRegistryModelCapsLoad(),
    ]);
    expect([a, b]).toEqual([true, true]);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("IPC が失敗したら、層が無い扱い（reject せず、知らせず、今の値のまま、読み直さない）", async () => {
    const invoke = vi.fn().mockRejectedValue(new Error("snapshot unavailable"));
    installBridge(invoke);
    const onLoaded = vi.fn();
    const before = resolveModelCapabilities("gpt-6-astra", OPENAI);

    await expect(startRegistryModelCapsLoad(onLoaded)).resolves.toBe(false);

    expect(onLoaded).not.toHaveBeenCalled();
    expect(getRegistryModelCaps("openai", "gpt-6-astra")).toBeNull();
    expect(resolveModelCapabilities("gpt-6-astra", OPENAI)).toEqual(before);
    await startRegistryModelCapsLoad(onLoaded);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("main が契約の形でない値を返したら、層が無い扱い", async () => {
    installBridge(
      vi.fn().mockResolvedValue({ ok: true, value: { ...VIEW, extra: 1 } }),
    );
    const onLoaded = vi.fn();
    await expect(startRegistryModelCapsLoad(onLoaded)).resolves.toBe(false);
    expect(onLoaded).not.toHaveBeenCalled();
    expect(getRegistryModelCaps("openai", "gpt-6-astra")).toBeNull();
  });

  it("Web 版（Electron でない）：IPC を呼ばず、層が無い扱い", async () => {
    const onLoaded = vi.fn();
    const before = resolveModelCapabilities("gpt-6-astra", OPENAI);
    await expect(startRegistryModelCapsLoad(onLoaded)).resolves.toBe(false);
    expect(onLoaded).not.toHaveBeenCalled();
    expect(resolveModelCapabilities("gpt-6-astra", OPENAI)).toEqual(before);
  });
});
