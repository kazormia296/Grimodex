// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const { mockLoad, mockLoadSetups, mockProposeSetups, ITEMS_WITH_PAYOFF } =
  vi.hoisted(() => {
    const mockLoad = vi.fn().mockResolvedValue(undefined);
    const mockLoadSetups = vi.fn().mockResolvedValue(undefined);
    const mockProposeSetups = vi.fn().mockResolvedValue(undefined);

    const ITEMS_WITH_PAYOFF = [
      {
        id: "f-with-payoff",
        projectId: "p",
        title: "回収先あり伏線",
        label: "seeded",
        setupCount: 1,
        intent: "井戸が後で重要になる",
        notes: null,
        payoffSceneId: "scene-99",
        payoffFromPos: 0,
        payoffToPos: 10,
        payoffConfirmed: false,
        abandoned: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: "f-planned",
        projectId: "p",
        title: "回収先なし伏線",
        label: "planned",
        setupCount: 0,
        intent: null,
        notes: null,
        payoffSceneId: null,
        payoffFromPos: null,
        payoffToPos: null,
        payoffConfirmed: false,
        abandoned: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];

    return { mockLoad, mockLoadSetups, mockProposeSetups, ITEMS_WITH_PAYOFF };
  });

vi.mock("./foreshadowStore", () => {
  const state = {
    items: ITEMS_WITH_PAYOFF,
    isLoading: false,
    load: mockLoad,
    create: vi.fn(),
    remove: vi.fn(),
    setupsByForeshadowId: {
      "f-with-payoff": [
        {
          id: "s-1",
          foreshadowId: "f-with-payoff",
          sceneId: "scene-1",
          kind: "designated_existing",
          strength: null,
          aiStrength: null,
          aiReasoning: null,
          attribution: "human",
          aiRationale: null,
          lastEvaluatedAt: null,
          isOrphan: false,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
    },
    loadSetups: mockLoadSetups,
    removeSetup: vi.fn(),
    reanchorSetup: vi.fn(),
    reinsertSetup: vi.fn(),
    evaluateSetup: vi.fn(),
    evaluatingSetupIds: new Set<string>(),
    proposeSetups: mockProposeSetups,
    proposingForForeshadowIds: new Set<string>(),
    auditingChapterIds: new Set<string>(),
    proposeResults: {},
  };
  return { useForeshadowStore: () => state };
});

vi.mock("./CreateForeshadowDialog", () => ({
  CreateForeshadowDialog: () => null,
}));

vi.mock("@/features/tree/store", () => ({
  useSceneStore: () => ({
    nodes: [
      {
        id: "ch-1",
        title: "第一章",
        nodeType: "folder",
        parentId: null,
        sortOrder: "a0",
        projectId: "p",
      },
    ],
  }),
}));

import { ForeshadowPanel } from "./ForeshadowPanel";

describe("ForeshadowPanel - Phase 3: タブ切替", () => {
  it("デフォルトで「一覧」タブが表示される", () => {
    render(<ForeshadowPanel />);
    expect(screen.getByTestId("foreshadow-tab-list")).toBeInTheDocument();
  });

  it("「章別監査」タブをクリックすると章別ビューが表示される", () => {
    render(<ForeshadowPanel />);
    fireEvent.click(screen.getByTestId("foreshadow-tab-chapter"));
    expect(
      screen.getByTestId("foreshadow-chapter-tab-content"),
    ).toBeInTheDocument();
  });

  it("「一覧」タブに戻るとアイテムリストが再表示される", () => {
    render(<ForeshadowPanel />);
    fireEvent.click(screen.getByTestId("foreshadow-tab-chapter"));
    fireEvent.click(screen.getByTestId("foreshadow-tab-list"));
    expect(screen.getByText("回収先あり伏線")).toBeInTheDocument();
  });
});

describe("ForeshadowPanel - Phase 3: Setup を提案ボタン", () => {
  beforeEach(() => {
    mockLoadSetups.mockClear();
    mockProposeSetups.mockClear();
  });

  it("payoff anchor ありの伏線展開時に「Setup を提案」ボタンが表示される", async () => {
    render(<ForeshadowPanel />);
    fireEvent.click(screen.getByTestId("foreshadow-expand-f-with-payoff"));

    await waitFor(() => {
      expect(
        screen.getByTestId("foreshadow-propose-setups-f-with-payoff"),
      ).toBeInTheDocument();
    });
  });

  it("payoff anchor なし（planned）の伏線展開時は「Setup を提案」ボタンが表示されない", async () => {
    render(<ForeshadowPanel />);
    fireEvent.click(screen.getByTestId("foreshadow-expand-f-planned"));

    await waitFor(() => {
      expect(
        screen.queryByTestId("foreshadow-propose-setups-f-planned"),
      ).not.toBeInTheDocument();
    });
  });

  it("「Setup を提案」ボタンをクリックすると proposeSetups が呼ばれる", async () => {
    render(<ForeshadowPanel />);
    fireEvent.click(screen.getByTestId("foreshadow-expand-f-with-payoff"));

    await waitFor(() => {
      expect(
        screen.getByTestId("foreshadow-propose-setups-f-with-payoff"),
      ).toBeInTheDocument();
    });

    fireEvent.click(
      screen.getByTestId("foreshadow-propose-setups-f-with-payoff"),
    );
    expect(mockProposeSetups).toHaveBeenCalledWith("f-with-payoff");
  });
});
