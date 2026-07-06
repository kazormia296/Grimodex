import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { CheckCircle2, ChevronDown, Loader2, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { useTreeStore } from "@/features/tree/treeStore";
import { useAiGate } from "@/features/ai-policy/useAiGate";
import { useAnchoredPopover } from "@/components/ui/useAnchoredPopover";
import { useKouetsuStore } from "../kouetsuStore";
import { useResolvedKouetsuScope } from "../useResolvedKouetsuScope";
import {
  FULL_CHECK_STEP_LABEL_KEY,
  FULL_CHECK_STEP_ORDER,
  runFullCheck,
  useFullCheckStore,
} from "../fullCheck";

/**
 * 全体チェックの起動導線（デザイン 2a の分割ボタン）。
 * - 非実行時: [全体チェック | ▾] — 左で実行、右で観点選択ドロップダウン。
 * - 実行中: 「実行中 n/N」ピル — クリックでパイプラインステージを表示
 *   （リストへ戻ってもここから復帰できる）。
 * 旧 FullCheckControl の後継。analysis ポリシー OFF 時は導線ごと隠す。
 */
export function RunControl() {
  const { t } = useTranslation();
  const scope = useResolvedKouetsuScope();
  const activeSceneId = useTreeStore((s) => s.activeSceneId);
  const effects = useKouetsuStore((s) => s.fullCheckEffects);
  const setEffect = useKouetsuStore((s) => s.setFullCheckEffect);
  const setSelectedIssueId = useKouetsuStore((s) => s.setSelectedIssueId);
  const analysisGate = useAiGate("analysis");

  const runState = useFullCheckStore((s) => s.runState);
  const done = useFullCheckStore((s) => s.done);
  const total = useFullCheckStore((s) => s.total);
  const pipelineVisible = useFullCheckStore((s) => s.pipelineVisible);
  const findingsTotal = useFullCheckStore((s) => s.findingsTotal);
  const showPipeline = useFullCheckStore((s) => s.showPipeline);

  const [open, setOpen] = useState(false);
  const chevronRef = useRef<HTMLButtonElement>(null);
  const popover = useAnchoredPopover(
    chevronRef,
    open,
    () => setOpen(false),
    "bottom-end",
  );

  // scene スコープでは lint を除外して「実行される観点数」を数える。
  const effectiveSteps = FULL_CHECK_STEP_ORDER.filter(
    (id) => effects[id] && !(id === "lint" && scope.type === "scene"),
  );
  const noScene = scope.type === "scene" && !activeSceneId;
  const nothingSelected = effectiveSteps.length === 0;
  const disabled =
    noScene || nothingSelected || analysisGate.presentation !== "enabled";

  const runTitle = noScene
    ? t("kouetsu.selectScene")
    : nothingSelected
      ? t("kouetsu.fullCheck.configure")
      : (analysisGate.tooltip ?? t("kouetsu.fullCheck.run"));

  // analysis がポリシーで OFF のときは実行導線ごと隠す（パネルは残す）。
  if (analysisGate.presentation === "hidden") return null;

  if (runState === "running") {
    return (
      <button
        type="button"
        title={t("kouetsu.triage.runningTitle")}
        onClick={() => {
          setSelectedIssueId(null);
          showPipeline();
        }}
        className={cn(
          "flex items-center gap-1.5 rounded-md px-2 py-0.5 text-xs font-medium",
          "bg-[var(--kouetsu-accent-weak)] text-[var(--kouetsu-accent)]",
        )}
      >
        <Loader2 size={12} className="animate-spin" />
        <span className="tabular-nums">
          {t("kouetsu.triage.runningBadge", { done, total })}
        </span>
      </button>
    );
  }

  // 実行中に「戻る」で畳んだまま run が完了すると runState=done かつ
  // pipelineVisible=false になる。ここが唯一の showPipeline 導線なので、
  // 完了バッジとして残して結果パイプラインへ復帰できるようにする
  // （「閉じる」で idle に戻るとバッジも消える）。
  if (runState === "done" && !pipelineVisible) {
    return (
      <button
        type="button"
        title={t("kouetsu.triage.pipeline.done", { count: findingsTotal })}
        onClick={() => {
          setSelectedIssueId(null);
          showPipeline();
        }}
        className={cn(
          "flex items-center gap-1.5 rounded-md px-2 py-0.5 text-xs font-medium",
          "bg-[var(--kouetsu-accent-weak)] text-[var(--kouetsu-accent)]",
        )}
      >
        <CheckCircle2 size={12} />
        <span className="tabular-nums">
          {t("kouetsu.triage.doneBadge", { count: findingsTotal })}
        </span>
      </button>
    );
  }

  return (
    <div className="flex items-stretch">
      <button
        type="button"
        disabled={disabled}
        title={runTitle}
        onClick={() => {
          // 設計 2a: 全体チェック開始で選択解除。選択が残るとモード優先順
          // （triage > pipeline）によりパイプラインステージが出ない。
          setSelectedIssueId(null);
          void runFullCheck(scope, effects);
        }}
        className={cn(
          "flex items-center gap-1 rounded-l-md px-2 py-0.5 text-xs font-medium",
          "bg-[var(--kouetsu-accent)] text-white hover:bg-[var(--kouetsu-accent-hover)]",
          "disabled:cursor-not-allowed disabled:opacity-50",
        )}
      >
        <Sparkles size={12} />
        <span>{t("kouetsu.fullCheck.run")}</span>
      </button>
      <button
        ref={chevronRef}
        type="button"
        onClick={() => setOpen(!open)}
        title={t("kouetsu.fullCheck.configure")}
        aria-label={t("kouetsu.fullCheck.configure")}
        className={cn(
          "flex items-center rounded-r-md border-l border-white/30 px-1",
          "bg-[var(--kouetsu-accent)] text-white hover:bg-[var(--kouetsu-accent-hover)]",
        )}
      >
        <ChevronDown size={11} />
      </button>

      {open &&
        popover.style &&
        createPortal(
          <div
            ref={popover.popoverRef}
            style={popover.style}
            className="z-[100] w-64 overflow-hidden rounded-md border border-border bg-popover text-xs shadow-lg"
          >
            <div className="border-b border-border px-3 py-1.5 font-medium text-muted-foreground">
              {t("kouetsu.fullCheck.configure")}
            </div>
            <div className="flex flex-col py-1">
              {FULL_CHECK_STEP_ORDER.map((id) => {
                const lintFolder = id === "lint" && scope.type === "folder";
                const lintScene = id === "lint" && scope.type === "scene";
                return (
                  <label
                    key={id}
                    className="flex cursor-pointer flex-col gap-0.5 px-3 py-1 hover:bg-accent/40"
                  >
                    <span className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={effects[id]}
                        onChange={(e) => setEffect(id, e.target.checked)}
                        className="h-3 w-3 accent-[var(--kouetsu-accent)]"
                      />
                      <span>{t(FULL_CHECK_STEP_LABEL_KEY[id])}</span>
                    </span>
                    {lintFolder && (
                      <span className="pl-5 text-[10px] leading-tight text-muted-foreground">
                        {t("kouetsu.fullCheck.lintProjectWide")}
                      </span>
                    )}
                    {lintScene && (
                      <span className="pl-5 text-[10px] leading-tight text-muted-foreground">
                        {t("kouetsu.fullCheck.lintSceneSkipped")}
                      </span>
                    )}
                  </label>
                );
              })}
            </div>
            <div className="border-t border-border bg-muted/30 px-3 py-1.5 text-[10px] leading-snug text-muted-foreground">
              {t("kouetsu.triage.effectsNote")}
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
