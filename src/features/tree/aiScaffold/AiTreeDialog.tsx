import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Sparkles, Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { blockIfPolicyOff } from "@/features/ai-policy/policyGuard";
import { blockIfUnlicensed } from "@/features/license/gate";
import { runAiTreeGeneration } from "./runAiTreeGeneration";

export interface AiTreeDialogProps {
  open: boolean;
  onClose: () => void;
  mode: "scaffold" | "reorganize";
  /** scope root。null = プロジェクト全体(空状態 scaffold / 全体再編)。 */
  rootRef: string | null;
  /** 対象フォルダのタイトル(説明文表示用)。 */
  rootTitle?: string;
}

export function AiTreeDialog({
  open,
  onClose,
  mode,
  rootRef,
  rootTitle,
}: AiTreeDialogProps) {
  const { t } = useTranslation();
  const [instruction, setInstruction] = useState("");
  const [withSynopsis, setWithSynopsis] = useState(true);
  const [busy, setBusy] = useState(false);

  const isScaffold = mode === "scaffold";
  const title = isScaffold
    ? t("aiTree.scaffoldTitle", "AI でアウトラインを生成")
    : t("aiTree.reorganizeTitle", "AI で構成を再編");
  const scopeLabel = rootTitle
    ? t("aiTree.scopeFolder", {
        title: rootTitle,
        defaultValue: `対象: ${rootTitle}`,
      })
    : t("aiTree.scopeProject", "対象: プロジェクト全体");

  async function handleRun() {
    // gate: 構造編集は structureWrite。synopsis 生成を伴う場合は bodyWrite も要求。
    if (blockIfPolicyOff("structureWrite")) return;
    if (withSynopsis && blockIfPolicyOff("bodyWrite")) return;
    if (blockIfUnlicensed()) return;

    setBusy(true);
    try {
      const res = await runAiTreeGeneration({
        mode,
        rootRef,
        instruction,
        withSynopsis,
      });
      toast.success(
        t("aiTree.done", {
          created: res.createdIds.length,
          moved: res.movedIds.length,
          renamed: res.renamedIds.length,
          defaultValue: `生成 ${res.createdIds.length} / 移動 ${res.movedIds.length} / リネーム ${res.renamedIds.length}`,
        }),
      );
      setInstruction("");
      onClose();
    } catch (err) {
      console.error("[aiTree] generation failed", err);
      toast.error(
        t(
          "aiTree.failed",
          "AI 構成の生成に失敗しました。もう一度お試しください。",
        ),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && !busy && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles size={16} className="text-primary" />
            {title}
          </DialogTitle>
          <DialogDescription>{scopeLabel}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <label className="block text-sm">
            <span className="text-muted-foreground">
              {isScaffold
                ? t(
                    "aiTree.scaffoldPrompt",
                    "どんな構成を作りますか？(プレミス・要望)",
                  )
                : t(
                    "aiTree.reorganizePrompt",
                    "どう再編しますか？(方針・要望)",
                  )}
            </span>
            <textarea
              className="mt-1 w-full resize-none rounded border border-border bg-background px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
              rows={4}
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              disabled={busy}
              placeholder={
                isScaffold
                  ? t(
                      "aiTree.scaffoldPlaceholder",
                      "例: 起承転結の4章構成。各章に2〜3シーン。",
                    )
                  : t(
                      "aiTree.reorganizePlaceholder",
                      "例: 時系列順に並べ替え、回想を別フォルダにまとめる。",
                    )
              }
            />
          </label>

          <label className="flex cursor-pointer items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={withSynopsis}
              onChange={(e) => setWithSynopsis(e.target.checked)}
              disabled={busy}
              className="h-4 w-4 cursor-pointer rounded border-input"
            />
            <span>
              {t("aiTree.withSynopsis", "各シーンにあらすじも生成する")}
            </span>
          </label>

          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose} disabled={busy}>
              {t("common.cancel", "キャンセル")}
            </Button>
            <Button onClick={() => void handleRun()} disabled={busy}>
              {busy ? (
                <Loader2 size={14} className="mr-1.5 animate-spin" />
              ) : (
                <Sparkles size={14} className="mr-1.5" />
              )}
              {busy
                ? t("aiTree.generating", "生成中…")
                : t("aiTree.generate", "生成")}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
