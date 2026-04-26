import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { listForeshadowsByCodexEntry } from "@/features/foreshadow/api";
import type { ForeshadowWithLabel } from "@/features/foreshadow/types";

const LABEL_STYLE: Record<string, string> = {
  planned: "bg-muted text-muted-foreground",
  seeded: "bg-blue-500/15 text-blue-600 dark:text-blue-400",
  paid: "bg-green-500/15 text-green-600 dark:text-green-400",
  needs_strengthening: "bg-yellow-500/15 text-yellow-600 dark:text-yellow-400",
  orphan_payoff: "bg-orange-500/15 text-orange-600 dark:text-orange-400",
  abandoned: "bg-muted text-muted-foreground/50",
};

interface ForeshadowTabProps {
  codexEntryId: string;
}

export function ForeshadowTab({ codexEntryId }: ForeshadowTabProps) {
  const { t } = useTranslation();
  const [items, setItems] = useState<ForeshadowWithLabel[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    setItems(null);
    listForeshadowsByCodexEntry(codexEntryId)
      .then((rows) => {
        if (!cancelled) setItems(rows);
      })
      .catch(() => {
        if (!cancelled) setItems([]);
      });
    return () => {
      cancelled = true;
    };
  }, [codexEntryId]);

  if (items === null) {
    return (
      <div
        data-testid="foreshadow-tab-loading"
        className="flex items-center justify-center py-8 text-xs text-muted-foreground"
      >
        {t("common.loading", "読み込み中…")}
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div
        data-testid="foreshadow-tab-empty"
        className="py-8 text-center text-xs text-muted-foreground"
      >
        {t("foreshadow.codexTab.empty", "リンクされた伏線はありません")}
      </div>
    );
  }

  return (
    <ul data-testid="foreshadow-tab-list" className="space-y-1">
      {items.map((item) => (
        <li
          key={item.id}
          className="flex items-center justify-between rounded-md px-2 py-1.5 hover:bg-accent"
        >
          <span className="truncate text-sm">{item.title}</span>
          <div className="ml-2 flex shrink-0 items-center gap-1.5">
            <span className="text-xs text-muted-foreground">
              {item.setupCount}
            </span>
            <span
              className={`rounded px-1.5 py-0.5 text-xs font-medium ${LABEL_STYLE[item.label] ?? ""}`}
            >
              {t(`foreshadow.label.${item.label}`, item.label)}
            </span>
          </div>
        </li>
      ))}
    </ul>
  );
}
