// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// listen / invoke の型と mock を hoist
const { mockListen, mockInvoke, mockDirtyTabIds, mockNotify, mockEnsurePerm } =
  vi.hoisted(() => ({
    mockListen: vi.fn(),
    mockInvoke: vi.fn(),
    mockDirtyTabIds: new Set<string>(),
    mockNotify: vi.fn(),
    mockEnsurePerm: vi.fn(),
  }));

vi.mock("@/lib/tauri", () => ({
  listen: mockListen,
  invoke: mockInvoke,
}));

// デスクトップ通知は環境依存 (Tauri plugin + document.hasFocus) なので stub し、
// 配線 (呼ばれる/呼ばれない) だけをここで検証する。
vi.mock("./desktopNotify", () => ({
  ensureNotificationPermission: mockEnsurePerm,
  notifyRunTerminalIfUnfocused: mockNotify,
}));

// 実 tabStore は layoutStore/treeStore まで引き込むため最小 stub にする
vi.mock("@/features/editor/tabStore", () => ({
  useTabStore: {
    getState: () => ({ dirtyTabIds: mockDirtyTabIds }),
  },
}));

import { flushPendingSceneSaves, runPostEffect } from "./api";
import { usePostEffectRunStore } from "./runStore";
import {
  registerSaveHandler,
  unregisterSaveHandler,
} from "@/features/editor/editorSaveRegistry";

// `@/lib/tauri` の listen はハンドラへ payload を**直接**渡す契約
// (tauriListen の (e) => handler(e.payload) ラップ)。mock も同じ契約にする。
type Handler = (payload: unknown) => void | Promise<void>;
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
  mockNotify.mockReset();
  mockEnsurePerm.mockReset();
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
      void s.handler(payload);
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

describe("runPostEffect run_id フィルタリング", () => {
  const baseReq = {
    project_id: "p1",
    effect_type: "review",
    scope_type: "scene",
    scope_target_id: "s1",
    model: "test",
    prompt_version: "v1",
    input_hash: "hash",
    codex_payload_json: "[]",
    scene_text: "",
    system_prompt: "test system prompt",
  } as const;

  beforeEach(() => {
    usePostEffectRunStore.setState({ runs: {} });
  });

  it("他 run の done では terminal handler も cleanup も発火しない", async () => {
    // 並行 run（例: review 実行中に typo を開始）で他 run の完了が
    // この run の spinner/toast を巻き込んで終わらせていた退行の防止。
    mockInvoke.mockResolvedValue({ run_id: "r1", from_cache: false });

    const onDone = vi.fn();
    await runPostEffect(baseReq, { onDone });

    fireEvent("post_effect:done", {
      run_id: "OTHER",
      annotation_count: 3,
      summary: null,
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(onDone).not.toHaveBeenCalled();
    for (const s of subs) {
      expect(s.unlisten).not.toHaveBeenCalled();
    }

    // 自 run の done では従来どおり発火 + 解除。
    fireEvent("post_effect:done", {
      run_id: "r1",
      annotation_count: 0,
      summary: null,
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("run_id 確定前に届いた自 run の done はバッファされ再生される", async () => {
    // starter (invoke) の resolve より先に done が emit される超高速
    // completion。ここを落とすと spinner 永続に戻る。
    let resolveStarter!: (v: unknown) => void;
    mockInvoke.mockReturnValue(
      new Promise((resolve) => {
        resolveStarter = resolve;
      }),
    );

    const onDone = vi.fn();
    const p = runPostEffect(baseReq, { onDone });
    // listen 登録完了を待つ（starter は未解決のまま）
    await Promise.resolve();
    await Promise.resolve();

    fireEvent("post_effect:done", {
      run_id: "r1",
      annotation_count: 2,
      summary: null,
    });
    fireEvent("post_effect:done", {
      run_id: "OTHER",
      annotation_count: 9,
      summary: null,
    });
    expect(onDone).not.toHaveBeenCalled();

    resolveStarter({ run_id: "r1", from_cache: false });
    await p;
    await Promise.resolve();
    await Promise.resolve();

    expect(onDone).toHaveBeenCalledTimes(1);
    expect(onDone.mock.calls[0][0].annotation_count).toBe(2);
    for (const s of subs) {
      expect(s.unlisten).toHaveBeenCalledTimes(1);
    }
  });

  it("runStore に begin → progress → complete が反映される", async () => {
    mockInvoke.mockResolvedValue({ run_id: "r1", from_cache: false });
    await runPostEffect(baseReq, {});

    const run = usePostEffectRunStore.getState().runs["r1"];
    expect(run).toBeDefined();
    expect(run.effectType).toBe("review");
    expect(run.scopeType).toBe("scene");
    expect(run.scopeTargetId).toBe("s1");
    expect(run.outcome).toBeUndefined();

    fireEvent("post_effect:progress", {
      run_id: "r1",
      stage: "calling_ai",
      progress: 0.5,
      message: "3/12",
    });
    await Promise.resolve();
    const mid = usePostEffectRunStore.getState().runs["r1"];
    expect(mid.progress).toBe(0.5);
    expect(mid.message).toBe("3/12");

    fireEvent("post_effect:done", {
      run_id: "r1",
      annotation_count: 4,
      summary: null,
    });
    await Promise.resolve();
    await Promise.resolve();
    const done = usePostEffectRunStore.getState().runs["r1"];
    // 終端後も AUTO_CLEAR_MS の間はエントリが残る（トースト完了表示用）
    expect(done.outcome).toEqual({ kind: "done", annotationCount: 4 });
  });

  it("error で outcome=error になる", async () => {
    mockInvoke.mockResolvedValue({ run_id: "r1", from_cache: false });
    await runPostEffect(baseReq, {});

    fireEvent("post_effect:error", { run_id: "r1", error: "boom" });
    await Promise.resolve();
    await Promise.resolve();

    expect(usePostEffectRunStore.getState().runs["r1"].outcome).toEqual({
      kind: "error",
      error: "boom",
    });
  });

  it("from_cache は runStore に cached 終端で登録する（常駐トーストに出す）", async () => {
    // 旧仕様は「登録しない」だったが、成功トーストを持たないビュー (review 等)
    // では「押しても何も起きない」ように見えた。cached の終端エントリとして
    // 登録し、全サーフェス共通のフィードバックを常駐トーストに出す。
    mockInvoke.mockResolvedValue({ run_id: "r1", from_cache: true });
    const onDone = vi.fn();
    await runPostEffect(baseReq, { onDone });
    await Promise.resolve();
    await Promise.resolve();

    expect(onDone).toHaveBeenCalledTimes(1);
    const run = usePostEffectRunStore.getState().runs["r1"];
    expect(run).toBeDefined();
    // 合成 done (dispatchDone → complete) が cached 終端を上書きしないこと。
    expect(run.outcome).toEqual({ kind: "cached" });
    // 終端済みなので spinner 判定 (outcome undefined) には乗らない。
  });

  it("done イベントの summary が outcome に伝搬する（部分失敗表示用）", async () => {
    mockInvoke.mockResolvedValue({ run_id: "r1", from_cache: false });
    await runPostEffect(baseReq, {});

    fireEvent("post_effect:done", {
      run_id: "r1",
      annotation_count: 4,
      summary: "3/15 シーンの解析に失敗しました",
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(usePostEffectRunStore.getState().runs["r1"].outcome).toEqual({
      kind: "done",
      annotationCount: 4,
      summary: "3/15 シーンの解析に失敗しました",
    });
  });

  it("done/error でデスクトップ通知が配線され、from_cache では呼ばれない", async () => {
    // 非キャッシュ run: 開始時に権限確保 + done で通知
    mockInvoke.mockResolvedValue({ run_id: "r1", from_cache: false });
    await runPostEffect(baseReq, {});
    expect(mockEnsurePerm).toHaveBeenCalledTimes(1);

    fireEvent("post_effect:done", { run_id: "r1", annotation_count: 2 });
    await Promise.resolve();
    await Promise.resolve();
    expect(mockNotify).toHaveBeenCalledWith(
      { effectType: "review", scopeType: "scene" },
      { kind: "done", annotationCount: 2, summary: undefined },
    );

    // error でも通知
    mockNotify.mockClear();
    mockInvoke.mockResolvedValue({ run_id: "r2", from_cache: false });
    await runPostEffect(baseReq, {});
    fireEvent("post_effect:error", { run_id: "r2", error: "boom" });
    await Promise.resolve();
    await Promise.resolve();
    expect(mockNotify).toHaveBeenCalledWith(
      { effectType: "review", scopeType: "scene" },
      { kind: "error", error: "boom" },
    );

    // キャッシュ短絡: 即時完了 (ユーザーは操作直後で見ている) なので通知しない
    mockNotify.mockClear();
    mockInvoke.mockResolvedValue({ run_id: "r3", from_cache: true });
    await runPostEffect(baseReq, {});
    await Promise.resolve();
    await Promise.resolve();
    expect(mockNotify).not.toHaveBeenCalled();
  });
});
