import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import type { CodexEntry } from "@/features/codex/api";
import type { MentionRole } from "@/features/codex/CodexMentionExtension";
import { getTypeLabel } from "../utils/typeLabels";

interface MentionPopupProps {
  items: CodexEntry[];
  selectedIndex: number;
  onSelect: (entry: CodexEntry) => void;
  onChangeIndex: (index: number) => void;
  clientRect: (() => DOMRect | null) | null | undefined;
  onSelectWithRole?: (entry: CodexEntry, role: MentionRole) => void;
}

const ROLES: { value: MentionRole; label: string }[] = [
  { value: "mentioned", label: "M" },
  { value: "actor", label: "A" },
  { value: "target", label: "T" },
];

export function MentionPopup({
  items,
  selectedIndex,
  onSelect,
  onChangeIndex,
  clientRect,
  onSelectWithRole,
}: MentionPopupProps) {
  const { t } = useTranslation();
  const listRef = useRef<HTMLUListElement>(null);

  // キーボードナビゲーションは親からキーイベントを受け取る
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        onChangeIndex((selectedIndex + 1) % Math.max(items.length, 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        onChangeIndex(
          (selectedIndex - 1 + Math.max(items.length, 1)) %
            Math.max(items.length, 1),
        );
      } else if (e.key === "Enter") {
        e.preventDefault();
        const item = items[selectedIndex];
        if (item) onSelect(item);
      }
    }
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [items, selectedIndex, onSelect, onChangeIndex]);

  if (items.length === 0) return null;

  // clientRect ベースで上方向に展開
  const rect = clientRect?.();
  const style = rect
    ? {
        position: "fixed" as const,
        left: `${rect.left}px`,
        bottom: `${window.innerHeight - rect.top + 4}px`,
        zIndex: 50,
      }
    : { position: "fixed" as const, left: 0, bottom: 0, zIndex: 50 };

  return (
    <ul
      ref={listRef}
      role="listbox"
      aria-label={t("chat.context.mentionSuggestions")}
      style={style}
      className="max-h-48 min-w-[200px] overflow-y-auto rounded-md border border-border bg-popover py-1 shadow-md"
    >
      {items.map((entry, i) => (
        <li
          key={entry.id}
          role="option"
          aria-selected={i === selectedIndex}
          className={[
            "flex cursor-pointer items-center gap-2 px-3 py-1.5 text-xs",
            i === selectedIndex
              ? "bg-primary text-primary-foreground"
              : "hover:bg-accent",
          ].join(" ")}
        >
          <span
            onClick={() => onSelect(entry)}
            className="flex min-w-0 flex-1 items-center gap-2"
          >
            <span
              className={
                i === selectedIndex
                  ? "rounded bg-primary-foreground/20 px-1 py-0.5 text-xs"
                  : "rounded bg-muted px-1 py-0.5 text-xs text-muted-foreground"
              }
            >
              {getTypeLabel(entry.type)}
            </span>
            <span className="font-medium">{entry.name}</span>
            {entry.summary && (
              <span
                className={
                  i === selectedIndex
                    ? "ml-auto max-w-[120px] truncate text-primary-foreground/80"
                    : "ml-auto max-w-[120px] truncate text-muted-foreground"
                }
              >
                {entry.summary}
              </span>
            )}
          </span>
          {onSelectWithRole && (
            <span className="ml-auto flex shrink-0 gap-0.5">
              {ROLES.map(({ value, label }) => (
                <button
                  key={value}
                  type="button"
                  data-testid={`mention-role-chip-${value}`}
                  title={t(`editor.mention.role.${value}`)}
                  onClick={(e) => {
                    e.stopPropagation();
                    onSelectWithRole(entry, value);
                  }}
                  className={[
                    "rounded px-1 py-0.5 text-[10px] font-medium",
                    i === selectedIndex
                      ? "bg-primary-foreground/20 hover:bg-primary-foreground/40"
                      : "bg-muted hover:bg-muted/70 text-muted-foreground",
                  ].join(" ")}
                >
                  {label}
                </button>
              ))}
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}
