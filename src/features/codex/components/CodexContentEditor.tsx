import { useEffect, useRef } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { AuthorshipMark } from "@/features/attribution/AuthorshipMark";
import { useAttribution } from "@/features/attribution/useAttribution";
import { useCodexHighlight } from "@/features/editor/useCodexHighlight";
import { useSceneContentStore } from "@/features/editor/sceneContentStore";
import { CodexPopover } from "@/features/editor/CodexPopover";

// Sentinel group index — distinguishes mini-editor updates from pane 0 / pane 1
const CODEX_MINI_GROUP = 99;

interface CodexContentEditorProps {
  content: string;
  onContentChange: (content: string) => void;
  entryId?: string;
  /** Called when the EditorPane pushes a change here so the parent can keep its contentRef in sync */
  onExternalSync?: (content: string) => void;
}

export function CodexContentEditor({
  content,
  onContentChange,
  entryId,
  onExternalSync,
}: CodexContentEditorProps) {
  const isApplyingExternalUpdate = useRef(false);
  const onExternalSyncRef = useRef(onExternalSync);
  onExternalSyncRef.current = onExternalSync;

  const parsedContent = (() => {
    if (!content || content === "{}") return "";
    try {
      return JSON.parse(content) as object;
    } catch {
      return "";
    }
  })();

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
