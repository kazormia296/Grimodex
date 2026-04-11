import { useState, useEffect, useRef, useCallback } from "react";
import {
  Save,
  Copy,
  Trash2,
  MessageSquare,
  ExternalLink,
  FileText,
  TextCursorInput,
} from "lucide-react";
import { toast } from "sonner";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { AuthorshipMark } from "@/features/attribution/AuthorshipMark";
import { useAttribution } from "@/features/attribution/useAttribution";
import {
  copyWithAttribution,
  handleCopyWithAttribution,
} from "@/lib/clipboardAttribution";
import type { AuthorshipSource } from "@/features/attribution/AuthorshipMark";
import type { Snippet } from "./api";
import { useTreeStore } from "@/features/tree/treeStore";
import { useTabStore } from "@/features/editor/tabStore";
import { useEditorStore } from "@/features/editor/editorStore";
import { useSnippetStore } from "./snippetStore";
import { TagSelector } from "@/features/codex/components/TagSelector";
import {
  listSnippetEntryTags,
  setSnippetEntryTags,
} from "@/features/codex/tagApi";
import type { CodexTag } from "@/features/codex/tagApi";

interface SnippetDetailContentProps {
  snippet: Snippet;
  onSave: (id: string, data: { title: string; content: string }) => void;
  onDelete: (id: string) => void;
}

export function SnippetDetailContent({
  snippet,
  onSave,
  onDelete,
}: SnippetDetailContentProps) {
  const setActiveScene = useTreeStore((s) => s.setActiveScene);
  const insertFromSnippet = useEditorStore((s) => s.insertFromSnippet);
  const incrementUsageCount = useSnippetStore((s) => s.incrementUsageCount);

  const [title, setTitle] = useState(snippet.title);
  const [selectedTags, setSelectedTags] = useState<CodexTag[]>([]);

  const titleRef = useRef(title);
  titleRef.current = title;

  const autoSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const editor = useEditor({
    extensions: [StarterKit.configure(), AuthorshipMark],
    content: snippet.content,
  });

  useAttribution(editor);

  // Load relational tags when snippet changes
  useEffect(() => {
    listSnippetEntryTags(snippet.id).then(setSelectedTags);
  }, [snippet.id]);

  // Sync form when snippet changes
  useEffect(() => {
    if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
    setTitle(snippet.title);
    editor?.commands.setContent(snippet.content);
  }, [snippet.id, snippet.title, snippet.content, editor]);

  // Auto-save on editor content change
  useEffect(() => {
    if (!editor) return;
    const handleUpdate = () => scheduleAutoSave();
    editor.on("update", handleUpdate);
    return () => {
      editor.off("update", handleUpdate);
    };
  });

  function scheduleAutoSave() {
    const snippetId = snippet.id;
    if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
    autoSaveTimerRef.current = setTimeout(() => {
      const content = editor?.getHTML() ?? snippet.content;
      onSave(snippetId, {
        title: titleRef.current.trim() || snippet.title,
        content,
      });
    }, 2000);
  }

  const handleSave = useCallback(() => {
    if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
    if (!title.trim()) return;
    const content = editor?.getHTML() ?? snippet.content;
    onSave(snippet.id, { title: title.trim(), content });
  }, [title, editor, snippet, onSave]);

  function handleInsertAtCursor() {
    const content = editor?.getHTML() ?? snippet.content;
    const source = (snippet.contentSource as "ai" | "human") ?? "human";
    const success = insertFromSnippet(snippet.id, content, source, null);
    if (success) {
      void incrementUsageCount(snippet.id);
      toast.success("挿入しました");
    }
  }

  return (
    <div data-testid="snippet-detail-content" className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <h3 className="text-sm font-semibold">Snippet詳細</h3>
        <div className="flex items-center gap-1">
          <button
            type="button"
            data-testid="snippet-insert-at-cursor"
            onClick={handleInsertAtCursor}
            className="rounded p-1.5 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
            title="カーソル位置に挿入"
          >
            <TextCursorInput className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            data-testid="snippet-save-button"
            onClick={handleSave}
            className="rounded p-1.5 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
            title="保存"
          >
            <Save className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            data-testid="snippet-copy-button"
            onClick={() =>
              copyWithAttribution(
                editor?.getText() ?? snippet.content,
                "human" as AuthorshipSource,
              )
            }
            className="rounded p-1.5 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
            title="コピー"
          >
            <Copy className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            data-testid="snippet-open-in-editor"
            onClick={() => useTabStore.getState().openSnippetTab(snippet.id)}
            className="rounded p-1.5 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
            title="エディタで開く"
          >
            <ExternalLink className="h-3.5 w-3.5" />
          </button>
          {snippet.sceneId && (
            <button
              type="button"
              data-testid="snippet-navigate-to-scene"
              onClick={() => setActiveScene(snippet.sceneId!)}
              className="rounded p-1.5 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
              title="関連シーンへ移動"
            >
              <FileText className="h-3.5 w-3.5" />
            </button>
          )}
          <button
            type="button"
            data-testid="snippet-detail-delete"
            onClick={() => onDelete(snippet.id)}
            className="rounded p-1.5 text-destructive hover:bg-destructive/10"
            title="削除"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      <div
        className="flex-1 space-y-3 overflow-y-auto px-3 py-3"
        onCopy={(e) =>
          handleCopyWithAttribution(e, "human" as AuthorshipSource)
        }
      >
        <div>
          <label className="mb-1 block text-xs font-medium">タイトル</label>
          <input
            data-testid="snippet-detail-title"
            type="text"
            value={title}
            onChange={(e) => {
              setTitle(e.target.value);
              scheduleAutoSave();
            }}
            className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm"
          />
        </div>

        <div>
          <label className="mb-1 block text-xs font-medium">タグ</label>
          <TagSelector
            entryId={snippet.id}
            entryType="snippet"
            selectedTags={selectedTags}
            onTagsChange={setSelectedTags}
            persistTags={setSnippetEntryTags}
          />
        </div>

        <div>
          <label className="mb-1 block text-xs font-medium">内容</label>
          <div className="rounded-md border border-input bg-background p-2">
            <EditorContent editor={editor} />
          </div>
        </div>

        {/* Metadata */}
        <div className="space-y-1 text-xs text-muted-foreground">
          <div>
            作成日: {new Date(snippet.createdAt).toLocaleString("ja-JP")}
          </div>
          <div className="flex items-center gap-2">
            <span>使用回数: {snippet.usageCount ?? 0}</span>
            {snippet.contentSource === "ai" ? (
              <span className="rounded-full bg-purple-500/20 px-1.5 py-0.5 text-[10px] text-purple-400">
                AI
              </span>
            ) : snippet.contentSource === "human" ? (
              <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                Human
              </span>
            ) : null}
          </div>
        </div>

        {snippet.sourceChatMessageId && (
          <div
            data-testid="snippet-source-chat-link"
            className="flex items-center gap-1.5 rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground"
          >
            <MessageSquare className="h-3.5 w-3.5" />
            <span>抽出元チャット: {snippet.sourceChatMessageId}</span>
          </div>
        )}
      </div>
    </div>
  );
}
