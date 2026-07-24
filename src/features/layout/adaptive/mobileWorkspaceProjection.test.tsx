// @vitest-environment happy-dom
import { act, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "@/features/settings/types";
import { useSettingsStore } from "@/features/settings/settingsStore";
import type { PanelId } from "../panelIds";

vi.mock("@/lib/tauri", () => ({
  invoke: vi.fn(),
  isTauri: () => false,
}));

vi.mock("../panelComponents", () => ({
  PANEL_COMPONENT_MAP: new Proxy(
    {},
    {
      get: (_target, prop) => () => (
        <div data-stub-panel={String(prop) as PanelId} />
      ),
    },
  ),
}));

vi.mock("../EditorArea", () => ({
  EditorArea: () => <div data-editor-area />,
}));

import { LayoutShell } from "../LayoutShell";
import { buildDefaultLayoutState } from "../layoutStateUtils";
import { useLayoutStore } from "../layoutStore";

describe("phone editor projection", () => {
  beforeEach(() => {
    const layout = buildDefaultLayoutState({ editorOpen: true });
    layout.center.segments.push({
      id: "phone-tool",
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
    useSettingsStore.setState({ cache: { ...DEFAULT_SETTINGS } });
  });

  it("projects only the mounted editor without enabling Zen or mutating the saved layout", () => {
    const { container, rerender } = render(
      <LayoutShell editorOnly={false} />,
    );
    const editor = container.querySelector("[data-editor-area]");
    const centerTool = container.querySelector<HTMLElement>(
      '[data-center-segment="phone-tool"]',
    );
    const left = container.querySelector<HTMLElement>(
      '[data-zoom-cell="left"]',
    );
    const layoutBefore = useLayoutStore.getState().layout;

    act(() => rerender(<LayoutShell editorOnly />));

    const shell = container.querySelector("[data-layout-shell]");
    expect(container.querySelector("[data-editor-area]")).toBe(editor);
    expect(shell).toHaveAttribute("data-editor-only", "true");
    expect(shell).not.toHaveAttribute("data-zen-mode");
    expect(centerTool).toHaveStyle({ visibility: "hidden" });
    expect(left).toHaveAttribute("aria-hidden", "true");
    expect(left).toHaveAttribute("inert");
    expect(useLayoutStore.getState().layout).toBe(layoutBefore);
    expect(useLayoutStore.getState().maximizedPanelId).toBeNull();

    act(() => rerender(<LayoutShell editorOnly={false} />));

    expect(container.querySelector("[data-editor-area]")).toBe(editor);
    expect(centerTool).not.toHaveStyle({ visibility: "hidden" });
    expect(left).not.toHaveAttribute("aria-hidden");
  });
});
