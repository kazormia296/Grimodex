import { useState, useEffect, useRef, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useTreeStore } from "./treeStore";
import { loadSceneContent } from "./api";
import { prosemirrorToText } from "@/lib/prosemirror";
import { generateSynopsisFromContent } from "@/features/chat/chatApi";
import { toast } from "sonner";

interface SynopsisAreaProps {
  nodeId: string;
}

export function SynopsisArea({ nodeId }: SynopsisAreaProps) {
  const nodes = useTreeStore((s) => s.nodes);
  const updateSynopsis = useTreeStore((s) => s.updateSynopsis);
  const node = nodes.find((n) => n.id === nodeId);
  const [text, setText] = useState(node?.synopsis ?? "");
  const [isGenerating, setIsGenerating] = useState(false);
  const [confirmOverwrite, setConfirmOverwrite] = useState(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { t } = useTranslation();

  // Sync external changes
  useEffect(() => {
    setText(node?.synopsis ?? "");
  }, [node?.synopsis]);

  const handleChange = useCallback(
    (value: string) => {
      setText(value);
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        updateSynopsis(nodeId, value).catch(() => {});
      }, 1000);
    },
    [nodeId, updateSynopsis],
  );

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
      setText(trimmed);
      await updateSynopsis(nodeId, trimmed);
      toast.success(t("tree.synopsis.generated"));
    } catch {
      toast.error(t("tree.synopsis.generateFailed"));
    } finally {
      setIsGenerating(false);
    }
  }, [node, nodeId, updateSynopsis]);

  const handleGenerate = useCallback(async () => {
    if (!node) return;
    // Check body content first, before asking about overwrite
    const rawContent = await loadSceneContent(nodeId);
    const content = prosemirrorToText(rawContent);
    if (!content?.trim()) {
      toast.warning(t("tree.synopsis.emptySceneWarning"));
      return;
    }
    // Show inline confirmation if synopsis already exists
    if (text.trim()) {
      setConfirmOverwrite(true);
      return;
    }
    await doGenerate();
  }, [node, nodeId, text, doGenerate]);

  if (!node || node.nodeType !== "scene") return null;

  return (
    <div className="border-t border-border p-2">
      <div className="mb-1 flex items-center justify-between">
        <span className="text-xs font-medium text-muted-foreground">
          Synopsis
        </span>
        <button
          type="button"
          onClick={handleGenerate}
          disabled={isGenerating}
          title={t("tree.synopsis.generateTitle")}
          className="flex items-center gap-0.5 rounded px-1 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40"
        >
          {isGenerating ? t("tree.synopsis.generating") : "✦ Generate"}
        </button>
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

      <textarea
        value={text}
        onChange={(e) => handleChange(e.target.value)}
        placeholder="What happens in this scene?"
        className="w-full resize-none rounded border border-border bg-background px-2 py-1.5 text-xs text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-ring"
        rows={3}
      />
    </div>
  );
}
