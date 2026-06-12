// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import type { Editor } from "@tiptap/react";
import { useEditorKeyboard } from "./useEditorKeyboard";
import { useSettingsStore } from "@/features/settings/settingsStore";
import type { ToolbarActions } from "@/features/editor/Toolbar";

/**
 * editor.inlineAiShortcut 設定の配線契約 (regression gate)。
 * トグルが Mod+Shift+Space のパレット起動を実行時に制御すること。
 */

function setShortcutSetting(value: string) {
  useSettingsStore.setState((s) => ({
    cache: { ...s.cache, "editor.inlineAiShortcut": value },
  }));
}

function pressPaletteShortcut() {
  window.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: " ",
      code: "Space",
      ctrlKey: true,
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    }),
  );
}

describe("useEditorKeyboard inlineAiPalette gating", () => {
  let pane: HTMLDivElement;
  let setPaletteOpen: ReturnType<typeof vi.fn<(open: boolean) => void>>;
  let unmount: () => void;

  beforeEach(() => {
    setShortcutSetting("true");
    pane = document.createElement("div");
    const focusable = document.createElement("button");
    pane.appendChild(focusable);
    document.body.appendChild(pane);
    focusable.focus();

    setPaletteOpen = vi.fn<(open: boolean) => void>();
    const rendered = renderHook(() =>
      useEditorKeyboard({
        paneRef: { current: pane },
        saveSceneIdRef: { current: "" },
        editorRef: { current: null as Editor | null },
        toolbarActionsRef: { current: null as ToolbarActions | null },
        handleManualSave: vi.fn(),
        setFindOpen: vi.fn(),
        setFindShowReplace: vi.fn(),
        setPalettePreselect: vi.fn(),
        setPaletteOpen,
      }),
    );
    unmount = rendered.unmount;
  });

  afterEach(() => {
    unmount();
    pane.remove();
  });

  it("opens the palette by default", () => {
    pressPaletteShortcut();
    expect(setPaletteOpen).toHaveBeenCalledWith(true);
  });

  it("does nothing when editor.inlineAiShortcut is off, re-enables at runtime", () => {
    setShortcutSetting("false");
    pressPaletteShortcut();
    expect(setPaletteOpen).not.toHaveBeenCalled();

    setShortcutSetting("true");
    pressPaletteShortcut();
    expect(setPaletteOpen).toHaveBeenCalledWith(true);
  });
});
