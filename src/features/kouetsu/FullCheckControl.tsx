import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { Loader2, Settings2, Sparkles, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useTreeStore } from "@/features/tree/treeStore";
import { useAiGate } from "@/features/ai-policy/useAiGate";
import { useAnchoredPopover } from "@/components/ui/useAnchoredPopover";
import { useKouetsuStore } from "./kouetsuStore";
import { useResolvedKouetsuScope } from "./useResolvedKouetsuScope";
import {
  FULL_CHECK_STEP_LABEL_KEY,
  FULL_CHECK_STEP_ORDER,
  runFullCheck,
  useFullCheckStore,
} from "./fullCheck";

/**
 * 全体チェックの起動導線。KouetsuScopeBar のヘッダ行（ステータスフィルタの左）に
 * 置く。実行ボタン（全成功/失敗は既存 runStore トースト・stripe バッジに乗る）+
 * 観点選択ポップオーバー + 実行中の進捗/中止を持つ薄い部品。
 *
 * 疑似コメント・影響レビューは全体チェックの対象外（設計決定）なので選択肢に
 * 出さない。lint は scene スコープでは live lint 済みのため除外し、folder でも
 * project 全域を走査する制約はポップオーバーで明示する。
 */
export function FullCheckControl() {
  const { t } = useTranslation();
  const scope = useResolvedKouetsuScope();
  const activeSceneId = useTreeStore((s) => s.activeSceneId);
  const effects = useKouetsuStore((s) => s.fullCheckEffects);
  const setEffect = useKouetsuStore((s) => s.setFullCheckEffect);
  const analysisGate = useAiGate("analysis");

  const running = useFullCheckStore((s) => s.running);
  const done = useFullCheckStore((s) => s.done);
  const total = useFullCheckStore((s) => s.total);
  const currentStep = useFullCheckStore((s) => s.currentStep);
  const cancelRequested = useFullCheckStore((s) => s.cancelRequested);
  const requestCancel = useFullCheckStore((s) => s.requestCancel);

  const [open, setOpen] = useState(false);
  const gearRef = useRef<HTMLButtonElement>(null);
  const popover = useAnchoredPopover(
    gearRef,
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
    running ||
    noScene ||
    nothingSelected ||
    analysisGate.presentation !== "enabled";

  const runTitle = noScene
    ? t("kouetsu.selectScene")
    : nothingSelected
      ? t("kouetsu.fullCheck.configure")
      : (analysisGate.tooltip ?? t("kouetsu.fullCheck.run"));

  // analysis がポリシーで OFF のときは実行導線ごと隠す（パネルは残す）。
  if (analysisGate.presentation === "hidden") return null;

  return (
    <div className="flex items-center gap-1">
      {running ? (
        <div className="flex items-center gap-1.5 rounded px-1.5 py-0.5 text-muted-foreground">
          <Loader2 size={12} className="animate-spin" />
          <span className="tabular-nums">
            {t("kouetsu.fullCheck.progress", { done, total })}
          </span>
          {currentStep && (
            <span className="truncate">
              · {t(FULL_CHECK_STEP_LABEL_KEY[currentStep])}
            </span>
          )}
          <button
            type="button"
            disabled={cancelRequested}
            onClick={() => requestCancel()}
            className="rounded px-1.5 py-0.5 text-destructive hover:bg-destructive/10 disabled:opacity-50"
          >
            {cancelRequested
              ? t("kouetsu.progressToast.aborting")
              : t("kouetsu.fullCheck.cancel")}
          </button>
        </div>
      ) : (
        <button
          type="button"
          disabled={disabled}
          title={runTitle}
          onClick={() => void runFullCheck(scope, effects)}
          className={cn(
            "flex items-center gap-1 rounded px-2 py-0.5",
            "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
            "disabled:cursor-not-allowed disabled:opacity-50",
          )}
        >
          <Sparkles size={12} />
          <span>{t("kouetsu.fullCheck.run")}</span>
        </button>
      )}

      <button
        ref={gearRef}
        type="button"
        onClick={() => setOpen(!open)}
        title={t("kouetsu.fullCheck.configure")}
        aria-label={t("kouetsu.fullCheck.configure")}
        className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        <Settings2 size={13} />
      </button>

      {open &&
        popover.style &&
        createPortal(
          <div
            ref={popover.popoverRef}
            style={popover.style}
            className="z-[100] w-64 overflow-hidden rounded-md border border-border bg-popover text-xs shadow-lg"
          >
            <div className="flex items-center justify-between border-b border-border px-3 py-1.5 font-medium text-muted-foreground">
              <span>{t("kouetsu.fullCheck.configure")}</span>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label={t("kouetsu.progressToast.close")}
                className="rounded p-0.5 hover:bg-accent hover:text-foreground"
              >
                <X size={12} />
              </button>
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
                        className="h-3 w-3"
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
          </div>,
          document.body,
        )}
    </div>
  );
}
