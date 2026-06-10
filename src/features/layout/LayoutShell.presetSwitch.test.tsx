// @vitest-environment happy-dom
/**
 * プリセット切替の remount 回帰テスト。
 *
 * かつて LayoutShell は motion.div に key={crossfadeKey} を与えており、
 * プリセット切替のたびに subtree 全体（全 TipTap エディタ・全パネル）が
 * unmount→remount されて体感フリーズの主因になっていた。crossfade は
 * opacity 再トリガー方式（useLayoutPresetCrossfade）で実現し、DOM ノードの
 * identity が切替を跨いで保持されることをここで gate する。
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, act } from "@testing-library/react";
import type { PanelId } from "./panelIds";

vi.mock("@/lib/tauri", () => ({
  invoke: vi.fn(),
}));

vi.mock("./panelComponents", () => ({
  PANEL_COMPONENT_MAP: new Proxy(
    {},
    {
      get: (_t, prop) => () => (
        <div data-stub-panel={String(prop) as PanelId} />
      ),
    },
  ),
}));

vi.mock("./EditorArea", () => ({
  EditorArea: () => <div data-editor-area />,
}));

import { LayoutShell } from "./LayoutShell";
import { useLayoutStore } from "./layoutStore";
import { buildDefaultLayoutState } from "./layoutStateUtils";

describe("LayoutShell preset switch", () => {
  beforeEach(() => {
    useLayoutStore.setState({
      layout: buildDefaultLayoutState({ editorOpen: true }),
      layoutLocked: false,
      draggingPanel: null,
      dragOverTarget: null,
      hiddenStripePanels: new Set(),
      activePresetId: "builtin:default",
      customPresets: [],
      initialized: true,
    });
  });

  it("preserves shell and editor DOM identity across applyPreset (no remount)", () => {
    const { container } = render(<LayoutShell />);
    const shellBefore = container.querySelector("[data-layout-shell]");
    const editorBefore = container.querySelector("[data-editor-area]");
    expect(shellBefore).toBeTruthy();
    expect(editorBefore).toBeTruthy();

    const layoutBefore = useLayoutStore.getState().layout;
    act(() => {
      // builtin:review はエディタ open のままのプリセット
      // （editorOpen: false のプリセットへの切替でエディタ自体が閉じて
      // unmount されるのは設計どおりで、このテストの対象外）
      useLayoutStore.getState().applyPreset("builtin:review");
    });

    // 切替自体は成立している（layout が差し替わっている）
    expect(useLayoutStore.getState().activePresetId).toBe("builtin:review");
    expect(useLayoutStore.getState().layout).not.toBe(layoutBefore);

    // が、shell とエディタ領域の DOM ノードは同一インスタンスのまま
    expect(container.querySelector("[data-layout-shell]")).toBe(shellBefore);
    expect(container.querySelector("[data-editor-area]")).toBe(editorBefore);
  });

  it("keeps shell and editor identity across consecutive rapid switches", () => {
    const { container } = render(<LayoutShell />);
    const shellBefore = container.querySelector("[data-layout-shell]");
    const editorBefore = container.querySelector("[data-editor-area]");

    act(() => {
      useLayoutStore.getState().applyPreset("builtin:review");
    });
    act(() => {
      useLayoutStore.getState().applyPreset("builtin:default");
    });

    expect(container.querySelector("[data-layout-shell]")).toBe(shellBefore);
    expect(container.querySelector("[data-editor-area]")).toBe(editorBefore);
  });
});
