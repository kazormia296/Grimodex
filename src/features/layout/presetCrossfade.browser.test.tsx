/**
 * プリセット切替（外形のモーフ）の実配線テスト（実 Chromium）。
 *
 * happy-dom 側のフック単体テストは controls.set/start の dispatch しか検証
 * できない（motion.div への購読が無いと set/start は no-op で素通りする）。
 * ここでは applyPreset 後に、外形がカードの旧矩形から新矩形へ動き、その間
 * data-layout-shell の computed opacity が 1 未満に落ちて（中身を隠す）、
 * 外形が消えた後に 1 へ戻ること、そしてその間 DOM ノードが remount されない
 * ことを実ブラウザで gate する。
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, act, waitFor } from "@testing-library/react";
import type { PanelId } from "./panelIds";
import { LayoutStoryPanelStub } from "./stories/LayoutStoryPanelStub";

vi.mock("@/lib/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tauri")>()),
  invoke: vi.fn(async () => ({})),
  // ブラウザモードはネイティブ ESM リンクのため、import graph 内で使われる
  // named export が factory に無いと SyntaxError になる（chatApi 経由で listen、
  // PanelChromeMenu→panelWindow で isTauri、codex multiwindow で emit が必要）
  listen: vi.fn(async () => () => {}),
  emit: vi.fn(async () => {}),
  isTauri: () => false,
}));

vi.mock("./panelComponents", () => ({
  PANEL_COMPONENT_MAP: new Proxy(
    {},
    {
      get: (_t, prop) => () => (
        <LayoutStoryPanelStub panelId={String(prop) as PanelId} />
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
import { useSettingsStore } from "@/features/settings/settingsStore";

describe("preset crossfade (real browser)", () => {
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
    useSettingsStore.setState((state) => ({
      cache: { ...state.cache, "display.reduceMotion": "false" },
    }));
  });

  it("fades opacity in place (dips below 1, returns to 1) without remount", async () => {
    const { container } = render(
      <div style={{ width: 1200, height: 800 }}>
        <LayoutShell />
      </div>,
    );
    const shell = container.querySelector("[data-layout-shell]") as HTMLElement;
    expect(shell).toBeTruthy();
    expect(getComputedStyle(shell).opacity).toBe("1");

    act(() => {
      useLayoutStore.getState().applyPreset("builtin:review");
    });

    // controls.set は MotionValue 経由で motion の frameloop (rAF) に乗り、
    // DOM への反映は同フレームの paint 直前（同期ではない）。反映までの
    // 固定フレーム待ちではなくポーリングで dip を観測する。フェードは
    // DURATIONS.fast=150ms 続くので、waitFor の既定間隔 (50ms) で取り逃さない。
    await waitFor(() => {
      expect(parseFloat(getComputedStyle(shell).opacity)).toBeLessThan(1);
    });

    await waitFor(
      () => {
        expect(getComputedStyle(shell).opacity).toBe("1");
      },
      { timeout: 2000 },
    );

    // フェードは同一ノード上で起きた（remount していない）
    expect(container.querySelector("[data-layout-shell]")).toBe(shell);
  });

  it("morphs card outlines from the old layout to the new one, then clears them", async () => {
    const { container } = render(
      <div style={{ width: 1200, height: 800 }}>
        <LayoutShell />
      </div>,
    );
    await new Promise((r) =>
      requestAnimationFrame(() => requestAnimationFrame(() => r(null))),
    );
    const editorBefore = container
      .querySelector('[data-center-segment-kind="editor"]')!
      .getBoundingClientRect();

    act(() => {
      useLayoutStore.getState().applyPreset("builtin:review");
    });

    const layer = container.querySelector("[data-layout-morph-layer]")!;
    const editorOutline = layer.querySelector<HTMLElement>(
      '[data-layout-morph-outline="editor"]',
    );
    expect(editorOutline).not.toBeNull();
    // 外形は旧矩形から動き始める。
    const start = editorOutline!.getBoundingClientRect();
    expect(Math.abs(start.left - editorBefore.left)).toBeLessThan(2);
    expect(Math.abs(start.width - editorBefore.width)).toBeLessThan(2);

    await waitFor(
      () => {
        expect(layer.children).toHaveLength(0);
        expect(
          getComputedStyle(
            container.querySelector("[data-layout-shell]") as HTMLElement,
          ).opacity,
        ).toBe("1");
      },
      { timeout: 2000 },
    );
  });

  it("switches at once under Reduced Motion", () => {
    useSettingsStore.setState((state) => ({
      cache: { ...state.cache, "display.reduceMotion": "true" },
    }));
    const { container } = render(
      <div style={{ width: 1200, height: 800 }}>
        <LayoutShell />
      </div>,
    );
    act(() => {
      useLayoutStore.getState().applyPreset("builtin:review");
    });
    expect(
      container.querySelector("[data-layout-morph-layer]")!.children,
    ).toHaveLength(0);
  });
});
