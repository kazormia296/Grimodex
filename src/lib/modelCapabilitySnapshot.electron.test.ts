// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetIpcQueueForTests } from "@/lib/ipcQueue";
import { getModelCapabilitySnapshot } from "./modelCapabilitySnapshot";

const GOOD = {
  origin: "bundled",
  source: "grimodex",
  generatedAt: "2026-11-18T15:28:51Z",
  models: {
    "openai/gpt-a": {
      contextWindow: 128_000,
      maxOutputTokens: 16_384,
      toolCall: true,
      reasoning: false,
    },
  },
};

function installBridge(invoke: ReturnType<typeof vi.fn>): void {
  (window as unknown as Record<string, unknown>).grimodex = {
    shell: "electron",
    invoke,
  };
}

beforeEach(() => {
  resetIpcQueueForTests();
});

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).grimodex;
});

describe("getModelCapabilitySnapshot（読み取り専用の typed IPC の wrapper）", () => {
  it("get_model_capability_snapshot を引数なしで 1 回だけ呼び、検証済みの写しを返す", async () => {
    const invoke = vi.fn().mockResolvedValue({ ok: true, value: GOOD });
    installBridge(invoke);
    await expect(getModelCapabilitySnapshot()).resolves.toEqual(GOOD);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith(
      "get_model_capability_snapshot",
      undefined,
    );
  });

  it("契約の形でない値は null（壊れた値を能力表へ入れない）", async () => {
    installBridge(
      vi.fn().mockResolvedValue({ ok: true, value: { ...GOOD, extra: 1 } }),
    );
    await expect(getModelCapabilitySnapshot()).resolves.toBeNull();
  });

  it("main が使える写しが無いと報告したら reject する（呼び出し側が自前の表へ落ちる）", async () => {
    installBridge(
      vi.fn().mockResolvedValue({
        ok: false,
        error: "MODEL_CAPABILITY_SNAPSHOT_UNAVAILABLE",
      }),
    );
    await expect(getModelCapabilitySnapshot()).rejects.toThrow();
  });

  it("Electron 以外では IPC を呼ばず null", async () => {
    await expect(getModelCapabilitySnapshot()).resolves.toBeNull();
  });
});
