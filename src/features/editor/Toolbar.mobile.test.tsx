// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceViewportProvider } from "@/runtime/workspaceViewportContext";
import { useCursorSettingsStore } from "./cursorSettingsStore";
import { Toolbar, type ToolbarActions } from "./Toolbar";

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
  actionsRef: React.RefObject<ToolbarActions | null>,
) {
  return render(
    <WorkspaceViewportProvider profile="phone">
      <Toolbar
        editor={editor as never}
        onFindReplace={() => {}}
        onTogglePanel={() => {}}
        actionsRef={actionsRef}
      />
    </WorkspaceViewportProvider>,
  );
}

afterEach(() => cleanup());

beforeEach(() => {
  useCursorSettingsStore.setState({ zenMode: false });
});

describe("Toolbar phone projection", () => {
  it("hides persistent editor chrome while keeping bubble-menu dialog actions registered", () => {
    const editor = createTestEditor();
    const actionsRef: React.RefObject<ToolbarActions | null> = {
      current: null,
    };
    const { container } = renderPhoneToolbar(editor, actionsRef);

    expect(screen.queryByRole("toolbar")).toBeNull();
    expect(
      container.querySelector("[data-phone-toolbar-headless]"),
    ).toBeInTheDocument();
    expect(actionsRef.current?.openRuby).toEqual(expect.any(Function));
    expect(actionsRef.current?.openLink).toEqual(expect.any(Function));

    editor.destroy();
  });
});
