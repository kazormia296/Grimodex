import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2, ShieldAlert } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { useAiGate } from "@/features/ai-policy/useAiGate";
import { blockIfPolicyOff } from "@/features/ai-policy/policyGuard";
import { blockIfUnlicensed } from "@/features/license/gate";
import { flushPendingSceneSaves } from "@/features/post-effect/api";
import { runImpactReview } from "@/features/impact-review/runImpactReview";

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
  const [running, setRunning] = useState(false);
  const analysisGate = useAiGate("analysis");

  // analysis がポリシーで OFF のときはボタンを描画しない (整合性チェックと同じ方針)。
  if (analysisGate.presentation === "hidden") return null;

  const run = async () => {
    if (running) return;
    if (blockIfPolicyOff("analysis")) return;
    if (blockIfUnlicensed()) return;
    setRunning(true);
    try {
      // 未保存のシーン本文を flush してから差分を取る (整合性チェックと同じ前処理)。
      await flushPendingSceneSaves();
      const result = await runImpactReview(entryId, {
        onDone: () => {
          toast.success(t("codex.impactCheck.done"));
        },
        onError: (e) => {
          toast.error(t("codex.impactCheck.error"), { description: e.error });
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
      toast.error(t("codex.impactCheck.error"), {
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setRunning(false);
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
