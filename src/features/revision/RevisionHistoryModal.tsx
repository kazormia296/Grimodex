import { useState, useEffect, useCallback } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import { diff_match_patch } from "diff-match-patch";
import { toast } from "sonner";
import { useRevisionStore } from "./revisionStore";
import { createRevision } from "./api";
import { saveSceneContent } from "@/features/tree/api";
import { useEditorStore } from "@/features/editor/editorStore";
import { getEditorExtensions } from "@/features/editor/extensions";
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

/** Walk a ProseMirror JSON node and collect all text. */
function extractText(node: Record<string, unknown>): string {
  if (node.type === "text") return (node.text as string) ?? "";
  const children = (node.content as Record<string, unknown>[]) ?? [];
  return children.map(extractText).join("");
}

function prosemirrorJsonToText(contentString: string): string {
  try {
    const json = JSON.parse(contentString) as Record<string, unknown>;
    return extractText(json);
  } catch {
    return "";
  }
}

/** Build a safe HTML string representing the diff between oldText and newText. */
function buildDiffHtml(oldText: string, newText: string): string {
  const dmp = new diff_match_patch();
  const diffs = dmp.diff_main(oldText, newText);
  dmp.diff_cleanupSemantic(diffs);

  return diffs
    .map(([op, text]) => {
      const escaped = text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/\n/g, "<br/>");
      if (op === 1) {
        return `<span class="diff-add">${escaped}</span>`;
      }
      if (op === -1) {
        return `<span class="diff-remove">${escaped}</span>`;
      }
      return escaped;
    })
    .join("");
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
// Preview Panel
// ---------------------------------------------------------------------------

interface PreviewPanelProps {
  content: string | null;
  isLoading: boolean;
  showDiff: boolean;
  diffHtml: string | null;
}

function PreviewPanel({
  content,
  isLoading,
  showDiff,
  diffHtml,
}: PreviewPanelProps) {
  const previewEditor = useEditor({
    extensions: getEditorExtensions(),
    editable: false,
    content: "",
  });

  useEffect(() => {
    if (!previewEditor) return;
    if (!content) {
      previewEditor.commands.setContent("");
      return;
    }
    try {
      const json = JSON.parse(content) as object;
      previewEditor.commands.setContent(json);
    } catch {
      previewEditor.commands.setContent(content);
    }
  }, [previewEditor, content]);

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

  if (showDiff && diffHtml) {
    return (
      <div
        className="h-full overflow-auto p-4 text-sm leading-relaxed whitespace-pre-wrap break-words"
        // diffHtml is built from escaped text only — safe to set
        dangerouslySetInnerHTML={{ __html: diffHtml }}
      />
    );
  }

  return (
    <div className="h-full overflow-auto p-4 prose prose-sm dark:prose-invert max-w-none">
      <EditorContent editor={previewEditor} />
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

  // Reset local state when modal opens/closes
  useEffect(() => {
    if (!isOpen) {
      setShowDiff(false);
      setConfirmRestore(false);
    }
  }, [isOpen]);

  // ---- Diff computation ----
  const diffHtml = (() => {
    if (!showDiff || !selectedContent) return null;

    const selectedText = prosemirrorJsonToText(selectedContent);

    // "previous" text: if current version is selected → latest revision's content
    // otherwise → the revision just before selected in the list
    let prevText = "";
    if (selectedRevisionId === null) {
      // Current version selected; compare against first revision
      if (revisions.length > 0) {
        // We don't have full content in list metadata, so we compare against empty
        // The actual previous content is not available without fetching; show nothing
        prevText = "";
      }
    } else {
      const idx = revisions.findIndex((r) => r.id === selectedRevisionId);
      // idx+1 is the revision before this one (older)
      const prevRevision = revisions[idx + 1];
      if (prevRevision) {
        // We don't have content in list items (performance), so we only have current content
        // as baseline. If selectedRevisionId !== null, compare against currentContent.
        prevText = currentContent ? prosemirrorJsonToText(currentContent) : "";
      }
    }

    return buildDiffHtml(prevText, selectedText);
  })();

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
      console.error("[RevisionHistoryModal] restore failed", err);
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
      <div className="bg-background rounded-lg border border-border shadow-xl w-[900px] max-w-[95vw] h-[70vh] flex flex-col">
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
                isLoading={isLoadingContent}
                showDiff={showDiff}
                diffHtml={diffHtml}
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
