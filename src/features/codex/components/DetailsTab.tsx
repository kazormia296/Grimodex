import { useState } from "react";
import { toast } from "sonner";
import { Wand2 } from "lucide-react";
import type { CodexEntry } from "../api";
import { AliasesField } from "./AliasesField";
import { CodexContentEditor } from "./CodexContentEditor";
import { DetailsSection } from "./DetailsSection";
import { extractPlainText } from "../prosemirrorTextExtractor";
import { generateSynopsisFromContent } from "@/features/chat/chatApi";

interface DetailsTabProps {
  entry: CodexEntry;
  aliases: string[];
  summary: string;
  onAliasesChange: (aliases: string[]) => void;
  onSummaryChange: (value: string) => void;
  onContentChange: (content: string) => void;
}

export function DetailsTab({
  entry,
  aliases,
  summary,
  onAliasesChange,
  onSummaryChange,
  onContentChange,
}: DetailsTabProps) {
  const emptyContent = !entry.content || entry.content === "{}";
  const [isGenerating, setIsGenerating] = useState(false);

  return (
    <div className="space-y-3">
      {/* Aliases */}
      <AliasesField
        label="Aliases"
        aliases={aliases}
        onChange={onAliasesChange}
      />

      {/* Summary */}
      <div>
        <label className="mb-1 block text-xs font-medium">概要</label>
        <textarea
          data-testid="codex-detail-summary"
          value={summary}
          onChange={(e) => onSummaryChange(e.target.value)}
          rows={3}
          className="w-full resize-none rounded-md border border-input bg-background px-2 py-1.5 text-sm"
          placeholder="Short description..."
        />
        {/* S5: hint when summary is empty but content exists */}
        {summary === "" && !emptyContent && (
          <p className="mt-1 text-[11px] text-muted-foreground">
            Summaryを記入するとAIチャットでのトークン消費を抑えられます
          </p>
        )}
        {/* M4: AI auto-generate button */}
        {summary === "" && !emptyContent && (
          <button
            type="button"
            data-testid="codex-generate-summary"
            disabled={isGenerating}
            onClick={async () => {
              setIsGenerating(true);
              try {
                const plainText = extractPlainText(entry.content ?? "{}");
                const generated = await generateSynopsisFromContent(
                  entry.name,
                  plainText,
                );
                onSummaryChange(generated);
              } catch {
                toast.error("AI要約の生成に失敗しました");
              } finally {
                setIsGenerating(false);
              }
            }}
            className="mt-1 flex items-center gap-1 rounded px-2 py-1 text-[11px] text-muted-foreground hover:bg-accent disabled:opacity-50"
          >
            <Wand2 className="h-3 w-3" />
            {isGenerating ? "生成中..." : "AI要約を生成"}
          </button>
        )}
      </div>

      {/* Content (TipTap) */}
      <div>
        <label className="mb-1 block text-xs font-medium">Content</label>
        <CodexContentEditor
          content={emptyContent ? "" : entry.content}
          onContentChange={onContentChange}
          entryId={entry.id}
        />
      </div>

      {/* Custom Details */}
      <DetailsSection entry={entry} />
    </div>
  );
}
