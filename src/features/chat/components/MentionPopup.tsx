import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import type {
  MentionItem,
  MentionRole,
} from "@/features/codex/CodexMentionExtension";
import { getTypeLabel } from "../utils/typeLabels";

interface MentionPopupProps {
  items: MentionItem[];
  selectedIndex: number;
  onSelect: (item: MentionItem) => void;
  onChangeIndex: (index: number) => void;
  clientRect: (() => DOMRect | null) | null | undefined;
  /**
   * codex item のみで使う role 別 quick-pick。scene item には適用されない。
   */
  onSelectWithRole?: (item: MentionItem, role: MentionRole) => void;
}

const ROLES: { value: MentionRole; label: string }[] = [
  { value: "mentioned", label: "M" },
  { value: "actor", label: "A" },
  { value: "target", label: "T" },
];

function displayTypeLabel(item: MentionItem, t: (k: string) => string): string {
  if (item.kind === "scene") return t("chat.context.mentionScene");
  return getTypeLabel(item.typeLabel);
}

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

  // 選択中の <li> が listbox の可視範囲外なら追従スクロール。
  // `scrollIntoView({ block: "nearest" })` は listbox を独立スクロール領域
  // として扱い、外側 (ChatPanel 等) のスクロール位置を巻き込まない。
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const target = list.children[selectedIndex] as HTMLElement | undefined;
    if (!target) return;
    const top = target.offsetTop;
    const bottom = top + target.offsetHeight;
    const viewTop = list.scrollTop;
    const viewBottom = viewTop + list.clientHeight;
    if (top < viewTop) {
      list.scrollTop = top;
    } else if (bottom > viewBottom) {
      list.scrollTop = bottom - list.clientHeight;
    }
  }, [selectedIndex, items]);

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
      {items.map((item, i) => (
        <li
          key={`${item.kind}-${item.id}`}
          role="option"
          aria-selected={i === selectedIndex}
          data-mention-kind={item.kind}
          className={[
            "flex cursor-pointer items-center gap-2 px-3 py-1.5 text-xs",
            i === selectedIndex
              ? "bg-primary text-primary-foreground"
              : "hover:bg-accent",
          ].join(" ")}
        >
          <span
            onClick={() => onSelect(item)}
            className="flex min-w-0 flex-1 items-center gap-2"
          >
            <span
              className={
                i === selectedIndex
                  ? "rounded bg-primary-foreground/20 px-1 py-0.5 text-xs"
                  : "rounded bg-muted px-1 py-0.5 text-xs text-muted-foreground"
              }
            >
              {displayTypeLabel(item, t)}
            </span>
            <span className="font-medium">{item.name}</span>
            {item.summary && (
              <span
                className={
                  i === selectedIndex
                    ? "ml-auto max-w-[120px] truncate text-primary-foreground/80"
                    : "ml-auto max-w-[120px] truncate text-muted-foreground"
                }
              >
                {item.summary}
              </span>
            )}
          </span>
          {onSelectWithRole && item.kind === "codex" && (
            <span className="ml-auto flex shrink-0 gap-0.5">
              {ROLES.map(({ value, label }) => (
                <button
                  key={value}
                  type="button"
                  data-testid={`mention-role-chip-${value}`}
                  title={t(`editor.mention.role.${value}`)}
                  onClick={(e) => {
                    e.stopPropagation();
                    onSelectWithRole(item, value);
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
