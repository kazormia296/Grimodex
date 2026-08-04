import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";
import { useQuiescentDraftParticipant } from "@/application/lifecycle/useQuiescentDraftParticipant";
import { trackPendingEditorWrite } from "@/lib/editorQuiescence";
import { getPalette, resolveStickyHex } from "@/lib/stickyPalettes";
import { StickyBodyEditor } from "@/features/sticky/StickyBodyEditor";
import { StickyRichTextBody } from "@/features/sticky/StickyRichTextBody";
import {
  projectCoverageToCard,
  type EditorTextCoverageRect,
} from "./editorTextCoverageIndex";
import type { EditorSticky } from "./editorStickyTypes";

interface DragState {
  pointerId: number;
  startX: number;
  startY: number;
}

export interface EditorStickyCardProps {
  sticky: EditorSticky;
  left: number;
  top: number;
  width: number;
  minHeight: number;
  height: number;
  fontSize: number;
  coverage: readonly EditorTextCoverageRect[];
  selected: boolean;
  editing: boolean;
  onSelect: (stickyId: string) => void;
  onEdit: (stickyId: string) => void;
  onStopEditing: (stickyId: string) => void;
  onBodySave: (sticky: EditorSticky, body: string) => Promise<void>;
  onDelete: (sticky: EditorSticky) => Promise<void>;
  onColorChange: (sticky: EditorSticky) => Promise<void>;
  onBringToFront: (sticky: EditorSticky) => Promise<void>;
  onSendToBack: (sticky: EditorSticky) => Promise<void>;
  onDragStart: (stickyId: string) => void;
  onDragMove: (stickyId: string, deltaX: number, deltaY: number) => void;
  onDragEnd: (stickyId: string) => void;
  onMeasure: (stickyId: string, width: number, height: number) => void;
}

export function EditorStickyCard({
  sticky,
  left,
  top,
  width,
  minHeight,
  height,
  fontSize,
  coverage,
  selected,
  editing,
  onSelect,
  onEdit,
  onStopEditing,
  onBodySave,
  onDelete,
  onColorChange,
  onBringToFront,
  onSendToBack,
  onDragStart,
  onDragMove,
  onDragEnd,
  onMeasure,
}: EditorStickyCardProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [draftBody, setDraftBody] = useState(sticky.body);
  const draftRef = useRef(sticky.body);
  const dirtyRef = useRef(false);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (!editing && !dirtyRef.current) {
      draftRef.current = sticky.body;
      setDraftBody(sticky.body);
    }
  }, [editing, sticky.body]);

  const commitBody = useCallback(async () => {
    if (!dirtyRef.current) return;
    const body = draftRef.current;
    await trackPendingEditorWrite(onBodySave(sticky, body));
    dirtyRef.current = false;
    setDirty(false);
    setDraftBody(body);
  }, [onBodySave, sticky]);

  useQuiescentDraftParticipant({
    id: `editor-sticky:${sticky.id}`,
    enabled: dirty,
    isDirty: () => dirtyRef.current,
    flush: commitBody,
    discard: () => {
      dirtyRef.current = false;
      setDirty(false);
      draftRef.current = sticky.body;
      setDraftBody(sticky.body);
    },
    recovery: () =>
      dirtyRef.current
        ? {
            kind: "editor-sticky-draft",
            stickyId: sticky.id,
            documentKey: sticky.documentKey,
            body: draftRef.current,
          }
        : null,
  });

  useEffect(() => {
    const element = cardRef.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const { width: measuredWidth, height: measuredHeight } =
        entry.contentRect;
      if (measuredWidth > 0 && measuredHeight > 0) {
        onMeasure(sticky.id, measuredWidth, measuredHeight);
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [onMeasure, sticky.id]);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    document.addEventListener("mousedown", close);
    document.addEventListener("contextmenu", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("contextmenu", close);
    };
  }, [menu]);

  const changeDraft = (body: string) => {
    draftRef.current = body;
    setDraftBody(body);
    dirtyRef.current = true;
    setDirty(true);
  };

  const leaveEditing = () => {
    void commitBody()
      .then(() => {
        onStopEditing(sticky.id);
        onSelect(sticky.id);
      })
      .catch(() => toast.error("付箋を保存できませんでした"));
  };

  const finishDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    onDragEnd(sticky.id);
  };

  const maskId = `editor-sticky-mask-${sticky.id.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
  const clippedCoverage = projectCoverageToCard(coverage, {
    x: left,
    y: top,
    width,
    height,
  });
  const paperColor = resolveStickyHex(sticky.paletteId, sticky.colorSlot);
  const cardStyle: CSSProperties = {
    position: "absolute",
    left,
    top,
    width,
    minHeight,
    zIndex: sticky.zIndex + 1000,
    fontSize,
    writingMode: "horizontal-tb",
    textOrientation: "mixed",
    direction: "ltr",
    pointerEvents: "auto",
    outline: selected
      ? "2px solid color-mix(in srgb, currentColor 55%, transparent)"
      : undefined,
  };

  return (
    <div
      ref={cardRef}
      data-editor-sticky-card="true"
      data-editor-sticky-id={sticky.id}
      className="editor-sticky-card"
      style={cardStyle}
      tabIndex={selected ? 0 : -1}
      onClick={(event) => {
        event.stopPropagation();
        onSelect(sticky.id);
      }}
      onDoubleClick={(event) => {
        event.stopPropagation();
        onEdit(sticky.id);
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onSelect(sticky.id);
        setMenu({ x: event.clientX, y: event.clientY });
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          if (editing) leaveEditing();
          else onSelect(sticky.id);
        } else if (event.key === "Delete" && !editing) {
          event.preventDefault();
          void onDelete(sticky).catch(() =>
            toast.error("付箋を削除できませんでした"),
          );
        }
      }}
      onBlur={(event) => {
        if (!editing) return;
        const next = event.relatedTarget;
        if (next instanceof Node && event.currentTarget.contains(next)) return;
        void commitBody()
          .then(() => onStopEditing(sticky.id))
          .catch(() => toast.error("付箋を保存できませんでした"));
      }}
    >
      <svg
        className="editor-sticky-card__paper"
        aria-hidden="true"
        width="100%"
        height="100%"
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
      >
        <defs>
          <mask
            id={maskId}
            maskUnits="userSpaceOnUse"
            x="0"
            y="0"
            width={width}
            height={height}
          >
            <rect width={width} height={height} fill="white" />
            {clippedCoverage.map((rect, index) => (
              <rect
                key={`${rect.x}:${rect.y}:${index}`}
                x={rect.x}
                y={rect.y}
                width={rect.width}
                height={rect.height}
                fill="black"
              />
            ))}
          </mask>
        </defs>
        <rect
          width={width}
          height={height}
          fill={paperColor}
          fillOpacity="0.94"
          mask={`url(#${maskId})`}
        />
      </svg>
      <div
        className="editor-sticky-card__content"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <div
          className="editor-sticky-card__handle"
          role="button"
          aria-label="付箋を移動"
          onPointerDown={(event) => {
            if (event.button !== 0 || editing) return;
            event.preventDefault();
            event.stopPropagation();
            dragRef.current = {
              pointerId: event.pointerId,
              startX: event.clientX,
              startY: event.clientY,
            };
            event.currentTarget.setPointerCapture(event.pointerId);
            onSelect(sticky.id);
            onDragStart(sticky.id);
          }}
          onPointerMove={(event) => {
            const drag = dragRef.current;
            if (!drag || drag.pointerId !== event.pointerId) return;
            event.stopPropagation();
            onDragMove(
              sticky.id,
              event.clientX - drag.startX,
              event.clientY - drag.startY,
            );
          }}
          onPointerUp={finishDrag}
          onPointerCancel={finishDrag}
        >
          <span aria-hidden="true">⋮⋮</span>
        </div>
        <div className="editor-sticky-card__body">
          {editing ? (
            <StickyBodyEditor
              body={draftBody}
              onContentChange={changeDraft}
              onEscape={leaveEditing}
            />
          ) : (
            <StickyRichTextBody body={sticky.body} />
          )}
        </div>
      </div>
      {menu
        ? createPortal(
            <div
              className="editor-sticky-menu"
              style={{ left: menu.x, top: menu.y }}
              onMouseDown={(event) => event.stopPropagation()}
            >
              <button
                type="button"
                onClick={() =>
                  void onColorChange(sticky).finally(() => setMenu(null))
                }
              >
                色を変更
              </button>
              <button
                type="button"
                onClick={() =>
                  void onBringToFront(sticky).finally(() => setMenu(null))
                }
              >
                前面へ
              </button>
              <button
                type="button"
                onClick={() =>
                  void onSendToBack(sticky).finally(() => setMenu(null))
                }
              >
                背面へ
              </button>
              <button
                type="button"
                onClick={() =>
                  void onDelete(sticky)
                    .catch(() => toast.error("付箋を削除できませんでした"))
                    .finally(() => setMenu(null))
                }
              >
                削除
              </button>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

export function nextStickyColor(sticky: EditorSticky): {
  paletteId: string;
  colorSlot: number;
} {
  const palette = getPalette(sticky.paletteId);
  return {
    paletteId: palette.id,
    colorSlot: (sticky.colorSlot + 1) % palette.colors.length,
  };
}
