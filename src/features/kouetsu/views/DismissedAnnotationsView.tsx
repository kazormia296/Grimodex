import { useEffect, useState } from "react";
import { AlertTriangle, Info, Loader2, RotateCcw, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { useTreeStore } from "@/features/tree/treeStore";
import { useAnnotationStore } from "@/features/post-effect/annotationStore";
import {
  listAnnotationsForProject,
  updateAnnotationStatus,
} from "@/features/post-effect/api";
import type {
  PostEffectAnnotation,
  PostEffectSeverity,
} from "@/features/post-effect/types";

const SEVERITY_ICONS: Record<PostEffectSeverity, React.ReactNode> = {
  error: <XCircle size={13} className="text-destructive shrink-0" />,
  warning: <AlertTriangle size={13} className="text-yellow-500 shrink-0" />,
  suggestion: <Info size={13} className="text-blue-400 shrink-0" />,
  info: <Info size={13} className="text-muted-foreground shrink-0" />,
};

function isManualDismiss(ann: PostEffectAnnotation): boolean {
  try {
    const meta =
      typeof ann.metadata === "string"
        ? (JSON.parse(ann.metadata) as Record<string, unknown>)
        : (ann.metadata as Record<string, unknown>);
    const inner =
      (meta.codex_ref as Record<string, unknown> | undefined) ?? meta;
    return inner.dismiss_source === "manual";
  } catch {
    return false;
  }
}

export function DismissedAnnotationsView() {
  const [annotations, setAnnotations] = useState<PostEffectAnnotation[]>([]);
  const [loading, setLoading] = useState(false);

  const projectId = useTreeStore((s) => s.projectId);
  const scenes = useTreeStore((s) => s.scenes);
  const { updateAnnotationStatus: localUpdate } = useAnnotationStore();

  const sceneTitle = (sceneId: string | null) =>
    scenes.find((s) => s.id === sceneId)?.title ?? sceneId ?? "不明";

  useEffect(() => {
    if (!projectId) return;
    setLoading(true);
    listAnnotationsForProject({ projectId, status: "dismissed" })
      .then((resp) => setAnnotations(resp.annotations.filter(isManualDismiss)))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [projectId]);

  async function reopen(ann: PostEffectAnnotation) {
    try {
      await updateAnnotationStatus(ann.id, "open");
      localUpdate(ann.id, "open");
      setAnnotations((prev) => prev.filter((a) => a.id !== ann.id));
    } catch {
      /* ignore */
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 size={16} className="animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (annotations.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 py-8 text-xs text-muted-foreground">
        <Info size={16} />
        <span>無視した整合性チェック結果はありません</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1 p-2">
      {annotations.map((ann) => (
        <DismissedRow
          key={ann.id}
          ann={ann}
          sceneTitle={sceneTitle(ann.sceneId ?? null)}
          onReopen={() => reopen(ann)}
        />
      ))}
    </div>
  );
}

function DismissedRow({
  ann,
  sceneTitle,
  onReopen,
}: {
  ann: PostEffectAnnotation;
  sceneTitle: string;
  onReopen: () => void;
}) {
  const severity = (ann.severity ?? "info") as PostEffectSeverity;
  return (
    <div
      className={cn(
        "group flex flex-col gap-1 rounded border border-border px-2 py-1.5 text-xs",
        "opacity-60 hover:opacity-100 transition-opacity",
      )}
    >
      <div className="flex items-start gap-1.5">
        {SEVERITY_ICONS[severity]}
        <div className="flex flex-1 flex-col gap-0.5">
          <p className="leading-snug">{ann.content}</p>
          <span className="text-muted-foreground">{sceneTitle}</span>
        </div>
        <button
          aria-label="再表示"
          title="再表示（open に戻す）"
          onClick={onReopen}
          className="shrink-0 rounded p-0.5 opacity-0 group-hover:opacity-100 hover:bg-accent transition-opacity"
        >
          <RotateCcw size={12} className="text-muted-foreground" />
        </button>
      </div>
      {ann.textSnapshot && (
        <blockquote className="border-l-2 border-muted-foreground/30 pl-2 text-muted-foreground line-clamp-2">
          {ann.textSnapshot}
        </blockquote>
      )}
    </div>
  );
}
