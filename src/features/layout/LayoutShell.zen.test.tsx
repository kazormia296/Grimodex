// @vitest-environment happy-dom
import { act, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PanelId } from "./panelIds";

vi.mock("@/lib/tauri", () => ({
  invoke: vi.fn(),
  isTauri: () => false,
}));

vi.mock("./panelComponents", () => ({
  PANEL_COMPONENT_MAP: new Proxy(
    {},
    {
      get: (_target, prop) => () => (
        <div data-stub-panel={String(prop) as PanelId} />
      ),
    },
  ),
}));

vi.mock("./EditorArea", () => ({
  EditorArea: () => <div data-editor-area />,
}));

import { LayoutShell } from "./LayoutShell";
import { buildDefaultLayoutState } from "./layoutStateUtils";
import { useLayoutStore } from "./layoutStore";

describe("LayoutShell Zen projection", () => {
  beforeEach(() => {
    const layout = buildDefaultLayoutState({ editorOpen: true });
    layout.center.segments.push({
      id: "zen-tool",
      kind: "tool",
      sizeRatio: 1,
      panels: ["chat"],
      activePanel: "chat",
    });
    useLayoutStore.setState({
      layout,
      layoutLocked: false,
      draggingPanel: null,
      dragOverTarget: null,
      hiddenStripePanels: new Set(),
      activePresetId: "builtin:default",
      customPresets: [],
      initialized: true,
      maximizedPanelId: null,
    });
  });

  it("projects the existing editor to the full layout without remounting or mutating layout state", () => {
    const { container, rerender } = render(<LayoutShell zenMode={false} />);
    const editor = container.querySelector("[data-editor-area]");
    const centerTool = container.querySelector<HTMLElement>(
      '[data-center-segment="zen-tool"]',
    );
    const left = container.querySelector<HTMLElement>(
      '[data-zoom-cell="left"]',
    );
    const layoutBefore = useLayoutStore.getState().layout;

    expect(editor).not.toBeNull();
    expect(centerTool).not.toBeNull();
    expect(left).not.toBeNull();

    act(() => rerender(<LayoutShell zenMode />));

    expect(container.querySelector("[data-editor-area]")).toBe(editor);
    expect(centerTool).toHaveStyle({ visibility: "hidden" });
    expect(left).toHaveAttribute("aria-hidden", "true");
    expect(container.querySelector("[data-zoom-restore-bar]")).toBeNull();
    expect(useLayoutStore.getState().layout).toBe(layoutBefore);
    expect(useLayoutStore.getState().maximizedPanelId).toBeNull();

    act(() => rerender(<LayoutShell zenMode={false} />));

    expect(container.querySelector("[data-editor-area]")).toBe(editor);
    expect(centerTool).not.toHaveStyle({ visibility: "hidden" });
    expect(left).not.toHaveAttribute("aria-hidden");
  });
});
