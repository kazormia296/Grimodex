// @vitest-environment happy-dom
/**
 * Toolbar の a11y 配線テスト。
 * - コンテナ role="toolbar" + accessible name
 * - Overflow メニューの menu/menuitem 化とキーボード・フォーカス管理
 *   (開時に最初の項目へ focus / Esc で閉じて trigger へ復元 / ArrowDown 移動)
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { Toolbar } from "./Toolbar";
import { useCursorSettingsStore } from "./cursorSettingsStore";
import { useBackgroundStudioStore } from "./background/backgroundStudioStore";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

function createTestEditor(content = "<p>こんにちは</p>") {
  return new Editor({ extensions: [StarterKit], content });
}

function renderToolbar(editor: Editor) {
  return render(<Toolbar editor={editor as never} onFindReplace={() => {}} />);
}

function openOverflow() {
  fireEvent.click(
    screen.getByRole("button", { name: "editor.toolbar.moreOptions" }),
  );
}

afterEach(() => cleanup());
beforeEach(() => {
  useCursorSettingsStore.setState({ zenMode: false });
  useBackgroundStudioStore.setState({ open: false });
});

describe("Toolbar container semantics", () => {
  it("exposes role=toolbar with an accessible name", () => {
    const editor = createTestEditor();
    renderToolbar(editor);
    const toolbar = screen.getByRole("toolbar");
    expect(toolbar).toHaveAttribute("aria-label", "editor.toolbar.label");
    editor.destroy();
  });

  it("marks separators as decorative (aria-hidden)", () => {
    const editor = createTestEditor();
    renderToolbar(editor);
    const seps = screen
      .getByRole("toolbar")
      .querySelectorAll("div.w-px[aria-hidden]");
    expect(seps.length).toBeGreaterThan(0);
    editor.destroy();
  });

  it("does not render persistent editor chrome in Zen mode", () => {
    const editor = createTestEditor();
    useCursorSettingsStore.setState({ zenMode: true });
    renderToolbar(editor);
    expect(screen.queryByRole("toolbar")).toBeNull();
    editor.destroy();
  });

  it("opens the live background studio from the normal editor toolbar", () => {
    const editor = createTestEditor();
    renderToolbar(editor);

    fireEvent.click(
      screen.getByRole("button", { name: "editor.background.open" }),
    );

    expect(useBackgroundStudioStore.getState().open).toBe(true);
    editor.destroy();
  });
});

describe("Toolbar overflow menu", () => {
  it("trigger exposes aria-haspopup and reflects expanded state", () => {
    const editor = createTestEditor();
    renderToolbar(editor);
    const trigger = screen.getByRole("button", {
      name: "editor.toolbar.moreOptions",
    });
    expect(trigger).toHaveAttribute("aria-haspopup", "menu");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    openOverflow();
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    editor.destroy();
  });

  it("opens as role=menu with menuitem children and focuses the first item", () => {
    const editor = createTestEditor();
    renderToolbar(editor);
    openOverflow();
    const menu = screen.getByRole("menu");
    expect(menu).toBeInTheDocument();
    const items = [
      ...screen.getAllByRole("menuitem"),
      ...screen.getAllByRole("menuitemcheckbox"),
    ];
    expect(items.length).toBeGreaterThan(0);
    // 開いた直後は最初の menuitem (検索と置換) にフォーカスが移る
    expect(document.activeElement).toBe(
      screen.getByRole("menuitem", { name: /findReplace/ }),
    );
    editor.destroy();
  });

  it("Escape closes the menu and restores focus to the trigger", () => {
    const editor = createTestEditor();
    renderToolbar(editor);
    openOverflow();
    const focused = document.activeElement as HTMLElement;
    fireEvent.keyDown(focused, { key: "Escape" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "editor.toolbar.moreOptions" }),
    );
    editor.destroy();
  });

  it("ArrowDown moves focus to the next focusable item", () => {
    const editor = createTestEditor();
    renderToolbar(editor);
    openOverflow();
    const first = document.activeElement as HTMLElement;
    fireEvent.keyDown(first, { key: "ArrowDown" });
    expect(document.activeElement).not.toBe(first);
    expect(screen.getByRole("menu").contains(document.activeElement)).toBe(
      true,
    );
    editor.destroy();
  });
});
