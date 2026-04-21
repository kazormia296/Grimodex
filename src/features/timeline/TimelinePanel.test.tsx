// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, act } from "@testing-library/react";
import { TimelinePanel } from "./TimelinePanel";
import { useTimelineStore } from "./timelineStore";

vi.mock("@/lib/tauri", () => ({ invoke: vi.fn() }));

vi.mock("@/features/tree/treeStore", () => ({
  useTreeStore: vi.fn((sel: (s: unknown) => unknown) =>
    sel({
      nodes: [],
      setActiveScene: vi.fn(),
      updateStoryTime: vi.fn(),
    }),
  ),
}));

vi.mock("@/features/layout/layoutStore", () => ({
  useLayoutStore: Object.assign(
    vi.fn((sel: (s: unknown) => unknown) => sel({ dockviewApi: null })),
    { getState: () => ({ dockviewApi: null }) },
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

function resetStore() {
  useTimelineStore.setState({
    axisMode: "reading",
    spacingMode: "uniform",
    zoom: 1,
    scrollOffset: 0,
    selectedNodeIds: [],
    inspectorOpen: false,
    display: {
      showTitles: true,
      showChapterNumbers: true,
      showPhasePins: false,
    },
  });
}

describe("TimelinePanel – isContentEditable keydown ガード (#5)", () => {
  beforeEach(resetStore);

  it("INPUT にフォーカスがある間は Ctrl+= で zoom が変わらない", () => {
    render(<TimelinePanel />);
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();

    act(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "=",
          ctrlKey: true,
          bubbles: true,
        }),
      );
    });

    expect(useTimelineStore.getState().zoom).toBe(1);
    document.body.removeChild(input);
  });

  it("TEXTAREA にフォーカスがある間は Ctrl+- で zoom が変わらない", () => {
    render(<TimelinePanel />);
    const ta = document.createElement("textarea");
    document.body.appendChild(ta);
    ta.focus();

    act(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "-",
          ctrlKey: true,
          bubbles: true,
        }),
      );
    });

    expect(useTimelineStore.getState().zoom).toBe(1);
    document.body.removeChild(ta);
  });

  it("contentEditable 要素にフォーカスがある間は Ctrl+0 で zoom が変わらない", () => {
    render(<TimelinePanel />);
    const div = document.createElement("div");
    div.contentEditable = "true";
    document.body.appendChild(div);
    div.focus();

    act(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "0",
          ctrlKey: true,
          bubbles: true,
        }),
      );
    });

    expect(useTimelineStore.getState().zoom).toBe(1);
    document.body.removeChild(div);
  });

  it("フォーカスなしの状態では Ctrl+= で zoom が増加する", () => {
    render(<TimelinePanel />);
    // body にフォーカスを戻す (input 系でない)
    (document.activeElement as HTMLElement | null)?.blur?.();

    act(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "=",
          ctrlKey: true,
          bubbles: true,
        }),
      );
    });

    expect(useTimelineStore.getState().zoom).toBeGreaterThan(1);
  });
});
