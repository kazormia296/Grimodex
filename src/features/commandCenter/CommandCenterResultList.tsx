import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Loader2 } from "lucide-react";
import { useCommandCenterStore } from "./store/commandCenterStore";
import { flattenSections } from "./lib/flattenSections";
import { CommandCenterResultItem } from "./CommandCenterResultItem";
import type { CommandCenterSection } from "./providers/types";

interface CommandCenterResultListProps {
  /** sections を外から渡せるようにして、専用パネルからも再利用可能にする */
  sections?: CommandCenterSection[];
  /**
   * 1 section あたりの表示上限。Bar の popover では `BAR_VISIBLE_LIMIT_PER_SECTION` を
   * 指定して slice する (store には panel 用の 50 件が入っているため)。
   * 未指定なら無制限。
   */
  maxItemsPerSection?: number;
}

export function CommandCenterResultList({
  sections,
  maxItemsPerSection,
}: CommandCenterResultListProps) {
  const { t } = useTranslation();
  const storeSections = useCommandCenterStore((s) => s.sections);
  const selectedIndex = useCommandCenterStore((s) => s.selectedIndex);
  const parsedQuery = useCommandCenterStore((s) => s.parsedQuery);

  const effective = useMemo(() => {
    const raw = sections ?? storeSections;
    if (maxItemsPerSection === undefined) return raw;
    return raw.map((s) => ({
      ...s,
      items: s.items.slice(0, maxItemsPerSection),
    }));
  }, [sections, storeSections, maxItemsPerSection]);
  const flat = flattenSections(effective);

  if (effective.length === 0) {
    if (parsedQuery.trim().length === 0) {
      return (
        <div className="px-3 py-3 text-xs text-muted-foreground">
          {t("commandCenter.emptyHint", {
            defaultValue: "キーワードを入力 (> でコマンドモード)",
          })}
        </div>
      );
    }
    return (
      <div className="px-3 py-3 text-center text-xs text-muted-foreground">
        {t("commandCenter.noResults", { defaultValue: "結果なし" })}
      </div>
    );
  }

  let cursor = 0;
  return (
    <div role="listbox" className="max-h-[60vh] overflow-y-auto py-1">
      {effective.map((section) => {
        const sectionStart = cursor;
        cursor += section.items.length;
        return (
          <div key={section.id} className="mb-1 last:mb-0">
            <div className="flex items-center justify-between px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
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
            {section.items.map((item, idx) => (
              <CommandCenterResultItem
                key={item.id}
                item={item}
                selected={sectionStart + idx === selectedIndex}
                onMouseEnter={() =>
                  useCommandCenterStore.setState({
                    selectedIndex: sectionStart + idx,
                  })
                }
                onClick={() => {
                  item.onSelect();
                  useCommandCenterStore.getState().setOpen(false);
                }}
              />
            ))}
          </div>
        );
      })}
      {flat.length === 0 && parsedQuery.trim().length > 0 && (
        <div className="px-3 py-3 text-center text-xs text-muted-foreground">
          {t("commandCenter.noResults", { defaultValue: "結果なし" })}
        </div>
      )}
    </div>
  );
}
