import { useState, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { TagPill } from "./TagPill";
import { listCodexTags, createCodexTag, setEntryTags } from "../tagApi";
import type { CodexTag } from "../tagApi";

type PersistFn = (entryId: string, tagIds: string[]) => Promise<void>;

const PRESET_COLORS = [
  "#534AB7",
  "#0F6E56",
  "#BA7517",
  "#993C1D",
  "#888888",
  "#C53030",
];

interface TagSelectorProps {
  entryId: string;
  entryType: string;
  projectId?: string;
  selectedTags: CodexTag[];
  onTagsChange: (tags: CodexTag[]) => void;
  /** 直接表示するタグの最大数。超えた分は +N ボタンに折りたたむ */
  maxVisible?: number;
  /** タグ永続化関数。省略時は setEntryTags を使用 */
  persistTags?: PersistFn;
}

export function TagSelector({
  entryId,
  entryType,
  projectId = "default-project",
  selectedTags,
  onTagsChange,
  maxVisible,
  persistTags = setEntryTags,
}: TagSelectorProps) {
  const { t } = useTranslation();
  const [allTags, setAllTags] = useState<CodexTag[]>([]);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState("");
  const [newColor, setNewColor] = useState(PRESET_COLORS[0]);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const overflowRef = useRef<HTMLDivElement>(null);

  const visibleTags =
    maxVisible !== undefined ? selectedTags.slice(0, maxVisible) : selectedTags;
  const hiddenTags =
    maxVisible !== undefined ? selectedTags.slice(maxVisible) : [];

  useEffect(() => {
    listCodexTags(projectId).then(setAllTags);
  }, [projectId]);

  // Close dropdown on outside click
  useEffect(() => {
    if (!dropdownOpen) return;
    const handler = (e: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(e.target as Node)
      ) {
        setDropdownOpen(false);
        setShowCreate(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [dropdownOpen]);

  // Close overflow dropdown on outside click
  useEffect(() => {
    if (!overflowOpen) return;
    const handler = (e: MouseEvent) => {
      if (
        overflowRef.current &&
        !overflowRef.current.contains(e.target as Node)
      ) {
        setOverflowOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [overflowOpen]);

  const filteredTags = allTags.filter((tag) => {
    if (!tag.typeFilter) return true;
    try {
      const types: string[] = JSON.parse(tag.typeFilter);
      return types.includes(entryType);
    } catch {
      return true;
    }
  });

  const selectedIds = new Set(selectedTags.map((t) => t.id));

  const handleToggle = async (tag: CodexTag) => {
    const next = selectedIds.has(tag.id)
      ? selectedTags.filter((t) => t.id !== tag.id)
      : [...selectedTags, tag];
    onTagsChange(next);
    await persistTags(
      entryId,
      next.map((t) => t.id),
    );
  };

  const handleRemove = async (tagId: string) => {
    const next = selectedTags.filter((t) => t.id !== tagId);
    onTagsChange(next);
    await persistTags(
      entryId,
      next.map((t) => t.id),
    );
  };

  const handleCreate = async () => {
    if (!newName.trim()) return;
    const tag = await createCodexTag({
      id: crypto.randomUUID(),
      projectId,
      name: newName.trim(),
      color: newColor,
    });
    setAllTags((prev) => [...prev, tag]);
    const next = [...selectedTags, tag];
    onTagsChange(next);
    await persistTags(
      entryId,
      next.map((t) => t.id),
    );
    setNewName("");
    setNewColor(PRESET_COLORS[0]);
    setShowCreate(false);
  };

  return (
    <div className="flex flex-wrap items-center gap-1">
      {visibleTags.map((tag) => (
        <TagPill
          key={tag.id}
          name={tag.name}
          color={tag.color}
          onRemove={() => handleRemove(tag.id)}
          size="sm"
        />
      ))}

      {hiddenTags.length > 0 && (
        <div className="relative" ref={overflowRef}>
          <button
            type="button"
            data-testid="tag-overflow-button"
            onClick={() => setOverflowOpen((v) => !v)}
            className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-muted/80"
          >
            +{hiddenTags.length}
          </button>
          {overflowOpen && (
            <div
              data-testid="tag-overflow-dropdown"
              className="absolute left-0 top-full z-50 mt-1 min-w-[140px] rounded-md border border-border bg-popover p-1 shadow-md"
            >
              {hiddenTags.map((tag) => (
                <div key={tag.id} className="py-0.5">
                  <TagPill
                    name={tag.name}
                    color={tag.color}
                    onRemove={() => handleRemove(tag.id)}
                    size="sm"
                  />
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="relative" ref={dropdownRef}>
        <button
          type="button"
          onClick={() => {
            setDropdownOpen((v) => !v);
            setShowCreate(false);
          }}
          className="rounded-full border border-dashed border-muted-foreground/40 px-1.5 py-0.5 text-[10px] text-muted-foreground hover:border-muted-foreground/70"
        >
          {t("codex.tagSelector.addTag")}
        </button>

        {dropdownOpen && (
          <div className="absolute left-0 top-full z-50 mt-1 min-w-[160px] rounded-md border border-border bg-popover shadow-md">
            <div className="max-h-48 overflow-y-auto p-1">
              {filteredTags.length === 0 && !showCreate && (
                <p className="px-2 py-1 text-[10px] text-muted-foreground">
                  {t("codex.tagSelector.noTags")}
                </p>
              )}
              {filteredTags.map((tag) => (
                <button
                  key={tag.id}
                  type="button"
                  onClick={() => handleToggle(tag)}
                  className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs hover:bg-accent"
                >
                  <span
                    className="h-2.5 w-2.5 flex-shrink-0 rounded-full"
                    style={{ backgroundColor: tag.color ?? "#888888" }}
                  />
                  <span className="flex-1 truncate">{tag.name}</span>
                  {selectedIds.has(tag.id) && (
                    <span className="text-[10px] text-primary">✓</span>
                  )}
                </button>
              ))}
            </div>

            <div className="border-t border-border p-1">
              {!showCreate ? (
                <button
                  type="button"
                  onClick={() => setShowCreate(true)}
                  className="w-full rounded px-2 py-1 text-left text-xs text-muted-foreground hover:bg-accent"
                >
                  {t("codex.tagSelector.createNew")}
                </button>
              ) : (
                <div className="space-y-1 p-1">
                  <input
                    type="text"
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    placeholder={t("codex.tagSelector.tagNamePlaceholder")}
                    autoFocus
                    className="w-full rounded border border-input bg-background px-1.5 py-0.5 text-xs"
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleCreate();
                      if (e.key === "Escape") setShowCreate(false);
                    }}
                  />
                  <div className="flex flex-wrap gap-1">
                    {PRESET_COLORS.map((c) => (
                      <button
                        key={c}
                        type="button"
                        onClick={() => setNewColor(c)}
                        className="h-4 w-4 rounded-full border-2"
                        style={{
                          backgroundColor: c,
                          borderColor: newColor === c ? "white" : "transparent",
                        }}
                        aria-label={c}
                      />
                    ))}
                  </div>
                  <button
                    type="button"
                    onClick={handleCreate}
                    className="w-full rounded bg-primary px-1.5 py-0.5 text-[10px] text-primary-foreground hover:bg-primary/90"
                  >
                    作成
                  </button>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
