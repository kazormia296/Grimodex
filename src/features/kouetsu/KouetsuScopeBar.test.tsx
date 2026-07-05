// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { KouetsuScopeBar } from "./KouetsuScopeBar";
import { useKouetsuStore } from "./kouetsuStore";
import { useTreeStore } from "@/features/tree/treeStore";

beforeEach(() => {
  useKouetsuStore.setState({ scope: { type: "scene" }, statusFilter: "open" });
  // activeSceneId は string 既定("")。null は型に合わない(実 treeStore 確認済み)。
  useTreeStore.setState({ nodes: [], activeSceneId: "" });
});

describe("KouetsuScopeBar", () => {
  it("トリガにスコープラベルが出る（scene 既定）", () => {
    render(<KouetsuScopeBar />);
    expect(
      screen.getByRole("button", { name: /現在シーン/ }),
    ).toBeInTheDocument();
  });

  it("トリガクリックで ScopeTreePickerList が開き、プロジェクト選択で store が変わる", () => {
    render(<KouetsuScopeBar />);
    fireEvent.click(screen.getByRole("button", { name: /現在シーン/ }));
    // ScopeTreePickerList のプロジェクト行は chat.scope.project = "プロジェクト全体"
    fireEvent.click(screen.getByText("プロジェクト全体"));
    expect(useKouetsuStore.getState().scope).toEqual({ type: "project" });
  });

  it("ステータスフィルタ chips: 除外クリックで statusFilter='dismissed'", () => {
    render(<KouetsuScopeBar />);
    fireEvent.click(screen.getByRole("button", { name: "除外" }));
    expect(useKouetsuStore.getState().statusFilter).toBe("dismissed");
    // aria-pressed で状態を表現する
    expect(screen.getByRole("button", { name: "除外" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });
});
