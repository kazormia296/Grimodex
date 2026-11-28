// @vitest-environment happy-dom
// 作中時間の軸の場面の点：押して離すだけでは保存せず、置けない場所への
// 落とし込みは例外を出さずに無視する。保存（updateNode）と undo の履歴まで見る。
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import { TimelinePanel } from "./TimelinePanel";
import { useTimelineStore } from "./timelineStore";
import { useTreeStore, type TreeNodeData } from "@/features/tree/treeStore";
import { useGlobalHistoryStore } from "@/store/globalHistoryStore";
import { cmpKeys } from "@/features/tree/fractionalIndex";

const { saved, updateNode } = vi.hoisted(() => {
  const saved = async (
    id: string,
    _data: unknown,
    _options?: { writeContext?: unknown },
  ) => ({ updatedAt: "2024-01-02T00:00:00Z", receipt: id });
  return { saved, updateNode: vi.fn(saved) };
});

vi.mock("@/lib/tauri", () => ({ invoke: vi.fn(), isTauri: () => false }));
vi.mock("@/features/tree/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/tree/api")>()),
  updateNode,
  treeWriteReceipt: vi.fn((result?: { receipt: string }) => result?.receipt),
  historyWriteContext: vi.fn((origin: string, receipt: string) => ({
    origin,
    receipt,
  })),
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
    updateNode.mockReset();
    updateNode.mockImplementation(saved);
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

  const orders = () =>
    Object.fromEntries(
      useTreeStore.getState().nodes.map((n) => [n.id, n.storyTimeOrder]),
    );
  const visible = () =>
    useTreeStore
      .getState()
      .nodes.filter((n) => n.storyTimeOrder !== null)
      .sort((a, b) => cmpKeys(a.storyTimeOrder!, b.storyTimeOrder!))
      .map((n) => n.id);

  it("同じ値の間に落とすと、後ろの同値の場面を振り直して間に置く", async () => {
    const { point } = setup({ s1: "a1", s2: "a1", s3: "a1", s4: "a2" });
    await press(point("s4"), between(point("s1"), point("s2")));
    await waitFor(() => expect(updateNode).toHaveBeenCalledTimes(3));
    // 後ろの場面から書き、落とした場面は最後。
    expect(updateNode.mock.calls.map(([id]) => id)).toEqual(["s3", "s2", "s4"]);
    expect(visible()).toEqual(["s1", "s4", "s2", "s3"]);
    const after = orders();
    expect(after.s1).toBe("a1");
    expect(after.s2).toBe(after.s3);
    expect(errors).toEqual([]);
  });

  it("振り直した場面も、元に戻す 1 回で一緒に戻り、やり直せる", async () => {
    const { point } = setup({ s1: "a1", s2: "a1", s3: "a1", s4: "a2" });
    const before = orders();
    await press(point("s4"), between(point("s1"), point("s2")));
    await waitFor(() =>
      expect(useGlobalHistoryStore.getState().past).toHaveLength(1),
    );
    const after = orders();

    updateNode.mockClear();
    await act(() => useGlobalHistoryStore.getState().undo());
    expect(orders()).toEqual(before);
    expect(useGlobalHistoryStore.getState().past).toHaveLength(0);
    // 逆順に戻し、それぞれ自分の書き込みの受領票を使う。
    expect(
      updateNode.mock.calls.map(([id, , options]) => [
        id,
        options?.writeContext,
      ]),
    ).toEqual([
      ["s4", { origin: "undo", receipt: "s4" }],
      ["s2", { origin: "undo", receipt: "s2" }],
      ["s3", { origin: "undo", receipt: "s3" }],
    ]);

    await act(() => useGlobalHistoryStore.getState().redo());
    expect(orders()).toEqual(after);
  });

  it("振り直しの途中で失敗したら残りを書かず、済んだ分は元に戻せる", async () => {
    const { point } = setup({ s1: "a1", s2: "a1", s3: "a1", s4: "a2" });
    const before = orders();
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);
    process.on("unhandledRejection", onRejection);
    try {
      updateNode.mockImplementationOnce(saved);
      updateNode.mockImplementationOnce(async () => {
        throw new Error("write failed");
      });
      await press(point("s4"), between(point("s1"), point("s2")));
      await waitFor(() => expect(rejections).toHaveLength(1));
    } finally {
      process.off("unhandledRejection", onRejection);
    }
    expect(updateNode.mock.calls.map(([id]) => id)).toEqual(["s3", "s2"]);
    // 書けたのは後ろの 1 件だけで、表示順は変わらない。
    expect(visible()).toEqual(["s1", "s2", "s3", "s4"]);
    expect(useGlobalHistoryStore.getState().past).toHaveLength(1);
    await act(() => useGlobalHistoryStore.getState().undo());
    expect(orders()).toEqual(before);
  });

  it("同じ値の場面を元と同じ順番に落とし直しても、何も保存しない", async () => {
    const { point } = setup({ s1: "a1", s2: "a1", s3: "a1" });
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
    expectNothingSaved();
  });

  it("同じ値の上の隣が読めない形なら、振り直さず何も保存しない", async () => {
    const { point } = setup({
      s1: "a1",
      s2: "a1",
      s3: "a2000000000000",
      s4: null,
    });
    await press(point("s4"), between(point("s1"), point("s2")));
    expectNothingSaved();
  });

  it("読めない形の印の隣に落としても、例外を出さず何も保存しない", async () => {
    // 取り込みが作る形（末尾が 0 の長いキー）。fractional-indexing は拒む。
    const { point } = setup({ s1: "a000000000000", s2: "a1", s3: "a2" });
    await press(point("s3"), between(point("s1"), point("s2")));
    expectNothingSaved();
  });
});
