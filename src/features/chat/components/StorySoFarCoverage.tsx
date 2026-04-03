import { useState, useCallback } from "react";
import { useTreeStore } from "@/features/tree/treeStore";
import { useSceneStore } from "@/features/tree/store";
import { loadSceneContent } from "@/features/tree/api";
import { generateSynopsisFromContent } from "@/features/chat/chatApi";
import { toast } from "sonner";

/**
 * B-10: storySoFar coverage warning pill.
 * Shows ⚠ pill when < 50% of preceding scenes have synopses.
 * Popover with "Generate all" to fill missing synopses via AI.
 */
export function StorySoFarCoverage() {
  const activeSceneId = useSceneStore((s) => s.activeSceneId);
  const nodes = useTreeStore((s) => s.nodes);
  const updateSynopsis = useTreeStore((s) => s.updateSynopsis);

  const [open, setOpen] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [progress, setProgress] = useState(0);
  const [total, setTotal] = useState(0);
  const [failedCount, setFailedCount] = useState(0);

  const currentScene = nodes.find((n) => n.id === activeSceneId);
  if (!currentScene) return null;

  // Count preceding scenes with/without synopsis
  const precedingScenes = nodes.filter(
    (n) =>
      n.nodeType === "scene" &&
      n.id !== activeSceneId &&
      n.sortOrder < currentScene.sortOrder,
  );

  const totalPreceding = precedingScenes.length;
  const withSynopsis = precedingScenes.filter((n) => n.synopsis?.trim()).length;
  const coverage = totalPreceding === 0 ? 1 : withSynopsis / totalPreceding;

  // Hide if coverage is sufficient or no preceding scenes
  if (totalPreceding === 0 || coverage >= 1.0) return null;

  const handleGenerateAll = useCallback(async () => {
    const missing = precedingScenes.filter((n) => !n.synopsis?.trim());
    setTotal(missing.length);
    setProgress(0);
    setFailedCount(0);
    setIsGenerating(true);

    let done = 0;
    let failed = 0;
    for (const scene of missing) {
      try {
        const content = await loadSceneContent(scene.id);
        if (content?.trim()) {
          const synopsis = await generateSynopsisFromContent(
            scene.title,
            content,
          );
          await updateSynopsis(scene.id, synopsis.trim());
        }
      } catch {
        failed++;
        setFailedCount(failed);
      }
      done++;
      setProgress(done);
    }

    setIsGenerating(false);
    setOpen(false);
    const succeeded = done - failed;
    if (failed > 0) {
      toast.warning(
        `${succeeded}/${done}件のSynopsisを生成しました（${failed}件失敗）`,
      );
    } else {
      toast.success(`${succeeded}件のSynopsisを生成しました`);
    }
  }, [precedingScenes, updateSynopsis]);

  const coverageLabel = `${withSynopsis}/${totalPreceding}`;

  return (
    <div className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 rounded-full bg-yellow-500/15 px-2 py-0.5 text-xs text-yellow-600 dark:text-yellow-400 hover:bg-yellow-500/25"
        title="storySoFar Synopsisカバレッジ"
      >
        ⚠ storySoFar: {coverageLabel}
      </button>

      {open && (
        <>
          {/* Backdrop */}
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          {/* Popover */}
          <div className="absolute left-0 top-full z-50 mt-1 w-72 rounded-md border border-border bg-popover p-3 shadow-md text-xs">
            <p className="text-muted-foreground mb-2">
              現在のシーンより前に <strong>{totalPreceding}</strong>{" "}
              シーンありますが、 Synopsisが記入済みなのは{" "}
              <strong>{withSynopsis}</strong> シーンのみです。
              AIのstorySoFarコンテキストが制限されます。
            </p>
            {isGenerating ? (
              <div>
                <div className="mb-1 flex justify-between">
                  <span>
                    生成中… {progress}/{total}
                    {failedCount > 0 ? ` (${failedCount}件失敗)` : ""}
                  </span>
                </div>
                <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                  <div
                    className="h-full bg-primary transition-all"
                    style={{
                      width: `${total > 0 ? (progress / total) * 100 : 0}%`,
                    }}
                  />
                </div>
              </div>
            ) : (
              <button
                type="button"
                onClick={handleGenerateAll}
                className="w-full rounded bg-primary px-2 py-1 text-xs text-primary-foreground hover:opacity-90"
              >
                Generate all ({totalPreceding - withSynopsis} missing)
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
