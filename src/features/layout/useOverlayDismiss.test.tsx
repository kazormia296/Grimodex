// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { createPortal } from "react-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./panelComponents", () => ({
  PANEL_COMPONENT_MAP: new Proxy(
    {},
    {
      get: () => () => (
        <div>
          <button type="button" data-testid="first">
            first
          </button>
          <input data-testid="second" />
          {/* Radix の menu／dialog と同じく、DOM では body 直下の portal に描く。 */}
          {createPortal(
            <button type="button" data-testid="portal-btn">
              portal
            </button>,
            document.body,
          )}
        </div>
      ),
    },
  ),
}));

import { ZenModeController } from "@/features/editor/ZenModeController";
import { useCursorSettingsStore } from "@/features/editor/cursorSettingsStore";
import { OverlayLayer } from "./OverlayLayer";
import { buildDefaultLayoutState } from "./layoutStateUtils";
import { useLayoutStore } from "./layoutStore";

const requestEditorFocus = vi.fn();

function Harness() {
  return (
    <div>
      <button type="button" data-testid="outside">
        outside
      </button>
      <button type="button" data-testid="opener">
        opener
      </button>
      <button type="button" data-overlay-knob="left" data-testid="knob">
        knob
      </button>
      <OverlayLayer side="left" />
    </div>
  );
}

function setup() {
  const layout = buildDefaultLayoutState({ allInactive: true });
  layout.overlays = { left: { panel: "snippets" }, right: { panel: null } };
  useLayoutStore.setState({
    layout,
    openOverlay: null,
    maximizedPanelId: null,
    requestEditorFocus,
  });
  const utils = render(<Harness />);
  const get = (id: string) => utils.getByTestId(id);
  return { ...utils, get };
}

function open() {
  act(() => useLayoutStore.getState().showOverlay("left"));
}
const isOpen = () => useLayoutStore.getState().openOverlay === "left";

afterEach(() => {
  cleanup();
  useCursorSettingsStore.getState().setZenMode(false);
});

describe("useOverlayDismiss", () => {
  beforeEach(() => {
    requestEditorFocus.mockClear();
  });

  describe("外での pointerdown", () => {
    it("外の pointerdown で閉じる", () => {
      const { get } = setup();
      open();
      fireEvent.pointerDown(get("outside"));
      expect(isOpen()).toBe(false);
    });

    it("中の pointerdown では閉じない", () => {
      const { get } = setup();
      open();
      fireEvent.pointerDown(get("first"));
      expect(isOpen()).toBe(true);
    });

    it("portal 内（DOM では外、React の木では中）の pointerdown では閉じない", () => {
      const { get } = setup();
      open();
      const portalBtn = get("portal-btn");
      expect(get("first").closest("[data-overlay-layer]")).not.toBeNull();
      expect(portalBtn.closest("[data-overlay-layer]")).toBeNull();
      fireEvent.pointerDown(portalBtn);
      expect(isOpen()).toBe(true);
      // 中の印は 1 回の event に限る。続く外の pointerdown では閉じる。
      fireEvent.pointerDown(get("outside"));
      expect(isOpen()).toBe(false);
    });

    it("rail のつまみの pointerdown は対象外（つまみ自身が開閉する）", () => {
      const { get } = setup();
      open();
      fireEvent.pointerDown(get("knob"));
      expect(isOpen()).toBe(true);
    });

    it("閉じている間は何もしない", () => {
      const { get } = setup();
      fireEvent.pointerDown(get("outside"));
      expect(isOpen()).toBe(false);
    });
  });

  describe("Tab で外へ抜ける", () => {
    it("Tab の直後に focus が外へ出ると閉じる", () => {
      const { get } = setup();
      open();
      act(() => get("second").focus());
      fireEvent.keyDown(get("second"), { key: "Tab" });
      act(() => get("outside").focus());
      expect(isOpen()).toBe(false);
    });

    it("Tab でも層の中へ移るだけなら閉じない", () => {
      const { get } = setup();
      open();
      act(() => get("first").focus());
      fireEvent.keyDown(get("first"), { key: "Tab" });
      act(() => get("second").focus());
      expect(isOpen()).toBe(true);
    });

    it("Tab で portal 内（React の木の中）へ移っても閉じない", () => {
      const { get } = setup();
      open();
      act(() => get("second").focus());
      fireEvent.keyDown(get("second"), { key: "Tab" });
      act(() => get("portal-btn").focus());
      expect(isOpen()).toBe(true);
    });

    it("プログラムの focus() では閉じない", () => {
      const { get } = setup();
      open();
      act(() => get("second").focus());
      act(() => get("outside").focus());
      expect(isOpen()).toBe(true);
    });

    it("Tab 以外のキーの後の focus() では閉じない", () => {
      const { get } = setup();
      open();
      act(() => get("second").focus());
      fireEvent.keyDown(get("second"), { key: "Tab" });
      fireEvent.keyUp(get("second"), { key: "Tab" });
      act(() => get("outside").focus());
      expect(isOpen()).toBe(true);
    });
  });

  describe("Esc", () => {
    it("Esc で閉じて preventDefault する", () => {
      const { get } = setup();
      open();
      const proceed = fireEvent.keyDown(get("first"), { key: "Escape" });
      expect(isOpen()).toBe(false);
      expect(proceed).toBe(false);
    });

    it("IME 変換中（isComposing）の Esc は奪わない", () => {
      const { get } = setup();
      open();
      const proceed = fireEvent.keyDown(get("first"), {
        key: "Escape",
        isComposing: true,
      });
      expect(isOpen()).toBe(true);
      expect(proceed).toBe(true);
    });

    it("keyCode 229 の Esc も奪わない", () => {
      const { get } = setup();
      open();
      fireEvent.keyDown(get("first"), { key: "Escape", keyCode: 229 });
      expect(isOpen()).toBe(true);
    });

    it("子が先に消費した（defaultPrevented）Esc は奪わない", () => {
      const { get } = setup();
      open();
      get("second").addEventListener("keydown", (e) => e.preventDefault());
      fireEvent.keyDown(get("second"), { key: "Escape" });
      expect(isOpen()).toBe(true);
    });

    it("zoom の Esc（window）は defaultPrevented を見て二重に反応しない", () => {
      const { get } = setup();
      // LayoutShell の zoom 解除と同じ条件の window listener。
      const zoomEsc = vi.fn();
      const onKeyDown = (e: KeyboardEvent) => {
        if (e.key !== "Escape" || e.defaultPrevented || e.isComposing) return;
        zoomEsc();
      };
      window.addEventListener("keydown", onKeyDown);
      try {
        open();
        fireEvent.keyDown(get("first"), { key: "Escape" });
        expect(isOpen()).toBe(false);
        expect(zoomEsc).not.toHaveBeenCalled();
        // 閉じた後の Esc は zoom 側に届く。
        fireEvent.keyDown(get("outside"), { key: "Escape" });
        expect(zoomEsc).toHaveBeenCalledTimes(1);
      } finally {
        window.removeEventListener("keydown", onKeyDown);
      }
    });

    it("Zen の Esc と二重にならない（overlay が先、次の Esc で Zen が解ける）", () => {
      const { get } = setup();
      render(<ZenModeController />);
      act(() => useCursorSettingsStore.getState().setZenMode(true));
      open();
      fireEvent.keyDown(get("first"), { key: "Escape" });
      expect(isOpen()).toBe(false);
      expect(useCursorSettingsStore.getState().zenMode).toBe(true);
      fireEvent.keyDown(get("outside"), { key: "Escape" });
      expect(useCursorSettingsStore.getState().zenMode).toBe(false);
    });
  });

  describe("フォーカス", () => {
    it("開くとパネルの先頭の操作できる要素へ移り、Esc で閉じると元の要素へ戻る", () => {
      const { get } = setup();
      act(() => get("opener").focus());
      open();
      expect(document.activeElement).toBe(get("first"));
      fireEvent.keyDown(get("first"), { key: "Escape" });
      expect(document.activeElement).toBe(get("opener"));
    });

    it("つまみで閉じても元の要素へ戻る", () => {
      const { get } = setup();
      act(() => get("opener").focus());
      open();
      act(() => get("first").focus());
      act(() => useLayoutStore.getState().toggleOverlay("left"));
      expect(document.activeElement).toBe(get("opener"));
    });

    it("元の要素が消えていたらエディタへ戻す", () => {
      const { get } = setup();
      const temp = document.createElement("button");
      document.body.append(temp);
      temp.focus();
      open();
      temp.remove();
      act(() => useLayoutStore.getState().closeOverlay());
      expect(requestEditorFocus).toHaveBeenCalledTimes(1);
      expect(document.activeElement).not.toBe(get("opener"));
    });

    it("外の pointerdown で閉じたときは focus を奪い返さない", () => {
      const { get } = setup();
      act(() => get("opener").focus());
      open();
      fireEvent.pointerDown(get("outside"));
      act(() => get("outside").focus());
      expect(document.activeElement).toBe(get("outside"));
      expect(requestEditorFocus).not.toHaveBeenCalled();
    });
  });
});
