import { useTranslation } from "react-i18next";
import { AlertTriangle, MessageSquarePlus } from "lucide-react";
import type { PlotPhaseType } from "@/db/schema";
import type { PlotThreadRow } from "./api";
import type { ThreadDormancy, ThreadPhaseProgress } from "./plotThreadAnalysis";
import { PhaseStepper } from "./PhaseStepper";
import { useChatStore } from "@/features/chat/chatStore";
import { useLayoutStore } from "@/features/layout/layoutStore";

interface Props {
  thread: PlotThreadRow;
  dormancy: ThreadDormancy;
  progress: ThreadPhaseProgress;
  phaseLabels: Record<PlotPhaseType, string>;
}

/** 構造分析ドロワー 1 行: 色ドット＋名前＋休眠チップ＋型抜け警告＋起承転結ステッパー。 */
export function PlotThreadAnalysisRow({
  thread,
  dormancy,
  progress,
  phaseLabels,
}: Props) {
  const { t } = useTranslation();
  const color = thread.color ?? "var(--primary)";
  const threadTitle =
    thread.name || t("plotThread.unnamed", "（無題のスレッド）");

  // Phase 3b: この糸を主題に AI 相談（非永続 focus override）。
  const handleDiscussInChat = () => {
    useChatStore
      .getState()
      .setThreadFocusOverride({ threadId: thread.id, title: threadTitle });
    useLayoutStore.getState().showPanel("chat");
  };

  let dormancyText: string;
  let dormancyTone = "text-muted-foreground";
  switch (dormancy.state) {
    case "active":
      dormancyText = t("plotThread.structure.active", "今");
      dormancyTone = "text-foreground";
      break;
    case "dormant":
      dormancyText = t("plotThread.structure.dormant", "休眠 +{{n}}", {
        n: dormancy.scenesSinceLast,
      });
      break;
    case "upcoming":
      dormancyText =
        dormancy.scenesUntilNext != null
          ? t("plotThread.structure.upcomingNext", "未登場 (次 +{{n}})", {
              n: dormancy.scenesUntilNext,
            })
          : t("plotThread.structure.upcoming", "未登場");
      break;
    default:
      dormancyText = t("plotThread.structure.unplaced", "未配置");
  }

  return (
    <div
      data-testid={`plot-structure-row-${thread.id}`}
      className="flex items-center gap-2 px-2 py-1 text-xs"
    >
      <span
        className="h-2 w-2 shrink-0 rounded-full"
        style={{ backgroundColor: color }}
        aria-hidden
      />
      <span
        className="min-w-0 flex-1 truncate font-medium text-foreground"
        title={thread.name}
      >
        {threadTitle}
      </span>

      <button
        type="button"
        onClick={handleDiscussInChat}
        className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
        title={t("plotThread.discussInChat", "この糸を AI で相談")}
        aria-label={t("plotThread.discussInChat", "この糸を AI で相談")}
      >
        <MessageSquarePlus className="h-3.5 w-3.5" aria-hidden />
      </button>

      <span
        className={`shrink-0 whitespace-nowrap tabular-nums ${dormancyTone}`}
      >
        {dormancyText}
      </span>
      {dormancy.distanceFromTail != null && dormancy.distanceFromTail > 0 && (
        <span
          className="shrink-0 whitespace-nowrap tabular-nums text-[10px] text-muted-foreground/70"
          title={t("plotThread.structure.tailDistanceHint", "軸末尾からの距離")}
        >
          {t("plotThread.structure.tailDistance", "末尾 -{{n}}", {
            n: dormancy.distanceFromTail,
          })}
        </span>
      )}

      {progress.anomalies.length > 0 && (
        <span
          className="inline-flex shrink-0 items-center gap-0.5 whitespace-nowrap text-amber-600 dark:text-amber-400"
          title={t("plotThread.structure.gapHint", "起承転結の型抜け")}
        >
          <AlertTriangle className="h-3 w-3" aria-hidden />
          {t("plotThread.structure.gap", "{{phase}}抜け", {
            phase: phaseLabels[progress.anomalies[0]],
          })}
        </span>
      )}

      <PhaseStepper
        threadId={thread.id}
        cells={progress.cells}
        color={thread.color}
        phaseLabels={phaseLabels}
        phasesReached={progress.phasesPresent}
      />
    </div>
  );
}
