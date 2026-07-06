import { useEffect, useState } from "react";
import type { RefObject } from "react";
import { Check, Search } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { AnchoredPopoverShell } from "./AnchoredPopoverShell";

export interface CodexRefEntry {
  id: string;
  name: string;
}

interface CodexRefPickerPopoverProps {
  open: boolean;
  onClose: () => void;
  triggerRef: RefObject<HTMLElement | null>;
  ariaLabel: string;
  searchPlaceholder: string;
  entries: CodexRefEntry[];
  value: string | null;
  onSelect: (id: string | null) => void;
  /** 行頭ドットの色（人物 / 場所のタイプ色）。 */
  dotColor: string;
}

/**
 * 視点(人物) / 場所のピッカーポップオーバー (1f/1h 共有)。
 * 検索入力 + 候補リスト + 「指定なしにする」。ネイティブ select の置換。
 */
export function CodexRefPickerPopover({
  open,
  onClose,
  triggerRef,
  ariaLabel,
  searchPlaceholder,
  entries,
  value,
  onSelect,
  dotColor,
}: CodexRefPickerPopoverProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

  // ポップオーバー本体は配置計算後にマウントされるため、open を見る effect では
  // 早すぎる。マウント時の callback ref で検索欄へフォーカスする（ダイアログの
  // フォーカス管理として意図的 — jsx-a11y/no-autofocus の JSX prop は使わない）。
  const focusOnMount = (el: HTMLInputElement | null) => {
    if (el && document.activeElement !== el) el.focus();
  };

  const q = query.trim().toLowerCase();
  const filtered = q
    ? entries.filter((e) => e.name.toLowerCase().includes(q))
    : entries;

  const pick = (id: string | null) => {
    onSelect(id);
    onClose();
  };

  return (
    <AnchoredPopoverShell
      open={open}
      onClose={onClose}
      triggerRef={triggerRef}
      ariaLabel={ariaLabel}
      className="w-[196px]"
      testId="codex-ref-picker"
    >
      <div className="flex items-center gap-1.5 border-b border-border px-2.5 py-1.5">
        <Search size={11} className="shrink-0 text-muted-foreground" />
        <input
          ref={focusOnMount}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={searchPlaceholder}
          aria-label={searchPlaceholder}
          className="w-full min-w-0 bg-transparent text-[11px] text-foreground placeholder:text-muted-foreground/70 focus:outline-none"
        />
      </div>
      <div className="max-h-48 overflow-y-auto py-0.5">
        {filtered.length === 0 && (
          <p className="px-2.5 py-1.5 text-[10px] italic text-muted-foreground/70">
            {t("editor.sceneDetail.noMatches")}
          </p>
        )}
        {filtered.map((e) => {
          const selected = e.id === value;
          return (
            <button
              key={e.id}
              type="button"
              onClick={() => pick(e.id)}
              className={cn(
                "flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[11px] text-foreground hover:bg-accent",
                selected && "bg-accent/60 font-medium",
              )}
            >
              <span
                aria-hidden
                className="h-1.5 w-1.5 shrink-0 rounded-full"
                style={{ background: dotColor }}
              />
              <span className="min-w-0 flex-1 truncate">{e.name}</span>
              {selected && (
                <Check size={11} className="shrink-0 text-primary" />
              )}
            </button>
          );
        })}
      </div>
      <button
        type="button"
        onClick={() => pick(null)}
        className="w-full border-t border-border px-2.5 py-1.5 text-left text-[10px] text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        {t("editor.sceneDetail.clearSelection")}
      </button>
    </AnchoredPopoverShell>
  );
}
