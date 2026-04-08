import type { CodexEntry, CodexEntryType } from "../api";
import type { CodexTag } from "../tagApi";
import { TagSelector } from "./TagSelector";
import { TagPill } from "./TagPill";
import { AliasesField } from "./AliasesField";
import { CodexContentEditor } from "./CodexContentEditor";
import { DetailsSection } from "./DetailsSection";

interface DetailsTabProps {
  entry: CodexEntry;
  aliases: string[];
  summary: string;
  entryType: CodexEntryType;
  selectedTags: CodexTag[];
  onAliasesChange: (aliases: string[]) => void;
  onSummaryChange: (value: string) => void;
  onContentChange: (content: string) => void;
  onTagsChange: (tags: CodexTag[]) => void;
}

export function DetailsTab({
  entry,
  aliases,
  summary,
  entryType,
  selectedTags,
  onAliasesChange,
  onSummaryChange,
  onContentChange,
  onTagsChange,
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

      {/* Tags */}
      <div data-testid="codex-detail-tags">
        <label className="mb-1 block text-xs font-medium">タグ</label>
        <TagSelector
          entryId={entry.id}
          entryType={entryType}
          selectedTags={selectedTags}
          onTagsChange={onTagsChange}
        />
        {selectedTags.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-0.5">
            {selectedTags.map((tag) => (
              <TagPill
                key={tag.id}
                name={tag.name}
                color={tag.color ?? "#888888"}
                size="sm"
              />
            ))}
          </div>
        )}
      </div>

      {/* Custom Details */}
      <DetailsSection entry={entry} />
    </div>
  );
}
