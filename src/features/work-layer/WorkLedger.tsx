import { useState } from "react";
import { ArrowLeft, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import type { WorkLedgerItemView } from "./types";
import { useWorkLayer } from "./WorkLayerContext";
import { useWorkLayerInitialFocus } from "./useWorkLayerInitialFocus";
import { deriveAllWork } from "./workLedgerItems";

type LedgerStatus = WorkLedgerItemView["status"];
type LedgerFilter = "all" | LedgerStatus;

const FILTERS: readonly LedgerFilter[] = [
  "all",
  "active",
  "waiting",
  "held",
  "completed",
];

export function WorkLedger() {
  const workLayer = useWorkLayer();
  const { t } = useTranslation();
  const [filter, setFilter] = useState<LedgerFilter>("all");
  const backRef = useWorkLayerInitialFocus<HTMLButtonElement>();
  if (workLayer == null) return null;

  const { back, close, openActiveWork } = workLayer;
  const filterLabels: Record<LedgerFilter, string> = {
    all: t("workLayer.ledger.filters.all", "すべて"),
    active: t("workLayer.ledger.filters.active", "進行中"),
    waiting: t("workLayer.ledger.filters.waiting", "待機"),
    held: t("workLayer.ledger.filters.held", "保留"),
    completed: t("workLayer.ledger.filters.completed", "完了"),
  };
  const statusLabels: Record<LedgerStatus, string> = {
    active: filterLabels.active,
    waiting: t("workLayer.ledger.groups.waiting", "待機（LATER）"),
    held: filterLabels.held,
    completed: filterLabels.completed,
  };
  const items = deriveAllWork(workLayer.model);
  const visible =
    filter === "all" ? items : items.filter((item) => item.status === filter);
  const groups = (["active", "waiting", "held", "completed"] as const).map(
    (status) => ({
      status,
      items: visible.filter((item) => item.status === status),
    }),
  );

  return (
    <section
      role="dialog"
      aria-label={t("workLayer.ledger.aria", "すべての作業")}
      aria-modal="false"
      className="absolute left-1/2 top-2 z-40 flex max-h-[calc(100%-1rem)] w-[min(40rem,calc(100%-2rem))] -translate-x-1/2 flex-col overflow-hidden rounded-sm border border-foreground/30 bg-background text-foreground shadow-2xl"
    >
      <header className="flex items-center border-b border-foreground/30 px-3 py-2">
        <button
          ref={backRef}
          type="button"
          onClick={back}
          aria-label={t("workLayer.ledger.back", "トレイに戻る")}
          className="rounded-sm p-1 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
        </button>
        <span className="ml-2 font-mono text-[9px]">ALL WORK</span>
        <h2 className="ml-3 text-sm font-semibold">
          {t("workLayer.ledger.heading", "すべての作業")}
        </h2>
        <button
          type="button"
          onClick={close}
          aria-label={t("common.close", "閉じる")}
          className="ml-auto rounded-sm p-1 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </header>

      <div className="flex flex-wrap items-center gap-1.5 border-b border-foreground/30 px-4 py-2">
        {FILTERS.map((id) => {
          const count =
            id === "all"
              ? items.length
              : items.filter((item) => item.status === id).length;
          return (
            <button
              key={id}
              type="button"
              aria-pressed={filter === id}
              onClick={() => setFilter(id)}
              className="rounded-full border border-foreground/30 px-2.5 py-1 text-[11px] text-muted-foreground hover:bg-accent aria-pressed:bg-foreground aria-pressed:text-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {filterLabels[id]} {count}
            </button>
          );
        })}
        <span className="ml-auto font-mono text-[8px] tracking-[0.1em] text-muted-foreground">
          {t("workLayer.ledger.order", "更新順")}
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-auto py-1">
        {groups.map((group) =>
          group.items.length === 0 ? null : (
            <section key={group.status} aria-label={statusLabels[group.status]}>
              <h3 className="px-4 pb-1 pt-2 font-mono text-[9px] tracking-[0.16em] text-muted-foreground">
                {statusLabels[group.status]}
              </h3>
              {group.items.map((item) => {
                const detail =
                  item.detail ??
                  (item.taskProgress == null
                    ? null
                    : t(
                        "workLayer.ledger.taskProgress",
                        "タスク {{completed}}/{{total}}",
                        item.taskProgress,
                      ));
                const content = (
                  <>
                    <span className="h-2 w-2 shrink-0 border border-foreground/50 group-data-[status=active]:rounded-full group-data-[status=active]:bg-foreground group-data-[status=completed]:border-0" />
                    <span className="min-w-0 flex-1 truncate text-xs group-data-[status=completed]:line-through group-data-[status=completed]:text-muted-foreground">
                      {item.title}
                    </span>
                    {detail != null && (
                      <span className="text-[10px] text-muted-foreground">
                        {detail}
                      </span>
                    )}
                    {item.tag != null && (
                      <span className="rounded-sm border border-border px-1.5 py-0.5 font-mono text-[8px] tracking-[0.1em] text-muted-foreground">
                        {item.tag}
                      </span>
                    )}
                    {item.updatedLabel != null && (
                      <span className="w-14 text-right font-mono text-[9px] text-muted-foreground">
                        {item.updatedLabel}
                      </span>
                    )}
                  </>
                );
                const rowClass =
                  "group flex w-full items-center gap-2.5 px-4 py-2 text-left hover:bg-accent";
                return item.status === "active" ? (
                  <button
                    key={item.id}
                    type="button"
                    data-status={item.status}
                    aria-label={t(
                      "workLayer.ledger.openActiveAria",
                      "進行中の{{title}}をトレイで開く",
                      { title: item.title },
                    )}
                    onClick={openActiveWork}
                    className={`${rowClass} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset`}
                  >
                    {content}
                  </button>
                ) : (
                  <div
                    key={item.id}
                    data-status={item.status}
                    className={rowClass}
                  >
                    {content}
                  </div>
                );
              })}
            </section>
          ),
        )}
        {visible.length === 0 && (
          <p className="px-4 py-8 text-center text-xs text-muted-foreground">
            {t("workLayer.ledger.empty", "該当する作業はありません。")}
          </p>
        )}
      </div>

      <footer className="border-t border-foreground/30 px-4 py-2 text-right font-mono text-[9px] tracking-[0.1em] text-muted-foreground">
        ESC {t("workLayer.ledger.escape", "トレイへ")}
      </footer>
    </section>
  );
}
