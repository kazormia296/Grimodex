// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { useLayoutStore } from "./layoutStore";
import {
  buildDefaultLayoutState,
  DEFAULT_EDITOR_SEGMENT_ID,
} from "./layoutStateUtils";

vi.mock("@/lib/tauri", () => ({
  invoke: vi.fn(),
}));

function setEditorOnlyCenter(viewportWidth: number) {
  vi.stubGlobal("innerWidth", viewportWidth);
  vi.stubGlobal("innerHeight", 800);
  useLayoutStore.setState({
    layout: {
      ...buildDefaultLayoutState({ allInactive: true, editorOpen: true }),
      center: {
        editorOpen: true,
        segments: [
          { id: DEFAULT_EDITOR_SEGMENT_ID, kind: "editor", sizeRatio: 1 },
        ],
      },
    },
    layoutLocked: false,
    draggingPanel: null,
    dragOverTarget: null,
    hiddenStripePanels: new Set(),
  });
}

describe("movePanelToNewSlot — center editor min-width guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects a new center slot when the editor would drop below min width", () => {
    setEditorOnlyCenter(400);

    useLayoutStore.getState().movePanelToNewSlot("scenes", "center", 1);

    const segments = useLayoutStore.getState().layout.center.segments;
    expect(segments).toHaveLength(1);
    expect(
      segments.some((s) => s.kind === "tool" && s.panels.includes("scenes")),
    ).toBe(false);
    vi.unstubAllGlobals();
  });

  it("allows a new center slot when the editor keeps its min width", () => {
    setEditorOnlyCenter(1600);

    useLayoutStore.getState().movePanelToNewSlot("scenes", "center", 1);

    expect(
      useLayoutStore
        .getState()
        .layout.center.segments.some(
          (s) => s.kind === "tool" && s.panels.includes("scenes"),
        ),
    ).toBe(true);
    vi.unstubAllGlobals();
  });
});
