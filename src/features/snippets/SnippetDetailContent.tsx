import { useState, useEffect } from "react";
import { Save, Copy, Trash2, MessageSquare } from "lucide-react";
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

interface SnippetDetailContentProps {
  snippet: Snippet;
  onSave: (
    id: string,
    data: { title: string; content: string; tags: string },
  ) => void;
  onDelete: (id: string) => void;
}

export function SnippetDetailContent({
  snippet,
  onSave,
  onDelete,
}: SnippetDetailContentProps) {
  const [title, setTitle] = useState(snippet.title);
  const [tags, setTags] = useState(snippet.tags ?? "");

  const editor = useEditor({
    extensions: [StarterKit.configure(), AuthorshipMark],
    content: snippet.content,
  });

  useAttribution(editor);

  // Sync form when snippet changes
  useEffect(() => {
    setTitle(snippet.title);
    setTags(snippet.tags ?? "");
    editor?.commands.setContent(snippet.content);
  }, [snippet.id, snippet.title, snippet.tags, snippet.content, editor]);

  const handleSave = () => {
    if (!title.trim()) return;
    const content = editor?.getHTML() ?? snippet.content;
    onSave(snippet.id, { title: title.trim(), content, tags });
  };

  return (
    <div data-testid="snippet-detail-content" className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <h3 className="text-sm font-semibold">Snippet詳細</h3>
        <div className="flex items-center gap-1">
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
            onChange={(e) => setTitle(e.target.value)}
            className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm"
          />
        </div>

        <div>
          <label className="mb-1 block text-xs font-medium">内容</label>
          <div className="rounded-md border border-input bg-background p-2">
            <EditorContent editor={editor} />
          </div>
        </div>

        <div>
          <label className="mb-1 block text-xs font-medium">タグ</label>
          <input
            data-testid="snippet-detail-tags"
            type="text"
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm"
          />
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
