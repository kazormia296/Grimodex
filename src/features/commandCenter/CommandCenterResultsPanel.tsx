import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { Loader2 } from "lucide-react";
import { useCommandCenterStore } from "./store/commandCenterStore";
import { useResultsPanelStore } from "./store/resultsPanelStore";
import { useFilteredSections } from "./hooks/useFilteredSections";
import { previewCache } from "./lib/previewCache";
import { CommandCenterFilterBar } from "./CommandCenterFilterBar";
import { CommandCenterPreviewPopover } from "./CommandCenterPreviewPopover";
import { CommandCenterResultItem } from "./CommandCenterResultItem";

/**
 * 検索結果を横断する Dockview パネル。
 * - クエリ + provider 実行は CommandCenter バー (`useCommandCenterSearch`) が SSoT
 *   このパネルからは `useCommandCenterSearch` を呼ばない (二重 hook race 防止)
 * - パネル mount 中は `useResultsPanelStore.mounted` が true になり、バー側が
 *   それを購読して provider の limit を 50 に拡大する
 * - パネル限定のフィルタ・選択は `resultsPanelStore`
 */

export function CommandCenterResultsPanel() {
  const { t } = useTranslation();
  const setMounted = useResultsPanelStore((s) => s.setMounted);
  const hoveredItemId = useResultsPanelStore((s) => s.hoveredItemId);
  const setHovered = useResultsPanelStore((s) => s.setHovered);
  const selectedItemId = useResultsPanelStore((s) => s.selectedItemId);
  const setSelected = useResultsPanelStore((s) => s.setSelected);
  const parsedQuery = useCommandCenterStore((s) => s.parsedQuery);

  const sections = useFilteredSections();

  useEffect(() => {
    setMounted(true);
    return () => {
      setMounted(false);
    };
  }, [setMounted]);

  // 検索本文 (prefix 剥がし後) が変わったら previewCache を全クリア。
  // raw `query` だとキャレット移動などで毎キーストローク発火してしまうため parsedQuery を使う。
  useEffect(() => {
    previewCache.clear();
  }, [parsedQuery]);

  return (
    <div className="flex h-full flex-col">
      <CommandCenterFilterBar />
      <div className="border-b border-border bg-background/30 px-3 py-1.5 text-xs">
        <span className="text-muted-foreground">
          {t("commandCenter.panel.queryLabel", { defaultValue: "クエリ" })}
          :{" "}
        </span>
        <span className="font-mono text-foreground">
          {parsedQuery || (
            <span className="italic text-muted-foreground/60">
              {t("commandCenter.panel.queryEmpty", {
                defaultValue: "(なし)",
              })}
            </span>
          )}
        </span>
      </div>
      <div
        className="flex-1 overflow-y-auto"
        onMouseLeave={() => setHovered(null)}
      >
        {parsedQuery.trim().length === 0 ? (
          <div className="px-3 py-6 text-center text-xs text-muted-foreground">
            {t("commandCenter.panel.typeInBar", {
              defaultValue: "ヘッダーの検索バーにキーワードを入力",
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
