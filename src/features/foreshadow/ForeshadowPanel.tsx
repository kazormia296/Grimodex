import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus, Trash2 } from "lucide-react";
import { useForeshadowStore } from "./foreshadowStore";
import { CreateForeshadowDialog } from "./CreateForeshadowDialog";
import type { DerivedLabel } from "./types";

const PROJECT_ID = "default-project";

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
  const { items, isLoading, load, create, remove } = useForeshadowStore();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);

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

      <div className="flex-1 overflow-y-auto">
        {isLoading && (
          <p className="px-3 py-4 text-xs text-muted-foreground">…</p>
        )}

        {!isLoading && items.length === 0 && (
          <p className="px-3 py-4 text-xs text-muted-foreground">
            {t("foreshadow.panel.empty")}
          </p>
        )}

        {!isLoading &&
          items.map((item) => (
            <div
              key={item.id}
              data-testid="foreshadow-item"
              className="group flex items-start gap-2 border-b border-border/50 px-3 py-2 hover:bg-accent/50"
            >
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
