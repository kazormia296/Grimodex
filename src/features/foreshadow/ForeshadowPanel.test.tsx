// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

const { mockLoad, mockRemove, ITEMS } = vi.hoisted(() => {
  const mockLoad = vi.fn().mockResolvedValue(undefined);
  const mockRemove = vi.fn().mockResolvedValue(undefined);
  const ITEMS = [
    {
      id: "1",
      title: "計画中アイテム",
      label: "planned",
      intent: null,
      setupCount: 0,
    },
    {
      id: "2",
      title: "設置済みアイテム",
      label: "seeded",
      intent: null,
      setupCount: 1,
    },
    {
      id: "3",
      title: "回収済みアイテム",
      label: "paid",
      intent: null,
      setupCount: 1,
    },
    {
      id: "4",
      title: "強化推奨アイテム",
      label: "needs_strengthening",
      intent: null,
      setupCount: 1,
    },
    {
      id: "5",
      title: "孤立アイテム",
      label: "orphan_payoff",
      intent: null,
      setupCount: 0,
    },
    {
      id: "6",
      title: "放棄アイテム",
      label: "abandoned",
      intent: null,
      setupCount: 0,
    },
  ];
  return { mockLoad, mockRemove, ITEMS };
});

vi.mock("./foreshadowStore", () => {
  const state = {
    items: ITEMS,
    isLoading: false,
    load: mockLoad,
    create: vi.fn(),
    remove: mockRemove,
  };
  return { useForeshadowStore: () => state };
});

vi.mock("./CreateForeshadowDialog", () => ({
  CreateForeshadowDialog: () => null,
}));

import { ForeshadowPanel } from "./ForeshadowPanel";

describe("ForeshadowPanel - ステータスフィルタ", () => {
  beforeEach(() => {
    mockLoad.mockClear();
  });

  it("初期状態では全ラベルのアイテムが表示される", () => {
    render(<ForeshadowPanel />);

    expect(screen.getByText("計画中アイテム")).toBeInTheDocument();
    expect(screen.getByText("設置済みアイテム")).toBeInTheDocument();
    expect(screen.getByText("回収済みアイテム")).toBeInTheDocument();
    expect(screen.getByText("強化推奨アイテム")).toBeInTheDocument();
    expect(screen.getByText("孤立アイテム")).toBeInTheDocument();
    expect(screen.getByText("放棄アイテム")).toBeInTheDocument();
  });

  it("ラベル pill をクリックするとそのラベルのみ表示される", () => {
    render(<ForeshadowPanel />);

    fireEvent.click(screen.getByTestId("foreshadow-filter-planned"));

    expect(screen.getByText("計画中アイテム")).toBeInTheDocument();
    expect(screen.queryByText("設置済みアイテム")).not.toBeInTheDocument();
    expect(screen.queryByText("回収済みアイテム")).not.toBeInTheDocument();
  });

  it("複数 pill を選択すると OR フィルタになる", () => {
    render(<ForeshadowPanel />);

    fireEvent.click(screen.getByTestId("foreshadow-filter-planned"));
    fireEvent.click(screen.getByTestId("foreshadow-filter-seeded"));

    expect(screen.getByText("計画中アイテム")).toBeInTheDocument();
    expect(screen.getByText("設置済みアイテム")).toBeInTheDocument();
    expect(screen.queryByText("回収済みアイテム")).not.toBeInTheDocument();
  });

  it("同じ pill を再度クリックすると選択解除される", () => {
    render(<ForeshadowPanel />);

    fireEvent.click(screen.getByTestId("foreshadow-filter-planned"));
    fireEvent.click(screen.getByTestId("foreshadow-filter-planned"));

    expect(screen.getByText("計画中アイテム")).toBeInTheDocument();
    expect(screen.getByText("設置済みアイテム")).toBeInTheDocument();
  });

  it("クリアボタンで全アイテムが再表示される", () => {
    render(<ForeshadowPanel />);

    fireEvent.click(screen.getByTestId("foreshadow-filter-planned"));
    expect(screen.queryByText("設置済みアイテム")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("foreshadow-filter-clear"));

    expect(screen.getByText("設置済みアイテム")).toBeInTheDocument();
    expect(screen.getByText("回収済みアイテム")).toBeInTheDocument();
  });
});
