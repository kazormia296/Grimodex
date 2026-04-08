import type { CodexEntry } from "../api";
import { AliasesField } from "./AliasesField";
import { CodexContentEditor } from "./CodexContentEditor";
import { DetailsSection } from "./DetailsSection";

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
      </div>

      {/* Content (TipTap) */}
      <div>
        <label className="mb-1 block text-xs font-medium">Content</label>
        <CodexContentEditor
          content={emptyContent ? "" : entry.content}
          onContentChange={onContentChange}
        />
      </div>

      {/* Custom Details */}
      <DetailsSection entry={entry} />
    </div>
  );
}
