import type { Editor } from "@tiptap/react";
import { useCodexHighlightStore } from "@/features/editor/codexHighlightStore";
import { COMMENT_REBUILD_META } from "@/features/editor/CommentDecorationPlugin";
import { GUTTER_REBUILD_META } from "@/features/editor/GutterMarksPlugin";
import { useCursorSettingsStore } from "@/features/editor/cursorSettingsStore";

export type EditorOverlayKind = "comment" | "foreshadow" | "codex";

export function ensureEditorOverlayVisible(
  kind: EditorOverlayKind,
  editor: Editor | null,
): void {
  if (kind === "comment") {
    const cursor = useCursorSettingsStore.getState();
    if (!cursor.showComments) cursor.setShowComments(true);
    dispatchRebuild(editor, COMMENT_REBUILD_META);
    return;
  }

  if (kind === "foreshadow") {
    const cursor = useCursorSettingsStore.getState();
    if (!cursor.showForeshadowMarks) cursor.setShowForeshadowMarks(true);
    dispatchRebuild(editor, GUTTER_REBUILD_META);
    return;
  }

  const codex = useCodexHighlightStore.getState();
  if (!codex.enabled) codex.setEnabled(true);
}

function dispatchRebuild(editor: Editor | null, meta: string): void {
  if (!editor || editor.isDestroyed || !editor.view) return;
  editor.view.dispatch(editor.state.tr.setMeta(meta, true));
}
