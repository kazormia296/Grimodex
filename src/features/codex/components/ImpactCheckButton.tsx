import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2, ShieldAlert } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { useAiGate } from "@/features/ai-policy/useAiGate";
import { blockIfPolicyOff } from "@/features/ai-policy/policyGuard";
import { blockIfUnlicensed } from "@/features/license/gate";
import { flushPendingSceneSaves } from "@/features/post-effect/api";
import { useIsPostEffectRunning } from "@/features/post-effect/runStore";
import { runImpactReview } from "@/features/impact-review/runImpactReview";
import {
  postEffectErrorToast,
  postEffectPartialToast,
} from "@/features/post-effect/errorToast";
import { useImpactPendingEpochStore } from "@/features/impact-review/impactPendingEpoch";
import { useImpactPending } from "./useImpactPending";

interface ImpactCheckButtonProps {
  entryId: string;
}

/**
 * Codex 詳細「整合性」タブの手動トリガ。
 * 「この変更の影響をチェック」= 設定変更後に矛盾する本文箇所を探し、
 * 結果を校閲パネル (Issues タブ > 影響レビュー) に annotation として出す。
 *
 * 整合性チェック (ProjectAnnotationsView 等) と同じ guard を踏襲:
 * AI ポリシー OFF はボタンを隠し、ライセンス未認証は実行時に弾く。
 */
export function ImpactCheckButton({ entryId }: ImpactCheckButtonProps) {
  const { t } = useTranslation();
  // 起動準備中のみのローカル状態。実行中表示は runStore から導出する
  // （タブ移動＝unmount で消えないように）。
  const [launching, setLaunching] = useState(false);
  // hook は短絡評価の右辺に置けないため、必ず無条件で呼ぶ。
  const storeRunning = useIsPostEffectRunning("impact_review", "project");
  const running = launching || storeRunning;
  const analysisGate = useAiGate("analysis");
  // 前回のチェック以降の変更の件数（ローカルの読みだけ・AI 0 回。DR-INN-1）。
  // 整合性タブを開く（mount）たびに最新を読む。
  const pending = useImpactPending(entryId);

  // analysis がポリシーで OFF のときはボタンを描画しない (整合性チェックと同じ方針)。
  if (analysisGate.presentation === "hidden") return null;

  const run = async () => {
    if (running) return;
    if (blockIfPolicyOff("analysis")) return;
    if (blockIfUnlicensed()) return;
    setLaunching(true);
    try {
      // 未保存のシーン本文を flush してから差分を取る (整合性チェックと同じ前処理)。
      await flushPendingSceneSaves();
      const result = await runImpactReview(entryId, {
        onDone: (e) => {
          // store の complete は runImpactReview の onDone（baseline の前進）より先に
          // 走る。baseline が進んだ後のこの時点で再計算を促す（タブを離れていても効く）。
          useImpactPendingEpochStore.getState().bump();
          // 部分失敗 (一部シーンのみ解析失敗) は warning に集約 (成功分は保存済み)。
          if (postEffectPartialToast(e.summary)) return;
          toast.success(t("codex.impactCheck.done"));
        },
        onError: (e) => {
          useImpactPendingEpochStore.getState().bump();
          postEffectErrorToast(t("codex.impactCheck.error"), e.error);
        },
      });
      switch (result.status) {
        case "no-change":
          toast.info(t("codex.impactCheck.noChange"));
          break;
        case "no-candidates":
          toast.info(t("codex.impactCheck.noCandidates"));
          break;
        case "source-changed":
          toast.warning(t("codex.impactCheck.sourceChanged"));
          break;
        case "started":
          toast.info(
            t("codex.impactCheck.started", {
              count: result.candidateSceneCount,
            }),
          );
          break;
      }
    } catch (e) {
      postEffectErrorToast(
        t("codex.impactCheck.error"),
        e instanceof Error ? e.message : String(e),
      );
    } finally {
      setLaunching(false);
      // no-candidates／no-change は run を作らずに baseline を進めるので、
      // 「前回のチェック以降の変更」の再計算を明示の合図で促す（メモリ内のみ）。
      useImpactPendingEpochStore.getState().bump();
    }
  };

  const disabled = running || analysisGate.presentation !== "enabled";

  return (
    <div className="space-y-1">
      {pending.state === "pending" && (
        <p
          data-testid="codex-impact-check-pending"
          className="flex items-start gap-1.5 px-1 text-xs text-muted-foreground"
        >
          <span
            aria-hidden="true"
            className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-primary"
          />
          <span className="min-w-0 break-words">
            {t("codex.impactCheck.pending", { count: pending.changeCount })}
          </span>
        </p>
      )}
      <button
        type="button"
        data-testid="codex-impact-check"
        disabled={disabled}
        title={analysisGate.tooltip ?? t("codex.impactCheck.tooltip")}
        onClick={() => void run()}
        className={cn(
          "flex w-full items-center justify-center gap-1.5 rounded-md border border-border px-2 py-1.5 text-xs",
          "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
          "disabled:cursor-not-allowed disabled:opacity-50",
        )}
      >
        {running ? (
          <Loader2 size={13} className="animate-spin" />
        ) : (
          <ShieldAlert size={13} />
        )}
        <span>{t("codex.impactCheck.button")}</span>
      </button>
    </div>
  );
}
