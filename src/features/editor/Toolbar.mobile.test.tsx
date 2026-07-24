// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceViewportProvider } from "@/runtime/workspaceViewportContext";
import { useCursorSettingsStore } from "./cursorSettingsStore";
import { Toolbar } from "./Toolbar";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

function createTestEditor() {
  return new Editor({
    extensions: [StarterKit],
    content: "<p>mobile</p>",
  });
}

function renderPhoneToolbar(
  editor: Editor,
  onTogglePanel: () => void = () => {},
) {
  return render(
    <WorkspaceViewportProvider profile="phone">
      <Toolbar
        editor={editor as never}
        onFindReplace={() => {}}
        onTogglePanel={onTogglePanel}
      />
    </WorkspaceViewportProvider>,
  );
}

afterEach(() => cleanup());

beforeEach(() => {
  useCursorSettingsStore.setState({ zenMode: false });
});

describe("Toolbar phone controls", () => {
  it("keeps the direct 44px touch controls within a 320px action budget", () => {
    const editor = createTestEditor();
    renderPhoneToolbar(editor);

    const toolbar = screen.getByRole("toolbar");
    expect(toolbar.querySelectorAll("button")).toHaveLength(6);
    expect(
      screen.queryByRole("button", {
        name: "editor.toolbar.sceneMetaPanel",
      }),
    ).toBeNull();

    editor.destroy();
  });

  it("keeps the scene information action reachable from More", () => {
    const editor = createTestEditor();
    const onTogglePanel = vi.fn();
    renderPhoneToolbar(editor, onTogglePanel);

    const moreButton = screen.getByRole("button", {
      name: "editor.toolbar.moreOptions",
    });
    fireEvent.click(moreButton);
    fireEvent.click(
      screen.getByRole("menuitem", {
        name: "editor.toolbar.sceneMetaPanel",
      }),
    );

    expect(onTogglePanel).toHaveBeenCalledOnce();
    expect(screen.queryByRole("menu")).toBeNull();
    expect(moreButton).toHaveFocus();
    editor.destroy();
  });

  it("renders More as a viewport-safe scroll region outside clipped editor chrome", () => {
    const editor = createTestEditor();
    renderPhoneToolbar(editor);
    const toolbar = screen.getByRole("toolbar");

    fireEvent.click(
      screen.getByRole("button", {
        name: "editor.toolbar.moreOptions",
      }),
    );

    const menu = screen.getByRole("menu");
    expect(menu).toHaveAttribute("data-phone-toolbar-overflow");
    expect(menu).toHaveClass("overflow-y-auto");
    expect(toolbar.contains(menu)).toBe(false);

    editor.destroy();
  });
});
