// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetIpcQueueForTests } from "@/lib/ipcQueue";
import { resolveModelCapabilities } from "./modelLimits";
import {
  __resetRegistryModelCapsForTests,
  getRegistryModelCaps,
  reloadRegistryModelCaps,
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

/** cache 由来の写し（設定が有効の間）と、同梱の写し（設定を無効にした後）。値が違う。 */
const CACHE_VIEW = {
  ...VIEW,
  origin: "cache",
  models: { "openai/gpt-6-astra": { contextWindow: 2_000_000 } },
};
const BUNDLED_VIEW = {
  ...VIEW,
  origin: "bundled",
  models: { "openai/gpt-6-astra": { contextWindow: 1_050_000 } },
};

describe("自動更新を切り替えた後の読み直し（reloadRegistryModelCaps）", () => {
  it("無効にした後：同梱の写しに差し替え、読み直したと知らせる（cache 由来の値を持ち続けない）", async () => {
    const invoke = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, value: CACHE_VIEW })
      .mockResolvedValueOnce({ ok: true, value: BUNDLED_VIEW });
    installBridge(invoke);
    await startRegistryModelCapsLoad();
    expect(resolveModelCapabilities("gpt-6-astra", OPENAI).contextWindow).toBe(
      2_000_000,
    );

    const onChanged = vi.fn();
    await expect(reloadRegistryModelCaps(onChanged)).resolves.toBe(true);

    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke).toHaveBeenLastCalledWith(
      "get_model_capability_snapshot",
      undefined,
    );
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(resolveModelCapabilities("gpt-6-astra", OPENAI).contextWindow).toBe(
      1_050_000,
    );
  });

  it("読み直しに失敗したら、古い写しを残さず層を消す（今の挙動のまま）", async () => {
    const invoke = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, value: CACHE_VIEW })
      .mockRejectedValueOnce(new Error("snapshot unavailable"));
    installBridge(invoke);
    await startRegistryModelCapsLoad();
    const onChanged = vi.fn();

    await expect(reloadRegistryModelCaps(onChanged)).resolves.toBe(true);

    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(getRegistryModelCaps("openai", "gpt-6-astra")).toBeNull();
    expect(resolveModelCapabilities("gpt-6-astra", OPENAI)).toMatchObject({
      contextWindow: 8_000,
      contextWindowSource: "default",
    });
  });

  it("最初の読み込みの途中で読み直しが始まったら、遅れて届いた古い結果は捨てる", async () => {
    let resolveFirst: (value: unknown) => void = () => undefined;
    const invoke = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockResolvedValueOnce({ ok: true, value: BUNDLED_VIEW });
    installBridge(invoke);
    const onLoaded = vi.fn();
    const first = startRegistryModelCapsLoad(onLoaded);
    // 最初の IPC の呼び出しが出るまで待つ（動的 import の後）。
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));

    await expect(reloadRegistryModelCaps()).resolves.toBe(true);
    expect(resolveModelCapabilities("gpt-6-astra", OPENAI).contextWindow).toBe(
      1_050_000,
    );

    // 古い cache 由来の結果が後から届いても、新しい状態を上書きしない。
    resolveFirst({ ok: true, value: CACHE_VIEW });
    await expect(first).resolves.toBe(false);
    expect(onLoaded).not.toHaveBeenCalled();
    expect(resolveModelCapabilities("gpt-6-astra", OPENAI).contextWindow).toBe(
      1_050_000,
    );
  });

  it("Web 版：何もしない（IPC を呼ばず、知らせない）", async () => {
    const onChanged = vi.fn();
    await expect(reloadRegistryModelCaps(onChanged)).resolves.toBe(false);
    expect(onChanged).not.toHaveBeenCalled();
  });
});
