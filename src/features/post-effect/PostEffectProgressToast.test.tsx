// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  cleanup,
  act,
} from "@testing-library/react";

const h = vi.hoisted(() => ({
  abortPostEffectRun: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));
vi.mock("sonner", () => ({
  toast: { error: vi.fn() },
}));
vi.mock("./api", () => ({
  abortPostEffectRun: h.abortPostEffectRun,
}));

import { PostEffectProgressToast } from "./PostEffectProgressToast";
import { AUTO_CLEAR_MS, usePostEffectRunStore } from "./runStore";

function seedRun(
  over: Partial<
    Parameters<ReturnType<typeof usePostEffectRunStore.getState>["begin"]>[0]
  > = {},
) {
  usePostEffectRunStore.getState().begin({
    runId: "r1",
    projectId: "p1",
    effectType: "review",
    scopeType: "project",
    scopeTargetId: null,
    totalScenes: 12,
    ...over,
  });
}

describe("PostEffectProgressToast", () => {
  beforeEach(() => {
    h.abortPostEffectRun.mockReset();
    usePostEffectRunStore.setState({ runs: {} });
  });

  afterEach(() => {
    cleanup();
    usePostEffectRunStore.setState({ runs: {} });
  });

  it("run が無ければ何も描画しない", () => {
    const { container } = render(<PostEffectProgressToast />);
    expect(container.innerHTML).toBe("");
  });

  it("実行中 run の種別・スコープ・進捗メッセージを表示する", () => {
    seedRun();
    render(<PostEffectProgressToast />);
    act(() => {
      usePostEffectRunStore.getState().updateProgress("r1", {
        stage: "calling_ai",
        progress: 0.25,
        message: "3/12",
      });
    });

    expect(
      screen.getByText(/kouetsu\.progressToast\.effect\.review/),
    ).toBeInTheDocument();
    expect(
      screen.getByText("kouetsu.progressToast.runningProgress"),
    ).toBeInTheDocument();
  });

  it("multi 実行には中止ボタンが出て abort コマンドを叩く", async () => {
    h.abortPostEffectRun.mockResolvedValue(undefined);
    seedRun();
    render(<PostEffectProgressToast />);

    fireEvent.click(screen.getByText("kouetsu.progressToast.abort"));
    expect(h.abortPostEffectRun).toHaveBeenCalledWith("r1", "p1");
    // 要求後は「中止中…」表示に切り替わる（終端は backend の error イベント）。
    expect(
      await screen.findByText("kouetsu.progressToast.aborting"),
    ).toBeInTheDocument();
  });

  it("単一シーン実行（totalScenes なし）には中止ボタンを出さない", () => {
    // backend の abort フラグはシーン間でしかチェックされないため、
    // 単一シーン run には中止が効かない＝出さない仕様。
    seedRun({
      totalScenes: undefined,
      scopeType: "scene",
      scopeTargetId: "s1",
    });
    render(<PostEffectProgressToast />);
    expect(screen.queryByText("kouetsu.progressToast.abort")).toBeNull();
  });

  it("done 終端は完了表示（件数あり/なし）になり、error 終端は失敗表示になる", () => {
    seedRun();
    seedRun({ runId: "r2", effectType: "typo_detection" });
    render(<PostEffectProgressToast />);

    act(() => {
      usePostEffectRunStore.getState().complete("r1", 4);
      usePostEffectRunStore.getState().fail("r2", "boom");
    });

    expect(screen.getByText("kouetsu.progressToast.done")).toBeInTheDocument();
    expect(
      screen.getByText("kouetsu.progressToast.failed"),
    ).toBeInTheDocument();
  });

  it("cached 終端は「キャッシュ再利用」表示になる（実行中扱いにならない）", () => {
    act(() => {
      usePostEffectRunStore.getState().recordCacheHit({
        runId: "r1",
        projectId: "p1",
        effectType: "review",
        scopeType: "project",
        scopeTargetId: null,
        totalScenes: 12,
      });
    });
    render(<PostEffectProgressToast />);

    expect(
      screen.getByText("kouetsu.progressToast.cached"),
    ).toBeInTheDocument();
    // 終端済みなので中止ボタンや進捗バーは出ない
    expect(screen.queryByText("kouetsu.progressToast.abort")).toBeNull();
    expect(screen.queryByText("kouetsu.progressToast.running")).toBeNull();
  });

  it("summary 付き done（部分失敗）は donePartial + summary 本文を表示する", () => {
    seedRun();
    render(<PostEffectProgressToast />);

    act(() => {
      usePostEffectRunStore
        .getState()
        .complete("r1", 4, "3/15 シーンの解析に失敗しました");
    });

    expect(
      screen.getByText("kouetsu.progressToast.donePartial"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("3/15 シーンの解析に失敗しました"),
    ).toBeInTheDocument();
  });

  it("done/cached は AUTO_CLEAR_MS 後に消え、error/部分失敗は残る", () => {
    vi.useFakeTimers();
    try {
      seedRun(); // r1: 完全成功
      seedRun({ runId: "r2" }); // r2: エラー
      seedRun({ runId: "r3" }); // r3: 部分失敗
      act(() => {
        usePostEffectRunStore.getState().complete("r1", 2);
        usePostEffectRunStore.getState().fail("r2", "boom");
        usePostEffectRunStore
          .getState()
          .complete("r3", 1, "3/15 シーンの解析に失敗しました");
        usePostEffectRunStore.getState().recordCacheHit({
          runId: "r4",
          projectId: "p1",
          effectType: "review",
          scopeType: "project",
          scopeTargetId: null,
        });
      });

      act(() => {
        vi.advanceTimersByTime(AUTO_CLEAR_MS + 100);
      });

      const runs = usePostEffectRunStore.getState().runs;
      expect(runs["r1"]).toBeUndefined(); // 完全成功は自動クリア
      expect(runs["r4"]).toBeUndefined(); // cached も自動クリア
      expect(runs["r2"]).toBeDefined(); // エラーは残る
      expect(runs["r3"]).toBeDefined(); // 部分失敗も残る
    } finally {
      vi.useRealTimers();
    }
  });

  it("終端エントリは × ボタンで閉じられる", () => {
    seedRun();
    render(<PostEffectProgressToast />);
    act(() => {
      usePostEffectRunStore.getState().fail("r1", "boom");
    });

    fireEvent.click(screen.getByLabelText("kouetsu.progressToast.close"));
    expect(usePostEffectRunStore.getState().runs["r1"]).toBeUndefined();
  });

  it("complete は既に終端済み (cached) のエントリを上書きしない", () => {
    act(() => {
      usePostEffectRunStore.getState().recordCacheHit({
        runId: "r1",
        projectId: "p1",
        effectType: "review",
        scopeType: "project",
        scopeTargetId: null,
      });
      // from_cache の合成 done が complete を叩いても cached 表示が残る
      usePostEffectRunStore.getState().complete("r1", 0);
    });

    expect(usePostEffectRunStore.getState().runs["r1"].outcome).toEqual({
      kind: "cached",
    });
  });
});
