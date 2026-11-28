// @vitest-environment happy-dom
// 作中時間の軸の場面の点：押して離すだけでは保存せず、置けない場所への
// 落とし込みは例外を出さずに無視する。保存（updateNode）と undo の履歴まで見る。
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { TimelinePanel } from "./TimelinePanel";
import { useTimelineStore } from "./timelineStore";
import { useTreeStore, type TreeNodeData } from "@/features/tree/treeStore";
import { useGlobalHistoryStore } from "@/store/globalHistoryStore";

const updateNode = vi.hoisted(() =>
  vi.fn(async () => ({ updatedAt: "2024-01-02T00:00:00Z" })),
);

vi.mock("@/lib/tauri", () => ({ invoke: vi.fn(), isTauri: () => false }));
vi.mock("@/features/tree/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/tree/api")>()),
  updateNode,
  treeWriteReceipt: vi.fn(() => undefined),
  historyWriteContext: vi.fn(),
}));
vi.mock("@/features/layout/layoutStore", () => ({
  useLayoutStore: Object.assign(
    vi.fn((sel: (s: unknown) => unknown) => sel({ showPanel: vi.fn() })),
    { getState: () => ({ showPanel: vi.fn() }) },
  ),
}));
vi.mock("@/features/codex/phaseStore", () => ({
  usePhaseStore: Object.assign(
    vi.fn((sel: (s: unknown) => unknown) => sel({ phasesByEntry: {} })),
    {
      getState: () => ({ phasesByEntry: {}, recomputeSceneOrder: vi.fn() }),
      setState: vi.fn(),
    },
  ),
}));
vi.mock("@/features/codex/codexStore", () => ({
  useCodexStore: Object.assign(
    vi.fn((sel: (s: unknown) => unknown) => sel({ entries: [] })),
    { getState: () => ({ entries: [] }) },
  ),
}));

const scene = (
  id: string,
  storyTimeOrder: string | null,
  index: number,
): TreeNodeData =>
  ({
    id,
    projectId: "p1",
    parentId: null,
    nodeType: "scene",
    title: id,
    synopsis: null,
    intent: null,
    sortOrder: `a${index}`,
    status: "draft",
    storyTimeOrder,
    storyTimeLabel: null,
    povCharacterId: null,
    locationId: null,
    createdAt: `2024-01-01T00:00:0${index}Z`,
    updatedAt: "2024-01-01T00:00:00Z",
  }) as unknown as TreeNodeData;

function setup(orders: Record<string, string | null>) {
  useTreeStore.setState({
    nodes: Object.entries(orders).map(([id, order], i) => scene(id, order, i)),
  });
  const view = render(<TimelinePanel isActive />);
  const point = (id: string) => {
    const dot = view.getByTestId(`timeline-scene-dot-${id}`);
    return {
      dot,
      x: Number(dot.getAttribute("cx")),
      y: Number(dot.getAttribute("cy")),
    };
  };
  return { point };
}

type Point = { x: number; y: number };

/** mousedown → (任意で mousemove) → mouseup。 */
async function press(
  from: Point & { dot: Element },
  to: Point = from,
  init: { shiftKey?: boolean; ctrlKey?: boolean; move?: boolean } = {},
) {
  const { move = to !== from, ...keys } = init;
  await act(async () => {
    fireEvent.mouseDown(from.dot, {
      button: 0,
      clientX: from.x,
      clientY: from.y,
      ...keys,
    });
    if (move) {
      fireEvent.mouseMove(document, { clientX: to.x, clientY: to.y, ...keys });
    }
    fireEvent.mouseUp(document, {
      button: 0,
      clientX: to.x,
      clientY: to.y,
      ...keys,
    });
  });
}

const between = (a: Point, b: Point): Point => ({
  x: (a.x + b.x) / 2,
  y: a.y,
});

const errors: unknown[] = [];
const onError = (event: ErrorEvent) => {
  errors.push(event.error ?? event.message);
  event.preventDefault();
};

describe("TimelinePanel – 作中時間の軸の点の押下とドラッグ", () => {
  beforeEach(() => {
    updateNode.mockClear();
    errors.length = 0;
    window.addEventListener("error", onError);
    useGlobalHistoryStore.getState().clear();
    useTimelineStore.setState({
      axisMode: "story",
      spacingMode: "uniform",
      zoom: 1,
      scrollOffset: 0,
      selectedNodeIds: [],
      inspectorOpen: false,
      pendingEditNodeId: null,
      showThreads: false,
    });
  });

  afterEach(() => {
    window.removeEventListener("error", onError);
    cleanup();
  });

  const expectNothingSaved = () => {
    expect.soft(updateNode.mock.calls).toEqual([]);
    expect.soft(useGlobalHistoryStore.getState().past).toHaveLength(0);
    expect.soft(errors).toEqual([]);
  };

  it.each([
    ["先頭", "s1"],
    ["中央", "s2"],
    ["末尾", "s3"],
  ])("%sの点を押して離すだけでは保存しない", async (_label, id) => {
    const { point } = setup({ s1: "a0", s2: "a2", s3: "a4" });
    await press(point(id));
    expectNothingSaved();
  });

  it("未配置の点を押して離すだけでは保存しない", async () => {
    const { point } = setup({ s1: "a0", s2: "a1", s3: null });
    await press(point("s3"));
    expectNothingSaved();
  });

  it("同じ印の場面の片方を押して離しても、印は変わらない", async () => {
    const { point } = setup({ s1: "a1", s2: "a1", s3: "a2" });
    await press(point("s1"));
    expectNothingSaved();
  });

  it("両隣が同じ印の点を押して離しても、例外が出ない", async () => {
    const { point } = setup({ s1: "a1", s2: "a1", s3: "a1" });
    await press(point("s2"));
    expectNothingSaved();
  });

  it.each([
    ["Shift", { shiftKey: true }],
    ["Ctrl", { ctrlKey: true }],
  ])("%s を押した選択の操作では保存しない", async (_label, keys) => {
    const { point } = setup({ s1: "a0", s2: "a2", s3: "a4" });
    await press(point("s2"), undefined, keys);
    expectNothingSaved();
  });

  it("しきい値以内の手ぶれでは保存しない", async () => {
    const { point } = setup({ s1: "a0", s2: "a2", s3: "a4" });
    const from = point("s2");
    await press(from, { x: from.x + 4, y: from.y - 4 });
    expectNothingSaved();
  });

  it("しきい値を超えて動かして落とすと、落とした場所の印を保存する", async () => {
    const { point } = setup({ s1: "a0", s2: "a2", s3: "a4" });
    await press(point("s3"), between(point("s1"), point("s2")));
    expect(updateNode.mock.calls).toEqual([["s3", { storyTimeOrder: "a1" }]]);
    expect(useGlobalHistoryStore.getState().past).toHaveLength(1);
  });

  it("mousemove が来なくても、離れた場所で離せば保存する", async () => {
    const { point } = setup({ s1: "a0", s2: "a2", s3: "a4" });
    await press(point("s3"), between(point("s1"), point("s2")), {
      move: false,
    });
    expect(updateNode.mock.calls).toEqual([["s3", { storyTimeOrder: "a1" }]]);
  });

  it("押したまま画面が横に流れても、ポインタを動かしていなければ保存しない", async () => {
    const { point } = setup({ s1: "a0", s2: "a2", s3: "a4" });
    const from = point("s2");
    const container = from.dot.closest(
      '[data-testid="timeline-scroll-container"]',
    ) as HTMLElement;
    await act(async () => {
      fireEvent.mouseDown(from.dot, {
        button: 0,
        clientX: from.x,
        clientY: from.y,
      });
      container.scrollLeft = 200;
      fireEvent.mouseUp(document, {
        button: 0,
        clientX: from.x,
        clientY: from.y,
      });
    });
    expect(container.scrollLeft).toBe(200);
    expectNothingSaved();
  });

  it("一度しきい値を超えれば、押した位置の近くで離してもドラッグとして扱う", async () => {
    const { point } = setup({ s1: "a0", s2: "a2", s3: "a4" });
    const from = point("s2");
    await act(async () => {
      fireEvent.mouseDown(from.dot, {
        button: 0,
        clientX: from.x,
        clientY: from.y,
      });
      fireEvent.mouseMove(document, { clientX: from.x + 40, clientY: from.y });
      fireEvent.mouseUp(document, {
        button: 0,
        clientX: from.x,
        clientY: from.y,
      });
    });
    expect(updateNode).toHaveBeenCalledTimes(1);
  });

  it("同じ印の場面の間に落としても、例外を出さず何も保存しない", async () => {
    const { point } = setup({ s1: "a1", s2: "a1", s3: "a2" });
    await press(point("s3"), between(point("s1"), point("s2")));
    expectNothingSaved();
  });

  it("読めない形の印の隣に落としても、例外を出さず何も保存しない", async () => {
    // 取り込みが作る形（末尾が 0 の長いキー）。fractional-indexing は拒む。
    const { point } = setup({ s1: "a000000000000", s2: "a1", s3: "a2" });
    await press(point("s3"), between(point("s1"), point("s2")));
    expectNothingSaved();
  });
});
