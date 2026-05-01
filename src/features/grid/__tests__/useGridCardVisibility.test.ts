// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import type { TreeNodeData } from "@/features/tree/treeStore";

vi.mock("@/features/codex/codexStore", () => ({
  useCodexStore: vi.fn((selector: (s: unknown) => unknown) =>
    selector({ entries: [] }),
  ),
}));

import { useCodexStore } from "@/features/codex/codexStore";
import { useGridCardVisibility } from "../useGridCardVisibility";

// Typed as unknown to sidestep Zustand's overloaded store signature in mocks
const mockUseCodexStore = useCodexStore as unknown as {
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
    label: null,
    ...overrides,
  } as TreeNodeData;
}

const DEFAULT_FILTER = {
  emptyOnly: false,
  hideCompleted: false,
  codexFilter: null as string | null,
};

beforeEach(() => {
  vi.clearAllMocks();

  mockUseCodexStore.mockImplementation((selector) => selector({ entries: [] }));
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
