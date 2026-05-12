import { useEffect } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Info,
  MapPinOff,
  X,
  XCircle,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useTreeStore } from "@/features/tree/treeStore";
import { useAiSettingsStore } from "@/features/chat/store";
import { useAnnotationStore } from "./annotationStore";
import { listAnnotationsForScene, updateAnnotationStatus } from "./api";
import type { PostEffectAnnotation, PostEffectSeverity } from "./types";

/**
 * metadata から orphaned フラグと detected_by_model を取り出す。
 * metadata は通常 row_to_annotation_value 経由で object 化されているが、
 * 万が一 string で来た場合は parse、parse 失敗時は安全な既定値を返す。
 */
function readAnnotationMeta(ann: PostEffectAnnotation): {
  orphaned: boolean;
  detectedByModel?: string;
} {
  let meta: Record<string, unknown> | undefined;
  try {
    meta =
      typeof ann.metadata === "string"
        ? (JSON.parse(ann.metadata) as Record<string, unknown>)
        : (ann.metadata as Record<string, unknown> | undefined);
  } catch {
    return { orphaned: false };
  }
  if (!meta) return { orphaned: false };
  const ref = (meta.codex_ref as Record<string, unknown> | undefined) ?? {};
  const orphaned = meta.orphaned === true || ref.orphaned === true;
  const detectedByModel =
    (ref.detected_by_model as string | undefined) ??
    (meta.detected_by_model as string | undefined);
  return { orphaned, detectedByModel };
}

interface Props {
  sceneId: string;
}

const SEVERITY_ICONS: Record<PostEffectSeverity, React.ReactNode> = {
  error: <XCircle size={14} className="text-destructive shrink-0" />,
  warning: <AlertTriangle size={14} className="text-yellow-500 shrink-0" />,
  suggestion: <Info size={14} className="text-blue-400 shrink-0" />,
  info: <Info size={14} className="text-muted-foreground shrink-0" />,
};

function AnnotationItem({ ann }: { ann: PostEffectAnnotation }) {
  const {
    focusedAnnotationId,
    setFocusedAnnotationId,
    updateAnnotationStatus: localUpdate,
  } = useAnnotationStore();
  const focused = focusedAnnotationId === ann.id;

  async function dismiss() {
    try {
      await updateAnnotationStatus(ann.id, "dismissed");
      localUpdate(ann.id, "dismissed");
    } catch {
      /* ignore */
    }
  }

  async function resolve() {
    try {
      await updateAnnotationStatus(ann.id, "resolved");
      localUpdate(ann.id, "resolved");
    } catch {
      /* ignore */
    }
  }

  const severity = (ann.severity ?? "info") as PostEffectSeverity;
  const isDone = ann.status === "dismissed" || ann.status === "resolved";
  const { orphaned, detectedByModel } = readAnnotationMeta(ann);
  const currentModel = useAiSettingsStore((s) => s.settings?.model);
  const isStaleModel =
    detectedByModel != null &&
    currentModel != null &&
    detectedByModel !== currentModel;

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => setFocusedAnnotationId(focused ? null : ann.id)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ")
          setFocusedAnnotationId(focused ? null : ann.id);
      }}
      className={cn(
        "group flex flex-col gap-1 rounded-md border px-3 py-2 text-sm cursor-pointer select-none",
        "transition-colors",
        focused
          ? "border-primary/60 bg-primary/5"
          : "border-border hover:border-muted-foreground/40 hover:bg-accent/30",
        isDone && "opacity-50",
      )}
    >
      <div className="flex items-start gap-2">
        {SEVERITY_ICONS[severity]}
        <p className="flex-1 leading-snug">{ann.content}</p>
        {!isDone && (
          <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
            <button
              aria-label="解決済み"
              title="解決済み"
              onClick={(e) => {
                e.stopPropagation();
                resolve();
              }}
              className="rounded p-0.5 hover:bg-green-500/20 text-green-600"
            >
              <CheckCircle2 size={13} />
            </button>
            <button
              aria-label="無視"
              title="無視"
              onClick={(e) => {
                e.stopPropagation();
                dismiss();
              }}
              className="rounded p-0.5 hover:bg-muted text-muted-foreground"
            >
              <X size={13} />
            </button>
          </div>
        )}
      </div>
      {ann.textSnapshot && (
        <blockquote className="border-l-2 border-muted-foreground/30 pl-2 text-xs text-muted-foreground line-clamp-2">
          {ann.textSnapshot}
        </blockquote>
      )}
      {(orphaned || isStaleModel) && (
        <div className="flex flex-wrap items-center gap-1 pt-0.5 text-[10px]">
          {orphaned && (
            <span
              title="本文中の該当位置を特定できませんでした"
              className="inline-flex items-center gap-0.5 rounded bg-amber-500/10 px-1.5 py-0.5 text-amber-600 dark:text-amber-400"
            >
              <MapPinOff size={10} /> 位置特定不可
            </span>
          )}
          {isStaleModel && (
            <span
              title={`現在のモデル (${currentModel}) とは別モデルで検出された指摘です`}
              className="inline-flex items-center gap-0.5 rounded bg-muted px-1.5 py-0.5 text-muted-foreground"
            >
              by {detectedByModel}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

export function PostEffectAnnotationPanel({ sceneId }: Props) {
  const { annotationsByScene, setAnnotations } = useAnnotationStore();
  const annotations = annotationsByScene.get(sceneId) ?? [];

  useEffect(() => {
    if (annotations.length > 0) return;
    const projectId = useTreeStore.getState().projectId;
    listAnnotationsForScene({ projectId, sceneId })
      .then((resp) => setAnnotations(sceneId, resp.annotations))
      .catch(() => {});
  }, [sceneId, annotations.length, setAnnotations]);

  const open = annotations.filter((a) => a.status === "open");
  const done = annotations.filter(
    (a) => a.status === "resolved" || a.status === "dismissed",
  );

  if (annotations.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
        <Info size={18} />
        <span>アノテーションなし</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 p-2">
      {open.map((a) => (
        <AnnotationItem key={a.id} ann={a} />
      ))}
      {done.length > 0 && (
        <>
          <p className="mt-2 text-xs text-muted-foreground">解決済み / 無視</p>
          {done.map((a) => (
            <AnnotationItem key={a.id} ann={a} />
          ))}
        </>
      )}
    </div>
  );
}
