// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { createPortal } from "react-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./panelComponents", async () => {
  const { useState } = await import("react");
  const { ChatMessageContextMenu } =
    await import("@/features/chat/components/ChatMessageContextMenu");
  const noop = () => {};
  // overlay を開いた「後」に document へ keydown を登録する独自メニュー（実物）。
  function Panel({ suffix }: { suffix: string }) {
    const [menu, setMenu] = useState(false);
    return (
      <div>
        <button type="button" data-testid={`first${suffix}`}>
          first
        </button>
        <input data-testid={`second${suffix}`} />
        <button
          type="button"
          data-testid={`open-menu${suffix}`}
          onClick={() => setMenu(true)}
        >
          menu
        </button>
        {menu && (
          <ChatMessageContextMenu
            messageId="m1"
            messageRole="assistant"
            messageContent="x"
            selectedText={null}
            x={0}
            y={0}
            onClose={() => setMenu(false)}
            onInsert={noop}
            onExtractCodexQuick={noop}
            onExtractCodexDetailed={noop}
            onSaveSnippetQuick={noop}
            onSaveSnippetDetailed={noop}
            onCopy={noop}
            onEdit={noop}
            onDelete={noop}
            onRegenerate={noop}
          />
        )}
        {/* Radix の menu／dialog と同じく、DOM では body 直下の portal に描く。 */}
        {createPortal(
          <button type="button" data-testid={`portal-btn${suffix}`}>
            portal
          </button>,
          document.body,
        )}
      </div>
    );
  }
  // 左（snippets）は従来の testid、右（attribution）は -right を付けて区別する。
  const components = new Map<string, () => React.ReactElement>();
  return {
    PANEL_COMPONENT_MAP: new Proxy(
      {},
      {
        get: (_target, prop) => {
          const key = String(prop);
          if (!components.has(key)) {
            const suffix = key === "snippets" ? "" : "-right";
            components.set(key, () => <Panel suffix={suffix} />);
          }
          return components.get(key);
        },
      },
    ),
  };
});

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
      <button type="button" data-overlay-knob="right" data-testid="knob-right">
        knob
      </button>
      <OverlayLayer side="left" />
      <OverlayLayer side="right" />
    </div>
  );
}

function setup() {
  const layout = buildDefaultLayoutState({ allInactive: true });
  layout.overlays = {
    left: { panel: "snippets" },
    right: { panel: "attribution" },
  };
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
/** Esc の閉じる処理は、その event の dispatch が全部終わった次の task で行う。 */
const flushEsc = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

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
    it("Esc で閉じる（内側の処理が終わった次の task で）", async () => {
      const { get } = setup();
      open();
      fireEvent.keyDown(get("first"), { key: "Escape" });
      expect(isOpen()).toBe(true);
      await flushEsc();
      expect(isOpen()).toBe(false);
    });

    it("IME 変換中（isComposing）の Esc は奪わない", async () => {
      const { get } = setup();
      open();
      const proceed = fireEvent.keyDown(get("first"), {
        key: "Escape",
        isComposing: true,
      });
      await flushEsc();
      expect(isOpen()).toBe(true);
      expect(proceed).toBe(true);
    });

    it("keyCode 229 の Esc も奪わない", async () => {
      const { get } = setup();
      open();
      fireEvent.keyDown(get("first"), { key: "Escape", keyCode: 229 });
      await flushEsc();
      expect(isOpen()).toBe(true);
    });

    it("子が先に消費した（defaultPrevented）Esc は奪わない", async () => {
      const { get } = setup();
      open();
      get("second").addEventListener("keydown", (e) => e.preventDefault());
      fireEvent.keyDown(get("second"), { key: "Escape" });
      await flushEsc();
      expect(isOpen()).toBe(true);
    });

    it("overlay を開いた後に document へ登録された独自メニューの Esc は、メニューだけ閉じる", async () => {
      const { get } = setup();
      const menu = () =>
        document.querySelector('[data-testid="chat-message-context-menu"]');
      open();
      // メニューは overlay を開いた後に mount され、document に keydown を登録する
      // （overlay の listener より後の登録）。
      fireEvent.click(get("open-menu"));
      expect(menu()).not.toBeNull();
      fireEvent.keyDown(get("open-menu"), { key: "Escape" });
      await flushEsc();
      expect(menu()).toBeNull();
      expect(isOpen()).toBe(true);
      // 次の Esc で overlay が閉じる。
      fireEvent.keyDown(get("first"), { key: "Escape" });
      await flushEsc();
      expect(isOpen()).toBe(false);
    });

    it("window へ後から登録された内側の listener が処理した Esc も奪わない", async () => {
      const { get } = setup();
      open();
      const inner = (e: KeyboardEvent) => {
        if (e.key === "Escape") e.preventDefault();
      };
      window.addEventListener("keydown", inner);
      try {
        fireEvent.keyDown(get("first"), { key: "Escape" });
        await flushEsc();
        expect(isOpen()).toBe(true);
      } finally {
        window.removeEventListener("keydown", inner);
      }
    });

    it("Zen の Esc と二重にならない（overlay が先、次の Esc で Zen が解ける）", async () => {
      const { get } = setup();
      render(<ZenModeController />);
      act(() => useCursorSettingsStore.getState().setZenMode(true));
      open();
      fireEvent.keyDown(get("first"), { key: "Escape" });
      // Zen の listener が overlay より先に走っても、後に走っても解けない。
      expect(useCursorSettingsStore.getState().zenMode).toBe(true);
      await flushEsc();
      expect(isOpen()).toBe(false);
      expect(useCursorSettingsStore.getState().zenMode).toBe(true);
      fireEvent.keyDown(get("outside"), { key: "Escape" });
      await flushEsc();
      expect(useCursorSettingsStore.getState().zenMode).toBe(false);
    });

    it("Zen の listener が overlay より後に登録されていても二重にならない", async () => {
      const { get } = setup();
      act(() => useCursorSettingsStore.getState().setZenMode(true));
      open();
      render(<ZenModeController />);
      fireEvent.keyDown(get("first"), { key: "Escape" });
      await flushEsc();
      expect(isOpen()).toBe(false);
      expect(useCursorSettingsStore.getState().zenMode).toBe(true);
    });
  });

  describe("フォーカス", () => {
    it("開くとパネルの先頭の操作できる要素へ移り、Esc で閉じると元の要素へ戻る", async () => {
      const { get } = setup();
      act(() => get("opener").focus());
      open();
      expect(document.activeElement).toBe(get("first"));
      fireEvent.keyDown(get("first"), { key: "Escape" });
      await flushEsc();
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

    it("つまみのクリックで閉じても元の要素へ戻る（クリックで focus がつまみに移る）", () => {
      const { get } = setup();
      act(() => get("opener").focus());
      open();
      // Chromium では button のクリックで focus がつまみへ移る。
      act(() => get("knob").focus());
      act(() => useLayoutStore.getState().toggleOverlay("left"));
      expect(document.activeElement).toBe(get("opener"));
    });

    it("左を開き、右へ切り替えて Esc で閉じても、最初の要素へ戻る", async () => {
      const { get } = setup();
      act(() => get("opener").focus());
      open();
      expect(document.activeElement).toBe(get("first"));
      // 左の層の中に focus がある状態で右へ切り替える（左の層は inert になる）。
      act(() => useLayoutStore.getState().showOverlay("right"));
      expect(useLayoutStore.getState().openOverlay).toBe("right");
      fireEvent.keyDown(get("first-right"), { key: "Escape" });
      await flushEsc();
      expect(useLayoutStore.getState().openOverlay).toBeNull();
      expect(document.activeElement).toBe(get("opener"));
      expect(requestEditorFocus).not.toHaveBeenCalled();
    });

    it("つまみで右へ切り替えて閉じても、最初の要素へ戻る（つまみには戻らない）", () => {
      const { get } = setup();
      act(() => get("opener").focus());
      open();
      act(() => get("knob-right").focus());
      act(() => useLayoutStore.getState().toggleOverlay("right"));
      act(() => get("knob-right").focus());
      act(() => useLayoutStore.getState().toggleOverlay("right"));
      expect(document.activeElement).toBe(get("opener"));
    });

    it("最初に戻す要素が無ければ、切り替えた後もエディタへ戻す", async () => {
      const { get } = setup();
      open();
      act(() => useLayoutStore.getState().showOverlay("right"));
      fireEvent.keyDown(get("first-right"), { key: "Escape" });
      await flushEsc();
      expect(requestEditorFocus).toHaveBeenCalledTimes(1);
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
