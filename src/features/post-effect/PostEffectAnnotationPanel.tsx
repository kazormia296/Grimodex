import { useEffect } from "react";
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { useTreeStore } from "@/features/tree/treeStore";
import { useEditorStore } from "@/features/editor/editorStore";
import { useAiSettingsStore } from "@/features/chat/store";
import { useAnnotationStore } from "./annotationStore";
import { listAnnotationsForScene } from "./api";
import { closeAnnotation } from "./closeAnnotation";
import { parseAnnotationMeta } from "./annotationMeta";
import {
  CodexChip,
  ConfidenceBadge,
  ContrastRow,
  ExpandedDetails,
  TypoChip,
  TypoContrastRow,
} from "./AnnotationDetails";
import type { PostEffectAnnotation, PostEffectSeverity } from "./types";

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
  const { focusedAnnotationId, setFocusedAnnotationId } = useAnnotationStore();
  const editor = useEditorStore((s) => s.editor);
  const focused = focusedAnnotationId === ann.id;

  async function dismiss() {
    await closeAnnotation(ann, "dismissed", editor);
  }

  async function resolve() {
    await closeAnnotation(ann, "resolved", editor);
  }

  const severity = (ann.severity ?? "info") as PostEffectSeverity;
  const isDone = ann.status === "dismissed" || ann.status === "resolved";
  const parsed = parseAnnotationMeta(ann);
  const currentModel = useAiSettingsStore((s) => s.settings?.model);

  // consistency / typo の content は冗長な自動生成文 (例「entry.detail と矛盾: ...」)。
  // chip + 対比行 + reason 行が同じ情報を綺麗に持つので、それらが揃う種別は
  // タイトル本文を抑制する。intra は対比情報が無いので content をタイトル表示。
  const showTitle = parsed.kind === "intra";

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
        "group flex flex-col gap-1.5 rounded-md border px-3 py-2 text-sm cursor-pointer select-none",
        "transition-colors",
        focused
          ? "border-primary/60 bg-primary/5"
          : "border-border hover:border-muted-foreground/40 hover:bg-accent/30",
        isDone && "opacity-50",
      )}
    >
      <div className="flex items-start gap-2">
        {SEVERITY_ICONS[severity]}
        <div className="flex flex-1 flex-wrap items-center gap-1.5">
          {parsed.codex && <CodexChip codex={parsed.codex} />}
          {parsed.typo && <TypoChip category={parsed.typo.category} />}
          {parsed.confidence && <ConfidenceBadge level={parsed.confidence} />}
          {showTitle && (
            <p className="basis-full leading-snug">{ann.content}</p>
          )}
        </div>
        {!isDone && (
          <div className="flex shrink-0 gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
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
      {parsed.codex && (
        <ContrastRow
          expected={parsed.codex.expectedValue}
          found={parsed.codex.foundValue}
        />
      )}
      {parsed.typo && (
        <TypoContrastRow
          found={parsed.foundText}
          suggestion={parsed.typo.suggestion}
        />
      )}
      {ann.textSnapshot && (
        <blockquote className="border-l-2 border-muted-foreground/30 pl-2 text-xs text-muted-foreground line-clamp-2">
          {ann.textSnapshot}
        </blockquote>
      )}
      {focused && (
        <ExpandedDetails parsed={parsed} currentModel={currentModel} />
      )}
    </div>
  );
}

export function PostEffectAnnotationPanel({ sceneId }: Props) {
  const { annotationsByScene, setAnnotations } = useAnnotationStore();
  const allAnnotations = annotationsByScene.get(sceneId) ?? [];

  useEffect(() => {
    if (allAnnotations.length > 0) return;
    const projectId = useTreeStore.getState().projectId;
    listAnnotationsForScene({ projectId, sceneId })
      .then((resp) => setAnnotations(sceneId, resp.annotations))
      .catch(() => {});
  }, [sceneId, allAnnotations.length, setAnnotations]);

  // 整合性 (consistency / intra) のみ。typo は TypoSection で別表示。
  const annotations = allAnnotations.filter(
    (a) => a.category !== "typo_anchor",
  );

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
