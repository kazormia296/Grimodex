// @vitest-environment happy-dom

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

// 書き込みのデバウンス永続化が DB 層に触れないようにする（cache 読み取りは素のまま）。
vi.mock("@/features/settings/api", () => ({
  setProjectSetting: vi.fn().mockResolvedValue(undefined),
  setSetting: vi.fn().mockResolvedValue(undefined),
  getProjectSetting: vi.fn().mockResolvedValue(null),
  getSetting: vi.fn().mockResolvedValue(null),
}));

import { DailyGoalProgress } from "./DailyGoalProgress";
import { useSettingsStore } from "@/features/settings/settingsStore";

function seedGoal(projectGoal: string, defaultGoal: string) {
  useSettingsStore.setState((s) => ({
    cache: {
      ...s.cache,
      "goal.dailyChars": projectGoal,
      "goal.dailyDefaultChars": defaultGoal,
    },
  }));
}

describe("DailyGoalProgress", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    seedGoal("0", "0");
  });

  it("目標未設定なら『目標を設定』ボタンを出す", () => {
    render(<DailyGoalProgress todayChars={300} hasCharData />);
    expect(screen.getByTestId("daily-goal-set")).toBeInTheDocument();
    expect(screen.queryByTestId("daily-goal")).not.toBeInTheDocument();
  });

  it("プロジェクト目標に対する進捗（実績・残り）を表示する", () => {
    seedGoal("1000", "0");
    render(<DailyGoalProgress todayChars={300} hasCharData />);
    const card = screen.getByTestId("daily-goal");
    expect(card.textContent).toContain("300");
    expect(card.textContent).toContain("1,000");
    expect(card.textContent).toContain("700"); // remaining
  });

  it("達成時は達成表示になる", () => {
    seedGoal("1000", "0");
    render(<DailyGoalProgress todayChars={1200} hasCharData />);
    expect(screen.getByTestId("daily-goal").textContent).toContain("🎉");
  });

  it("プロジェクト値が 0 のときグローバル既定にフォールバックし注記を出す", () => {
    seedGoal("0", "2000");
    render(<DailyGoalProgress todayChars={500} hasCharData />);
    const card = screen.getByTestId("daily-goal");
    expect(card.textContent).toContain("2,000");
    expect(card.textContent).toContain("既定の目標を使用中");
  });

  it("字数データが無いとき注記を出す", () => {
    seedGoal("1000", "0");
    render(<DailyGoalProgress todayChars={0} hasCharData={false} />);
    expect(screen.getByTestId("daily-goal").textContent).toContain(
      "本日の字数データがありません",
    );
  });

  it("インライン編集で当プロジェクトの目標を保存する", () => {
    render(<DailyGoalProgress todayChars={0} hasCharData />);
    fireEvent.click(screen.getByTestId("daily-goal-set"));
    const input = screen.getByTestId("daily-goal-input");
    fireEvent.change(input, { target: { value: "1500" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(useSettingsStore.getState().getNumber("goal.dailyChars")).toBe(1500);
  });
});
