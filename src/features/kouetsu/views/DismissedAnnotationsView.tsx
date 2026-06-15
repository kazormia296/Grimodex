import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
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
  PostEffectCategory,
  PostEffectSeverity,
} from "@/features/post-effect/types";
import { selectManuallyDismissed } from "@/features/kouetsu/dismissedAnnotations";

const SEVERITY_ICONS: Record<PostEffectSeverity, React.ReactNode> = {
  error: <XCircle size={13} className="text-destructive shrink-0" />,
  warning: <AlertTriangle size={13} className="text-yellow-500 shrink-0" />,
  suggestion: <Info size={13} className="text-blue-400 shrink-0" />,
  info: <Info size={13} className="text-muted-foreground shrink-0" />,
};

interface Props {
  /** このビューが扱う annotation category。整合性=consistency_anchor / 誤字脱字=typo_anchor。 */
  category: PostEffectCategory;
  /** 空状態の文言。section ごとに正しいラベルを出す (整合性向け文言の漏れを防ぐ)。 */
  emptyLabel: string;
}

export function DismissedAnnotationsView({ category, emptyLabel }: Props) {
  const { t } = useTranslation();
  const [annotations, setAnnotations] = useState<PostEffectAnnotation[]>([]);
  const [loading, setLoading] = useState(false);

  const projectId = useTreeStore((s) => s.projectId);
  const scenes = useTreeStore((s) => s.scenes);
  const { updateAnnotationStatus: localUpdate } = useAnnotationStore();

  const sceneTitle = (sceneId: string | null) =>
    scenes.find((s) => s.id === sceneId)?.title ??
    sceneId ??
    t("attribution.columnUnknown");

  useEffect(() => {
    if (!projectId) return;
    setLoading(true);
    // listAnnotationsForProject は category 引数を持たないため client 側で絞る。
    // category で絞らないと各セクションが同一の全件リストを描画してしまう
    // (byte 同一の重複)。判定ロジックは dismissedAnnotations.ts に抽出・unit test 済み。
    listAnnotationsForProject({ projectId, status: "dismissed" })
      .then((resp) =>
        setAnnotations(selectManuallyDismissed(resp.annotations, category)),
      )
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [projectId, category]);

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
        <span>{emptyLabel}</span>
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
  const { t } = useTranslation();
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
          aria-label={t("kouetsu.dismissed.reopen")}
          title={t("kouetsu.dismissed.reopenTooltip")}
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
