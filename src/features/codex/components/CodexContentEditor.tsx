import { useEffect, useRef } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { AuthorshipMark } from "@/features/attribution/AuthorshipMark";
import { useAttribution } from "@/features/attribution/useAttribution";
import { useCodexHighlight } from "@/features/editor/useCodexHighlight";
import { useSceneContentStore } from "@/features/editor/sceneContentStore";
import { CodexPopover } from "@/features/editor/CodexPopover";
import { useTrashBinCapture } from "@/features/editor/useTrashBinCapture";
import { useFocusedContentEditorStore } from "@/store/focusedContentEditorStore";

// Sentinel group index — distinguishes mini-editor updates from pane 0 / pane 1
const CODEX_MINI_GROUP = 99;

interface CodexContentEditorProps {
  content: string;
  onContentChange: (content: string) => void;
  entryId?: string;
  /** Called when the EditorPane pushes a change here so the parent can keep its contentRef in sync */
  onExternalSync?: (content: string) => void;
  /** フェーズプレビュー用: 非nullの場合このコンテンツをエディタに適用（読み取り専用） */
  externalContent?: string | null;
}

function parseContent(raw: string): object | "" {
  if (!raw || raw === "{}") return "";
  try {
    return JSON.parse(raw) as object;
  } catch {
    return "";
  }
}

export function CodexContentEditor({
  content,
  onContentChange,
  entryId,
  onExternalSync,
  externalContent,
}: CodexContentEditorProps) {
  const isApplyingExternalUpdate = useRef(false);
  const onExternalSyncRef = useRef(onExternalSync);
  onExternalSyncRef.current = onExternalSync;
  const contentRef = useRef(content);
  contentRef.current = content;

  const parsedContent = parseContent(content);

  const editor = useEditor({
    extensions: [StarterKit.configure(), AuthorshipMark],
    content: parsedContent,
    onUpdate: ({ editor: e }) => {
      if (isApplyingExternalUpdate.current) return;
      try {
        const json = e.getJSON();
        const serialized = JSON.stringify(json);
        onContentChange(serialized);
        // Publish to sceneContentStore so the EditorPane tab stays in sync
        if (entryId) {
          useSceneContentStore
            .getState()
            .setLiveContent(entryId, json, CODEX_MINI_GROUP);
        }
      } catch {
        // ignore serialization errors
      }
    },
  });

  useAttribution(editor);
  useCodexHighlight(editor, {
    excludeEntryIds: entryId ? [entryId] : [],
    skipMatchedIds: true,
  });

  // ゴミ箱キャプチャ (副次経路)。externalContent プレビュー中は paused で停止。
  useTrashBinCapture(
    editor,
    entryId ? { kind: "codex", id: entryId } : null,
    externalContent != null,
  );

  // Trash Bin の挿入ターゲットとして「フォーカス中のミニエディタ」を共有。
  // EditorPane の codex タブが開いているとき主経路はそちらが優先される。
  useEffect(() => {
    if (!editor || !entryId) return;
    // テスト等で mock された Editor は on/off を持たないことがあるためガード。
    if (typeof editor.on !== "function") return;
    const handleFocus = () => {
      useFocusedContentEditorStore
        .getState()
        .setCurrent({ kind: "codex", id: entryId }, editor);
    };
    editor.on("focus", handleFocus);
    return () => {
      if (typeof editor.off === "function") editor.off("focus", handleFocus);
    };
  }, [editor, entryId]);

  // externalContent（フェーズプレビュー）変化時にエディタ内容を更新
  useEffect(() => {
    if (!editor) return;
    // externalContent が null → base content に戻す
    const target =
      externalContent != null ? externalContent : contentRef.current;
    const parsed = parseContent(target);
    isApplyingExternalUpdate.current = true;
    try {
      editor.commands.setContent(
        parsed as Parameters<typeof editor.commands.setContent>[0],
        { emitUpdate: false },
      );
    } finally {
      isApplyingExternalUpdate.current = false;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [externalContent]);

  // Subscribe to EditorPane updates and apply them to this mini-editor
  useEffect(() => {
    if (!entryId || !editor) return;
    return useSceneContentStore
      .getState()
      .subscribe(entryId, (json, sourceGroupIndex) => {
        if (sourceGroupIndex === CODEX_MINI_GROUP) return; // our own update — ignore
        isApplyingExternalUpdate.current = true;
        try {
          editor.commands.setContent(
            json as Parameters<typeof editor.commands.setContent>[0],
            { emitUpdate: false },
          );
          const serialized = JSON.stringify(json);
          onExternalSyncRef.current?.(serialized);
        } finally {
          isApplyingExternalUpdate.current = false;
        }
      });
  }, [entryId, editor]);

  return (
    <>
      <div
        data-testid="codex-content-editor"
        className="min-h-[80px] rounded-md border border-input bg-background px-2 py-1.5 text-sm [&_.ProseMirror]:min-h-[60px] [&_.ProseMirror]:outline-none"
      >
        <EditorContent editor={editor} />
      </div>
      <CodexPopover editor={editor} />
    </>
  );
}
