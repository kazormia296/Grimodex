/**
 * パネル最大化（視覚 zoom）の幾何 invariant テスト（実 Chromium）。
 *
 * zoom は LayoutState を変更せず grid template とセル可視性だけを切り替える
 * 設計なので、ここで gate する invariant は:
 *
 *   1. zoom 中、対象パネルのセルが shell ほぼ全面を占める
 *   2. 非対象セル/兄弟 slot は不可視になるが **unmount はされない**
 *      （keepalive ノード数が不変・要素参照が同一 = エディタ state 破棄回避）
 *   3. zoom 解除で元の幾何に復帰する
 *
 * happy-dom は flex/grid の実寸を計算しないため、このスイートは実ブラウザ必須。
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, act } from "@testing-library/react";
import type { PanelId } from "./panelIds";
import { LayoutStoryPanelStub } from "./stories/LayoutStoryPanelStub";

vi.mock("@/lib/tauri", () => ({
  invoke: vi.fn(async () => ({})),
  // ブラウザモードはネイティブ ESM リンクのため、import graph 内で使われる
  // named export が factory に無いと SyntaxError になる。
  listen: vi.fn(async () => () => {}),
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
import type { LayoutState, ToolWindowPanelId } from "./layoutTypes";

const SHELL_SIZE = { width: 1200, height: 800 };
// cardLayout の外周 padding + パネル間ギャップぶんの許容差。
const CHROME_TOLERANCE_PX = 48;
// zoom 中は上端に復帰バー行（STRIPE_SIZE）+ gap 行が残るため、高さ方向は
// その分を追加で許容する。
const ZOOM_TOP_CHROME_PX = 48;

function setLayout(mutate: (layout: LayoutState) => void) {
  const layout = buildDefaultLayoutState({ allInactive: true });
  mutate(layout);
  useLayoutStore.setState({
    layout,
    layoutLocked: false,
    draggingPanel: null,
    dragOverTarget: null,
    hiddenStripePanels: new Set(),
    initialized: true,
    maximizedPanelId: null,
  });
}

function setSlots(
  layout: LayoutState,
  region: "left" | "right" | "bottom",
  slots: Array<{ id: string; panels: string[]; activePanel: string | null }>,
) {
  layout.regions[region].slots = slots.map((s) => ({
    id: s.id,
    sizeRatio: 1,
    panels: s.panels as ToolWindowPanelId[],
    activePanel: s.activePanel as ToolWindowPanelId | null,
  }));
}

function renderShell() {
  return render(
    <div
      className="app-shell"
      data-card="true"
      data-shell-host
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        width: SHELL_SIZE.width,
        height: SHELL_SIZE.height,
      }}
    >
      <LayoutShell />
    </div>,
  );
}

async function settleFrames() {
  await new Promise((r) =>
    requestAnimationFrame(() => requestAnimationFrame(() => r(null))),
  );
}

function maximize(panel: PanelId) {
  act(() => {
    useLayoutStore.getState().toggleMaximizePanel(panel);
  });
}

function clearMaximize() {
  act(() => {
    useLayoutStore.getState().clearMaximize();
  });
}

function expectFillsShell(rect: DOMRect, shellRect: DOMRect) {
  expect(rect.width).toBeGreaterThan(shellRect.width - CHROME_TOLERANCE_PX);
  expect(rect.height).toBeGreaterThan(
    shellRect.height - CHROME_TOLERANCE_PX - ZOOM_TOP_CHROME_PX,
  );
  expect(rect.left).toBeGreaterThanOrEqual(shellRect.left - 0.5);
  expect(rect.right).toBeLessThanOrEqual(shellRect.right + 0.5);
  expect(rect.top).toBeGreaterThanOrEqual(shellRect.top - 0.5);
  expect(rect.bottom).toBeLessThanOrEqual(shellRect.bottom + 0.5);
}

describe("panel zoom geometry invariants (real Chromium)", () => {
  beforeEach(() => {
    setLayout(() => {});
  });

  it("side slot zoom: 対象 slot が全面化し、兄弟 slot は不可視のままマウント維持、解除で復帰する", async () => {
    setLayout((layout) => {
      setSlots(layout, "left", [
        { id: "l0", panels: ["scenes"], activePanel: "scenes" },
        { id: "l1", panels: ["codex-quick"], activePanel: "codex-quick" },
      ]);
    });
    const { container } = renderShell();
    await settleFrames();

    const shell = container.querySelector<HTMLElement>("[data-layout-shell]")!;
    const slot0 = container.querySelector<HTMLElement>(
      '[data-drop-slot="l0"]',
    )!;
    const slot1 = container.querySelector<HTMLElement>(
      '[data-drop-slot="l1"]',
    )!;
    const scenesNode = container.querySelector<HTMLElement>(
      '[data-animated-slot-panel="scenes"]',
    )!;
    const baselineSlot0 = slot0.getBoundingClientRect();
    const panelNodeCount = container.querySelectorAll(
      "[data-animated-slot-panel]",
    ).length;

    maximize("scenes");
    await settleFrames();

    // 1. 対象 slot が shell ほぼ全面を占め、かつ visible のまま
    //（getBoundingClientRect は hidden 要素にも幾何を返すため明示 assert）
    expectFillsShell(
      slot0.getBoundingClientRect(),
      shell.getBoundingClientRect(),
    );
    expect(getComputedStyle(slot0).visibility).toBe("visible");

    // 2. 兄弟 slot は不可視だが DOM に残る
    expect(getComputedStyle(slot1).visibility).toBe("hidden");
    expect(
      container.querySelectorAll("[data-animated-slot-panel]").length,
    ).toBe(panelNodeCount);
    expect(container.querySelector('[data-animated-slot-panel="scenes"]')).toBe(
      scenesNode,
    );

    // stripe / 他 region のセルも不可視
    const leftStripe = container.querySelector<HTMLElement>(
      '[data-region-stripe-column="left"]',
    )!;
    expect(getComputedStyle(leftStripe).visibility).toBe("hidden");
    const editorSegment = container.querySelector<HTMLElement>(
      '[data-center-segment-kind="editor"]',
    )!;
    expect(getComputedStyle(editorSegment).visibility).toBe("hidden");
    expect(container.querySelector("[data-editor-area]")).not.toBeNull();

    // 復帰バーが常時見える解除アフォーダンスとして出ている
    const restoreBar = container.querySelector<HTMLElement>(
      "[data-zoom-restore-bar]",
    )!;
    expect(restoreBar).not.toBeNull();
    expect(getComputedStyle(restoreBar).visibility).toBe("visible");
    expect(restoreBar.getBoundingClientRect().height).toBeGreaterThan(4);

    // 3. 復帰ボタンのクリックで解除し、元の幾何へ復帰（±2px）
    const restoreButton = container.querySelector<HTMLElement>(
      '[data-testid="zoom-restore-button"]',
    )!;
    act(() => {
      restoreButton.click();
    });
    await settleFrames();
    expect(useLayoutStore.getState().maximizedPanelId).toBeNull();
    expect(container.querySelector("[data-zoom-restore-bar]")).toBeNull();
    const restored = slot0.getBoundingClientRect();
    expect(Math.abs(restored.left - baselineSlot0.left)).toBeLessThan(2);
    expect(Math.abs(restored.top - baselineSlot0.top)).toBeLessThan(2);
    expect(Math.abs(restored.width - baselineSlot0.width)).toBeLessThan(2);
    expect(Math.abs(restored.height - baselineSlot0.height)).toBeLessThan(2);
    expect(getComputedStyle(slot1).visibility).toBe("visible");
    expect(container.querySelector('[data-animated-slot-panel="scenes"]')).toBe(
      scenesNode,
    );
  });

  it("editor zoom: editor segment が全面化し、side region は不可視のままマウント維持", async () => {
    setLayout((layout) => {
      setSlots(layout, "left", [
        { id: "l0", panels: ["scenes"], activePanel: "scenes" },
      ]);
    });
    const { container } = renderShell();
    await settleFrames();

    const shell = container.querySelector<HTMLElement>("[data-layout-shell]")!;
    const editorSegment = container.querySelector<HTMLElement>(
      '[data-center-segment-kind="editor"]',
    )!;
    const editorNode =
      container.querySelector<HTMLElement>("[data-editor-area]")!;
    const scenesNode = container.querySelector<HTMLElement>(
      '[data-animated-slot-panel="scenes"]',
    )!;
    const baseline = editorSegment.getBoundingClientRect();

    maximize("editor");
    await settleFrames();

    expectFillsShell(
      editorSegment.getBoundingClientRect(),
      shell.getBoundingClientRect(),
    );
    expect(getComputedStyle(editorSegment).visibility).toBe("visible");
    // editor は unmount されない（要素参照が同一）
    expect(container.querySelector("[data-editor-area]")).toBe(editorNode);
    const slot0 = container.querySelector<HTMLElement>(
      '[data-drop-slot="l0"]',
    )!;
    expect(getComputedStyle(slot0).visibility).toBe("hidden");
    expect(container.querySelector('[data-animated-slot-panel="scenes"]')).toBe(
      scenesNode,
    );

    clearMaximize();
    await settleFrames();
    const restored = editorSegment.getBoundingClientRect();
    expect(Math.abs(restored.left - baseline.left)).toBeLessThan(2);
    expect(Math.abs(restored.width - baseline.width)).toBeLessThan(2);
    expect(container.querySelector("[data-editor-area]")).toBe(editorNode);
  });

  it("center tool segment zoom: tool segment が全面化し、editor segment は不可視のままマウント維持", async () => {
    setLayout((layout) => {
      setSlots(layout, "left", [
        { id: "l0", panels: ["scenes"], activePanel: "scenes" },
      ]);
      // chat を right から外し center tool segment に置く
      for (const region of Object.values(layout.regions)) {
        for (const slot of region.slots) {
          slot.panels = slot.panels.filter((p) => p !== "chat");
          if (slot.activePanel === "chat") slot.activePanel = null;
        }
      }
      layout.center.segments = [
        ...layout.center.segments,
        {
          id: "ct1",
          kind: "tool",
          sizeRatio: 0.4,
          panels: ["chat"],
          activePanel: "chat",
        },
      ];
    });
    const { container } = renderShell();
    await settleFrames();

    const shell = container.querySelector<HTMLElement>("[data-layout-shell]")!;
    const toolSegment = container.querySelector<HTMLElement>(
      '[data-center-segment="ct1"]',
    )!;
    const editorNode =
      container.querySelector<HTMLElement>("[data-editor-area]")!;

    maximize("chat");
    await settleFrames();

    expectFillsShell(
      toolSegment.getBoundingClientRect(),
      shell.getBoundingClientRect(),
    );
    expect(getComputedStyle(toolSegment).visibility).toBe("visible");
    const editorSegment = container.querySelector<HTMLElement>(
      '[data-center-segment-kind="editor"]',
    )!;
    expect(getComputedStyle(editorSegment).visibility).toBe("hidden");
    expect(container.querySelector("[data-editor-area]")).toBe(editorNode);

    clearMaximize();
    await settleFrames();
    expect(getComputedStyle(editorSegment).visibility).toBe("visible");
    expect(container.querySelector("[data-editor-area]")).toBe(editorNode);
  });

  it("bottom zoom: bottom パネルが全面化し、bottom stripe と他 region は不可視", async () => {
    setLayout((layout) => {
      setSlots(layout, "left", [
        { id: "l0", panels: ["scenes"], activePanel: "scenes" },
      ]);
      setSlots(layout, "bottom", [
        { id: "b0", panels: ["timeline"], activePanel: "timeline" },
      ]);
    });
    const { container } = renderShell();
    await settleFrames();

    const shell = container.querySelector<HTMLElement>("[data-layout-shell]")!;
    const slotB0 = container.querySelector<HTMLElement>(
      '[data-drop-slot="b0"]',
    )!;
    const baseline = slotB0.getBoundingClientRect();

    maximize("timeline");
    await settleFrames();

    expectFillsShell(
      slotB0.getBoundingClientRect(),
      shell.getBoundingClientRect(),
    );
    expect(getComputedStyle(slotB0).visibility).toBe("visible");
    const bottomStripe = container.querySelector<HTMLElement>(
      '[data-stripe-region="bottom"]',
    )!;
    expect(getComputedStyle(bottomStripe).visibility).toBe("hidden");
    const slotL0 = container.querySelector<HTMLElement>(
      '[data-drop-slot="l0"]',
    )!;
    expect(getComputedStyle(slotL0).visibility).toBe("hidden");

    clearMaximize();
    await settleFrames();
    const restored = slotB0.getBoundingClientRect();
    expect(Math.abs(restored.top - baseline.top)).toBeLessThan(2);
    expect(Math.abs(restored.height - baseline.height)).toBeLessThan(2);
    expect(getComputedStyle(bottomStripe).visibility).toBe("visible");
  });
});
