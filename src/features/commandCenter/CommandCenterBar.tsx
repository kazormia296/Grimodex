import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Search, Terminal } from "lucide-react";
import { cn } from "@/lib/utils";
import { useBarStore } from "./store/commandCenterStore";
import { useCommandCenterSearch } from "./hooks/useCommandCenterSearch";
import { handleCommandCenterKeyDown } from "./hooks/useCommandCenterKeyboard";
import { CommandCenterPopover } from "./CommandCenterPopover";
import { BAR_FETCH_LIMIT } from "./lib/constants";

/**
 * ヘッダー中央に常駐する検索 / Command Center バー。
 *
 * 設計メモ:
 * - `data-tauri-drag-region="false"` を最外 div に明示して header 全体の drag を子要素で除外
 * - input フォーカスは store の `focusRequest` カウンタを watch して制御 (Ctrl+Shift+P 用)
 * - popover の click-outside / Escape は containerRef 経由で AnimatedPopover に委ねる
 *
 * Phase A2 で検索パネルとは別 store (`useBarStore`) に分離済。バーは
 * `BAR_FETCH_LIMIT` 固定、検索パネルは独自に `usePanelStore` + `PANEL_FETCH_LIMIT`
 * で fetch する。両者は同じ provider を独立に駆動するため Tauri command が
 * 二重呼びになるが、Phase B で bar 用 provider (Quick Open / コマンド) に
 * 差し替える前提の暫定構成。
 */
export function CommandCenterBar() {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const query = useBarStore((s) => s.query);
  const mode = useBarStore((s) => s.mode);
  const open = useBarStore((s) => s.open);
  const focusRequest = useBarStore((s) => s.focusRequest);
  const setQuery = useBarStore((s) => s.setQuery);
  const setOpen = useBarStore((s) => s.setOpen);

  useCommandCenterSearch(useBarStore, {
    limit: BAR_FETCH_LIMIT,
    surface: "bar",
  });

  // requestFocus() で input にフォーカス + 全選択
  useEffect(() => {
    if (focusRequest === 0) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [focusRequest]);

  const Icon = mode === "command" ? Terminal : Search;
  const placeholder =
    mode === "command"
      ? t("commandCenter.placeholderCommand", { defaultValue: "コマンド…" })
      : t("commandCenter.placeholderSearch", { defaultValue: "検索…" });

  return (
    <div
      ref={containerRef}
      data-tauri-drag-region="false"
      className="relative w-full max-w-2xl"
    >
      <div className="relative">
        <Icon
          className={cn(
            "pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2",
            mode === "command" ? "text-primary" : "text-muted-foreground",
          )}
        />
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            if (!open) setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => handleCommandCenterKeyDown(e, useBarStore)}
          placeholder={placeholder}
          aria-label={placeholder}
          className={cn(
            "h-8 w-full rounded-md border border-border bg-background/60 pl-8 pr-3 text-sm text-foreground transition-colors",
            "placeholder:text-muted-foreground/60",
            "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
          )}
        />
      </div>
      <CommandCenterPopover containerRef={containerRef} />
    </div>
  );
}
