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

import { FinishLinePacemaker } from "./FinishLinePacemaker";
import { useSettingsStore } from "@/features/settings/settingsStore";

// ローカルタイムゾーン非依存（component も finishLine もローカル基準）。
const NOW = new Date(2026, 5, 18, 10, 0, 0).getTime(); // 2026-06-18

function seed(target: string, deadline: string) {
  useSettingsStore.setState((s) => ({
    cache: {
      ...s.cache,
      "goal.manuscriptTargetChars": target,
      "goal.manuscriptDeadline": deadline,
    },
  }));
}

describe("FinishLinePacemaker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    seed("0", "");
  });

  it("目標未設定なら『完走目標を設定』ボタンを出す", () => {
    render(
      <FinishLinePacemaker
        currentChars={5000}
        pace={500}
        hasCharData
        now={NOW}
      />,
    );
    expect(screen.getByTestId("pacemaker-set")).toBeInTheDocument();
    expect(screen.queryByTestId("pacemaker")).not.toBeInTheDocument();
  });

  it("目標設定時：現在/目標/残量・ペース・完走予定を出す", () => {
    seed("100000", "");
    render(
      <FinishLinePacemaker
        currentChars={62300}
        pace={1850}
        hasCharData
        now={NOW}
      />,
    );
    const card = screen.getByTestId("pacemaker");
    expect(card.textContent).toContain("62,300");
    expect(card.textContent).toContain("100,000");
    expect(card.textContent).toContain("37,700"); // remaining
    expect(card.textContent).toContain("直近ペース"); // pace line
    expect(card.textContent).toContain("完走予定"); // projection
  });

  it("字数データ無し：ペース行/完走予定を伏せ、注記を出すが目標/残量は出す（回帰: pace行の二重表示防止）", () => {
    seed("100000", "");
    render(
      <FinishLinePacemaker
        currentChars={62300}
        pace={0}
        hasCharData={false}
        now={NOW}
      />,
    );
    const card = screen.getByTestId("pacemaker");
    // 目標/現在/残量（charCount 由来）は出る
    expect(card.textContent).toContain("62,300");
    expect(card.textContent).toContain("37,700");
    // ペース行・完走予定（events 由来）は伏せる
    expect(card.textContent).not.toContain("直近ペース");
    expect(card.textContent).not.toContain("完走予定");
    // 代わりに注記
    expect(card.textContent).toContain(
      "字数データが不足しているためペースを概算できません",
    );
  });

  it("締切ありで遅れる：必要ペースと遅れ日数を出す", () => {
    seed("100000", "2026-06-30"); // +12 日
    render(
      <FinishLinePacemaker
        currentChars={62300}
        pace={1850}
        hasCharData
        now={NOW}
      />,
    );
    const card = screen.getByTestId("pacemaker");
    // daysToFinish 21 − daysUntilDeadline 12 = 9 日遅れ
    expect(card.textContent).toContain("9");
    expect(card.textContent).toContain("遅れ");
    // 必要ペース ceil(37700/12)=3142
    expect(card.textContent).toContain("3,142");
  });

  it("達成済み：🎉 を出しペース/予測は伏せる", () => {
    seed("50000", "2026-06-30");
    render(
      <FinishLinePacemaker
        currentChars={52000}
        pace={1000}
        hasCharData
        now={NOW}
      />,
    );
    const card = screen.getByTestId("pacemaker");
    expect(card.textContent).toContain("🎉");
    expect(card.textContent).not.toContain("直近ペース");
    expect(card.textContent).not.toContain("完走予定");
  });

  it("インライン設定：目標と締切を保存する", () => {
    render(
      <FinishLinePacemaker currentChars={0} pace={0} hasCharData now={NOW} />,
    );
    fireEvent.click(screen.getByTestId("pacemaker-set"));
    fireEvent.change(screen.getByTestId("pacemaker-target-input"), {
      target: { value: "80000" },
    });
    fireEvent.change(screen.getByTestId("pacemaker-deadline-input"), {
      target: { value: "2026-08-01" },
    });
    fireEvent.keyDown(screen.getByTestId("pacemaker-target-input"), {
      key: "Enter",
    });
    const st = useSettingsStore.getState();
    expect(st.getNumber("goal.manuscriptTargetChars")).toBe(80000);
    expect(st.get("goal.manuscriptDeadline")).toBe("2026-08-01");
  });

  it("負の目標値は 0（未設定）にクランプして保存する", () => {
    seed("1000", "");
    render(
      <FinishLinePacemaker currentChars={0} pace={0} hasCharData now={NOW} />,
    );
    // 既存目標があるので編集鉛筆から開く
    fireEvent.click(screen.getByTitle("目標・締切を編集"));
    fireEvent.change(screen.getByTestId("pacemaker-target-input"), {
      target: { value: "-5" },
    });
    fireEvent.keyDown(screen.getByTestId("pacemaker-target-input"), {
      key: "Enter",
    });
    expect(
      useSettingsStore.getState().getNumber("goal.manuscriptTargetChars"),
    ).toBe(0);
  });
});
