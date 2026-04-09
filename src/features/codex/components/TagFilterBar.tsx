import { X } from "lucide-react";

interface TagFilterBarProps {
  allTags: string[];
  selectedTags: Set<string>;
  onToggle: (tag: string) => void;
  onClear: () => void;
}

export function TagFilterBar({
  allTags,
  selectedTags,
  onToggle,
  onClear,
}: TagFilterBarProps) {
  if (allTags.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-1 border-b border-border px-2 py-1.5">
      {allTags.map((tag) => (
        <button
          key={tag}
          type="button"
          data-testid={`codex-tag-filter-${tag}`}
          onClick={() => onToggle(tag)}
          className={`rounded-full px-2 py-0.5 text-[10px] font-medium transition-colors ${
            selectedTags.has(tag)
              ? "bg-primary text-primary-foreground"
              : "bg-muted text-muted-foreground hover:bg-accent"
          }`}
        >
          {tag}
        </button>
      ))}
      {selectedTags.size > 0 && (
        <button
          type="button"
          onClick={onClear}
          className="ml-auto rounded p-0.5 text-muted-foreground hover:bg-accent"
          title="フィルタをクリア"
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </div>
  );
}
