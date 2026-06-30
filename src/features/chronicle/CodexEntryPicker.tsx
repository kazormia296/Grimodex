import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, ChevronsUpDown, Search } from "lucide-react";
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from "@/components/ui/popover";

export interface CodexPickerOption {
  id: string;
  name: string;
}

/** 検索クエリで Codex 候補を絞る純関数（名前の部分一致・大文字小文字無視）。 */
export function filterCodexOptions(
  options: CodexPickerOption[],
  query: string,
): CodexPickerOption[] {
  const q = query.trim().toLowerCase();
  if (!q) return options;
  return options.filter((o) => o.name.toLowerCase().includes(q));
}

export interface CodexEntryPickerProps {
  /** 選択中の codex id（null=未選択）。 */
  value: string | null;
  /** 種別で絞り込み済みの候補。 */
  options: CodexPickerOption[];
  onChange: (id: string | null) => void;
  /** トリガーボタンの aria-label。 */
  ariaLabel: string;
  /** 未選択時にトリガーへ出す文言（既定="なし"）。 */
  placeholder?: string;
}

/**
 * 種別フィルタ済み Codex から 1 件選ぶ検索付きピッカー（Chat の Spotlight 風）。
 * 主人物=character・場所=location など、呼び出し側で options を絞って渡す。
 */
export function CodexEntryPicker({
  value,
  options,
  onChange,
  ariaLabel,
  placeholder,
}: CodexEntryPickerProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const selected = options.find((o) => o.id === value) ?? null;
  const filtered = useMemo(
    () => filterCodexOptions(options, query),
    [options, query],
  );

  const choose = (id: string | null) => {
    onChange(id);
    setOpen(false);
    setQuery("");
  };

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setQuery("");
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={ariaLabel}
          className="inline-flex max-w-36 items-center gap-1 rounded border bg-transparent px-1.5 py-0.5 text-xs hover:bg-accent"
        >
          <span className="truncate">
            {selected
              ? selected.name
              : (placeholder ?? t("chronicle.none", "なし"))}
          </span>
          <ChevronsUpDown className="size-3 shrink-0 opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-56 p-0">
        <div className="flex items-center gap-1 border-b px-2 py-1.5">
          <Search className="size-3.5 opacity-50" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("chronicle.pickerSearch", "検索…")}
            className="w-full bg-transparent text-xs outline-none"
          />
        </div>
        <div className="max-h-56 overflow-auto py-1">
          <button
            type="button"
            onClick={() => choose(null)}
            className="flex w-full items-center gap-2 px-2 py-1 text-left text-xs hover:bg-accent"
          >
            <span className="size-3.5 shrink-0">
              {value == null ? <Check className="size-3.5" /> : null}
            </span>
            <span className="text-muted-foreground">
              {t("chronicle.none", "なし")}
            </span>
          </button>
          {filtered.map((o) => (
            <button
              key={o.id}
              type="button"
              onClick={() => choose(o.id)}
              className="flex w-full items-center gap-2 px-2 py-1 text-left text-xs hover:bg-accent"
            >
              <span className="size-3.5 shrink-0">
                {o.id === value ? <Check className="size-3.5" /> : null}
              </span>
              <span className="truncate">{o.name}</span>
            </button>
          ))}
          {filtered.length === 0 && (
            <div className="px-2 py-1.5 text-xs text-muted-foreground">
              {t("chronicle.pickerEmpty", "該当なし")}
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
