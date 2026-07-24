import { useEffect, useRef, useState } from "react";
import { Clock } from "lucide-react";
import type { Editor } from "@tiptap/react";
import i18next from "i18next";
import { AttributionLegend } from "@/features/attribution/AttributionLegend";
import { ReorderModeHint } from "@/features/editor/reorder/ReorderModeHint";
import { AiPolicyBadge } from "@/features/ai-policy/AiPolicyBadge";
import { LicenseBadge } from "@/features/license/LicenseBadge";
import { StatusBarIndicator } from "@/features/lint/StatusBarIndicator";
import { EditorStatsFooter } from "@/features/editor/EditorStatsFooter";
import type { SceneStatus } from "@/features/tree/treeStore";
import { useCursorSettingsStore } from "@/features/editor/cursorSettingsStore";
import { useWorkspaceViewportProfile } from "@/runtime/workspaceViewportContext";

const STATUS_COLORS: Record<SceneStatus, string> = {
  outline: "text-muted-foreground",
  draft: "text-yellow-500",
  complete: "text-green-500",
  revision: "text-purple-400",
  final: "text-blue-400",
};

function getStatusLabels(): Record<SceneStatus, string> {
  return {
    outline: i18next.t("editor.status.outline"),
    draft: i18next.t("editor.status.draft"),
    complete: i18next.t("editor.status.complete"),
    revision: i18next.t("editor.status.revision"),
    final: i18next.t("editor.status.final"),
  };
}

interface EditorPaneStatusBarProps {
  activeStatus: SceneStatus | null;
  editor: Editor | null;
  getStatsSceneId: () => string | null | undefined;
  isEntryMode: boolean;
  isSceneContentLoading: boolean;
  showAttribution: boolean;
  aiRatio: number;
  isSaving: boolean;
  isDirty: boolean;
  onStatusChange: (status: SceneStatus) => void;
  onOpenAttribution: () => void;
  onOpenRevisionHistory: () => void;
}

/** Render-only bottom chrome with its local status-menu interaction. */
export function EditorPaneStatusBar({
  activeStatus,
  editor,
  getStatsSceneId,
  isEntryMode,
  isSceneContentLoading,
  showAttribution,
  aiRatio,
  isSaving,
  isDirty,
  onStatusChange,
  onOpenAttribution,
  onOpenRevisionHistory,
}: EditorPaneStatusBarProps) {
  const zenMode = useCursorSettingsStore((state) => state.zenMode);
  const phoneWorkspace = useWorkspaceViewportProfile() === "phone";
  const [statusPopoverOpen, setStatusPopoverOpen] = useState(false);
  const statusPopoverRef = useRef<HTMLDivElement>(null);
  const statusBadgeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!statusPopoverOpen) return;
    function onMouseDown(e: MouseEvent) {
      const target = e.target as Node;
      if (
        !statusBadgeRef.current?.contains(target) &&
        !statusPopoverRef.current?.contains(target)
      ) {
        setStatusPopoverOpen(false);
      }
    }
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [statusPopoverOpen]);

  if (zenMode || phoneWorkspace) return null;

  return (
    <div className="glass-editor-chrome flex flex-shrink-0 items-center justify-between border-t border-border px-3 py-1 text-xs text-muted-foreground">
      <div className="relative flex min-w-0 items-center gap-2">
        {activeStatus ? (
          <>
            <button
              ref={statusBadgeRef}
              type="button"
              title={i18next.t("editor.status.changeStatus")}
              onClick={() => setStatusPopoverOpen((v) => !v)}
              className={`rounded px-1.5 py-0.5 font-medium hover:bg-accent ${STATUS_COLORS[activeStatus]}`}
            >
              {getStatusLabels()[activeStatus]}
            </button>
            {statusPopoverOpen && (
              <div
                ref={statusPopoverRef}
                className="absolute bottom-full left-0 z-50 mb-1 min-w-[120px] rounded border border-border bg-popover py-1 shadow-md"
              >
                {(
                  Object.entries(getStatusLabels()) as [SceneStatus, string][]
                ).map(([status, label]) => (
                  <button
                    key={status}
                    type="button"
                    onClick={() => {
                      onStatusChange(status);
                      setStatusPopoverOpen(false);
                    }}
                    className={`flex w-full items-center px-3 py-1.5 text-left text-xs hover:bg-accent ${status === activeStatus ? "font-medium" : ""} ${STATUS_COLORS[status]}`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            )}
          </>
        ) : null}
        {showAttribution && (
          <AttributionLegend className="text-[10px] text-muted-foreground" />
        )}
        <ReorderModeHint className="text-[10px] text-muted-foreground" />
      </div>
      <div className="flex flex-shrink-0 items-center gap-3">
        <AiPolicyBadge />
        <LicenseBadge />
        <StatusBarIndicator />
        {showAttribution && aiRatio > 0 && (
          <button
            type="button"
            title={i18next.t("editor.status.openAttribution")}
            onClick={onOpenAttribution}
            className="tabular-nums text-attribution-ai hover:text-foreground"
          >
            AI: {aiRatio}%
          </button>
        )}
        <EditorStatsFooter
          editor={editor}
          getSyncSceneId={getStatsSceneId}
          syncToTree={!isEntryMode}
          isLoading={isSceneContentLoading}
        />
        {isSaving ? (
          <span className="opacity-50">
            {i18next.t("editor.status.saving")}
          </span>
        ) : isDirty ? (
          <span className="text-amber-500">
            {i18next.t("editor.status.unsaved")}
          </span>
        ) : (
          <span className="opacity-40">{i18next.t("editor.status.saved")}</span>
        )}
        <button
          type="button"
          title={i18next.t("editor.status.revisionHistory")}
          onClick={onOpenRevisionHistory}
          className="hover:text-foreground"
        >
          <Clock className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}
