import { Sparkles } from "lucide-react";
import { useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useTreeStore } from "./treeStore";
import { loadSceneContent } from "./api";
import { prosemirrorToText } from "@/lib/prosemirror";
import { generateSynopsisFromContent } from "@/features/chat/chatApi";
import { useAiGate } from "@/features/ai-policy/useAiGate";
import { blockIfPolicyOff } from "@/features/ai-policy/policyGuard";
import { toast } from "sonner";
import { InlineSynopsisEditor } from "@/features/editor/InlineSynopsisEditor";

interface SynopsisAreaProps {
  nodeId: string;
  /**
   * 外枠（border-t + p-2）と重複ラベルを外し、本文テキストエリアを親コンテナの
   * インセットへ揃える。Editor インスペクタ（SynopsisHeader）が intent 欄と
   * 左端を一致させるために使う。既定 false（Scenes パネルは従来通り枠付き）。
   */
  bare?: boolean;
}

export function SynopsisArea({ nodeId, bare = false }: SynopsisAreaProps) {
  const nodes = useTreeStore((s) => s.nodes);
  const updateSynopsis = useTreeStore((s) => s.updateSynopsis);
  const node = nodes.find((n) => n.id === nodeId);
  const [isGenerating, setIsGenerating] = useState(false);
  const [confirmOverwrite, setConfirmOverwrite] = useState(false);
  const { t } = useTranslation();
  // AI のあらすじは本文の提案（bodyWrite）。オフなら入口を隠し、実行も止める。
  const bodyWriteGate = useAiGate("bodyWrite");

  const doGenerate = useCallback(async () => {
    if (!node) return;
    setConfirmOverwrite(false);
    if (blockIfPolicyOff("bodyWrite")) return;
    setIsGenerating(true);
    try {
      const rawContent = await loadSceneContent(nodeId);
      const content = prosemirrorToText(rawContent);
      if (!content?.trim()) {
        toast.warning(t("tree.synopsis.emptySceneWarning"));
        return;
      }
      // 読込みと生成の待ちの間にオフになり得るため、AI の呼び出し前と保存前に読む。
      if (blockIfPolicyOff("bodyWrite")) return;
      const generated = await generateSynopsisFromContent(node.title, content);
      if (blockIfPolicyOff("bodyWrite")) return;
      const trimmed = generated.trim();
      await updateSynopsis(nodeId, trimmed);
      toast.success(t("tree.synopsis.generated"));
    } catch {
      toast.error(t("tree.synopsis.generateFailed"));
    } finally {
      setIsGenerating(false);
    }
  }, [node, nodeId, updateSynopsis, t]);

  const handleGenerate = useCallback(async () => {
    if (!node) return;
    if (blockIfPolicyOff("bodyWrite")) return;
    const rawContent = await loadSceneContent(nodeId);
    const content = prosemirrorToText(rawContent);
    if (!content?.trim()) {
      toast.warning(t("tree.synopsis.emptySceneWarning"));
      return;
    }
    if (node.synopsis?.trim()) {
      setConfirmOverwrite(true);
      return;
    }
    await doGenerate();
  }, [node, nodeId, doGenerate, t]);

  // Scene と folder で synopsis を兼用する。folder の場合はラベルを "Outline" に
  // 切り替え、AI 生成ボタンは隠す（folder には自動要約の元になる本文が無い）。
  // nodeType === "note" は対象外（note は AI コンテキストに乗せていない）。
  if (!node || (node.nodeType !== "scene" && node.nodeType !== "folder"))
    return null;
  const isFolder = node.nodeType === "folder";

  return (
    <div className={bare ? "" : "border-t border-border p-2"}>
      <div
        className={`mb-1 flex items-center ${bare ? "justify-end" : "justify-between"}`}
      >
        {!bare && (
          <span className="text-xs font-medium text-muted-foreground">
            {isFolder ? t("tree.outline.label") : "Synopsis"}
          </span>
        )}
        {!isFolder && bodyWriteGate.presentation !== "hidden" && (
          <button
            type="button"
            onClick={handleGenerate}
            disabled={isGenerating}
            title={t("tree.synopsis.generateTitle")}
            className="flex items-center gap-0.5 rounded px-1 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40"
          >
            {isGenerating ? (
              t("tree.synopsis.generating")
            ) : (
              <>
                <Sparkles className="h-3 w-3" aria-hidden />
                {t("tree.synopsis.generate")}
              </>
            )}
          </button>
        )}
      </div>

      {/* Inline overwrite confirmation (replaces window.confirm) */}
      {confirmOverwrite && (
        <div className="mb-2 flex items-center gap-2 rounded border border-border bg-muted/40 px-2 py-1.5 text-xs">
          <span className="flex-1 text-muted-foreground">
            {t("tree.synopsis.overwriteConfirm")}
          </span>
          <button
            type="button"
            onClick={doGenerate}
            className="rounded bg-primary px-2 py-0.5 text-xs text-primary-foreground"
          >
            {t("tree.synopsis.overwrite")}
          </button>
          <button
            type="button"
            onClick={() => setConfirmOverwrite(false)}
            className="rounded px-2 py-0.5 text-xs text-muted-foreground hover:bg-accent"
          >
            {t("common.cancel")}
          </button>
        </div>
      )}

      <InlineSynopsisEditor
        nodeId={nodeId}
        synopsis={node.synopsis}
        alwaysEditing
        rows={3}
        placeholder={
          isFolder
            ? t("tree.outline.placeholder")
            : t("tree.synopsis.scenePlaceholder")
        }
        textareaClassName="w-full resize-none rounded border border-border bg-background px-2 py-1.5 text-xs text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-ring"
      />
    </div>
  );
}
