// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { useForeshadowStore } from "../foreshadowStore";
import { useForeshadowNavStore } from "../foreshadowNavStore";
import { useTreeStore } from "@/features/tree/treeStore";
import type { DerivedLabel, ForeshadowWithLabel } from "../types";

vi.mock("../foreshadowSceneJump", () => ({
  requestForeshadowJump: vi.fn(),
}));

import { requestForeshadowJump } from "../foreshadowSceneJump";
import { ForeshadowRadarTab } from "./ForeshadowRadarTab";

const mockJump = vi.mocked(requestForeshadowJump);

function makeF(p: {
  id: string;
  label: DerivedLabel;
  payoffSceneId?: string | null;
  payoffConfirmed?: boolean;
  payoffFromPos?: number | null;
  payoffToPos?: number | null;
  setupCount?: number;
}): ForeshadowWithLabel {
  return {
    id: p.id,
    projectId: "proj",
    title: p.id,
    intent: null,
    notes: null,
    payoffSceneId: p.payoffSceneId ?? null,
    payoffFromPos: p.payoffFromPos ?? null,
    payoffToPos: p.payoffToPos ?? null,
    payoffConfirmed: p.payoffConfirmed ?? false,
    abandoned: false,
    secret: false,
    loadBearing: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    label: p.label,
    setupCount: p.setupCount ?? 0,
  };
}

function seedScenes(ids: string[]) {
  useTreeStore.setState({
    nodes: ids.map((id, i) => ({
      id,
      projectId: "proj",
      parentId: null,
      nodeType: "scene",
      title: id,
      sortOrder: `a${i}`,
    })),
  } as never);
}

function seed(
  items: ForeshadowWithLabel[],
  setupScenesByForeshadowId: Record<string, string[]>,
  setupsByForeshadowId: Record<
    string,
    Array<{ foreshadowId: string; sceneId: string; isOrphan: boolean }>
  > = {},
) {
  useForeshadowStore.setState({
    items,
    setupScenesByForeshadowId,
    setupsByForeshadowId,
  } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  useForeshadowNavStore.setState({ pendingPanelHighlight: null });
  seedScenes([]);
  seed([], {});
});

afterEach(() => {
  cleanup();
});

describe("ForeshadowRadarTab", () => {
  it("伏線が無いときは空状態を出す", () => {
    render(<ForeshadowRadarTab />);
    expect(screen.getByText("伏線はありません")).toBeTruthy();
    expect(screen.queryByTestId("foreshadow-radar-chart")).toBeNull();
  });

  it("回収バーとアークを描画する", () => {
    seedScenes(["s0", "s1", "s2"]);
    seed(
      [
        makeF({
          id: "f1",
          label: "paid",
          payoffSceneId: "s2",
          payoffConfirmed: true,
          payoffFromPos: 3,
          payoffToPos: 7,
          setupCount: 1,
        }),
        makeF({ id: "f2", label: "seeded", setupCount: 1 }),
      ],
      { f1: ["s0"], f2: ["s1"] },
    );
    render(<ForeshadowRadarTab />);

    expect(screen.getByTestId("foreshadow-radar-recovery-bar")).toBeTruthy();
    expect(screen.getByTestId("foreshadow-radar-chart")).toBeTruthy();
    expect(screen.getByTestId("foreshadow-radar-arc-f1")).toBeTruthy();
    expect(screen.getByTestId("foreshadow-radar-arc-f2")).toBeTruthy();
  });

  it("確定回収アークのクリックは payoff へ位置付きジャンプ", () => {
    seedScenes(["s0", "s1", "s2"]);
    seed(
      [
        makeF({
          id: "f1",
          label: "paid",
          payoffSceneId: "s2",
          payoffConfirmed: true,
          payoffFromPos: 3,
          payoffToPos: 7,
          setupCount: 1,
        }),
      ],
      { f1: ["s0"] },
    );
    render(<ForeshadowRadarTab />);

    fireEvent.click(screen.getByTestId("foreshadow-radar-arc-f1"));
    expect(mockJump).toHaveBeenCalledWith("s2", 3, 7);
  });

  it("未回収アークのクリックは setup シーンを開く (位置なし)", () => {
    seedScenes(["s0", "s1"]);
    seed([makeF({ id: "f2", label: "seeded", setupCount: 1 })], {
      f2: ["s1"],
    });
    render(<ForeshadowRadarTab />);

    fireEvent.click(screen.getByTestId("foreshadow-radar-arc-f2"));
    expect(mockJump).toHaveBeenCalledWith("s1");
  });

  it("setup 編集後は live な setupsByForeshadowId を反映する (スナップショットを上書き)", () => {
    seedScenes(["s0", "s1", "s2"]);
    // スナップショットでは f2 の setup は s0。だが live では s2 に移動済み。
    seed(
      [makeF({ id: "f2", label: "seeded", setupCount: 1 })],
      { f2: ["s0"] },
      { f2: [{ foreshadowId: "f2", sceneId: "s2", isOrphan: false }] },
    );
    render(<ForeshadowRadarTab />);

    fireEvent.click(screen.getByTestId("foreshadow-radar-arc-f2"));
    // 最早 setup が s2 になっていれば override 成功。
    expect(mockJump).toHaveBeenCalledWith("s2");
  });

  it("未配置の伏線はチップで出し、クリックで一覧ハイライトを要求する", () => {
    seedScenes(["s0"]);
    seed([makeF({ id: "f4", label: "planned", setupCount: 0 })], {});
    render(<ForeshadowRadarTab />);

    const chip = screen.getByTestId("foreshadow-radar-floating-f4");
    fireEvent.click(chip);
    expect(useForeshadowNavStore.getState().pendingPanelHighlight).toBe("f4");
  });
});
