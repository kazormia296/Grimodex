import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, Tag as TagIcon } from "lucide-react";
import { TagSelector } from "./TagSelector";
import type { CodexTag } from "../tagApi";

interface TagsChipProps {
  entryId: string;
  entryType: string;
  selectedTags: CodexTag[];
  onTagsChange: (tags: CodexTag[]) => void;
}

export function TagsChip({
  entryId,
  entryType,
  selectedTags,
  onTagsChange,
}: TagsChipProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const count = selectedTags.length;
  const label =
    count > 0 ? t("codex.tagsCountChip", { count }) : t("codex.tagsAdd");

  return (
    <div ref={ref} data-testid="codex-detail-tags" className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1.5 rounded border border-border bg-transparent px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        <TagIcon className="h-3 w-3" />
        <span>{label}</span>
        <ChevronDown className="h-2.5 w-2.5 text-muted-foreground/70" />
      </button>

      {open && (
        <div className="absolute left-0 top-full z-30 mt-1.5 min-w-[220px] rounded-lg border border-border bg-popover p-2 shadow-lg">
          <TagSelector
            entryId={entryId}
            entryType={entryType}
            selectedTags={selectedTags}
            onTagsChange={onTagsChange}
          />
        </div>
      )}
    </div>
  );
}
