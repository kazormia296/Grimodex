// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render } from "@testing-library/react";
import { TimelinePanel } from "./TimelinePanel";
import { useTimelineStore } from "./timelineStore";
import { usePlotThreadStore } from "@/features/plot-threads/plotThreadStore";

vi.mock("@/lib/tauri", () => ({ invoke: vi.fn(), isTauri: () => false }));

const mkScene = (id: string, so: string, title: string) => ({
  id,
  projectId: "p1",
  parentId: null,
  nodeType: "scene" as const,
  title,
  synopsis: null,
  intent: null,
  sortOrder: so,
  status: "draft",
  storyTimeOrder: null,
  storyTimeLabel: null,
  povCharacterId: null,
  locationId: null,
  createdAt: "2024-01-01T00:00:00Z",
  updatedAt: "2024-01-01T00:00:00Z",
});
const sceneNodes = [
  mkScene("s1", "a0", "Scene 1"),
  mkScene("s2", "a1", "Scene 2"),
  mkScene("s3", "a2", "Scene 3"),
  mkScene("s4", "a3", "Scene 4"),
  mkScene("s5", "a4", "Scene 5"),
];

vi.mock("@/features/editor/tabStore", () => ({
  useTabStore: Object.assign(
    vi.fn((sel: (s: unknown) => unknown) =>
      sel({
        openPinned: vi.fn(),
        openInSecondaryGroup: vi.fn(),
        openPreview: vi.fn(),
      }),
    ),
    { getState: () => ({ openPinned: vi.fn() }) },
  ),
}));

vi.mock("@/features/tree/treeStore", () => ({
  useTreeStore: vi.fn((sel: (s: unknown) => unknown) =>
    sel({
      nodes: sceneNodes,
      setActiveScene: vi.fn(),
      updateStoryTime: vi.fn(),
      deleteNode: vi.fn(),
    }),
  ),
}));

vi.mock("@/features/layout/layoutStore", () => ({
  useLayoutStore: Object.assign(
    vi.fn((sel: (s: unknown) => unknown) => sel({ showPanel: vi.fn() })),
    { getState: () => ({ showPanel: vi.fn() }) },
  ),
}));

vi.mock("@/features/codex/phaseResolver", () => ({
  computeGlobalSceneOrder: vi.fn(() => new Map()),
}));
vi.mock("@/features/codex/phaseStore", () => ({
  usePhaseStore: vi.fn((sel: (s: unknown) => unknown) =>
    sel({ phasesByEntry: {} }),
  ),
}));
vi.mock("@/features/codex/codexStore", () => ({
  useCodexStore: vi.fn((sel: (s: unknown) => unknown) => sel({ entries: [] })),
}));
vi.mock("fractional-indexing", () => ({
  generateKeyBetween: vi.fn(() => "a0"),
}));

describe("TimelinePanel inspector repro (Phase B)", () => {
  beforeEach(() => {
    useTimelineStore.setState({
      axisMode: "reading",
      spacingMode: "uniform",
      zoom: 1,
      scrollOffset: 0,
      selectedNodeIds: [],
      inspectorOpen: true,
      showThreads: true,
      selectedPlotThreadId: "t1",
      selectedPlotLinkId: null,
      pendingEditNodeId: null,
      display: {
        showTitles: true,
        showChapterNumbers: true,
        showPhasePins: false,
        showThreadGaps: false,
        showStructureAnalysis: false,
      },
    });
    const th = (
      id: string,
      so: string,
      extra: Record<string, unknown> = {},
    ) => ({
      id,
      projectId: "p1",
      name: id,
      color: null,
      description: null,
      sortOrder: so,
      startNodeId: null,
      endNodeId: null,
      version: 0,
      createdAt: "",
      updatedAt: "",
      ...extra,
    });
    const lk = (id: string, threadId: string, nodeId: string) => ({
      id,
      threadId,
      nodeId,
      phaseType: "introduce" as const,
      note: null,
      sortOrder: null,
      semanticKey: "",
      version: 0,
      createdAt: "",
      updatedAt: "",
    });
    usePlotThreadStore.setState({
      // a,b は s1..s3 で並走 → 束ね。c は a から分岐＋自走終端。d は override 付き。
      threads: [
        th("t1", "a0", { name: "復讐の糸" }),
        th("b", "a1"),
        th("c", "a2"),
        th("d", "a3", { startNodeId: "s1", endNodeId: "s5" }),
      ],
      links: [
        lk("la1", "t1", "s1"),
        lk("la2", "t1", "s2"),
        lk("la3", "t1", "s3"),
        lk("lb1", "b", "s1"),
        lk("lb2", "b", "s2"),
        lk("lb3", "b", "s3"),
        lk("lc1", "c", "s3"),
        lk("lc2", "c", "s5"),
        lk("ld1", "d", "s3"),
      ],
      branches: [
        {
          id: "br1",
          projectId: "p1",
          fromThreadId: "t1",
          toThreadId: "c",
          atNodeId: "s3",
          kind: "branch" as const,
          semanticKey: "",
          version: 0,
          createdAt: "",
          updatedAt: "",
        },
      ],
      loading: false,
    });
  });

  it("束ね/分岐/終端/override がある状態でインスペクタを開いても落ちない", () => {
    const { getByTestId } = render(<TimelinePanel />);
    const inspector = getByTestId("plot-marker-inspector");
    expect(inspector).toBeTruthy();
    // インスペクタにスレッド編集 UI が出ている（空でない）
    expect(inspector.textContent).toContain("名前");
    // 名前入力に thread 名が入っている（input value は textContent に出ないため value で確認）
    const nameInput = inspector.querySelector("input") as HTMLInputElement;
    expect(nameInput.value).toBe("復讐の糸");
    // ビューポートも描画されている（束ね線/マーカー）
    expect(getByTestId("timeline-panel")).toBeTruthy();
  });

  it("Splitter は固定幅 box で包む（flex-row 直置きだと w-full でビューポートが 0 幅に潰れタイムライン全体が空白になる回帰の gate）", () => {
    const { container } = render(<TimelinePanel />);
    const handle = container.querySelector(
      "[data-splitter-handle]",
    ) as HTMLElement | null;
    expect(handle).toBeTruthy();
    // SplitterHandle(w-full) は固定 px 幅の親 box の内側になければならない。
    const wrapper = handle!.parentElement as HTMLElement;
    expect(wrapper.style.width).toMatch(/px$/);
    // 親 box は flex-row のメイン軸を食わないよう shrink-0。
    expect(wrapper.className).toContain("shrink-0");
  });
});
