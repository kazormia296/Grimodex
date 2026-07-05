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
import { postEffectErrorToast } from "@/features/post-effect/errorToast";

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
        onDone: () => {
          toast.success(t("codex.impactCheck.done"));
        },
        onError: (e) => {
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
    }
  };

  const disabled = running || analysisGate.presentation !== "enabled";

  return (
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
  );
}
