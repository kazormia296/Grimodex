// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { Editor } from "@tiptap/react";
import type { EditorSettings } from "@/features/settings/hooks/useEditorSettings";
import { WorkspaceViewportProvider } from "@/runtime/workspaceViewportContext";

/**
 * editor.spellCheck 設定が本文ラッパーの spellcheck 属性に届く配線契約
 * (regression gate)。spellcheck は属性継承するため、ラッパー div に
 * 付けば中の contenteditable に効く。
 *
 * EditorContentArea は render-only (設定は props 経由) なので、重い
 * サブコンポーネントは描画だけ落とし、props → DOM 属性の流れを assert する。
 */

vi.mock("@tiptap/react", () => ({
  EditorContent: () => null,
}));
vi.mock("@/features/editor/beat/SceneBeatEditorContext", () => ({
  SceneBeatEditorContextProvider: ({
    children,
  }: {
    children: React.ReactNode;
  }) => <>{children}</>,
}));
vi.mock("@/features/editor/CodexPopover", () => ({
  CodexPopover: () => null,
}));
vi.mock("@/features/editor/EditorBubbleMenu", () => ({
  EditorBubbleMenu: () => null,
}));
vi.mock("@/features/editor/EditorContextMenu", () => ({
  EditorContextMenu: () => null,
}));
vi.mock("@/features/editor/CommentAddPopover", () => ({
  CommentAddPopover: () => null,
}));
vi.mock("@/features/editor/CommentHoverPopover", () => ({
  CommentHoverPopover: () => null,
}));
vi.mock("@/features/post-effect/PseudoCommentBubble", () => ({
  PseudoCommentBubble: () => null,
}));
vi.mock("@/features/foreshadow/ForeshadowMarkPopover", () => ({
  ForeshadowMarkPopover: () => null,
}));
vi.mock("@/features/foreshadow/ForeshadowMarkHoverPopover", () => ({
  ForeshadowMarkHoverPopover: () => null,
}));
vi.mock("@/features/editor/FindReplaceBar", () => ({
  FindReplaceBar: () => null,
}));
vi.mock("@/features/editor/FindScrollbarMarkers", () => ({
  FindScrollbarMarkers: ({
    editor,
    enabled,
    verticalMode,
  }: {
    editor: Editor | null;
    enabled: boolean;
    verticalMode: boolean;
  }) => (
    <div
      data-testid="find-scrollbar-markers-mock"
      data-has-editor={editor ? "true" : "false"}
      data-enabled={enabled ? "true" : "false"}
      data-vertical={verticalMode ? "true" : "false"}
    />
  ),
}));
vi.mock("@/features/editor/EditorContentSkeleton", () => ({
  EditorBodyWithLoading: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
}));
vi.mock("@/features/editor/EditorDropDiv", () => ({
  EditorDropDiv: ({
    children,
    outerRef: _outerRef,
    ...props
  }: React.HTMLAttributes<HTMLDivElement> & {
    children: React.ReactNode;
    outerRef?: React.MutableRefObject<HTMLDivElement | null>;
  }) => <div {...props}>{children}</div>,
}));
vi.mock("@/features/editor/useVerticalWheelScroll", () => ({
  useVerticalWheelScroll: () => {},
}));
vi.mock("@/features/editor/zen/useZenBackgroundAppearance", () => ({
  useZenBackgroundEnabled: () => true,
}));
vi.mock("@/features/editor/ZenAmbientBackdrop", () => ({
  ZenAmbientBackdrop: () => <div data-zen-ambient aria-hidden="true" />,
}));

import { EditorContentArea } from "./EditorContentArea";

function makeSettings(spellCheck: boolean): EditorSettings {
  return {
    fontFamily: "serif",
    fontSize: 16,
    lineHeight: 1.8,
    maxContentWidth: 800,
    paragraphSpacing: 8,
    typewriterMode: false,
    focusMode: false,
    autoSaveDelay: 600000,
    spellCheck,
    smartQuotes: false,
    smartDashes: false,
    inlineAiCommand: true,
    inlineAiShortcut: true,
    smoothCaret: false,
    cursorBlink: false,
    characterFadeOut: false,
    disableAllAnimations: false,
    wordBreak: "normal",
    lineBreak: "auto",
    textAutospace: "normal",
    focusModeHideBeats: false,
    linearBeatDisplay: "normal",
    sceneMetaPanelOpen: false,
    sceneMetaPanelWidth: 20,
    showLineNumbers: false,
    aozoraInput: true,
    showInvisibles: false,
    showStickies: true,
    autoPairBrackets: true,
    paragraphIndent: 0,
    verticalMode: false,
  };
}

function renderArea(
  spellCheck: boolean,
  filterSource: "human" | "ai" | "unknown" | null = null,
  zenMode = false,
  options: {
    profile?: "wide" | "compact" | "phone";
    gutterReserve?: string | null;
    showLineNumbers?: boolean;
    titleEditing?: boolean;
    titleDraft?: string;
    editorTitle?: string;
    handleTitleSave?: () => Promise<void>;
    editor?: Editor | null;
    findOpen?: boolean;
    isSceneContentLoading?: boolean;
    verticalMode?: boolean;
  } = {},
) {
  const settings = makeSettings(spellCheck);
  settings.showLineNumbers = options.showLineNumbers ?? false;
  settings.verticalMode = options.verticalMode ?? false;
  return render(
    <WorkspaceViewportProvider profile={options.profile ?? "wide"}>
      <EditorContentArea
        editor={options.editor ?? null}
        editorContainerRef={{ current: null }}
        toolbarActionsRef={{ current: null }}
        findOpen={options.findOpen ?? false}
        findShowReplace={false}
        setFindOpen={() => {}}
        showForeshadowMarks
        gutterReserve={options.gutterReserve ?? null}
        focusModeHideBeats={false}
        focusMode={false}
        typewriterMode={false}
        filterSource={filterSource}
        editorSettings={settings}
        editorTitle={options.editorTitle ?? ""}
        loadedPhaseLabel={null}
        titleEditing={options.titleEditing ?? false}
        titleDraft={options.titleDraft ?? ""}
        setTitleDraft={() => {}}
        handleTitleSave={options.handleTitleSave ?? (() => Promise.resolve())}
        handleTitleCancel={() => {}}
        handleTitleEditStart={() => {}}
        isSceneContentLoading={options.isSceneContentLoading ?? false}
        sceneId="scene-1"
        zenMode={zenMode}
      />
    </WorkspaceViewportProvider>,
  );
}

describe("EditorContentArea spellcheck wiring", () => {
  it("reflects editor.spellCheck=false on the content wrapper", () => {
    const { container } = renderArea(false);
    const el = container.querySelector("div[spellcheck]");
    expect(el).not.toBeNull();
    expect(el!.getAttribute("spellcheck")).toBe("false");
  });

  it("reflects editor.spellCheck=true on the content wrapper", () => {
    const { container } = renderArea(true);
    const el = container.querySelector("div[spellcheck]");
    expect(el).not.toBeNull();
    expect(el!.getAttribute("spellcheck")).toBe("true");
  });
});

describe("EditorContentArea attribution filter live region", () => {
  it("announces the active filter via role=status", () => {
    const { getByRole } = renderArea(false, "ai");
    const status = getByRole("status");
    // 既存キー: attribution.filtering="フィルタ中:" / attribution.ai="AI生成"
    expect(status.textContent).toContain("AI生成");
    expect(status.className).toContain("sr-only");
  });

  it("keeps the live region mounted but empty without a filter", () => {
    const { getByRole } = renderArea(false, null);
    expect(getByRole("status").textContent).toBe("");
  });
});

describe("EditorContentArea background boundary", () => {
  it("leaves the shared background at App level and applies alpha only to the paper", () => {
    const { container } = renderArea(false, null, true);

    const paper = container.querySelector('[data-zen-editor-column="true"]');
    expect(paper).not.toBeNull();
    expect(container.querySelector("[data-zen-ambient]")).toBeNull();
    expect(paper).toHaveStyle({
      background:
        "color-mix(in oklch, var(--content-background) 35%, transparent)",
    });
    expect((paper as HTMLElement).style.opacity).toBe("");
  });
});

describe("EditorContentArea phone projection", () => {
  it("uses equal compact padding and removes every inline-start gutter reserve", () => {
    const { container } = renderArea(false, null, false, {
      profile: "phone",
      gutterReserve: "40px",
      showLineNumbers: true,
    });

    const body = container.querySelector(
      '[data-editor-layer-projection="codex-only"]',
    );
    expect(body).toBeInTheDocument();
    expect(body).toHaveClass("px-2", "py-4");
    expect(body).not.toHaveClass("p-4");
    expect(body).toHaveAttribute("data-show-foreshadow-marks", "false");

    const paper = container.querySelector("div[spellcheck]") as HTMLElement;
    expect(paper).not.toHaveClass(
      "editor-line-numbers",
      "editor-gutter-reserve",
    );
    expect(paper.style.getPropertyValue("--gutter-reserve")).toBe("");
  });
});

describe("EditorContentArea find scrollbar markers", () => {
  it("binds the active editor and writing axis while find is open", () => {
    const editor = {} as Editor;
    const { getByTestId } = renderArea(false, null, false, {
      editor,
      findOpen: true,
      verticalMode: true,
    });

    expect(getByTestId("find-scrollbar-markers-mock")).toHaveAttribute(
      "data-has-editor",
      "true",
    );
    expect(getByTestId("find-scrollbar-markers-mock")).toHaveAttribute(
      "data-enabled",
      "true",
    );
    expect(getByTestId("find-scrollbar-markers-mock")).toHaveAttribute(
      "data-vertical",
      "true",
    );
  });

  it("disables markers while the editor is loading a different document", () => {
    const { getByTestId } = renderArea(false, null, false, {
      editor: {} as Editor,
      findOpen: true,
      isSceneContentLoading: true,
    });

    expect(getByTestId("find-scrollbar-markers-mock")).toHaveAttribute(
      "data-enabled",
      "false",
    );
  });
});

describe("EditorContentArea title IME boundary", () => {
  it("does not commit or blur the title on composition Enter", () => {
    const handleTitleSave = vi.fn().mockResolvedValue(undefined);
    renderArea(false, null, false, {
      titleEditing: true,
      titleDraft: "変換中",
      editorTitle: "元の題",
      handleTitleSave,
    });
    const input = screen.getByRole("textbox");
    input.focus();

    fireEvent.keyDown(input, { key: "Enter", isComposing: true });

    expect(handleTitleSave).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(input);
  });
});
