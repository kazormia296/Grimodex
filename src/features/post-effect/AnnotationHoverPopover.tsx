import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { AlertTriangle, Info, XCircle } from "lucide-react";
import { useTreeStore } from "@/features/tree/treeStore";
import { ANNOTATION_CATEGORY_TO_CAT } from "@/features/kouetsu/triage/issueModel";
import { CAT_LABEL_KEY } from "@/features/kouetsu/triage/catalog";
import type { PostEffectCategory, PostEffectSeverity } from "./types";
import { useAnnotationStore } from "./annotationStore";

interface Props {
  containerRef: React.RefObject<HTMLElement | null>;
}

interface Target {
  annId: string;
  x: number;
  y: number;
}

const SEVERITY_ICONS: Record<PostEffectSeverity, React.ReactNode> = {
  error: <XCircle size={13} className="shrink-0 text-destructive" />,
  warning: <AlertTriangle size={13} className="shrink-0 text-yellow-500" />,
  suggestion: <Info size={13} className="shrink-0 text-blue-400" />,
  info: <Info size={13} className="shrink-0 text-muted-foreground" />,
};

/**
 * 校閲の指摘 (pe-annotation、pseudo_comment を除く) のホバーポップオーバー。
 * 波線にマウスを乗せると観点ラベル + 重要度 + 指摘本文を表示する。
 * 読者コメントは PseudoCommentBubble が受け持つためここでは無視する。
 * 検出は CommentHoverPopover と同じ containerRef への mouseover 委譲。
 */
export function AnnotationHoverPopover({ containerRef }: Props) {
  const { t } = useTranslation();
  const showAnnotations = useAnnotationStore((s) => s.showAnnotations);
  const annotationsByScene = useAnnotationStore((s) => s.annotationsByScene);
  const [target, setTarget] = useState<Target | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearHideTimer = useCallback(() => {
    if (hideTimer.current !== null) {
      clearTimeout(hideTimer.current);
      hideTimer.current = null;
    }
  }, []);

  const scheduleHide = useCallback(() => {
    clearHideTimer();
    hideTimer.current = setTimeout(() => setTarget(null), 200);
  }, [clearHideTimer]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !showAnnotations) return;

    function onMouseOver(e: MouseEvent) {
      const el = (e.target as Element).closest(
        "[data-pe-ann-id]",
      ) as HTMLElement | null;
      // 読者コメントは PseudoCommentBubble の担当
      if (!el || el.getAttribute("data-pe-category") === "pseudo_comment") {
        scheduleHide();
        return;
      }
      clearHideTimer();
      const annId = el.getAttribute("data-pe-ann-id");
      if (!annId) return;
      const rect = el.getBoundingClientRect();
      setTarget({ annId, x: rect.left, y: rect.bottom + 6 });
    }

    container.addEventListener("mouseover", onMouseOver);
    return () => container.removeEventListener("mouseover", onMouseOver);
  }, [containerRef, showAnnotations, scheduleHide, clearHideTimer]);

  useEffect(() => {
    if (!showAnnotations) setTarget(null);
  }, [showAnnotations]);

  if (!target) return null;

  const activeSceneId = useTreeStore.getState().activeSceneId;
  const ann = activeSceneId
    ? (annotationsByScene.get(activeSceneId) ?? []).find(
        (a) => a.id === target.annId,
      )
    : undefined;
  if (!ann) return null;

  const cat = ANNOTATION_CATEGORY_TO_CAT[ann.category as PostEffectCategory];
  const catLabel = cat ? t(CAT_LABEL_KEY[cat]) : ann.category;
  const severity = (ann.severity ?? "warning") as PostEffectSeverity;

  const width = 300;
  const x = Math.min(target.x, window.innerWidth - width - 8);
  const y = Math.min(target.y, window.innerHeight - 160);

  return createPortal(
    <div
      role="dialog"
      aria-label={t("editor.layers.review")}
      className="fixed z-50 rounded-md border border-border bg-popover p-3 shadow-md"
      style={{ left: x, top: y, width }}
      onMouseEnter={clearHideTimer}
      onMouseLeave={scheduleHide}
      data-testid="annotation-hover-popover"
    >
      <div className="mb-1.5 flex items-center gap-1.5">
        {SEVERITY_ICONS[severity]}
        <span className="text-[10px] font-semibold text-muted-foreground">
          {catLabel}
        </span>
      </div>
      <p className="text-sm leading-snug text-popover-foreground">
        {ann.content}
      </p>
    </div>,
    document.body,
  );
}
