/**
 * オーバーレイの層の幾何と開閉（実 Chromium）。happy-dom は寸法と transition を
 * 計算しないため、閉じているときの位置・不可視・inert と、開いたときの幅と位置は
 * ここで測る。
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { fireEvent, render } from "@testing-library/react";
import { LayoutShell } from "./LayoutShell";
import { HORIZONTAL_STRIPE_SIZE, OVERLAY_WIDTH } from "./layoutConstants";
import { useLayoutStore } from "./layoutStore";
import { buildDefaultLayoutState } from "./layoutStateUtils";
import type { OverlayId } from "./layoutTypes";
import type { PanelId } from "./panelIds";
import { LayoutStoryPanelStub } from "./stories/LayoutStoryPanelStub";

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
  EditorArea: () => (
    <div data-editor-area className="h-full w-full">
      editor
    </div>
  ),
}));

const HEIGHT = 800;
/** transition(300ms) が終わるまで待つ。 */
const SETTLE_MS = 450;
const OUTER_PAD = 14;
const STRIPE_GAP = 12;

function setOverlay(side: OverlayId) {
  const layout = buildDefaultLayoutState({ allInactive: true });
  for (const region of ["left", "right", "bottom"] as const) {
    for (const slot of layout.regions[region].slots) {
      slot.panels = slot.panels.filter((p) => p !== "snippets");
      if (slot.activePanel === "snippets") slot.activePanel = null;
    }
  }
  layout.overlays = {
    left: { panel: side === "left" ? "snippets" : null },
    right: { panel: side === "right" ? "snippets" : null },
  };
  useLayoutStore.setState({
    layout,
    layoutLocked: false,
    draggingPanel: null,
    dragOverTarget: null,
    hiddenStripePanels: new Set(),
    initialized: true,
    maximizedPanelId: null,
    openOverlay: null,
  });
}

function renderHost(width: number) {
  return render(
    <div
      className="app-shell"
      style={{ position: "fixed", top: 0, left: 0, width, height: HEIGHT }}
    >
      <LayoutShell />
    </div>,
  );
}

const settle = () => new Promise((r) => setTimeout(r, SETTLE_MS));
const frame = () => new Promise((r) => requestAnimationFrame(() => r(null)));

describe.each<[OverlayId]>([["left"], ["right"]])(
  "overlay layer (%s, real Chromium)",
  (side) => {
    beforeEach(() => setOverlay(side));

    const q = (c: HTMLElement, sel: string) =>
      c.querySelector<HTMLElement>(sel)!;

    it("is inert, invisible and tucked past the screen edge while closed", async () => {
      const { container } = renderHost(1200);
      await frame();
      const layer = q(container, `[data-overlay-layer="${side}"]`);
      const panel = q(container, `[data-overlay-panel="${side}"]`);
      expect(layer.inert).toBe(true);
      expect(layer.getAttribute("aria-hidden")).toBe("true");
      expect(getComputedStyle(layer).visibility).toBe("hidden");
      // パネルは層の基点（画面の端から外周の余白の内側）より外に退いている。
      const rect = panel.getBoundingClientRect();
      if (side === "left") {
        expect(rect.right).toBeLessThanOrEqual(OUTER_PAD + 0.5);
      } else {
        expect(rect.left).toBeGreaterThanOrEqual(1200 - OUTER_PAD - 0.5);
      }
      // 開くまでは中身を mount しない。
      expect(container.querySelector("[data-story-panel]")).toBeNull();
    });

    it("slides out from the outer-pad inset to OVERLAY_WIDTH and back, without unmounting", async () => {
      const { container } = renderHost(1200);
      await frame();
      const knob = q(container, `[data-overlay-knob="${side}"]`);
      const layer = q(container, `[data-overlay-layer="${side}"]`);
      const panel = q(container, `[data-overlay-panel="${side}"]`);

      fireEvent.click(knob);
      await settle();
      expect(layer.inert).toBe(false);
      expect(getComputedStyle(layer).visibility).toBe("visible");
      expect(knob.getAttribute("aria-expanded")).toBe("true");
      expect(layer.id).toBe(knob.getAttribute("aria-controls"));
      const open = panel.getBoundingClientRect();
      expect(open.width).toBe(OVERLAY_WIDTH);
      // 画面の端から外周の余白の内側。
      if (side === "left") expect(open.left).toBe(OUTER_PAD);
      else expect(open.right).toBe(1200 - OUTER_PAD);
      // 上下は grid の内容域（center stripe と gap の下、下端は外周の余白）に合わせる。
      expect(open.top).toBe(OUTER_PAD + HORIZONTAL_STRIPE_SIZE + STRIPE_GAP);
      expect(open.bottom).toBe(HEIGHT - OUTER_PAD);
      // 開いた層はつまみ（上段の角）を覆わない: 上端はつまみの下端以下の側にある。
      const knobRect = knob.getBoundingClientRect();
      expect(open.top).toBeGreaterThanOrEqual(knobRect.bottom - 0.5);
      // 層の箱は上端まであるが padding 分は空で、つまみのクリックは層に奪われない。
      const kx = knobRect.left + knobRect.width / 2;
      if (kx < window.innerWidth) {
        const hitKnob = document.elementFromPoint(
          kx,
          knobRect.top + knobRect.height / 2,
        );
        expect(knob.contains(hitKnob)).toBe(true);
      }
      expect(q(container, "[data-story-panel]")).not.toBeNull();
      // grid と Stripe より上（DnD の fixed 層 z-[9998] より下）。
      const z = Number(getComputedStyle(layer).zIndex);
      expect(z).toBeGreaterThan(30);
      expect(z).toBeLessThan(9998);
      // ブラウザの実 viewport（既定 414px 幅）に収まる左側だけ、ヒットテストで最前面を確かめる。
      const cx = open.left + open.width / 2;
      if (cx < window.innerWidth) {
        const hit = document.elementFromPoint(cx, open.top + open.height / 2);
        expect(layer.contains(hit)).toBe(true);
      }

      fireEvent.click(knob);
      await settle();
      expect(layer.inert).toBe(true);
      expect(getComputedStyle(layer).visibility).toBe("hidden");
      // unmount しない（状態を残す）。
      expect(container.querySelector("[data-story-panel]")).not.toBeNull();
    });

    it("caps the width at half of the screen on a narrow window", async () => {
      const { container } = renderHost(700);
      await frame();
      fireEvent.click(q(container, `[data-overlay-knob="${side}"]`));
      await settle();
      const rect = q(
        container,
        `[data-overlay-panel="${side}"]`,
      ).getBoundingClientRect();
      expect(rect.width).toBe(350);
    });
  },
);
