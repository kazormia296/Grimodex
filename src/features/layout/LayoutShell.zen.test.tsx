// @vitest-environment happy-dom
import { act, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "@/features/settings/types";
import { useSettingsStore } from "@/features/settings/settingsStore";
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
    useSettingsStore.setState({
      cache: {
        ...DEFAULT_SETTINGS,
        "editor.zenBackground.glass.blur": "22",
        "editor.zenBackground.glass.refraction": "13",
        "editor.zenBackground.glass.saturation": "1.4",
        "editor.zenBackground.glass.shine": "0.65",
      },
    });
  });

  it("publishes the shared Glass contract on the normal workspace root", () => {
    const { container } = render(<LayoutShell />);
    const shell = container.querySelector<HTMLElement>(
      "[data-workspace-glass-root]",
    );

    expect(shell).toHaveAttribute("data-layout-shell");
    expect(shell).toHaveAttribute("data-workspace-fluid-glass", "true");
    expect(shell).toHaveAttribute(
      "data-workspace-fluid-glass-refraction",
      "13",
    );
    expect(shell?.style.getPropertyValue("--workspace-fluid-glass-blur")).toBe(
      "22px",
    );
    expect(
      shell?.style.getPropertyValue("--workspace-fluid-glass-saturate"),
    ).toBe("1.4");
    expect(shell?.style.getPropertyValue("--workspace-fluid-glass-shine")).toBe(
      "0.65",
    );
  });

  it("publishes layout initialization as a live DOM contract", () => {
    act(() => {
      useLayoutStore.setState({ initialized: false });
    });
    const { container } = render(<LayoutShell />);
    const shell = container.querySelector<HTMLElement>("[data-layout-shell]");

    expect(shell).toHaveAttribute("data-layout-initialized", "false");

    act(() => {
      useLayoutStore.setState({ initialized: true });
    });

    expect(shell).toHaveAttribute("data-layout-initialized", "true");
  });

  it("publishes the same Glass root around a solo non-Editor panel", () => {
    const { container } = render(<LayoutShell hidden soloPanelId="chat" />);
    const root = container.querySelector<HTMLElement>(
      "[data-workspace-glass-root]",
    );

    expect(root).not.toHaveAttribute("data-layout-shell");
    expect(root).toHaveAttribute("data-workspace-fluid-glass", "true");
    expect(root).toHaveAttribute("data-workspace-fluid-glass-refraction", "13");
    expect(
      root?.querySelector('[data-ambient-glass-surface="panel"]'),
    ).not.toBeNull();
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
