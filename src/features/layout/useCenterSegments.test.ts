// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { renderHook } from "@testing-library/react";
import { useCenterSegments } from "./useCenterSegments";
import { useLayoutStore } from "./layoutStore";
import {
  buildCenterSegmentsWithTools,
  buildDefaultLayoutState,
  DEFAULT_EDITOR_SEGMENT_ID,
} from "./layoutStateUtils";

describe("useCenterSegments", () => {
  it("includes the editor segment with open state from editorOpen", () => {
    useLayoutStore.setState({
      layout: buildDefaultLayoutState({ editorOpen: true }),
      hiddenStripePanels: new Set(),
    });

    const { result } = renderHook(() => useCenterSegments());
    const editor = result.current.find((s) => s.kind === "editor");
    expect(editor).toBeDefined();
    expect(editor?.open).toBe(true);
    expect(editor?.slotId).toBe(DEFAULT_EDITOR_SEGMENT_ID);
  });

  it("marks editor segment collapsed when editor is closed", () => {
    useLayoutStore.setState({
      layout: buildDefaultLayoutState({ editorOpen: false }),
      hiddenStripePanels: new Set(),
    });

    const { result } = renderHook(() => useCenterSegments());
    const editor = result.current.find((s) => s.kind === "editor");
    expect(editor?.open).toBe(false);
  });

  it("preserves center.segments order with tool segments before editor", () => {
    const center = buildCenterSegmentsWithTools(["kouetsu", "codex"], {
      kouetsu: true,
      codex: true,
    });
    const toolFirst = [center[1], center[2], center[0]];

    useLayoutStore.setState({
      layout: {
        ...buildDefaultLayoutState({ editorOpen: true }),
        center: {
          editorOpen: true,
          segments: toolFirst,
        },
      },
      hiddenStripePanels: new Set(),
    });

    const { result } = renderHook(() => useCenterSegments());
    expect(result.current.map((s) => s.kind)).toEqual([
      "tool",
      "tool",
      "editor",
    ]);
  });
});
