import { X } from "lucide-react";
import { useTranslation } from "react-i18next";

import { AttentionTrayBody } from "./AttentionTrayBody";
import { FocusTrayBody } from "./FocusTrayBody";
import { TaskTrayFooter } from "./TaskTrayFooter";
import { useWorkLayer } from "./WorkLayerContext";
import { useWorkLayerInitialFocus } from "./useWorkLayerInitialFocus";

interface TaskTrayProps {
  readonly door: "attention" | "focus";
}

export function TaskTray({ door }: TaskTrayProps) {
  const workLayer = useWorkLayer();
  const { t } = useTranslation();
  const closeRef = useWorkLayerInitialFocus<HTMLButtonElement>(
    `${door}:${workLayer?.model.focus?.id ?? "none"}`,
  );
  if (workLayer == null) return null;

  const { model, close } = workLayer;
  const isAttention = door === "attention";
  const isEmptyAttention = isAttention && model.attention.length === 0;
  const title = isAttention
    ? t("workLayer.tray.attentionAria", "Attentionの作業トレイ")
    : t("workLayer.tray.focusAria", "Focusの作業トレイ");

  return (
    <section
      role="dialog"
      aria-label={title}
      aria-modal="false"
      className="absolute left-1/2 top-2 z-40 flex max-h-[min(42rem,calc(100%-1rem))] w-[min(46rem,calc(100%-2rem))] -translate-x-1/2 flex-col overflow-hidden rounded-sm border border-foreground/30 bg-background text-foreground shadow-2xl"
    >
      {isEmptyAttention ? (
        <button
          ref={closeRef}
          type="button"
          onClick={close}
          aria-label={t("common.close", "閉じる")}
          className="absolute right-2 top-2 z-10 rounded-sm bg-background p-1 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      ) : (
        <header className="flex items-center border-b border-foreground/30 px-3 py-2 font-mono text-[9px] tracking-[0.16em]">
          <span>{isAttention ? "ATTENTION" : "NOW"}</span>
          <span className="ml-2 rounded-sm border border-foreground/30 px-1.5 py-0.5 text-[8px] text-muted-foreground">
            UI PREVIEW
          </span>
          <span className="ml-auto text-muted-foreground">
            {isAttention
              ? model.attention.length
              : (model.focus?.authorTasks.length ?? 0)}
          </span>
          <button
            ref={closeRef}
            type="button"
            onClick={close}
            aria-label={t("common.close", "閉じる")}
            className="ml-3 rounded-sm p-1 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </header>
      )}

      {isAttention ? <AttentionTrayBody /> : <FocusTrayBody />}
      <TaskTrayFooter />
    </section>
  );
}
