/**
 * プリセット切替クロスフェードの実配線テスト（実 Chromium）。
 *
 * happy-dom 側のフック単体テストは controls.set/start の dispatch しか検証
 * できない（motion.div への購読が無いと set/start は no-op で素通りする）。
 * ここでは applyPreset 後に data-layout-shell の computed opacity が一旦
 * 1 未満に落ち（useLayoutEffect での paint 前 set(0)）、アニメ完了で 1 に
 * 戻ること、そしてその間 DOM ノードが remount されないことを実ブラウザで
 * gate する。
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, act, waitFor } from "@testing-library/react";
import type { PanelId } from "./panelIds";
import { LayoutStoryPanelStub } from "./stories/LayoutStoryPanelStub";

vi.mock("@/lib/tauri", () => ({
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
    // フレーム数はエンジン依存（WebKit は 2 rAF 後でも未反映のことがある）
    // ため、固定フレーム待ちではなくポーリングで dip を観測する。フェードは
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
});
