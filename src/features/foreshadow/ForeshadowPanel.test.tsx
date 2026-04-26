// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const {
  mockLoad,
  mockRemove,
  mockLoadSetups,
  mockRemoveSetup,
  mockReanchorSetup,
  mockReinsertSetup,
  ITEMS,
  SETUPS,
} = vi.hoisted(() => {
  const mockLoad = vi.fn().mockResolvedValue(undefined);
  const mockRemove = vi.fn().mockResolvedValue(undefined);
  const mockLoadSetups = vi.fn().mockResolvedValue(undefined);
  const mockRemoveSetup = vi.fn().mockResolvedValue(undefined);
  const mockReanchorSetup = vi.fn().mockResolvedValue(undefined);
  const mockReinsertSetup = vi.fn().mockResolvedValue(undefined);

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

  // item "2" has one active setup and one orphan setup
  const SETUPS: Record<string, object[]> = {
    "2": [
      {
        id: "s-active",
        foreshadowId: "2",
        sceneId: "scene-1",
        kind: "designated_existing",
        strength: "moderate",
        aiStrength: null,
        aiReasoning: null,
        attribution: "human",
        aiRationale: null,
        lastEvaluatedAt: null,
        isOrphan: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: "s-orphan",
        foreshadowId: "2",
        sceneId: "scene-2",
        kind: "inserted_new",
        strength: null,
        aiStrength: null,
        aiReasoning: null,
        attribution: "human",
        aiRationale: null,
        lastEvaluatedAt: null,
        isOrphan: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ],
  };

  return {
    mockLoad,
    mockRemove,
    mockLoadSetups,
    mockRemoveSetup,
    mockReanchorSetup,
    mockReinsertSetup,
    ITEMS,
    SETUPS,
  };
});

vi.mock("./foreshadowStore", () => {
  const state = {
    items: ITEMS,
    isLoading: false,
    load: mockLoad,
    create: vi.fn(),
    remove: mockRemove,
    setupsByForeshadowId: SETUPS,
    loadSetups: mockLoadSetups,
    removeSetup: mockRemoveSetup,
    reanchorSetup: mockReanchorSetup,
    reinsertSetup: mockReinsertSetup,
  };
  return { useForeshadowStore: () => state };
});

vi.mock("./CreateForeshadowDialog", () => ({
  CreateForeshadowDialog: () => null,
}));

import { ForeshadowPanel } from "./ForeshadowPanel";

// ── ステータスフィルタ ────────────────────────────────────────────────

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

// ── オーファン Setup UI ───────────────────────────────────────────────

describe("ForeshadowPanel - オーファン Setup UI", () => {
  beforeEach(() => {
    mockLoadSetups.mockClear();
    mockRemoveSetup.mockClear();
    mockReanchorSetup.mockClear();
    mockReinsertSetup.mockClear();
  });

  it("アイテムをクリックすると展開され loadSetups が呼ばれる", async () => {
    render(<ForeshadowPanel />);

    fireEvent.click(screen.getByTestId("foreshadow-expand-2"));

    expect(mockLoadSetups).toHaveBeenCalledWith("2");
  });

  it("展開時に孤立 Setup のみ表示され、アクティブ Setup は表示されない", async () => {
    render(<ForeshadowPanel />);

    fireEvent.click(screen.getByTestId("foreshadow-expand-2"));

    await waitFor(() => {
      expect(
        screen.getByTestId("foreshadow-setup-s-orphan"),
      ).toBeInTheDocument();
      expect(
        screen.queryByTestId("foreshadow-setup-s-active"),
      ).not.toBeInTheDocument();
    });
  });

  it("孤立 Setup には「孤立」バッジが表示される", async () => {
    render(<ForeshadowPanel />);

    fireEvent.click(screen.getByTestId("foreshadow-expand-2"));

    await waitFor(() => {
      expect(screen.getByTestId("foreshadow-setup-s-orphan")).toHaveTextContent(
        "孤立",
      );
    });
  });

  it("孤立 Setup には破棄ボタンがある", async () => {
    render(<ForeshadowPanel />);

    fireEvent.click(screen.getByTestId("foreshadow-expand-2"));

    await waitFor(() => {
      expect(
        screen.getByTestId("foreshadow-setup-discard-s-orphan"),
      ).toBeInTheDocument();
    });
  });

  it("孤立 Setup には再アンカー / 再挿入ボタンがある", async () => {
    render(<ForeshadowPanel />);

    fireEvent.click(screen.getByTestId("foreshadow-expand-2"));

    await waitFor(() => {
      expect(
        screen.getByTestId("foreshadow-setup-reanchor-s-orphan"),
      ).toBeInTheDocument();
      expect(
        screen.getByTestId("foreshadow-setup-reinsert-s-orphan"),
      ).toBeInTheDocument();
    });
  });

  it("破棄ボタンをクリックすると removeSetup が呼ばれる", async () => {
    render(<ForeshadowPanel />);

    fireEvent.click(screen.getByTestId("foreshadow-expand-2"));

    await waitFor(() => {
      expect(
        screen.getByTestId("foreshadow-setup-discard-s-orphan"),
      ).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId("foreshadow-setup-discard-s-orphan"));
    expect(mockRemoveSetup).toHaveBeenCalledWith("s-orphan", "2");
  });

  it("再アンカーボタンをクリックすると reanchorSetup が呼ばれる", async () => {
    render(<ForeshadowPanel />);

    fireEvent.click(screen.getByTestId("foreshadow-expand-2"));

    await waitFor(() => {
      expect(
        screen.getByTestId("foreshadow-setup-reanchor-s-orphan"),
      ).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId("foreshadow-setup-reanchor-s-orphan"));
    expect(mockReanchorSetup).toHaveBeenCalledWith("s-orphan", "2");
  });

  it("再挿入ボタンをクリックすると reinsertSetup が呼ばれる", async () => {
    render(<ForeshadowPanel />);

    fireEvent.click(screen.getByTestId("foreshadow-expand-2"));

    await waitFor(() => {
      expect(
        screen.getByTestId("foreshadow-setup-reinsert-s-orphan"),
      ).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId("foreshadow-setup-reinsert-s-orphan"));
    expect(mockReinsertSetup).toHaveBeenCalledWith("s-orphan", "2");
  });

  it("再クリックで折り畳まれる", async () => {
    render(<ForeshadowPanel />);

    fireEvent.click(screen.getByTestId("foreshadow-expand-2"));
    await waitFor(() => {
      expect(
        screen.getByTestId("foreshadow-setup-s-orphan"),
      ).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId("foreshadow-expand-2"));
    expect(
      screen.queryByTestId("foreshadow-setup-s-orphan"),
    ).not.toBeInTheDocument();
  });
});
