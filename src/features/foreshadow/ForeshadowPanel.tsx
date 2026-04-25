import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronRight, Plus, Trash2, X } from "lucide-react";
import { useForeshadowStore } from "./foreshadowStore";
import { CreateForeshadowDialog } from "./CreateForeshadowDialog";
import type { DerivedLabel } from "./types";

const PROJECT_ID = "default-project";

const LABEL_ORDER: DerivedLabel[] = [
  "planned",
  "seeded",
  "needs_strengthening",
  "paid",
  "orphan_payoff",
  "abandoned",
];

const LABEL_STYLE: Record<DerivedLabel, string> = {
  planned: "bg-muted text-muted-foreground",
  seeded: "bg-blue-500/15 text-blue-600 dark:text-blue-400",
  paid: "bg-green-500/15 text-green-600 dark:text-green-400",
  needs_strengthening: "bg-yellow-500/15 text-yellow-600 dark:text-yellow-400",
  orphan_payoff: "bg-orange-500/15 text-orange-600 dark:text-orange-400",
  abandoned: "bg-muted text-muted-foreground/50 line-through",
};

export function ForeshadowPanel() {
  const { t } = useTranslation();
  const {
    items,
    isLoading,
    load,
    create,
    remove,
    setupsByForeshadowId,
    loadSetups,
    removeSetup,
  } = useForeshadowStore();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const handleExpand = (id: string) => {
    if (expandedId === id) {
      setExpandedId(null);
      return;
    }
    setExpandedId(id);
    void loadSetups(id);
  };
  const [activeFilters, setActiveFilters] = useState<Set<DerivedLabel>>(
    () => new Set(),
  );

  const toggleFilter = (label: DerivedLabel) => {
    setActiveFilters((prev) => {
      const next = new Set(prev);
      if (next.has(label)) {
        next.delete(label);
      } else {
        next.add(label);
      }
      return next;
    });
  };

  const visibleItems =
    activeFilters.size === 0
      ? items
      : items.filter((item) => activeFilters.has(item.label));

  const usedLabels = new Set(items.map((item) => item.label));

  useEffect(() => {
    void load(PROJECT_ID);
  }, [load]);

  const handleCreate = async (data: {
    title: string;
    intent: string | null;
  }) => {
    await create({
      projectId: PROJECT_ID,
      title: data.title,
      intent: data.intent,
    });
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <span className="text-xs font-semibold text-foreground">
          {t("foreshadow.panel.title")}
          {items.length > 0 && (
            <span className="ml-1.5 text-muted-foreground">
              ({items.length})
            </span>
          )}
        </span>
        <button
          type="button"
          data-testid="foreshadow-new-button"
          onClick={() => setDialogOpen(true)}
          className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
          title={t("foreshadow.panel.newButton")}
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Label filter bar — only shown when items exist */}
      {items.length > 0 && (
        <div className="flex flex-wrap items-center gap-1 border-b border-border px-2 py-1.5">
          {LABEL_ORDER.filter((label) => usedLabels.has(label)).map((label) => (
            <button
              key={label}
              type="button"
              data-testid={`foreshadow-filter-${label}`}
              onClick={() => toggleFilter(label)}
              className={`rounded-full px-2 py-0.5 text-[10px] font-medium transition-colors ${
                activeFilters.has(label)
                  ? "opacity-100 ring-1 ring-current " + LABEL_STYLE[label]
                  : "opacity-60 hover:opacity-90 " + LABEL_STYLE[label]
              }`}
            >
              {t(`foreshadow.label.${label}`)}
            </button>
          ))}
          {activeFilters.size > 0 && (
            <button
              type="button"
              data-testid="foreshadow-filter-clear"
              onClick={() => setActiveFilters(new Set())}
              className="ml-auto rounded p-0.5 text-muted-foreground hover:bg-accent"
              aria-label={t("foreshadow.panel.clearFilter", "フィルタをクリア")}
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
      )}

      <div className="flex-1 overflow-y-auto">
        {isLoading && (
          <p className="px-3 py-4 text-xs text-muted-foreground">…</p>
        )}

        {!isLoading && items.length === 0 && (
          <p className="px-3 py-4 text-xs text-muted-foreground">
            {t("foreshadow.panel.empty")}
          </p>
        )}

        {!isLoading && items.length > 0 && visibleItems.length === 0 && (
          <p className="px-3 py-4 text-xs text-muted-foreground">
            {t("foreshadow.panel.filterEmpty", "該当なし")}
          </p>
        )}

        {!isLoading &&
          visibleItems.map((item) => (
            <div key={item.id} className="border-b border-border/50">
              {/* Item row */}
              <div
                data-testid="foreshadow-item"
                className="group flex items-start gap-2 px-3 py-2 hover:bg-accent/50"
              >
                <button
                  type="button"
                  data-testid={`foreshadow-expand-${item.id}`}
                  onClick={() => handleExpand(item.id)}
                  className="mt-0.5 shrink-0 text-muted-foreground hover:text-foreground"
                  aria-label={t("foreshadow.panel.toggle", "展開/折り畳み")}
                >
                  {expandedId === item.id ? (
                    <ChevronDown className="h-3 w-3" />
                  ) : (
                    <ChevronRight className="h-3 w-3" />
                  )}
                </button>

                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs font-medium text-foreground">
                    {item.title}
                  </p>
                  {item.intent && (
                    <p className="mt-0.5 truncate text-xs text-muted-foreground">
                      {item.intent}
                    </p>
                  )}
                </div>

                {deleteConfirmId === item.id ? (
                  <div className="flex shrink-0 items-center gap-1">
                    <span className="text-[10px] text-destructive">
                      {t("common.confirmDelete", "削除?")}
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        setDeleteConfirmId(null);
                        void remove(item.id);
                      }}
                      className="rounded px-1 py-0.5 text-[10px] text-destructive hover:bg-destructive/10"
                      aria-label={t("common.confirm", "確認")}
                    >
                      ✓
                    </button>
                    <button
                      type="button"
                      onClick={() => setDeleteConfirmId(null)}
                      className="rounded px-1 py-0.5 text-[10px] text-muted-foreground hover:bg-accent"
                      aria-label={t("common.cancel", "キャンセル")}
                    >
                      ✗
                    </button>
                  </div>
                ) : (
                  <div className="flex shrink-0 items-center gap-1.5">
                    <span
                      className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${LABEL_STYLE[item.label]}`}
                    >
                      {t(`foreshadow.label.${item.label}`)}
                    </span>
                    <button
                      type="button"
                      onClick={() => setDeleteConfirmId(item.id)}
                      className="rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-destructive group-hover:opacity-100"
                      aria-label={t("common.delete", "削除")}
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </div>
                )}
              </div>

              {/* Setup list (shown when expanded) */}
              {expandedId === item.id && (
                <div className="border-t border-border/30 bg-muted/30 pl-6 pr-3">
                  {!setupsByForeshadowId[item.id] ? (
                    <p className="py-2 text-[10px] text-muted-foreground">…</p>
                  ) : setupsByForeshadowId[item.id].length === 0 ? (
                    <p className="py-2 text-[10px] text-muted-foreground">
                      {t("foreshadow.panel.setupsEmpty", "Setup なし")}
                    </p>
                  ) : (
                    setupsByForeshadowId[item.id].map((setup) => (
                      <div
                        key={setup.id}
                        data-testid={`foreshadow-setup-${setup.id}`}
                        className="flex items-center gap-1.5 py-1"
                      >
                        <span className="text-[10px] text-muted-foreground">
                          {t(`foreshadow.setup.kind.${setup.kind}`)}
                        </span>
                        {setup.isOrphan && (
                          <span className="rounded bg-orange-500/15 px-1 py-0.5 text-[10px] font-medium text-orange-600 dark:text-orange-400">
                            {t("foreshadow.setup.orphan", "孤立")}
                          </span>
                        )}
                        {setup.isOrphan && (
                          <button
                            type="button"
                            data-testid={`foreshadow-setup-discard-${setup.id}`}
                            onClick={() => void removeSetup(setup.id, item.id)}
                            className="ml-auto rounded px-1.5 py-0.5 text-[10px] text-destructive hover:bg-destructive/10"
                          >
                            {t("foreshadow.setup.discard", "破棄")}
                          </button>
                        )}
                      </div>
                    ))
                  )}
                </div>
              )}
            </div>
          ))}
      </div>

      <CreateForeshadowDialog
        open={dialogOpen}
        projectId={PROJECT_ID}
        onSave={handleCreate}
        onClose={() => setDialogOpen(false)}
      />
    </div>
  );
}
