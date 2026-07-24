// @vitest-environment happy-dom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
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

function ToolbarAtProfile({
  profile,
  editor,
  actionsRef,
}: {
  profile: "wide" | "phone";
  editor: Editor;
  actionsRef: React.RefObject<ToolbarActions | null>;
}) {
  return (
    <WorkspaceViewportProvider profile={profile}>
      <Toolbar
        editor={editor as never}
        onFindReplace={() => {}}
        onTogglePanel={() => {}}
        actionsRef={actionsRef}
      />
    </WorkspaceViewportProvider>
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

  it("keeps the Ruby portal functional while the phone toolbar root is hidden", () => {
    const editor = createTestEditor();
    editor.commands.setTextSelection({ from: 1, to: 4 });
    const actionsRef: React.RefObject<ToolbarActions | null> = {
      current: null,
    };
    renderPhoneToolbar(editor, actionsRef);

    act(() => actionsRef.current?.openRuby());

    expect(
      screen.getByPlaceholderText("editor.toolbar.rubyAnnotation"),
    ).toBeInTheDocument();
    editor.destroy();
  });

  it("closes overflow and layer UI when the viewport enters phone mode", async () => {
    const editor = createTestEditor();
    const actionsRef: React.RefObject<ToolbarActions | null> = {
      current: null,
    };
    const { rerender } = render(
      <ToolbarAtProfile
        profile="wide"
        editor={editor}
        actionsRef={actionsRef}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: "editor.toolbar.moreOptions",
      }),
    );
    expect(
      screen.getByRole("menu", { name: "editor.toolbar.moreOptions" }),
    ).toBeInTheDocument();

    rerender(
      <ToolbarAtProfile
        profile="phone"
        editor={editor}
        actionsRef={actionsRef}
      />,
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("menu", { name: "editor.toolbar.moreOptions" }),
      ).toBeNull(),
    );

    rerender(
      <ToolbarAtProfile
        profile="wide"
        editor={editor}
        actionsRef={actionsRef}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "editor.toolbar.layers" }),
    );
    expect(await screen.findByTestId("layers-popover")).toBeInTheDocument();

    rerender(
      <ToolbarAtProfile
        profile="phone"
        editor={editor}
        actionsRef={actionsRef}
      />,
    );
    await waitFor(() =>
      expect(screen.queryByTestId("layers-popover")).toBeNull(),
    );

    editor.destroy();
  });
});
