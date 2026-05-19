import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Search, Terminal } from "lucide-react";
import { cn } from "@/lib/utils";
import { useCommandCenterStore } from "./store/commandCenterStore";
import { useResultsPanelStore } from "./store/resultsPanelStore";
import { useCommandCenterSearch } from "./hooks/useCommandCenterSearch";
import { handleCommandCenterKeyDown } from "./hooks/useCommandCenterKeyboard";
import { CommandCenterPopover } from "./CommandCenterPopover";
import { BAR_FETCH_LIMIT, PANEL_FETCH_LIMIT } from "./lib/constants";

/**
 * ヘッダー中央に常駐する検索 / Command Center バー。
 *
 * 設計メモ:
 * - `data-tauri-drag-region="false"` を最外 div に明示して header 全体の drag を子要素で除外
 * - input フォーカスは store の `focusRequest` カウンタを watch して制御 (Ctrl+Shift+F 用)
 * - popover の click-outside / Escape は containerRef 経由で AnimatedPopover に委ねる
 *
 * `useCommandCenterSearch` の単一所有者 — 専用ビュー側からは呼ばない (二重 hook race 防止)。
 * パネル mount 中は `limit: PANEL_FETCH_LIMIT (=50)` で fetch し、store には 50 件入る。
 * バーの popover 表示は `CommandCenterResultList` 側で per-section に slice する。
 */
export function CommandCenterBar() {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const query = useCommandCenterStore((s) => s.query);
  const mode = useCommandCenterStore((s) => s.mode);
  const open = useCommandCenterStore((s) => s.open);
  const focusRequest = useCommandCenterStore((s) => s.focusRequest);
  const setQuery = useCommandCenterStore((s) => s.setQuery);
  const setOpen = useCommandCenterStore((s) => s.setOpen);
  const panelMounted = useResultsPanelStore((s) => s.mounted);

  useCommandCenterSearch({
    limit: panelMounted ? PANEL_FETCH_LIMIT : BAR_FETCH_LIMIT,
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
          onKeyDown={handleCommandCenterKeyDown}
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
