// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import type { TreeNodeData } from "@/features/tree/treeStore";

vi.mock("@/features/codex/codexStore", () => ({
  useCodexStore: vi.fn((selector: (s: unknown) => unknown) =>
    selector({ entries: [] }),
  ),
}));

vi.mock("@/features/labels/labelStore", () => ({
  useLabelStore: vi.fn((selector: (s: unknown) => unknown) =>
    selector({ nodeLabels: {} }),
  ),
}));

import { useCodexStore } from "@/features/codex/codexStore";
import { useLabelStore } from "@/features/labels/labelStore";
import { useGridCardVisibility } from "../useGridCardVisibility";

// Typed as unknown to sidestep Zustand's overloaded store signature in mocks
const mockUseCodexStore = useCodexStore as unknown as {
  mockImplementation: (
    fn: (selector: (s: unknown) => unknown) => unknown,
  ) => void;
};
const mockUseLabelStore = useLabelStore as unknown as {
  mockImplementation: (
    fn: (selector: (s: unknown) => unknown) => unknown,
  ) => void;
};

function makeScene(
  id: string,
  overrides: Partial<TreeNodeData> = {},
): TreeNodeData {
  return {
    id,
    title: `Scene ${id}`,
    nodeType: "scene",
    parentId: null,
    order: 0,
    charCount: 0,
    status: "draft",
    synopsis: null,
    unplacedBeatPreview: null,
    placedBeatPreview: null,
    label: null,
    ...overrides,
  } as TreeNodeData;
}

const DEFAULT_FILTER = {
  emptyOnly: false,
  hideCompleted: false,
  codexFilter: null as string | null,
  labelFilter: [] as string[],
};

beforeEach(() => {
  vi.clearAllMocks();

  mockUseCodexStore.mockImplementation((selector) => selector({ entries: [] }));
  mockUseLabelStore.mockImplementation((selector) =>
    selector({ nodeLabels: {} }),
  );
});

describe("useGridCardVisibility — 検索", () => {
  it("検索クエリが空のとき全カード matchesSearch=true", () => {
    const scenes = [makeScene("s1"), makeScene("s2")];
    const { result } = renderHook(() =>
      useGridCardVisibility({
        scenes,
        searchQuery: "",
        filter: DEFAULT_FILTER,
        charCounts: {},
        pinsByScene: {},
      }),
    );
    expect(result.current.get("s1")?.matchesSearch).toBe(true);
    expect(result.current.get("s2")?.matchesSearch).toBe(true);
  });

  it("タイトルが一致するとき matchesSearch=true", () => {
    const scenes = [
      makeScene("s1", { title: "序章" }),
      makeScene("s2", { title: "終章" }),
    ];
    const { result } = renderHook(() =>
      useGridCardVisibility({
        scenes,
        searchQuery: "序章",
        filter: DEFAULT_FILTER,
        charCounts: {},
        pinsByScene: {},
      }),
    );
    expect(result.current.get("s1")?.matchesSearch).toBe(true);
    expect(result.current.get("s2")?.matchesSearch).toBe(false);
  });

  it("synopsis が一致するとき matchesSearch=true", () => {
    const scenes = [
      makeScene("s1", { synopsis: "主人公が旅に出る" }),
      makeScene("s2", { synopsis: "敵が現れる" }),
    ];
    const { result } = renderHook(() =>
      useGridCardVisibility({
        scenes,
        searchQuery: "旅",
        filter: DEFAULT_FILTER,
        charCounts: {},
        pinsByScene: {},
      }),
    );
    expect(result.current.get("s1")?.matchesSearch).toBe(true);
    expect(result.current.get("s2")?.matchesSearch).toBe(false);
  });

  it("Beat プレビュー行が一致するとき matchesSearch=true", () => {
    const scenes = [
      makeScene("s1", {
        unplacedBeatPreview: JSON.stringify(["伏線を張る"]),
      }),
      makeScene("s2", {
        unplacedBeatPreview: JSON.stringify(["別の出来事"]),
      }),
    ];
    const { result } = renderHook(() =>
      useGridCardVisibility({
        scenes,
        searchQuery: "伏線",
        filter: DEFAULT_FILTER,
        charCounts: {},
        pinsByScene: {},
      }),
    );
    expect(result.current.get("s1")?.matchesSearch).toBe(true);
    expect(result.current.get("s2")?.matchesSearch).toBe(false);
  });

  it("Codex エントリ名が一致するとき matchesSearch=true", () => {
    mockUseCodexStore.mockImplementation((selector) =>
      selector({ entries: [{ id: "e1", name: "アリス" }] }),
    );
    const scenes = [makeScene("s1"), makeScene("s2")];
    const { result } = renderHook(() =>
      useGridCardVisibility({
        scenes,
        searchQuery: "アリス",
        filter: DEFAULT_FILTER,
        charCounts: {},
        pinsByScene: { s1: ["e1"] },
      }),
    );
    expect(result.current.get("s1")?.matchesSearch).toBe(true);
    expect(result.current.get("s2")?.matchesSearch).toBe(false);
  });
});

describe("useGridCardVisibility — フィルタ", () => {
  it("emptyOnly: 文字数が 0 のシーンだけ passesFilter=true", () => {
    const scenes = [makeScene("s1"), makeScene("s2", { charCount: 100 })];
    const { result } = renderHook(() =>
      useGridCardVisibility({
        scenes,
        searchQuery: "",
        filter: { ...DEFAULT_FILTER, emptyOnly: true },
        charCounts: {},
        pinsByScene: {},
      }),
    );
    expect(result.current.get("s1")?.passesFilter).toBe(true);
    expect(result.current.get("s2")?.passesFilter).toBe(false);
  });

  it("emptyOnly: charCounts をリアルタイム値として優先する", () => {
    const scenes = [makeScene("s1", { charCount: 0 })];
    const { result } = renderHook(() =>
      useGridCardVisibility({
        scenes,
        searchQuery: "",
        filter: { ...DEFAULT_FILTER, emptyOnly: true },
        charCounts: { s1: 500 },
        pinsByScene: {},
      }),
    );
    expect(result.current.get("s1")?.passesFilter).toBe(false);
  });

  it("hideCompleted: complete / final ステータスを非表示にする", () => {
    const scenes = [
      makeScene("s1", { status: "draft" }),
      makeScene("s2", { status: "complete" }),
      makeScene("s3", { status: "final" }),
    ];
    const { result } = renderHook(() =>
      useGridCardVisibility({
        scenes,
        searchQuery: "",
        filter: { ...DEFAULT_FILTER, hideCompleted: true },
        charCounts: {},
        pinsByScene: {},
      }),
    );
    expect(result.current.get("s1")?.passesFilter).toBe(true);
    expect(result.current.get("s2")?.passesFilter).toBe(false);
    expect(result.current.get("s3")?.passesFilter).toBe(false);
  });

  it("codexFilter: 指定 entryId を持つシーンだけ passesFilter=true", () => {
    const scenes = [makeScene("s1"), makeScene("s2")];
    const { result } = renderHook(() =>
      useGridCardVisibility({
        scenes,
        searchQuery: "",
        filter: { ...DEFAULT_FILTER, codexFilter: "e1" },
        charCounts: {},
        pinsByScene: { s1: ["e1", "e2"], s2: ["e2"] },
      }),
    );
    expect(result.current.get("s1")?.passesFilter).toBe(true);
    expect(result.current.get("s2")?.passesFilter).toBe(false);
  });
});

describe("useGridCardVisibility — labelFilter", () => {
  it("labelFilter が空のとき全シーン passesFilter=true", () => {
    const scenes = [makeScene("s1"), makeScene("s2")];
    const { result } = renderHook(() =>
      useGridCardVisibility({
        scenes,
        searchQuery: "",
        filter: { ...DEFAULT_FILTER, labelFilter: [] },
        charCounts: {},
        pinsByScene: {},
      }),
    );
    expect(result.current.get("s1")?.passesFilter).toBe(true);
    expect(result.current.get("s2")?.passesFilter).toBe(true);
  });

  it("labelFilter: 指定ラベルを持つシーンだけ passesFilter=true", () => {
    mockUseLabelStore.mockImplementation((selector) =>
      selector({ nodeLabels: { s1: ["label-a"], s2: ["label-b"] } }),
    );
    const scenes = [makeScene("s1"), makeScene("s2")];
    const { result } = renderHook(() =>
      useGridCardVisibility({
        scenes,
        searchQuery: "",
        filter: { ...DEFAULT_FILTER, labelFilter: ["label-a"] },
        charCounts: {},
        pinsByScene: {},
      }),
    );
    expect(result.current.get("s1")?.passesFilter).toBe(true);
    expect(result.current.get("s2")?.passesFilter).toBe(false);
  });

  it("labelFilter OR: A または B を持つシーンが通過する", () => {
    mockUseLabelStore.mockImplementation((selector) =>
      selector({
        nodeLabels: { s1: ["label-a"], s2: ["label-b"], s3: ["label-c"] },
      }),
    );
    const scenes = [makeScene("s1"), makeScene("s2"), makeScene("s3")];
    const { result } = renderHook(() =>
      useGridCardVisibility({
        scenes,
        searchQuery: "",
        filter: { ...DEFAULT_FILTER, labelFilter: ["label-a", "label-b"] },
        charCounts: {},
        pinsByScene: {},
      }),
    );
    expect(result.current.get("s1")?.passesFilter).toBe(true);
    expect(result.current.get("s2")?.passesFilter).toBe(true);
    expect(result.current.get("s3")?.passesFilter).toBe(false);
  });

  it("labelFilter AND emptyOnly: 両方満たすシーンだけ通過", () => {
    mockUseLabelStore.mockImplementation((selector) =>
      selector({ nodeLabels: { s1: ["label-a"], s2: ["label-a"] } }),
    );
    const scenes = [
      makeScene("s1", { charCount: 0 }),
      makeScene("s2", { charCount: 100 }),
    ];
    const { result } = renderHook(() =>
      useGridCardVisibility({
        scenes,
        searchQuery: "",
        filter: {
          ...DEFAULT_FILTER,
          labelFilter: ["label-a"],
          emptyOnly: true,
        },
        charCounts: {},
        pinsByScene: {},
      }),
    );
    expect(result.current.get("s1")?.passesFilter).toBe(true);
    expect(result.current.get("s2")?.passesFilter).toBe(false);
  });

  it("dangling ID: nodeLabels に存在しない ID では fail", () => {
    mockUseLabelStore.mockImplementation((selector) =>
      selector({ nodeLabels: { s1: ["label-a"] } }),
    );
    const scenes = [makeScene("s1"), makeScene("s2")];
    const { result } = renderHook(() =>
      useGridCardVisibility({
        scenes,
        searchQuery: "",
        filter: { ...DEFAULT_FILTER, labelFilter: ["nonexistent-label"] },
        charCounts: {},
        pinsByScene: {},
      }),
    );
    expect(result.current.get("s1")?.passesFilter).toBe(false);
    expect(result.current.get("s2")?.passesFilter).toBe(false);
  });
});
