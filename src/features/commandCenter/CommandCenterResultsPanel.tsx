import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { Loader2, Search, Terminal } from "lucide-react";
import { useCommandCenterStore } from "./store/commandCenterStore";
import { useResultsPanelStore } from "./store/resultsPanelStore";
import { useFilteredSections } from "./hooks/useFilteredSections";
import { previewCache } from "./lib/previewCache";
import { CommandCenterFilterBar } from "./CommandCenterFilterBar";
import { CommandCenterPreviewPopover } from "./CommandCenterPreviewPopover";
import { CommandCenterResultItem } from "./CommandCenterResultItem";

/**
 * 検索パネル (Dockview)。バーと同じ commandCenterStore.query を編集し、
 * 同じ結果を横断的に閲覧する。
 *
 * - クエリ + provider 実行は CommandCenter バー (`useCommandCenterSearch`) が SSoT。
 *   パネルからは `useCommandCenterSearch` を呼ばない (二重 hook race 防止)。
 *   パネル内の入力欄は store の `query`/`setQuery` を共有するため、バーが既に
 *   起動している `useCommandCenterSearch` がそのまま結果を更新する。
 * - パネル mount 中は `useResultsPanelStore.mounted` が true になり、バー側が
 *   それを購読して provider の limit を 50 に拡大する。
 * - パネル限定のフィルタ・選択は `resultsPanelStore`。
 */

export function CommandCenterResultsPanel() {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement>(null);
  const setMounted = useResultsPanelStore((s) => s.setMounted);
  const hoveredItemId = useResultsPanelStore((s) => s.hoveredItemId);
  const setHovered = useResultsPanelStore((s) => s.setHovered);
  const selectedItemId = useResultsPanelStore((s) => s.selectedItemId);
  const setSelected = useResultsPanelStore((s) => s.setSelected);
  const focusRequest = useResultsPanelStore((s) => s.focusRequest);
  const query = useCommandCenterStore((s) => s.query);
  const setQuery = useCommandCenterStore((s) => s.setQuery);
  const mode = useCommandCenterStore((s) => s.mode);
  const parsedQuery = useCommandCenterStore((s) => s.parsedQuery);

  const sections = useFilteredSections();

  useEffect(() => {
    setMounted(true);
    return () => {
      setMounted(false);
    };
  }, [setMounted]);

  // Ctrl+Shift+F の requestFocus() でパネル内 input を focus + 全選択。
  useEffect(() => {
    if (focusRequest === 0) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [focusRequest]);

  // 検索本文 (prefix 剥がし後) が変わったら previewCache を全クリア。
  // raw `query` だとキャレット移動などで毎キーストローク発火してしまうため parsedQuery を使う。
  useEffect(() => {
    previewCache.clear();
  }, [parsedQuery]);

  const Icon = mode === "command" ? Terminal : Search;
  const placeholder =
    mode === "command"
      ? t("commandCenter.placeholderCommand", { defaultValue: "コマンド…" })
      : t("commandCenter.placeholderSearch", { defaultValue: "検索…" });

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-border bg-background/40 px-3 py-2">
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
            onChange={(e) => setQuery(e.target.value)}
            placeholder={placeholder}
            aria-label={placeholder}
            className={cn(
              "h-8 w-full rounded-md border border-border bg-background pl-8 pr-3 text-sm text-foreground transition-colors",
              "placeholder:text-muted-foreground/60",
              "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
            )}
          />
        </div>
      </div>
      <CommandCenterFilterBar />
      <div
        className="flex-1 overflow-y-auto"
        onMouseLeave={() => setHovered(null)}
      >
        {parsedQuery.trim().length === 0 ? (
          <div className="px-3 py-6 text-center text-xs text-muted-foreground">
            {t("commandCenter.panel.emptyHint", {
              defaultValue: "キーワードを入力して検索 (> でコマンドモード)",
            })}
          </div>
        ) : sections.length === 0 ? (
          <div className="px-3 py-6 text-center text-xs text-muted-foreground">
            {t("commandCenter.noResults", { defaultValue: "結果なし" })}
          </div>
        ) : (
          sections.map((section) => (
            <div key={section.id} className="mb-2">
              <div className="sticky top-0 z-10 flex items-center justify-between bg-background/95 px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70 backdrop-blur">
                <span>
                  {section.title} ({section.items.length})
                </span>
                {section.state?.kind === "loading" && (
                  <span className="flex items-center gap-1 normal-case">
                    <Loader2 className="h-3 w-3 animate-spin" />
                    {t("commandCenter.loading", { defaultValue: "検索中…" })}
                  </span>
                )}
                {section.state?.kind === "error" && (
                  <span className="normal-case text-destructive">
                    {section.state.message}
                  </span>
                )}
              </div>
              {section.items.map((item) => (
                <CommandCenterPreviewPopover
                  key={item.id}
                  item={item}
                  active={hoveredItemId === item.id}
                >
                  <div
                    onMouseEnter={() => {
                      setHovered(item.id);
                      setSelected(item.id);
                    }}
                    className={cn(
                      "block",
                      selectedItemId === item.id && "bg-accent/30",
                    )}
                  >
                    <CommandCenterResultItem
                      item={item}
                      selected={false}
                      onMouseEnter={() => {}}
                      onClick={() => {
                        item.onSelect();
                      }}
                    />
                  </div>
                </CommandCenterPreviewPopover>
              ))}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
