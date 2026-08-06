import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { useQuiescentDraftParticipant } from "@/application/lifecycle/useQuiescentDraftParticipant";
import { getPalette, resolveStickyHex } from "@/lib/stickyPalettes";
import { StickyBodyEditor } from "@/features/sticky/StickyBodyEditor";
import { StickyPaperVisual } from "@/features/sticky/StickyPaperVisual";
import { StickyRichTextBody } from "@/features/sticky/StickyRichTextBody";
import {
  createStickyDraftController,
  type StickyDraftController,
} from "@/features/sticky/stickyDraftController";
import {
  projectCoverageToCard,
  type EditorTextCoverageIndex,
  type EditorTextCoverageRect,
} from "./editorTextCoverageIndex";
import { setEditorStickyColor } from "./editorStickyCommands";
import type { EditorSticky } from "./editorStickyTypes";
import { createEditorStickyMaskId } from "./editorStickyMaskId";

interface DragState {
  pointerId: number;
  startX: number;
  startY: number;
}

interface EditorStickyDraftSession {
  baseBody: string;
  baseVersion: number;
}

type StickyGlueOrientation = "left" | "top";

const STICKY_GLUE_TO_TOP_HEIGHT = 110;
const STICKY_GLUE_TO_LEFT_HEIGHT = 90;
const STICKY_INSET_SHADOW =
  "inset 0 1px 0 rgba(255, 255, 255, 0.35), inset 0 -10px 18px -14px rgba(0, 0, 0, 0.18)";
const STICKY_LEFT_OUTER_SHADOW =
  "0 1px 0 rgba(0, 0, 0, 0.04), 2px 3px 3px rgba(0, 0, 0, 0.06), 8px 14px 22px -10px rgba(0, 0, 0, 0.32)";
const STICKY_TOP_OUTER_SHADOW =
  "0 1px 0 rgba(0, 0, 0, 0.04), 0 3px 3px rgba(0, 0, 0, 0.06), 0 14px 22px -10px rgba(0, 0, 0, 0.32)";

// Keep identical to Map's stickyRotation: stable per id, ±2.5deg.
function stickyRotation(id: string): number {
  let hash = 0;
  for (let index = 0; index < id.length; index += 1) {
    hash = ((hash << 5) - hash + id.charCodeAt(index)) | 0;
  }
  return ((Math.abs(hash) % 1000) / 1000) * 5 - 2.5;
}

export interface EditorStickyCardProps {
  sticky: EditorSticky;
  left: number;
  top: number;
  width: number;
  minHeight: number;
  maxHeight: number;
  height: number;
  fontSize: number;
  coverage: readonly EditorTextCoverageRect[] | EditorTextCoverageIndex;
  selected: boolean;
  editing: boolean;
  onSelect: (stickyId: string | null) => void;
  onEdit: (stickyId: string) => void;
  onStopEditing: (stickyId: string) => void;
  onBodySave: (
    sticky: EditorSticky,
    body: string,
    baseVersion: number,
  ) => Promise<EditorSticky>;
  onDelete: (sticky: EditorSticky) => Promise<void>;
  /**
   * Compatibility callback for callers that still expose the former
   * next-color action. Explicit palette choices are persisted through the
   * editor sticky command so every submenu item maps to its exact slot.
   */
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
  maxHeight,
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
  onBringToFront,
  onSendToBack,
  onDragStart,
  onDragMove,
  onDragEnd,
  onMeasure,
}: EditorStickyCardProps) {
  const { t } = useTranslation();
  const cardRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const [glueOrient, setGlueOrient] = useState<StickyGlueOrientation>("left");
  const draftControllerRef = useRef<StickyDraftController | null>(null);
  const draftBaseVersionRef = useRef<number>(sticky.version);
  const surfaceInstanceId = useId();
  if (
    draftControllerRef.current === null ||
    draftControllerRef.current.id !== sticky.id
  ) {
    draftControllerRef.current = createStickyDraftController(
      sticky.id,
      sticky.body,
    );
  }
  const draftController = draftControllerRef.current;
  const draftSessionRef = useRef<EditorStickyDraftSession | null>(
    editing ? { baseBody: sticky.body, baseVersion: sticky.version } : null,
  );
  // Capture the edit authority on entry. A sibling Surface may publish a
  // newer row while this editor is open, but that row must not rebase this
  // draft before its own save is attempted.
  if (editing && draftSessionRef.current === null) {
    draftSessionRef.current = {
      baseBody: sticky.body,
      baseVersion: sticky.version,
    };
    draftBaseVersionRef.current = sticky.version;
  }
  draftController.setPersist(async (body) => {
    const saved = await onBodySave(sticky, body, draftBaseVersionRef.current);
    draftBaseVersionRef.current = saved.version;
    draftSessionRef.current = {
      baseBody: saved.body,
      baseVersion: saved.version,
    };
  });
  const [draftBody, setDraftBody] = useState(sticky.body);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (!editing && !draftController.dirty) {
      draftController.latestBody = sticky.body;
      draftBaseVersionRef.current = sticky.version;
      draftSessionRef.current = null;
      setDraftBody(sticky.body);
    }
  }, [draftController, editing, sticky.body, sticky.version]);

  const commitBody = useCallback(async () => {
    if (!draftController.dirty) return;
    await draftController.save();
    setDirty(false);
    setDraftBody(draftController.latestBody);
  }, [draftController]);

  useQuiescentDraftParticipant({
    id: `editor-sticky:${sticky.id}`,
    enabled: dirty,
    isDirty: () => draftController.dirty,
    flush: commitBody,
    discard: () => {
      draftController.discard();
      setDirty(false);
      draftBaseVersionRef.current = sticky.version;
      draftSessionRef.current = editing
        ? { baseBody: sticky.body, baseVersion: sticky.version }
        : null;
      draftController.latestBody = sticky.body;
      setDraftBody(sticky.body);
    },
    recovery: () =>
      draftController.dirty
        ? {
            kind: "editor-sticky-draft",
            stickyId: sticky.id,
            documentKey: sticky.documentKey,
            body: draftController.latestBody,
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
        setGlueOrient((current) => {
          if (
            current === "left" &&
            measuredHeight >= STICKY_GLUE_TO_TOP_HEIGHT
          ) {
            return "top";
          }
          if (
            current === "top" &&
            measuredHeight <= STICKY_GLUE_TO_LEFT_HEIGHT
          ) {
            return "left";
          }
          return current;
        });
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [onMeasure, sticky.id]);

  useEffect(() => {
    if (!selected) return;
    const clearSelection = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (cardRef.current?.contains(target)) return;
      const element = target instanceof Element ? target : target.parentElement;
      const menu = element?.closest("[data-editor-sticky-menu]");
      if (menu?.getAttribute("data-editor-sticky-menu") === sticky.id) return;
      onSelect(null);
    };
    document.addEventListener("pointerdown", clearSelection, true);
    return () =>
      document.removeEventListener("pointerdown", clearSelection, true);
  }, [onSelect, selected, sticky.id]);

  const changeDraft = (body: string) => {
    // Keep the base version captured at edit entry. Re-reading sticky.version
    // here would turn a sibling's external update into a silent rebase.
    if (draftSessionRef.current === null) {
      draftSessionRef.current = {
        baseBody: sticky.body,
        baseVersion: sticky.version,
      };
      draftBaseVersionRef.current = sticky.version;
    }
    draftController.markDirty(body);
    setDraftBody(body);
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

  const handleDelete = useCallback(async () => {
    await commitBody();
    await onDelete(sticky);
  }, [commitBody, onDelete, sticky]);

  const finishDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (
      typeof event.currentTarget.hasPointerCapture === "function" &&
      event.currentTarget.hasPointerCapture(event.pointerId)
    ) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    onDragEnd(sticky.id);
  };

  const maskId = createEditorStickyMaskId(sticky.id, surfaceInstanceId);
  const clippedCoverage = projectCoverageToCard(coverage, {
    x: left,
    y: top,
    width,
    height,
  });
  const palette = getPalette(sticky.paletteId);
  const paperColor = resolveStickyHex(sticky.paletteId, sticky.colorSlot);
  const rotation = stickyRotation(sticky.id);
  const cardStyle: CSSProperties = {
    position: "absolute",
    left,
    top,
    width,
    minHeight,
    maxHeight,
    overflow: "visible",
    zIndex: sticky.zIndex + 1000,
    fontSize,
    writingMode: "horizontal-tb",
    textOrientation: "mixed",
    direction: "ltr",
    pointerEvents: "auto",
    borderRadius: 0,
    color: "rgba(0, 0, 0, 0.78)",
    boxShadow:
      glueOrient === "top" ? STICKY_TOP_OUTER_SHADOW : STICKY_LEFT_OUTER_SHADOW,
    outline: selected ? "2px solid #534AB7" : "none",
    outlineOffset: "2px",
    transform: `rotate(${rotation}deg)`,
    transformOrigin: `${width / 2}px ${height / 2}px`,
    cursor: editing ? "text" : "default",
    userSelect: editing ? "text" : "none",
    touchAction: editing ? "auto" : "none",
  };

  return (
    <ContextMenu
      onOpenChange={(open) => {
        if (open) onSelect(sticky.id);
      }}
    >
      <ContextMenuTrigger asChild>
        <div
          ref={cardRef}
          data-editor-sticky-card="true"
          data-editor-sticky-id={sticky.id}
          data-glue={glueOrient}
          className="editor-sticky-card"
          style={cardStyle}
          tabIndex={0}
          aria-label="Editor付箋"
          aria-selected={selected}
          onClick={(event) => {
            event.stopPropagation();
            onSelect(sticky.id);
          }}
          onDoubleClickCapture={(event) => {
            if (editing) return;
            event.preventDefault();
            event.stopPropagation();
            onEdit(sticky.id);
          }}
          onPointerDown={(event) => {
            if (event.button !== 0 || editing) return;
            event.stopPropagation();
            dragRef.current = {
              pointerId: event.pointerId,
              startX: event.clientX,
              startY: event.clientY,
            };
            if (typeof event.currentTarget.setPointerCapture === "function") {
              event.currentTarget.setPointerCapture(event.pointerId);
            }
            event.currentTarget.focus();
            onSelect(sticky.id);
            onDragStart(sticky.id);
          }}
          onPointerMove={(event) => {
            const drag = dragRef.current;
            if (!drag || drag.pointerId !== event.pointerId) return;
            event.preventDefault();
            event.stopPropagation();
            onDragMove(
              sticky.id,
              event.clientX - drag.startX,
              event.clientY - drag.startY,
            );
          }}
          onPointerUp={finishDrag}
          onPointerCancel={finishDrag}
          onContextMenu={(event) => {
            event.stopPropagation();
            onSelect(sticky.id);
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              if (editing) leaveEditing();
              else onSelect(null);
            } else if (event.key === "Delete" && !editing) {
              event.preventDefault();
              void handleDelete().catch(() =>
                toast.error("付箋を削除できませんでした"),
              );
            }
          }}
          onBlur={(event) => {
            if (!editing) return;
            const next = event.relatedTarget;
            if (next instanceof Node && event.currentTarget.contains(next))
              return;
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
            style={{ filter: "none" }}
          >
            <defs>
              <mask
                id={maskId}
                maskUnits="userSpaceOnUse"
                maskContentUnits="userSpaceOnUse"
                x="0"
                y="0"
                width={width}
                height={height}
              >
                <rect width={width} height={height} fill="white" />
                <g
                  data-testid="editor-sticky-mask-holes"
                  transform={`rotate(${-rotation} ${width / 2} ${height / 2})`}
                >
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
                </g>
              </mask>
            </defs>
            <rect
              width={width}
              height={height}
              fill={paperColor}
              fillOpacity="0.94"
              mask={`url(#${maskId})`}
            />
            <foreignObject
              data-testid="editor-sticky-paper-mask"
              width={width}
              height={height}
              mask={`url(#${maskId})`}
            >
              <StickyPaperVisual
                data-testid="editor-sticky-paper-visual"
                data-glue={glueOrient}
                paperColor={paperColor}
                style={{
                  width: "100%",
                  height: "100%",
                  boxShadow: STICKY_INSET_SHADOW,
                }}
              />
            </foreignObject>
          </svg>
          <div
            className="sticky-content editor-sticky-card__content"
            style={{ padding: "6px 10px 10px" }}
          >
            <div
              className="editor-sticky-card__body"
              style={{
                maxHeight: Math.max(maxHeight - 16, fontSize * 1.5),
                overflowY: "auto",
              }}
            >
              {editing ? (
                <StickyBodyEditor
                  body={draftBody}
                  onContentChange={changeDraft}
                  onEscape={leaveEditing}
                  style={{ fontSize, lineHeight: 1.5 }}
                  onPointerDown={(event) => event.stopPropagation()}
                />
              ) : (
                <StickyRichTextBody body={sticky.body} fontSize={fontSize} />
              )}
            </div>
          </div>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent
        className="min-w-[180px]"
        data-editor-sticky-menu={sticky.id}
      >
        <ContextMenuSub>
          <ContextMenuSubTrigger>
            {t("map.menu.changeColor")}
          </ContextMenuSubTrigger>
          <ContextMenuSubContent
            className="min-w-[160px]"
            data-editor-sticky-menu={sticky.id}
          >
            {palette.colors.map((color, slot) => (
              <ContextMenuItem
                key={slot}
                onSelect={() => {
                  void setEditorStickyColor(sticky, palette.id, slot).catch(
                    () => toast.error("付箋の色を変更できませんでした"),
                  );
                }}
              >
                <span
                  aria-hidden
                  style={{
                    width: 12,
                    height: 12,
                    borderRadius: "50%",
                    border: "1.5px solid rgba(0,0,0,0.2)",
                    background: color.hex,
                    flexShrink: 0,
                    marginRight: 8,
                  }}
                />
                <span>{color.label}</span>
              </ContextMenuItem>
            ))}
          </ContextMenuSubContent>
        </ContextMenuSub>
        <ContextMenuSeparator />
        <ContextMenuItem
          onSelect={() => {
            void onBringToFront(sticky).catch(() =>
              toast.error("付箋を前面へ移動できませんでした"),
            );
          }}
        >
          {t("map.menu.bringToFront")}
        </ContextMenuItem>
        <ContextMenuItem
          onSelect={() => {
            void onSendToBack(sticky).catch(() =>
              toast.error("付箋を背面へ移動できませんでした"),
            );
          }}
        >
          {t("map.menu.sendToBack")}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          className="text-destructive focus:text-destructive"
          onSelect={() => {
            void handleDelete().catch(() =>
              toast.error("付箋を削除できませんでした"),
            );
          }}
        >
          {t("common.delete")}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
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
