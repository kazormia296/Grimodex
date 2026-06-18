import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ListRowSkeletonList } from "@/components/ui/skeleton-patterns";
import { listAnnotationsForProject } from "@/features/post-effect/api";
import {
  selectConsistencyFindingsForEntry,
  type ConsistencyFinding,
} from "@/features/post-effect/consistencyByEntry";
import {
  codexChipLabel,
  clipValue,
} from "@/features/post-effect/annotationMeta";
import { useAnnotationStore } from "@/features/post-effect/annotationStore";
import { useTreeStore } from "@/features/tree/treeStore";
import { ImpactCheckButton } from "./ImpactCheckButton";

const SEVERITY_DOT: Record<string, string> = {
  error: "bg-red-500",
  warning: "bg-yellow-500",
  suggestion: "bg-blue-500",
  info: "bg-muted-foreground/50",
};

interface ConsistencyTabProps {
  codexEntryId: string;
}

/**
 * Codex 詳細タブ: この設定に矛盾する本文側の整合性指摘 (consistency) を surfacing する。
 * Tier A-1 — 既存 annotation データを entry_id で読み替えるだけ (生成側不変)。
 * 件数は client 側集計。校閲パネル (ProjectAnnotationsView) と逆向きの導線。
 */
export function ConsistencyTab({ codexEntryId }: ConsistencyTabProps) {
  const { t } = useTranslation();
  const projectId = useTreeStore((s) => s.projectId);
  const nodes = useTreeStore((s) => s.nodes);
  const setFocusedAnnotationId = useAnnotationStore(
    (s) => s.setFocusedAnnotationId,
  );
  const [findings, setFindings] = useState<ConsistencyFinding[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    setFindings(null);
    if (!projectId) {
      setFindings([]);
      return;
    }
    listAnnotationsForProject({ projectId, status: "open" })
      .then((resp) => {
        if (!cancelled) {
          setFindings(
            selectConsistencyFindingsForEntry(resp.annotations, codexEntryId),
          );
        }
      })
      .catch(() => {
        if (!cancelled) setFindings([]);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, codexEntryId]);

  if (findings === null) {
    return (
      <ListRowSkeletonList testId="consistency-tab-loading" className="py-2" />
    );
  }

  if (findings.length === 0) {
    return (
      <div className="space-y-3">
        <ImpactCheckButton entryId={codexEntryId} />
        <div
          data-testid="consistency-tab-empty"
          className="py-8 text-center text-xs text-muted-foreground"
        >
          {t("codex.consistencyTab.empty")}
        </div>
      </div>
    );
  }

  const titleById = new Map(nodes.map((n) => [n.id, n.title] as const));

  const jump = (finding: ConsistencyFinding) => {
    const { annotation } = finding;
    if (annotation.sceneId) {
      useTreeStore.getState().setActiveScene(annotation.sceneId);
    }
    setFocusedAnnotationId(annotation.id);
  };

  return (
    <div className="space-y-2">
      <ImpactCheckButton entryId={codexEntryId} />
      <p
        data-testid="consistency-tab-count"
        className="px-1 text-xs text-muted-foreground"
      >
        {t("codex.consistencyTab.count", { count: findings.length })}
      </p>
      <ul data-testid="consistency-tab-list" className="space-y-1">
        {findings.map((finding) => {
          const { annotation, meta } = finding;
          const severity = annotation.severity ?? "info";
          const sceneTitle =
            titleById.get(annotation.sceneId ?? "") ??
            t("codex.consistencyTab.unknownScene");
          const reason = clipValue(meta.llmReason ?? meta.foundText, 80);
          return (
            <li key={annotation.id}>
              <button
                type="button"
                onClick={() => jump(finding)}
                className="flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-left hover:bg-accent"
              >
                <span className="flex items-center gap-1.5">
                  <span
                    className={`h-2 w-2 shrink-0 rounded-full ${
                      SEVERITY_DOT[severity] ?? SEVERITY_DOT.info
                    }`}
                    aria-hidden="true"
                  />
                  <span className="truncate text-sm">
                    {codexChipLabel(meta.codex)}
                  </span>
                  <span className="ml-auto shrink-0 truncate text-[10px] text-muted-foreground">
                    {sceneTitle}
                  </span>
                </span>
                {reason && (
                  <span className="truncate pl-3.5 text-xs text-muted-foreground">
                    {reason}
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
