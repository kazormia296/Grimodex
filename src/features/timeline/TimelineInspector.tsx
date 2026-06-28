import { useState, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Clock, X } from "lucide-react";
import type { TreeNodeData } from "@/features/tree/treeStore";
import { usePhaseStore } from "@/features/codex/phaseStore";
import { useCodexStore } from "@/features/codex/codexStore";
import { SceneDateEditor } from "@/features/chronicle/SceneDateEditor";
import { useTimelineStore } from "./timelineStore";

interface Props {
  node: TreeNodeData | null;
  /** Splitter で可変・永続化された幅(px)。 */
  width: number;
  onClose: () => void;
  onUpdateStoryTimeLabel: (id: string, label: string) => void;
}

export function TimelineInspector({
  node,
  width,
  onClose,
  onUpdateStoryTimeLabel,
}: Props) {
  const { t } = useTranslation();
  const axisMode = useTimelineStore((s) => s.axisMode);
  const pendingEditNodeId = useTimelineStore((s) => s.pendingEditNodeId);
  const setPendingEditNodeId = useTimelineStore((s) => s.setPendingEditNodeId);
  const phasesByEntry = usePhaseStore((s) => s.phasesByEntry);
  const entries = useCodexStore((s) => s.entries);
  const [labelDraft, setLabelDraft] = useState(node?.storyTimeLabel ?? "");
  const labelInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setLabelDraft(node?.storyTimeLabel ?? "");
  }, [node?.id, node?.storyTimeLabel]);

  useEffect(() => {
    if (node && pendingEditNodeId === node.id && labelInputRef.current) {
      labelInputRef.current.focus();
      labelInputRef.current.select();
      setPendingEditNodeId(null);
    }
  }, [pendingEditNodeId, node, setPendingEditNodeId]);

  const anchoredPhases = node
    ? entries.flatMap((entry) => {
        const phases = phasesByEntry[entry.id] ?? [];
        return phases
          .filter((p) => p.anchorNodeId === node.id)
          .map((p) => ({ entryName: entry.name, label: p.label }));
      })
    : [];

  function commitLabel() {
    if (node && labelDraft !== (node.storyTimeLabel ?? "")) {
      onUpdateStoryTimeLabel(node.id, labelDraft);
    }
  }

  return (
    <div
      data-testid="timeline-inspector"
      style={{ width }}
      className="flex min-h-0 shrink-0 flex-col gap-2 overflow-y-auto border-l border-border bg-background px-3 py-2 text-xs"
    >
      {/* Header */}
      <div className="flex items-center justify-between">
        <span className="font-semibold text-foreground">
          {node ? node.title : t("timeline.inspector.title", "インスペクター")}
        </span>
        <button
          onClick={onClose}
          className="text-muted-foreground hover:text-foreground"
          aria-label={t("timeline.inspector.close", "インスペクターを閉じる")}
        >
          <X size={12} />
        </button>
      </div>

      {!node ? (
        // シーン未選択時もパネルは表示し、プレースホルダーで案内する
        // （threads モードの PlotMarkerInspector と同じ挙動）。
        <p className="text-muted-foreground">
          {t(
            "timeline.inspector.empty",
            "シーンを選択すると詳細が表示されます",
          )}
        </p>
      ) : (
        <>
          {/* Status */}
          <div className="flex items-center gap-1 text-muted-foreground">
            <span>{t("timeline.inspector.status", "Status")}</span>
            <span className="ml-auto font-medium text-foreground">
              {node.status ?? "—"}
            </span>
          </div>

          {/* Story-time fields (story-time axis only) */}
          {axisMode === "story" && (
            <div className="flex flex-col gap-1">
              <label className="text-muted-foreground">
                {t("timeline.inspector.storyTimeLabel", "Story-time label")}
              </label>
              <input
                ref={labelInputRef}
                type="text"
                value={labelDraft}
                onChange={(e) => setLabelDraft(e.target.value)}
                onBlur={commitLabel}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    commitLabel();
                    (e.target as HTMLInputElement).blur();
                  }
                }}
                placeholder={t("timeline.inspector.labelPlaceholder", "T1")}
                className="rounded border border-border bg-background px-1.5 py-0.5 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
              />
              <span className="text-muted-foreground">
                {node.storyTimeOrder
                  ? t("timeline.inspector.hasOrder", "配置済み")
                  : t("timeline.inspector.unscheduled", "Unscheduled")}
              </span>
            </div>
          )}

          {/* Synopsis */}
          {node.synopsis && (
            <div className="flex flex-col gap-0.5">
              <span className="text-muted-foreground">
                {t("timeline.inspector.synopsis", "Synopsis")}
              </span>
              <p className="text-foreground/80 leading-relaxed">
                {node.synopsis}
              </p>
            </div>
          )}

          {/* Story-date (作中暦日付) — scene のみ。SceneMetaPanel と同じ編集 UI を再利用。 */}
          {node.nodeType === "scene" && (
            <div className="-mx-3">
              <SceneDateEditor node={node} />
            </div>
          )}

          {/* Anchored phases */}
          {anchoredPhases.length > 0 && (
            <div className="flex flex-col gap-1">
              <span className="text-muted-foreground">
                {t("timeline.inspector.phases", "Phases anchored ({{n}})", {
                  n: anchoredPhases.length,
                })}
              </span>
              {anchoredPhases.map((p, i) => (
                <div
                  key={i}
                  className="flex items-center gap-1 text-foreground/80"
                >
                  <Clock className="h-3 w-3 shrink-0" aria-hidden />
                  <span>
                    {p.entryName}: {p.label}
                  </span>
                </div>
              ))}
            </div>
          )}

          {/* Created at */}
          <div className="mt-auto text-muted-foreground">
            {t("timeline.inspector.created", "Created")}{" "}
            {new Date(node.createdAt).toLocaleDateString()}
          </div>
        </>
      )}
    </div>
  );
}
