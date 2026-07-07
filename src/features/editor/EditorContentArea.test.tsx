// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import type { EditorSettings } from "@/features/settings/hooks/useEditorSettings";

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
vi.mock("@/features/editor/EditorContentSkeleton", () => ({
  EditorBodyWithLoading: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
}));
vi.mock("@/features/editor/EditorDropDiv", () => ({
  EditorDropDiv: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));
vi.mock("@/features/editor/useVerticalWheelScroll", () => ({
  useVerticalWheelScroll: () => {},
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
    autoPairBrackets: true,
    paragraphIndent: 0,
    verticalMode: false,
  };
}

function renderArea(
  spellCheck: boolean,
  filterSource: "human" | "ai" | "unknown" | null = null,
) {
  return render(
    <EditorContentArea
      editor={null}
      editorContainerRef={{ current: null }}
      toolbarActionsRef={{ current: null }}
      findOpen={false}
      findShowReplace={false}
      setFindOpen={() => {}}
      showForeshadowMarks={false}
      gutterReserve={null}
      focusModeHideBeats={false}
      focusMode={false}
      typewriterMode={false}
      filterSource={filterSource}
      editorSettings={makeSettings(spellCheck)}
      editorTitle=""
      loadedPhaseLabel={null}
      titleEditing={false}
      titleDraft=""
      setTitleDraft={() => {}}
      handleTitleSave={() => {}}
      handleTitleCancel={() => {}}
      handleTitleEditStart={() => {}}
      isSceneContentLoading={false}
      sceneId="scene-1"
    />,
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
