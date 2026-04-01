import { useState, useEffect } from "react";
import type { CodexEntryType } from "./api";

interface CodexExtractionFormData {
  type: CodexEntryType;
  name: string;
  summary: string;
  tags: string;
  sourceChatMessageId: string;
}

interface CodexExtractionDialogProps {
  open: boolean;
  messageId: string;
  initialContent: string;
  messageRole?: "user" | "assistant";
  onSave: (data: CodexExtractionFormData) => void;
  onClose: () => void;
}

const TYPE_OPTIONS: { value: CodexEntryType; label: string }[] = [
  { value: "character", label: "キャラクター" },
  { value: "location", label: "場所" },
  { value: "item", label: "アイテム" },
  { value: "lore", label: "設定・世界観" },
];

export function CodexExtractionDialog({
  open,
  messageId,
  initialContent,
  onSave,
  onClose,
}: CodexExtractionDialogProps) {
  const [type, setType] = useState<CodexEntryType>("character");
  const [name, setName] = useState("");
  const [summary, setSummary] = useState(initialContent);
  const [tags, setTags] = useState("");

  useEffect(() => {
    if (open) {
      setType("character");
      setName("");
      setSummary(initialContent);
      setTags("");
    }
  }, [open, initialContent]);

  if (!open) return null;

  const handleSave = () => {
    if (!name.trim()) return;
    onSave({
      type,
      name: name.trim(),
      summary,
      tags,
      sourceChatMessageId: messageId,
    });
  };

  return (
    <div
      data-testid="codex-extraction-dialog"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
    >
      <div className="w-full max-w-lg rounded-lg border border-border bg-background p-6 shadow-xl">
        <h2 className="mb-4 text-lg font-semibold">Codexに抽出</h2>

        <div className="mb-3">
          <label className="mb-1 block text-sm font-medium">タイプ</label>
          <select
            data-testid="codex-type-select"
            value={type}
            onChange={(e) => setType(e.target.value as CodexEntryType)}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          >
            {TYPE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>

        <div className="mb-3">
          <label className="mb-1 block text-sm font-medium">名前</label>
          <input
            data-testid="codex-name-input"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="エントリ名を入力"
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          />
        </div>

        <div className="mb-3">
          <label className="mb-1 block text-sm font-medium">概要</label>
          <textarea
            data-testid="codex-summary-textarea"
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
            rows={5}
            className="w-full resize-none rounded-md border border-input bg-background px-3 py-2 text-sm"
          />
        </div>

        <div className="mb-4">
          <label className="mb-1 block text-sm font-medium">タグ</label>
          <input
            data-testid="codex-tags-input"
            type="text"
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            placeholder="タグをカンマ区切りで入力"
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          />
        </div>

        <div className="flex justify-end gap-2">
          <button
            type="button"
            data-testid="codex-cancel-button"
            onClick={onClose}
            className="rounded-md border border-border px-4 py-2 text-sm hover:bg-accent"
          >
            キャンセル
          </button>
          <button
            type="button"
            data-testid="codex-save-button"
            onClick={handleSave}
            className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground hover:bg-primary/90"
          >
            保存
          </button>
        </div>
      </div>
    </div>
  );
}
