import { cn } from "@/lib/utils";
import { useTranslation } from "react-i18next";
import { EditorContent } from "@tiptap/react";
import type { Editor } from "@tiptap/react";
import { SceneBeatEditorContextProvider } from "@/features/editor/beat/SceneBeatEditorContext";
import type { ToolbarActions } from "@/features/editor/Toolbar";
import { CodexPopover } from "@/features/editor/CodexPopover";
import { EditorBubbleMenu } from "@/features/editor/EditorBubbleMenu";
import { EditorContextMenu } from "@/features/editor/EditorContextMenu";
import { CommentAddPopover } from "@/features/editor/CommentAddPopover";
import { CommentHoverPopover } from "@/features/editor/CommentHoverPopover";
import { PseudoCommentBubble } from "@/features/post-effect/PseudoCommentBubble";
import { AnnotationHoverPopover } from "@/features/post-effect/AnnotationHoverPopover";
import { LintHoverPopover } from "@/features/lint/LintHoverPopover";
import { ForeshadowMarkPopover } from "@/features/foreshadow/ForeshadowMarkPopover";
import { ForeshadowMarkHoverPopover } from "@/features/foreshadow/ForeshadowMarkHoverPopover";
import { FindReplaceBar } from "@/features/editor/FindReplaceBar";
import { EditorBodyWithLoading } from "@/features/editor/EditorContentSkeleton";
import { EditorDropDiv } from "@/features/editor/EditorDropDiv";
import { buildEditorContentStyle } from "@/features/editor/editorLayout";
import { isWebKitGtk } from "@/lib/platform";
import { useVerticalWheelScroll } from "@/features/editor/useVerticalWheelScroll";
import type { EditorSettings } from "@/features/settings/hooks/useEditorSettings";
import type { FilterSource } from "@/features/attribution/attributionStore";
import type { InlineAiCommand } from "@/features/editor/inlineAi/inlineAiTypes";
import { useCurrentProject } from "@/features/project/projectStore";

interface EditorContentAreaProps {
  editor: Editor | null;
  editorContainerRef: React.MutableRefObject<HTMLDivElement | null>;
  toolbarActionsRef: React.MutableRefObject<ToolbarActions | null>;
  findOpen: boolean;
  findShowReplace: boolean;
  setFindOpen: (open: boolean) => void;
  showForeshadowMarks: boolean;
  /** ガター生成レイヤーON時の inline-start 予約幅 (gutterReserveInlineSize)。 */
  gutterReserve: string | null;
  focusModeHideBeats: boolean;
  focusMode: boolean;
  typewriterMode: boolean;
  filterSource: FilterSource;
  editorSettings: EditorSettings;
  editorTitle: string;
  loadedPhaseLabel: string | null;
  titleEditing: boolean;
  titleDraft: string;
  setTitleDraft: (value: string) => void;
  handleTitleSave: () => void;
  handleTitleCancel: () => void;
  handleTitleEditStart: () => void;
  isSceneContentLoading: boolean;
  sceneId: string;
  /** バブルメニューの AI サブメニューから起動されるインライン AI コマンドの
   *  ハンドラ。未指定 (file-backed シーン等) のときはバブルに AI ボタンを出さない。 */
  onInlineAiCommand?: (cmd: InlineAiCommand) => void;
}

/**
 * Editor body shared by both EditorPane layout branches (meta panel visible /
 * hidden). Render-only: all state stays in EditorPane and flows in via props.
 * Must be rendered as a descendant of EditorPane's beat DndContext so that
 * EditorDropDiv's useDroppable resolves against it.
 */
export function EditorContentArea({
  editor,
  editorContainerRef,
  toolbarActionsRef,
  findOpen,
  findShowReplace,
  setFindOpen,
  showForeshadowMarks,
  gutterReserve,
  focusModeHideBeats,
  focusMode,
  typewriterMode,
  filterSource,
  editorSettings,
  editorTitle,
  loadedPhaseLabel,
  titleEditing,
  titleDraft,
  setTitleDraft,
  handleTitleSave,
  handleTitleCancel,
  handleTitleEditStart,
  isSceneContentLoading,
  sceneId,
  onInlineAiCommand,
}: EditorContentAreaProps) {
  const { t } = useTranslation();
  // 英語プロジェクトでは段落スタイルを英文組版 (first-line indent + 先頭段落
  // 例外) に切り替える。クラス付与方式 (editor-vertical と同じ流儀)。
  const isEnglish = useCurrentProject()?.language === "en";
  // 縦書きではホイールの縦回転を読み進み方向 (横) のスクロールに変換する
  useVerticalWheelScroll(editorContainerRef, editorSettings.verticalMode);
  return (
    <>
      <FindReplaceBar
        editor={editor}
        open={findOpen}
        showReplace={findShowReplace}
        onClose={() => setFindOpen(false)}
      />
      {/* 帰属フィルタは色のみの表現のため、SR には live region で状態を伝える */}
      <div
        role="status"
        className="sr-only"
        data-testid="attribution-filter-status"
      >
        {filterSource
          ? `${t("attribution.filtering")} ${t(`attribution.${filterSource}`)}`
          : ""}
      </div>
      <EditorDropDiv
        outerRef={editorContainerRef}
        data-show-foreshadow-marks={showForeshadowMarks ? "true" : "false"}
        data-focus-hide-beats={
          focusModeHideBeats && focusMode ? "true" : undefined
        }
        className={`glass-editor-body flex-1 overflow-auto bg-content-background text-content-foreground-secondary p-4${editorSettings.verticalMode ? " editor-vertical" : ""}${typewriterMode ? " typewriter-padding" : ""}${filterSource ? ` attribution-filter-${filterSource}` : ""}`}
        onClick={(e) => {
          if (e.target === e.currentTarget) {
            editor?.commands.focus();
          }
        }}
      >
        <div
          className={cn(
            editorSettings.showLineNumbers && "editor-line-numbers",
            editorSettings.showInvisibles && "editor-show-invisibles",
            gutterReserve && "editor-gutter-reserve",
            isEnglish && "editor-en-typography",
          )}
          style={{
            ...buildEditorContentStyle(editorSettings, {
              vertical: editorSettings.verticalMode,
              webkitGtk: isWebKitGtk(),
            }),
            ...(gutterReserve
              ? ({ "--gutter-reserve": gutterReserve } as React.CSSProperties)
              : {}),
          }}
          // contenteditable は spellcheck 属性を祖先から継承する
          spellCheck={editorSettings.spellCheck}
        >
          {editorTitle && (
            <div
              className="mb-6 border-b border-border/40 pb-4"
              style={{
                fontSize: `${Math.round(editorSettings.fontSize * 1.6)}px`,
              }}
            >
              {titleEditing ? (
                <input
                  // eslint-disable-next-line jsx-a11y/no-autofocus
                  autoFocus
                  type="text"
                  value={titleDraft}
                  onChange={(e) => setTitleDraft(e.target.value)}
                  onBlur={handleTitleSave}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      handleTitleSave();
                    } else if (e.key === "Escape") {
                      e.preventDefault();
                      handleTitleCancel();
                    }
                  }}
                  className="w-full bg-transparent font-semibold text-content-foreground/60 outline-none placeholder:text-content-foreground/30"
                  style={{ fontFamily: "inherit", fontSize: "inherit" }}
                />
              ) : (
                <div
                  role="button"
                  tabIndex={0}
                  onClick={handleTitleEditStart}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === "F2")
                      handleTitleEditStart();
                  }}
                  className="cursor-text select-none font-semibold text-content-foreground/60 hover:text-content-foreground/80"
                >
                  {editorTitle}
                </div>
              )}
              {loadedPhaseLabel && (
                <div
                  className="mt-1 text-sm font-normal text-purple-500/70"
                  style={{ fontSize: `${editorSettings.fontSize}px` }}
                >
                  [{loadedPhaseLabel}]
                </div>
              )}
            </div>
          )}
          <EditorBodyWithLoading isLoading={isSceneContentLoading}>
            <SceneBeatEditorContextProvider value={{ sceneId: sceneId }}>
              <EditorContent editor={editor} />
            </SceneBeatEditorContextProvider>
            <CodexPopover editor={editor} />
            <EditorBubbleMenu
              editor={editor}
              toolbarActionsRef={toolbarActionsRef}
              onInlineAiCommand={onInlineAiCommand}
            />
            <CommentAddPopover editor={editor} />
            <ForeshadowMarkPopover editor={editor} />
            <ForeshadowMarkHoverPopover
              editor={editor}
              containerRef={editorContainerRef}
            />
            <CommentHoverPopover
              editor={editor}
              containerRef={editorContainerRef}
            />
            <PseudoCommentBubble
              editor={editor}
              containerRef={editorContainerRef}
            />
            <AnnotationHoverPopover containerRef={editorContainerRef} />
            <LintHoverPopover
              editor={editor}
              containerRef={editorContainerRef}
              sceneId={sceneId}
            />
            <EditorContextMenu
              editor={editor}
              containerRef={editorContainerRef}
              toolbarActionsRef={toolbarActionsRef}
            />
          </EditorBodyWithLoading>
        </div>
      </EditorDropDiv>
    </>
  );
}
