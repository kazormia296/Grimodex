import { useEffect, type CSSProperties, type PointerEventHandler } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import { getStickyEditorExtensions } from "@/features/editor/extensions";
import { useTrashBinCapture } from "@/features/editor/useTrashBinCapture";
import {
  aiEditedKey,
  createAiEditedPlugin,
} from "@/features/attribution/AiEditedPlugin";
import { isEditorViewReady } from "@/features/editor/isEditorViewReady";
import { useLicenseEditableSync } from "@/features/license/useLicenseEditableSync";
import type { TrashOrigin } from "@/features/trash-bin/types";
import { cn } from "@/lib/utils";
import { parseStickyBody } from "./StickyRichTextBody";

export interface StickyBodyEditorProps {
  body: string;
  onContentChange: (body: string) => void;
  onEscape: () => void;
  /** Map supplies this; Editor-only notes deliberately leave it null. */
  trashOrigin?: TrashOrigin | null;
  /** Map AI-seeded notes retain the attribution cleanup plugin. */
  enableAiEdited?: boolean;
  className?: string;
  style?: CSSProperties;
  onPointerDown?: PointerEventHandler<HTMLDivElement>;
}

export function StickyBodyEditor({
  body,
  onContentChange,
  onEscape,
  trashOrigin = null,
  enableAiEdited = false,
  className,
  style,
  onPointerDown,
}: StickyBodyEditorProps) {
  const editor = useEditor({
    extensions: getStickyEditorExtensions(),
    content: parseStickyBody(body),
    onUpdate({ editor: current }) {
      onContentChange(JSON.stringify(current.getJSON()));
    },
  });
  useTrashBinCapture(editor, trashOrigin);
  useLicenseEditableSync(editor);

  useEffect(() => {
    if (!enableAiEdited || !isEditorViewReady(editor)) return;
    const has = editor.view.state.plugins.find(
      (plugin) => plugin.spec.key === aiEditedKey,
    );
    if (!has) editor.registerPlugin(createAiEditedPlugin());
    return () => {
      if (isEditorViewReady(editor)) editor.unregisterPlugin(aiEditedKey);
    };
  }, [editor, enableAiEdited]);

  useEffect(() => {
    if (!editor) return;
    const timer = window.setTimeout(() => editor.commands.focus("end"), 0);
    return () => window.clearTimeout(timer);
  }, [editor]);

  if (!editor) return null;

  return (
    <div
      data-editor-sticky-ignore="true"
      className={cn("sticky-editor", className)}
      style={style}
      onPointerDown={onPointerDown}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        onEscape();
      }}
    >
      <EditorContent editor={editor} />
    </div>
  );
}
