// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { useTreeStore } from "@/features/tree/treeStore";

// useAiGate は provider readiness 依存でテスト環境では pending/disabled になりうる
// ため enabled に固定する。gate 表示は useAiGate 側で別途テスト済み。
vi.mock("@/features/ai-policy/useAiGate", () => ({
  useAiGate: () => ({ presentation: "enabled", tooltip: null }),
}));

// runFullCheck だけ差し替える（useFullCheckStore / STEP 定数は実物を使う）。
const { runFullCheckMock } = vi.hoisted(() => ({ runFullCheckMock: vi.fn() }));
vi.mock("./fullCheck", async (orig) => {
  const actual = await orig<typeof import("./fullCheck")>();
  return { ...actual, runFullCheck: runFullCheckMock };
});

import { FullCheckControl } from "./FullCheckControl";
import { useFullCheckStore } from "./fullCheck";
import { useKouetsuStore } from "./kouetsuStore";

const DEFAULT_EFFECTS = {
  lint: true,
  typo: true,
  consistency: true,
  review: true,
  meta: true,
  timeline: true,
  intent: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  useFullCheckStore.setState({
    running: false,
    currentStep: null,
    done: 0,
    total: 0,
    failures: [],
    cancelRequested: false,
  });
  useKouetsuStore.setState({
    scope: { type: "project" },
    fullCheckEffects: { ...DEFAULT_EFFECTS },
  });
  useTreeStore.setState({ activeSceneId: "scene-1", projectId: "p1" });
});

afterEach(() => cleanup());

describe("FullCheckControl", () => {
  it("実行ボタンを押すと scope + effects で runFullCheck を呼ぶ", () => {
    render(<FullCheckControl />);
    fireEvent.click(screen.getByText("全体チェック"));
    expect(runFullCheckMock).toHaveBeenCalledTimes(1);
    expect(runFullCheckMock).toHaveBeenCalledWith(
      { type: "project" },
      expect.objectContaining({ typo: true, review: true }),
    );
  });

  it("観点が 1 つも選ばれていないと実行ボタンは無効", () => {
    useKouetsuStore.setState({
      fullCheckEffects: {
        lint: false,
        typo: false,
        consistency: false,
        review: false,
        meta: false,
        timeline: false,
        intent: false,
      },
    });
    render(<FullCheckControl />);
    expect(screen.getByText("全体チェック").closest("button")).toBeDisabled();
  });

  it("scene スコープで activeSceneId が無いと無効", () => {
    useKouetsuStore.setState({ scope: { type: "scene" } });
    useTreeStore.setState({ activeSceneId: "" });
    render(<FullCheckControl />);
    expect(screen.getByText("全体チェック").closest("button")).toBeDisabled();
  });

  it("ポップオーバーのチェック切替が persist ストアに反映される", () => {
    render(<FullCheckControl />);
    fireEvent.click(screen.getByLabelText("チェックする観点"));
    // 誤字脱字チェックのチェックを外す。
    const typoLabel = screen.getByText("誤字脱字チェック").closest("label")!;
    const checkbox = typoLabel.querySelector(
      "input[type=checkbox]",
    ) as HTMLInputElement;
    expect(checkbox.checked).toBe(true);
    fireEvent.click(checkbox);
    expect(useKouetsuStore.getState().fullCheckEffects.typo).toBe(false);
  });

  it("実行中は進捗と中止ボタンを表示し、中止で cancelRequested を立てる", () => {
    useFullCheckStore.setState({
      running: true,
      currentStep: "review",
      done: 2,
      total: 5,
    });
    render(<FullCheckControl />);
    // 実行ボタンは消え、進捗が出る。
    expect(screen.queryByText("全体チェック")).toBeNull();
    expect(screen.getByText("2/5 観点")).toBeInTheDocument();
    fireEvent.click(screen.getByText("中止"));
    expect(useFullCheckStore.getState().cancelRequested).toBe(true);
  });
});
