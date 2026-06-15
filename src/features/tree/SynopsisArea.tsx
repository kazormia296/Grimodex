import { Sparkles } from "lucide-react";
import { useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useTreeStore } from "./treeStore";
import { loadSceneContent } from "./api";
import { prosemirrorToText } from "@/lib/prosemirror";
import { generateSynopsisFromContent } from "@/features/chat/chatApi";
import { toast } from "sonner";
import { InlineSynopsisEditor } from "@/features/editor/InlineSynopsisEditor";

interface SynopsisAreaProps {
  nodeId: string;
}

export function SynopsisArea({ nodeId }: SynopsisAreaProps) {
  const nodes = useTreeStore((s) => s.nodes);
  const updateSynopsis = useTreeStore((s) => s.updateSynopsis);
  const node = nodes.find((n) => n.id === nodeId);
  const [isGenerating, setIsGenerating] = useState(false);
  const [confirmOverwrite, setConfirmOverwrite] = useState(false);
  const { t } = useTranslation();

  const doGenerate = useCallback(async () => {
    if (!node) return;
    setConfirmOverwrite(false);
    setIsGenerating(true);
    try {
      const rawContent = await loadSceneContent(nodeId);
      const content = prosemirrorToText(rawContent);
      if (!content?.trim()) {
        toast.warning(t("tree.synopsis.emptySceneWarning"));
        return;
      }
      const generated = await generateSynopsisFromContent(node.title, content);
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
    <div className="border-t border-border p-2">
      <div className="mb-1 flex items-center justify-between">
        <span className="text-xs font-medium text-muted-foreground">
          {isFolder ? t("tree.outline.label") : "Synopsis"}
        </span>
        {!isFolder && (
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
