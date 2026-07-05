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
import { usePostEffectRunStore } from "./runStore";

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
});
