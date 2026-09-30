import { useTranslation } from "react-i18next";

import { TaskDraftComposer } from "./TaskDraftComposer";
import { useWorkLayer } from "./WorkLayerContext";
import { deriveAllWork } from "./workLedgerItems";

export function FocusTrayBody() {
  const workLayer = useWorkLayer();
  const { t } = useTranslation();
  if (workLayer == null) return null;

  const { model, openAttention, switchFocusPreview } = workLayer;
  const { focus } = model;
  const firstAttention = model.attention[0];
  const allWork = deriveAllWork(model);
  const laterTargets =
    focus?.later ??
    allWork
      .filter((item) => item.status === "waiting")
      .map((item) => ({ id: item.id, title: item.title }));
  const previousCompleted =
    focus == null ? allWork.find((item) => item.status === "completed") : null;

  return (
    <div className="min-h-0 overflow-auto">
      <div className="p-3">
        <div className="font-mono text-[9px] tracking-[0.16em] text-muted-foreground">
          NOW · AUTHOR TASK
        </div>
        <h2 className="mt-1 text-sm font-semibold">
          {focus?.title ?? t("workLayer.tray.noFocus", "Focus なし")}
        </h2>
        {previousCompleted != null && (
          <div className="mt-2 flex items-center gap-2 text-[11px] text-muted-foreground">
            <span aria-hidden="true">✓</span>
            <span className="line-through">{previousCompleted.title}</span>
            <span className="ml-auto font-mono text-[8px] tracking-[0.08em]">
              {previousCompleted.updatedLabel}
            </span>
          </div>
        )}
        <div className="mt-3 space-y-1">
          {focus?.authorTasks.map((task) => (
            <label
              key={task.id}
              className="flex cursor-pointer items-center gap-2 rounded-sm border border-border px-3 py-2 text-xs hover:bg-accent"
            >
              <input type="checkbox" defaultChecked={task.completed} />
              <span>{task.title}</span>
              <span className="ml-auto font-mono text-[8px] tracking-[0.1em] text-muted-foreground">
                AUTHOR TASK
              </span>
            </label>
          ))}
        </div>
        {focus != null && <TaskDraftComposer focusId={focus.id} />}
      </div>

      {model.attention.length > 0 && (
        <button
          id="work-layer-switch-attention"
          type="button"
          onClick={openAttention}
          aria-label={t(
            "workLayer.tray.expandAttention",
            "Attention {{count}}件を展開",
            { count: model.attention.length },
          )}
          className="flex w-full items-center gap-2 bg-foreground px-4 py-2 text-left text-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
        >
          <span className="font-mono text-[9px] tracking-[0.16em]">
            ATTENTION
          </span>
          <span className="min-w-0 flex-1 truncate text-xs opacity-75">
            {firstAttention?.title}
            {model.attention.length > 1
              ? t("workLayer.tray.andMore", " ほか")
              : ""}
          </span>
          <span className="font-mono text-xs font-bold tabular-nums">
            {model.attention.length}
          </span>
          <span aria-hidden="true" className="opacity-75">
            →
          </span>
        </button>
      )}

      <div className="border-t border-border p-3">
        <div className="font-mono text-[9px] tracking-[0.16em] text-muted-foreground">
          LATER
        </div>
        {laterTargets.map((target) => (
          <button
            key={target.id}
            type="button"
            onClick={() => switchFocusPreview(target.id)}
            aria-label={t(
              "workLayer.tray.switchFocusTarget",
              "{{title}}へFocusを切り替える",
              { title: target.title },
            )}
            className="mt-1 flex w-full items-center rounded-sm px-2 py-2 text-left text-xs hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span className="min-w-0 flex-1 truncate">{target.title}</span>
            <span className="ml-3 shrink-0 text-[10px] text-muted-foreground">
              {t("workLayer.tray.switchFocus", "Focusへ切り替える")}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
