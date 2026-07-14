// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { Editor } from "@tiptap/core";
import { getEditorExtensions } from "@/features/editor/extensions";
import { useSettingsStore } from "@/features/settings/settingsStore";
import { useCursorSettingsStore } from "@/features/editor/cursorSettingsStore";
import { EditorBubbleMenu } from "./EditorBubbleMenu";
import type { ToolbarActions } from "./Toolbar";

// AI サブメニューの表示ゲートに使う useAiGate を固定値でモック
// (プロバイダ readiness ストアを引き込まない)。policy は既定 (未ブロック)。
vi.mock("@/features/ai-policy/useAiGate", () => ({
  useAiGate: () => ({ presentation: "enabled", tooltip: null, capability: {} }),
}));

function makeEditor(html: string) {
  return new Editor({ extensions: getEditorExtensions(), content: html });
}

function setBubble(on: boolean) {
  useSettingsStore.setState((s) => ({
    cache: { ...s.cache, "editor.bubbleMenu": String(on) },
  }));
}

function actionsRef(
  partial: Partial<ToolbarActions> = {},
): React.RefObject<ToolbarActions | null> {
  return {
    current: { openLink: vi.fn(), openRuby: vi.fn(), ...partial },
  };
}

function setSemanticLinkPickerOpen(open: boolean) {
  useCursorSettingsStore.setState({ semanticLinkPickerOpen: open } as never);
}

function isSemanticLinkPickerOpen(): boolean {
  return (
    (
      useCursorSettingsStore.getState() as unknown as {
        semanticLinkPickerOpen?: boolean;
      }
    ).semanticLinkPickerOpen === true
  );
}

describe("EditorBubbleMenu", () => {
  beforeEach(() => {
    setBubble(true);
    useCursorSettingsStore.getState().setCommentPickerOpen(false);
    useCursorSettingsStore.getState().setForeshadowPickerOpen(false);
    setSemanticLinkPickerOpen(false);
  });
  afterEach(() => cleanup());

  it("is hidden when the selection is collapsed", () => {
    const editor = makeEditor("<p>hello world</p>");
    editor.commands.setTextSelection(3);
    render(
      <EditorBubbleMenu editor={editor} toolbarActionsRef={actionsRef()} />,
    );
    expect(screen.queryByRole("toolbar")).not.toBeInTheDocument();
    editor.destroy();
  });

  it("appears when text is selected", () => {
    const editor = makeEditor("<p>hello world</p>");
    editor.commands.setTextSelection({ from: 1, to: 6 });
    render(
      <EditorBubbleMenu editor={editor} toolbarActionsRef={actionsRef()} />,
    );
    expect(screen.getByRole("toolbar")).toBeInTheDocument();
    expect(screen.getByTestId("bubble-bold")).toBeInTheDocument();
    // 装飾セパレータは aria-hidden で SR から隠す
    const seps = screen
      .getByRole("toolbar")
      .querySelectorAll("div.w-px[aria-hidden]");
    expect(seps.length).toBeGreaterThan(0);
    editor.destroy();
  });

  it("is gated off by the editor.bubbleMenu setting", () => {
    setBubble(false);
    const editor = makeEditor("<p>hello world</p>");
    editor.commands.setTextSelection({ from: 1, to: 6 });
    render(
      <EditorBubbleMenu editor={editor} toolbarActionsRef={actionsRef()} />,
    );
    expect(screen.queryByRole("toolbar")).not.toBeInTheDocument();
    editor.destroy();
  });

  it("returns nothing when editor is null", () => {
    render(<EditorBubbleMenu editor={null} toolbarActionsRef={actionsRef()} />);
    expect(screen.queryByRole("toolbar")).not.toBeInTheDocument();
  });

  it("toggles bold on the current selection", () => {
    const editor = makeEditor("<p>hello world</p>");
    editor.commands.setTextSelection({ from: 1, to: 6 });
    render(
      <EditorBubbleMenu editor={editor} toolbarActionsRef={actionsRef()} />,
    );
    fireEvent.click(screen.getByTestId("bubble-bold"));
    expect(editor.isActive("bold")).toBe(true);
    editor.destroy();
  });

  it("opens the ruby dialog through toolbar actions", () => {
    const editor = makeEditor("<p>hello world</p>");
    editor.commands.setTextSelection({ from: 1, to: 6 });
    const openRuby = vi.fn();
    render(
      <EditorBubbleMenu
        editor={editor}
        toolbarActionsRef={actionsRef({ openRuby })}
      />,
    );
    fireEvent.click(screen.getByTestId("bubble-ruby"));
    expect(openRuby).toHaveBeenCalledTimes(1);
    editor.destroy();
  });

  it("opens the comment picker for the selection", () => {
    const editor = makeEditor("<p>hello world</p>");
    editor.commands.setTextSelection({ from: 1, to: 6 });
    render(
      <EditorBubbleMenu editor={editor} toolbarActionsRef={actionsRef()} />,
    );
    fireEvent.click(screen.getByTestId("bubble-comment"));
    expect(useCursorSettingsStore.getState().commentPickerOpen).toBe(true);
    editor.destroy();
  });

  it("opens the Codex semantic-link picker when scene editing allows it", () => {
    const editor = makeEditor("<p>hello world</p>");
    editor.commands.setTextSelection({ from: 1, to: 6 });
    render(
      <EditorBubbleMenu
        editor={editor}
        toolbarActionsRef={actionsRef()}
        canEditCodexSemanticLink
      />,
    );

    fireEvent.click(screen.getByTestId("bubble-semantic-link"));

    expect(isSemanticLinkPickerOpen()).toBe(true);
    editor.destroy();
  });

  it.each([
    ["omitted", undefined],
    ["false", false],
  ] as const)(
    "hides the Codex semantic-link action when the capability is %s",
    (_label, canEditCodexSemanticLink) => {
      const editor = makeEditor("<p>hello world</p>");
      editor.commands.setTextSelection({ from: 1, to: 6 });
      render(
        <EditorBubbleMenu
          editor={editor}
          toolbarActionsRef={actionsRef()}
          {...(canEditCodexSemanticLink === undefined
            ? {}
            : { canEditCodexSemanticLink })}
        />,
      );

      expect(
        screen.queryByTestId("bubble-semantic-link"),
      ).not.toBeInTheDocument();
      expect(isSemanticLinkPickerOpen()).toBe(false);
      editor.destroy();
    },
  );

  it("reflects active marks via aria-pressed", () => {
    const editor = makeEditor("<p>hello world</p>");
    editor.chain().setTextSelection({ from: 1, to: 6 }).toggleBold().run();
    render(
      <EditorBubbleMenu editor={editor} toolbarActionsRef={actionsRef()} />,
    );
    expect(screen.getByTestId("bubble-bold")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    editor.destroy();
  });

  it("omits the AI submenu when onInlineAiCommand is not provided", () => {
    const editor = makeEditor("<p>hello world</p>");
    editor.commands.setTextSelection({ from: 1, to: 6 });
    render(
      <EditorBubbleMenu editor={editor} toolbarActionsRef={actionsRef()} />,
    );
    expect(screen.queryByTestId("bubble-ai")).not.toBeInTheDocument();
    editor.destroy();
  });

  it("shows the AI submenu trigger when onInlineAiCommand is provided", () => {
    const editor = makeEditor("<p>hello world</p>");
    editor.commands.setTextSelection({ from: 1, to: 6 });
    render(
      <EditorBubbleMenu
        editor={editor}
        toolbarActionsRef={actionsRef()}
        onInlineAiCommand={vi.fn()}
      />,
    );
    expect(screen.getByTestId("bubble-ai")).toBeInTheDocument();
    editor.destroy();
  });
});
