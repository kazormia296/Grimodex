// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// listen / invoke の型と mock を hoist
const { mockListen, mockInvoke, mockDirtyTabIds } = vi.hoisted(() => ({
  mockListen: vi.fn(),
  mockInvoke: vi.fn(),
  mockDirtyTabIds: new Set<string>(),
}));

vi.mock("@/lib/tauri", () => ({
  listen: mockListen,
  invoke: mockInvoke,
}));

// 実 tabStore は layoutStore/treeStore まで引き込むため最小 stub にする
vi.mock("@/features/editor/tabStore", () => ({
  useTabStore: {
    getState: () => ({ dirtyTabIds: mockDirtyTabIds }),
  },
}));

import { flushPendingSceneSaves, runPostEffect } from "./api";
import {
  registerSaveHandler,
  unregisterSaveHandler,
} from "@/features/editor/editorSaveRegistry";

type Handler = (event: { payload: unknown }) => void | Promise<void>;
type EventChannel =
  | "post_effect:progress"
  | "post_effect:partial"
  | "post_effect:done"
  | "post_effect:error";

interface Subscription {
  channel: EventChannel;
  handler: Handler;
  unlisten: ReturnType<typeof vi.fn>;
}

let subs: Subscription[];

beforeEach(() => {
  subs = [];
  mockListen.mockReset();
  mockInvoke.mockReset();
  // listen(channel, handler) は unlisten 関数を返す Promise
  mockListen.mockImplementation(
    async (channel: EventChannel, handler: Handler) => {
      const unlisten = vi.fn();
      subs.push({ channel, handler, unlisten });
      return unlisten;
    },
  );
});

function fireEvent(channel: EventChannel, payload: unknown) {
  for (const s of subs) {
    if (s.channel === channel) {
      void s.handler({ payload });
    }
  }
}

describe("flushPendingSceneSaves", () => {
  afterEach(() => {
    unregisterSaveHandler("scene-a");
    unregisterSaveHandler("scene-b");
    mockDirtyTabIds.clear();
  });

  it("sceneId 指定時は dirty 状態に関係なく登録済み save handler を await する", async () => {
    const save = vi.fn(async () => {});
    registerSaveHandler("scene-a", save);

    await flushPendingSceneSaves("scene-a");

    expect(save).toHaveBeenCalledTimes(1);
  });

  it("sceneId のシーンが開いていない（handler 未登録）なら no-op で resolve する", async () => {
    await expect(flushPendingSceneSaves("scene-a")).resolves.toBeUndefined();
  });

  it("引数なしは dirty なタブだけを flush する", async () => {
    const saveA = vi.fn(async () => {});
    const saveB = vi.fn(async () => {});
    registerSaveHandler("scene-a", saveA);
    registerSaveHandler("scene-b", saveB);
    mockDirtyTabIds.add("scene-a");

    await flushPendingSceneSaves();

    expect(saveA).toHaveBeenCalledTimes(1);
    expect(saveB).not.toHaveBeenCalled();
  });

  it("dirty タブの handler が未登録でも throw しない", async () => {
    mockDirtyTabIds.add("scene-a");

    await expect(flushPendingSceneSaves()).resolves.toBeUndefined();
  });
});

describe("runPostEffect 自動 cleanup", () => {
  const baseReq = {
    project_id: "p1",
    effect_type: "consistency",
    scope_type: "scene",
    scope_target_id: "s1",
    model: "test",
    prompt_version: "v1",
    input_hash: "hash",
    codex_payload_json: "[]",
    scene_text: "",
    system_prompt: "test system prompt",
  } as const;

  it("done 受信で listen を全解除する", async () => {
    mockInvoke.mockResolvedValue({ run_id: "r1", from_cache: false });

    const onDone = vi.fn();
    await runPostEffect(baseReq, { onDone });

    expect(subs.length).toBeGreaterThanOrEqual(2);
    fireEvent("post_effect:done", {
      run_id: "r1",
      annotation_count: 0,
      summary: null,
    });

    // microtask 完了待ち
    await Promise.resolve();
    await Promise.resolve();

    expect(onDone).toHaveBeenCalledTimes(1);
    for (const s of subs) {
      expect(s.unlisten).toHaveBeenCalledTimes(1);
    }
  });

  it("error 受信で listen を全解除する", async () => {
    mockInvoke.mockResolvedValue({ run_id: "r1", from_cache: false });

    const onError = vi.fn();
    await runPostEffect(baseReq, { onError });

    fireEvent("post_effect:error", { run_id: "r1", error: "boom" });
    await Promise.resolve();
    await Promise.resolve();

    expect(onError).toHaveBeenCalledTimes(1);
    for (const s of subs) {
      expect(s.unlisten).toHaveBeenCalledTimes(1);
    }
  });

  it("ハンドラが throw しても cleanup は走る (TDZ 退行防止)", async () => {
    mockInvoke.mockResolvedValue({ run_id: "r1", from_cache: false });

    const onDone = vi.fn(() => {
      throw new ReferenceError("Cannot access 'cleanup' before initialization");
    });
    await runPostEffect(baseReq, { onDone });

    fireEvent("post_effect:done", {
      run_id: "r1",
      annotation_count: 0,
      summary: null,
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(onDone).toHaveBeenCalledTimes(1);
    for (const s of subs) {
      expect(s.unlisten).toHaveBeenCalledTimes(1);
    }
  });

  it("starter (invoke) が失敗したら listen を解除する", async () => {
    mockInvoke.mockRejectedValue(new Error("ipc fail"));

    await expect(runPostEffect(baseReq, {})).rejects.toThrow("ipc fail");

    for (const s of subs) {
      expect(s.unlisten).toHaveBeenCalledTimes(1);
    }
  });

  it("from_cache:true なら done イベントを待たず直ちに onDone を fire し cleanup する", async () => {
    // バックエンドはキャッシュヒット時にタスクを spawn しない。
    // そのまま放置すると spinner 永続なので、合成 onDone を発火する必要がある。
    mockInvoke.mockResolvedValue({ run_id: "r1", from_cache: true });

    const onDone = vi.fn();
    await runPostEffect(baseReq, { onDone });

    // 合成 onDone は次のマイクロタスクで発火
    await Promise.resolve();
    await Promise.resolve();

    expect(onDone).toHaveBeenCalledTimes(1);
    expect(onDone.mock.calls[0][0].run_id).toBe("r1");
    for (const s of subs) {
      expect(s.unlisten).toHaveBeenCalledTimes(1);
    }
  });

  it("複数の terminal イベントが来ても cleanup は冪等", async () => {
    mockInvoke.mockResolvedValue({ run_id: "r1", from_cache: false });

    const onDone = vi.fn();
    await runPostEffect(baseReq, { onDone });

    fireEvent("post_effect:done", {
      run_id: "r1",
      annotation_count: 0,
      summary: null,
    });
    fireEvent("post_effect:done", {
      run_id: "r1",
      annotation_count: 0,
      summary: null,
    });
    await Promise.resolve();
    await Promise.resolve();

    for (const s of subs) {
      // 2 回目の done でも cleanup() は no-op (cleanedUp フラグ)
      expect(s.unlisten).toHaveBeenCalledTimes(1);
    }
  });
});
