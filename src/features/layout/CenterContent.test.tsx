// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render } from "@testing-library/react";

vi.mock("./EditorArea", () => ({
  EditorArea: () => <div data-testid="editor-area" />,
}));

vi.mock("./SlotView", () => ({
  SlotView: ({ panelId }: { panelId: string }) => (
    <div data-mock-slot-view={panelId} />
  ),
}));

vi.mock("./AnimatedSlotPanel", () => ({
  AnimatedSlotPanel: ({ panelId }: { panelId: string }) => (
    <div data-mock-animated-slot-panel={panelId} />
  ),
}));

import { CenterContent } from "./CenterContent";
import { useLayoutStore } from "./layoutStore";
import { buildDefaultLayoutState } from "./layoutStateUtils";

describe("CenterContent", () => {
  beforeEach(() => {
    useLayoutStore.setState({
      layout: buildDefaultLayoutState({ editorOpen: true }),
      layoutLocked: false,
      draggingPanel: null,
      dragOverTarget: null,
      panelDragSource: null,
      activePresetId: null,
      customPresets: [],
      initialized: false,
      hiddenStripePanels: new Set(),
    });
  });

  it("renders editor segment when editor is open", () => {
    const { getByTestId } = render(<CenterContent />);
    expect(getByTestId("editor-area")).toBeTruthy();
  });

  it("hides editor segment when editor is closed", () => {
    useLayoutStore.getState().setEditorOpen(false);
    const { container } = render(<CenterContent />);
    expect(
      container.querySelector('[data-center-segment-kind="editor"]'),
    ).toBeNull();
  });

  it("marks tool segments as Glass hosts while leaving the Editor on its own surface", () => {
    const layout = buildDefaultLayoutState({ editorOpen: true });
    layout.center.segments.push({
      id: "center-chat",
      kind: "tool",
      sizeRatio: 1,
      panels: ["chat"],
      activePanel: "chat",
    });
    useLayoutStore.setState({ layout });

    const { container } = render(<CenterContent />);
    const tool = container.querySelector(
      '[data-center-segment-kind="tool"]',
    );
    const editor = container.querySelector(
      '[data-center-segment-kind="editor"]',
    );

    expect(tool).toHaveAttribute("data-ambient-glass-surface", "panel");
    expect(tool?.classList.contains("gx-panel")).toBe(true);
    expect(editor).not.toHaveAttribute("data-ambient-glass-surface");
  });
});
