import { useState, useEffect, useCallback } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import { toast } from "sonner";
import { debugLog, errorDetail } from "@/lib/debugLog";
import { useRevisionStore } from "./revisionStore";
import { createRevision } from "./api";
import { saveSceneContent } from "@/features/tree/api";
import { useEditorStore } from "@/features/editor/editorStore";
import { getReadonlyEditorExtensions } from "@/features/editor/extensions";
import type { RevisionMeta } from "./api";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("ja-JP", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

interface RevisionListItemProps {
  revision: RevisionMeta;
  isSelected: boolean;
  onClick: () => void;
}

function RevisionListItem({
  revision,
  isSelected,
  onClick,
}: RevisionListItemProps) {
  const isManual = revision.snapshotType === "manual";

  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        "w-full text-left px-3 py-2 flex items-center gap-2 rounded text-sm transition-colors",
        isSelected
          ? "bg-primary/20 text-primary"
          : "hover:bg-muted text-foreground",
      ].join(" ")}
    >
      {/* dot marker for manual */}
      <span
        className={[
          "w-2 h-2 rounded-full flex-shrink-0",
          isManual ? "bg-primary" : "bg-transparent",
        ].join(" ")}
        aria-hidden="true"
      />
      <span className="flex-1 min-w-0">
        <span className="block truncate">
          {formatTimestamp(revision.createdAt)}
        </span>
        <span className="text-xs text-muted-foreground">
          {isManual ? "手動" : "自動"} · v{revision.versionNumber}
        </span>
      </span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Block-level diff helpers
// ---------------------------------------------------------------------------

function extractNodeText(node: Record<string, unknown>): string {
  if (node.type === "text") return (node.text as string) ?? "";
  const children = (node.content as Record<string, unknown>[]) ?? [];
  return children.map(extractNodeText).join("");
}

function extractTopLevelTexts(contentString: string): string[] {
  try {
    const json = JSON.parse(contentString) as { content?: unknown[] };
    return (json.content ?? []).map((n) =>
      extractNodeText(n as Record<string, unknown>),
    );
  } catch {
    return [];
  }
}

/** LCS-based block diff. Returns indices of unmatched blocks in each version. */
function computeBlockDiff(
  prevBlocks: string[],
  currBlocks: string[],
): { prevChanged: Set<number>; currChanged: Set<number> } {
  const m = prevBlocks.length;
  const n = currBlocks.length;
  const dp = Array.from({ length: m + 1 }, () =>
    new Array<number>(n + 1).fill(0),
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] =
        prevBlocks[i - 1] === currBlocks[j - 1]
          ? dp[i - 1][j - 1] + 1
          : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  const prevMatched = new Set<number>();
  const currMatched = new Set<number>();
  let i = m,
    j = n;
  while (i > 0 && j > 0) {
    if (prevBlocks[i - 1] === currBlocks[j - 1]) {
      prevMatched.add(i - 1);
      currMatched.add(j - 1);
      i--;
      j--;
    } else if (dp[i - 1][j] >= dp[i][j - 1]) {
      i--;
    } else {
      j--;
    }
  }
  return {
    prevChanged: new Set(
      Array.from({ length: m }, (_, k) => k).filter((k) => !prevMatched.has(k)),
    ),
    currChanged: new Set(
      Array.from({ length: n }, (_, k) => k).filter((k) => !currMatched.has(k)),
    ),
  };
}

// ---------------------------------------------------------------------------
// Preview Panel
// ---------------------------------------------------------------------------

interface PreviewPanelProps {
  content: string | null;
  prevContent: string | null;
  isLoading: boolean;
  showDiff: boolean;
}

function PreviewPanel({
  content,
  prevContent,
  isLoading,
  showDiff,
}: PreviewPanelProps) {
  const currentEditor = useEditor({
    extensions: getReadonlyEditorExtensions(),
    editable: false,
    content: "",
  });

  const prevEditor = useEditor({
    extensions: getReadonlyEditorExtensions(),
    editable: false,
    content: "",
  });

  useEffect(() => {
    if (!currentEditor) return;
    if (!content) {
      currentEditor.commands.setContent("");
      return;
    }
    try {
      currentEditor.commands.setContent(JSON.parse(content) as object);
    } catch {
      currentEditor.commands.setContent(content);
    }
  }, [currentEditor, content]);

  useEffect(() => {
    if (!prevEditor) return;
    if (!prevContent) {
      prevEditor.commands.setContent("");
      return;
    }
    try {
      prevEditor.commands.setContent(JSON.parse(prevContent) as object);
    } catch {
      prevEditor.commands.setContent(prevContent);
    }
  }, [prevEditor, prevContent]);

  // Apply block-level diff highlights after content is set
  useEffect(() => {
    if (!showDiff || !content || !prevContent || !currentEditor || !prevEditor)
      return;
    const prevTexts = extractTopLevelTexts(prevContent);
    const currTexts = extractTopLevelTexts(content);
    const { prevChanged, currChanged } = computeBlockDiff(prevTexts, currTexts);
    // setTimeout(0) ensures ProseMirror has finished updating the DOM
    const handle = window.setTimeout(() => {
      Array.from(prevEditor.view.dom.children).forEach((el, idx) => {
        (el as HTMLElement).classList.toggle(
          "diff-block-remove",
          prevChanged.has(idx),
        );
      });
      Array.from(currentEditor.view.dom.children).forEach((el, idx) => {
        (el as HTMLElement).classList.toggle(
          "diff-block-add",
          currChanged.has(idx),
        );
      });
    }, 0);
    return () => window.clearTimeout(handle);
  }, [currentEditor, prevEditor, content, prevContent, showDiff]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
        読み込み中…
      </div>
    );
  }

  if (!content) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
        リビジョンを選択してください
      </div>
    );
  }

  if (showDiff && prevContent) {
    return (
      <div className="flex h-full overflow-hidden">
        <div className="flex flex-col flex-1 overflow-hidden border-r border-border">
          <div className="px-3 py-1 text-xs text-muted-foreground bg-muted/30 border-b border-border flex-shrink-0">
            前のバージョン
          </div>
          <div className="flex-1 overflow-auto p-4 prose prose-sm dark:prose-invert max-w-none">
            <EditorContent editor={prevEditor} />
          </div>
        </div>
        <div className="flex flex-col flex-1 overflow-hidden">
          <div className="px-3 py-1 text-xs text-muted-foreground bg-muted/30 border-b border-border flex-shrink-0">
            このバージョン
          </div>
          <div className="flex-1 overflow-auto p-4 prose prose-sm dark:prose-invert max-w-none">
            <EditorContent editor={currentEditor} />
          </div>
        </div>
      </div>
    );
  }

  if (showDiff && !prevContent) {
    return (
      <div className="flex flex-col h-full overflow-hidden">
        <div className="px-3 py-1.5 text-xs text-muted-foreground bg-muted/30 border-b border-border flex-shrink-0">
          比較対象の前バージョンがありません
        </div>
        <div className="flex-1 overflow-auto p-4 prose prose-sm dark:prose-invert max-w-none">
          <EditorContent editor={currentEditor} />
        </div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto p-4 prose prose-sm dark:prose-invert max-w-none">
      <EditorContent editor={currentEditor} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main Modal
// ---------------------------------------------------------------------------

export function RevisionHistoryModal() {
  const {
    isOpen,
    entityType,
    entityId,
    currentContent,
    revisions,
    selectedRevisionId,
    selectedContent,
    isLoadingContent,
    hasMore,
    closeHistory,
    loadMore,
    selectRevision,
  } = useRevisionStore();

  const mainEditor = useEditorStore((s) => s.editor);

  const [showDiff, setShowDiff] = useState(false);
  const [isRestoring, setIsRestoring] = useState(false);
  const [confirmRestore, setConfirmRestore] = useState(false);
  const [prevRevisionContent, setPrevRevisionContent] = useState<string | null>(
    null,
  );

  // Reset local state when modal opens/closes
  useEffect(() => {
    if (!isOpen) {
      setShowDiff(false);
      setConfirmRestore(false);
      setPrevRevisionContent(null);
    }
  }, [isOpen]);

  // Fetch previous revision content for diff display
  useEffect(() => {
    if (!showDiff) {
      setPrevRevisionContent(null);
      return;
    }
    let cancelled = false;
    async function fetchPrev() {
      if (selectedRevisionId === null) {
        // Current version: compare against latest saved revision
        if (revisions.length > 0) {
          const { getRevision } = await import("./api");
          const rev = await getRevision(revisions[0].id);
          if (!cancelled) setPrevRevisionContent(rev?.content ?? null);
        } else {
          if (!cancelled) setPrevRevisionContent(null);
        }
      } else {
        const idx = revisions.findIndex((r) => r.id === selectedRevisionId);
        const prevRevision = revisions[idx + 1];
        if (prevRevision) {
          const { getRevision } = await import("./api");
          const rev = await getRevision(prevRevision.id);
          if (!cancelled) setPrevRevisionContent(rev?.content ?? null);
        } else {
          if (!cancelled) setPrevRevisionContent(null);
        }
      }
    }
    fetchPrev().catch(console.error);
    return () => {
      cancelled = true;
    };
  }, [showDiff, selectedRevisionId, revisions]);

  // ---- Restore logic ----
  const selectedRevisionMeta = revisions.find(
    (r) => r.id === selectedRevisionId,
  );

  const handleRestoreClick = () => {
    setConfirmRestore(true);
  };

  const handleRestoreConfirm = useCallback(async () => {
    if (!selectedContent || !entityId || !entityType || !mainEditor) return;

    setIsRestoring(true);
    try {
      // 1. Save current content as a manual snapshot (safety net)
      if (currentContent) {
        await createRevision({
          entityType,
          entityId,
          content: currentContent,
          snapshotType: "manual",
        });
      }

      // 2. Parse the selected ProseMirror JSON
      const json = JSON.parse(selectedContent) as object;

      // 3. Set editor content
      mainEditor.commands.setContent(json);

      // 4. Save the restored content as markdown (trigger Tauri write)
      if (entityType === "scene") {
        const getMarkdown = (
          mainEditor.storage as { markdown?: { getMarkdown?: () => string } }
        )?.markdown?.getMarkdown;
        const md = typeof getMarkdown === "function" ? getMarkdown() : "";
        await saveSceneContent(entityId, md);
      }

      setConfirmRestore(false);
      toast.success("復元しました");
      closeHistory();
    } catch (err) {
      debugLog.error("RevisionHistory", "restore failed", errorDetail(err));
      toast.error("復元に失敗しました");
    } finally {
      setIsRestoring(false);
    }
  }, [
    selectedContent,
    entityId,
    entityType,
    currentContent,
    mainEditor,
    closeHistory,
  ]);

  // ---- Keyboard shortcut to close ----
  useEffect(() => {
    if (!isOpen) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") closeHistory();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isOpen, closeHistory]);

  if (!isOpen) return null;

  const isCurrentVersionSelected = selectedRevisionId === null;
  const canRestore = !isCurrentVersionSelected && !!selectedContent;

  // ---- Confirm dialog ----
  if (confirmRestore && selectedRevisionMeta) {
    return (
      <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center">
        <div className="bg-background rounded-lg border border-border shadow-xl p-6 w-[440px] max-w-[95vw]">
          <h2 className="text-base font-semibold mb-3">リビジョンを復元</h2>
          <p className="text-sm text-muted-foreground mb-6">
            {formatTimestamp(selectedRevisionMeta.createdAt)}{" "}
            のリビジョンに復元しますか？
            <br />
            現在の内容はスナップショットとして保存されます。
          </p>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              className="px-3 py-1.5 text-sm rounded border border-border hover:bg-muted transition-colors"
              onClick={() => setConfirmRestore(false)}
              disabled={isRestoring}
            >
              キャンセル
            </button>
            <button
              type="button"
              className="px-3 py-1.5 text-sm rounded bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
              onClick={handleRestoreConfirm}
              disabled={isRestoring}
            >
              {isRestoring ? "復元中…" : "復元する"}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center"
      onClick={(e) => {
        if (e.target === e.currentTarget) closeHistory();
      }}
    >
      <div
        className={[
          "bg-background rounded-lg border border-border shadow-xl h-[70vh] flex flex-col",
          showDiff ? "w-[1200px] max-w-[98vw]" : "w-[900px] max-w-[95vw]",
        ].join(" ")}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border flex-shrink-0">
          <h2 className="text-base font-semibold">変更履歴</h2>
          <button
            type="button"
            aria-label="閉じる"
            className="text-muted-foreground hover:text-foreground transition-colors"
            onClick={closeHistory}
          >
            ✕
          </button>
        </div>

        {/* Body: left preview + right list */}
        <div className="flex flex-1 overflow-hidden">
          {/* Left: preview */}
          <div className="flex flex-col flex-1 border-r border-border overflow-hidden">
            {/* Diff toggle */}
            <div className="flex items-center gap-2 px-4 py-2 border-b border-border flex-shrink-0">
              <label className="flex items-center gap-1.5 text-sm cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={showDiff}
                  onChange={(e) => setShowDiff(e.target.checked)}
                  className="rounded"
                />
                変更を表示
              </label>
            </div>

            {/* Preview content */}
            <div className="flex-1 overflow-hidden">
              <PreviewPanel
                content={
                  isCurrentVersionSelected ? currentContent : selectedContent
                }
                prevContent={prevRevisionContent}
                isLoading={isLoadingContent}
                showDiff={showDiff}
              />
            </div>
          </div>

          {/* Right: revision list */}
          <div className="w-72 flex flex-col flex-shrink-0 overflow-hidden">
            <div className="flex-1 overflow-y-auto p-2 space-y-0.5">
              {/* Current version entry */}
              <button
                type="button"
                onClick={() => selectRevision(null)}
                className={[
                  "w-full text-left px-3 py-2 flex items-center gap-2 rounded text-sm transition-colors",
                  isCurrentVersionSelected
                    ? "bg-primary/20 text-primary"
                    : "hover:bg-muted text-foreground",
                ].join(" ")}
              >
                <span className="w-2 h-2 rounded-full flex-shrink-0 bg-transparent" />
                <span>
                  <span className="block font-medium">現在のバージョン</span>
                  <span className="text-xs text-muted-foreground">
                    未保存の変更を含む
                  </span>
                </span>
              </button>

              {/* Saved revisions */}
              {revisions.map((rev) => (
                <RevisionListItem
                  key={rev.id}
                  revision={rev}
                  isSelected={selectedRevisionId === rev.id}
                  onClick={() => selectRevision(rev.id)}
                />
              ))}

              {/* Load more */}
              {hasMore && (
                <button
                  type="button"
                  className="w-full text-center py-2 text-xs text-muted-foreground hover:text-foreground transition-colors"
                  onClick={loadMore}
                >
                  さらに読み込む
                </button>
              )}

              {revisions.length === 0 && (
                <p className="text-xs text-muted-foreground px-3 py-4 text-center">
                  保存済みのリビジョンはありません
                </p>
              )}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-border flex-shrink-0">
          <button
            type="button"
            className="px-3 py-1.5 text-sm rounded border border-border hover:bg-muted transition-colors"
            onClick={closeHistory}
          >
            閉じる
          </button>
          <button
            type="button"
            className="px-3 py-1.5 text-sm rounded bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            onClick={handleRestoreClick}
            disabled={!canRestore}
          >
            この時点に復元
          </button>
        </div>
      </div>
    </div>
  );
}
