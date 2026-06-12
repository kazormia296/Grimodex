// @vitest-environment happy-dom
/**
 * パネル最大化（視覚 zoom）の Esc 解除経路のテスト。
 *
 * window keydown リスナーは zoom 中のみ登録され、
 * - 素の Escape で解除する
 * - defaultPrevented（Radix ダイアログ / パネル固有 Esc が消費済み）は無視
 * - isComposing（IME 変換キャンセルの Escape）は無視
 * を gate する。zoom 幾何そのものは layoutZoom.browser.test.tsx が担当。
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

function dispatchEscape(init?: { isComposing?: boolean }) {
  const event = new KeyboardEvent("keydown", {
    key: "Escape",
    bubbles: true,
    cancelable: true,
  });
  if (init?.isComposing) {
    Object.defineProperty(event, "isComposing", { value: true });
  }
  act(() => {
    window.dispatchEvent(event);
  });
}

describe("LayoutShell zoom Esc dismissal", () => {
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
      maximizedPanelId: null,
    });
  });

  function renderMaximized() {
    const utils = render(<LayoutShell />);
    act(() => {
      useLayoutStore.getState().toggleMaximizePanel("editor");
    });
    expect(useLayoutStore.getState().maximizedPanelId).toBe("editor");
    return utils;
  }

  it("素の Escape で zoom を解除する", () => {
    renderMaximized();
    dispatchEscape();
    expect(useLayoutStore.getState().maximizedPanelId).toBeNull();
  });

  it("defaultPrevented な Escape では解除しない（ダイアログ/パネル固有 Esc を尊重）", () => {
    const swallow = (e: KeyboardEvent) => {
      if (e.key === "Escape") e.preventDefault();
    };
    // LayoutShell のリスナーより先に登録された消費者を模す
    window.addEventListener("keydown", swallow);
    try {
      renderMaximized();
      dispatchEscape();
      expect(useLayoutStore.getState().maximizedPanelId).toBe("editor");
    } finally {
      window.removeEventListener("keydown", swallow);
    }
  });

  it("IME 変換中（isComposing）の Escape では解除しない", () => {
    renderMaximized();
    dispatchEscape({ isComposing: true });
    expect(useLayoutStore.getState().maximizedPanelId).toBe("editor");
  });

  it("zoom していないときは Escape を消費しない", () => {
    render(<LayoutShell />);
    const event = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      window.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(false);
    expect(useLayoutStore.getState().maximizedPanelId).toBeNull();
  });
});
