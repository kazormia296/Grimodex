import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import type { Editor } from "@tiptap/core";
import { toast } from "sonner";
import { useCurrentProjectId } from "@/features/project/projectStore";
import {
  clampStickyPosition,
  logicalToPhysicalPosition,
  physicalToLogicalPosition,
  type StickyPhysicalPosition,
} from "./editorStickyPlacement";
import { loadEditorStickies, useEditorStickyStore } from "./editorStickyStore";
import type { EditorSticky, EditorStickyPatch } from "./editorStickyTypes";
import { registerEditorStickySurface } from "./editorStickySurfaceRegistry";
import { EditorStickyCard, nextStickyColor } from "./EditorStickyCard";
import { useEditorTextCoverage } from "./useEditorTextCoverage";
import { type DocumentKey } from "@/features/editor/document/documentKey";

const EMPTY_STICKIES: EditorSticky[] = [];
const DEFAULT_HEIGHT = 520;

interface SurfaceSize {
  width: number;
  height: number;
}

interface CardSize {
  width: number;
  height: number;
}

export interface EditorStickySurfaceProps {
  editor: Editor | null;
  documentKey: DocumentKey | null;
  projectId?: string | null;
  fontSize: number;
  verticalMode: boolean;
  children: ReactNode;
}

function useSurfaceSize(surfaceRef: React.RefObject<HTMLDivElement | null>) {
  const [size, setSize] = useState<SurfaceSize>({ width: 0, height: 0 });

  useLayoutEffect(() => {
    const surface = surfaceRef.current;
    if (!surface) return;
    const measure = () => {
      const rect = surface.getBoundingClientRect();
      setSize({
        width: Math.max(1, surface.clientWidth, rect.width),
        height: Math.max(
          1,
          surface.clientHeight,
          surface.scrollHeight,
          rect.height,
        ),
      });
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(surface);
    return () => observer.disconnect();
  }, [surfaceRef]);

  return size;
}

export function EditorStickySurface({
  editor,
  documentKey,
  projectId,
  fontSize,
  verticalMode,
  children,
}: EditorStickySurfaceProps) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);
  const surfaceSize = useSurfaceSize(surfaceRef);
  const stickyWidth = Math.max(fontSize * 12.5, 160);
  const stickyMinHeight = Math.max(fontSize * 3.25, 52);
  const currentProjectId = useCurrentProjectId();
  const resolvedProjectId = projectId ?? currentProjectId;
  const stickies = useEditorStickyStore((state) => {
    if (!resolvedProjectId || !documentKey) return EMPTY_STICKIES;
    return state.getForDocument(resolvedProjectId, documentKey);
  });
  const cardSizesRef = useRef<Record<string, CardSize>>({});
  const [cardSizes, setCardSizes] = useState<Record<string, CardSize>>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [dragPositions, setDragPositions] = useState<
    Record<string, StickyPhysicalPosition>
  >({});
  const dragBasesRef = useRef<Record<string, StickyPhysicalPosition>>({});
  const dragPreviewsRef = useRef<Record<string, StickyPhysicalPosition>>({});
  const { coverage, requestMeasure } = useEditorTextCoverage(
    editor,
    surfaceRef,
    draggingRef,
  );

  useEffect(() => {
    requestMeasure();
  }, [fontSize, requestMeasure, verticalMode]);

  useEffect(() => {
    if (!resolvedProjectId || !documentKey) return;
    void loadEditorStickies(resolvedProjectId, documentKey).catch(() => {
      toast.error("付箋を読み込めませんでした");
    });
  }, [documentKey, resolvedProjectId]);

  const effectiveSurfaceSize = {
    width: Math.max(surfaceSize.width, stickyWidth + 48),
    height: Math.max(surfaceSize.height, DEFAULT_HEIGHT),
  };

  const positionForSticky = useCallback(
    (sticky: EditorSticky): StickyPhysicalPosition => {
      const size = cardSizes[sticky.id];
      const raw = logicalToPhysicalPosition(
        {
          inlineOffset: sticky.inlineOffset,
          blockOffset: sticky.blockOffset,
        },
        {
          verticalMode,
          surfaceWidth: effectiveSurfaceSize.width,
          stickyWidth,
        },
      );
      return clampStickyPosition(raw, {
        surfaceWidth: effectiveSurfaceSize.width,
        surfaceHeight: effectiveSurfaceSize.height,
        stickyWidth,
        stickyHeight: Math.max(
          size?.height ?? stickyMinHeight,
          stickyMinHeight,
        ),
      });
    },
    [
      cardSizes,
      effectiveSurfaceSize.height,
      effectiveSurfaceSize.width,
      stickyMinHeight,
      stickyWidth,
      verticalMode,
    ],
  );

  const positions = useMemo(() => {
    const result: Record<string, StickyPhysicalPosition> = {};
    for (const sticky of stickies)
      result[sticky.id] = positionForSticky(sticky);
    return result;
  }, [positionForSticky, stickies]);

  const addAtClientPoint = useCallback(
    (clientX: number, clientY: number) => {
      if (!resolvedProjectId || !documentKey || !surfaceRef.current) return;
      const rect = surfaceRef.current.getBoundingClientRect();
      const position = clampStickyPosition(
        {
          left: clientX - rect.left - stickyWidth / 2,
          top: clientY - rect.top - stickyMinHeight / 2,
        },
        {
          surfaceWidth: effectiveSurfaceSize.width,
          surfaceHeight: effectiveSurfaceSize.height,
          stickyWidth,
          stickyHeight: stickyMinHeight,
        },
      );
      const logical = physicalToLogicalPosition(position, {
        verticalMode,
        surfaceWidth: effectiveSurfaceSize.width,
        stickyWidth,
      });
      void useEditorStickyStore
        .getState()
        .create(resolvedProjectId, documentKey, logical)
        .then((created) => {
          setSelectedId(created.id);
          setEditingId(created.id);
        })
        .catch(() => toast.error("付箋を追加できませんでした"));
    },
    [
      documentKey,
      effectiveSurfaceSize.height,
      effectiveSurfaceSize.width,
      resolvedProjectId,
      stickyMinHeight,
      stickyWidth,
      verticalMode,
    ],
  );

  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface) return;
    return registerEditorStickySurface(surface, { addAtClientPoint });
  }, [addAtClientPoint]);

  const updateSticky = useCallback(
    async (sticky: EditorSticky, patch: EditorStickyPatch) => {
      if (!documentKey || !resolvedProjectId) return;
      await useEditorStickyStore
        .getState()
        .update(sticky.id, resolvedProjectId, documentKey, patch);
    },
    [documentKey, resolvedProjectId],
  );

  const handleBodySave = useCallback(
    async (sticky: EditorSticky, body: string) => {
      await updateSticky(sticky, { body });
    },
    [updateSticky],
  );

  const handleDelete = useCallback(
    async (sticky: EditorSticky) => {
      if (!documentKey) return;
      await useEditorStickyStore
        .getState()
        .remove(sticky.id, sticky.projectId, documentKey, sticky.version);
      setSelectedId((current) => (current === sticky.id ? null : current));
      setEditingId((current) => (current === sticky.id ? null : current));
    },
    [documentKey],
  );

  const handleColorChange = useCallback(
    async (sticky: EditorSticky) => {
      await updateSticky(sticky, nextStickyColor(sticky));
    },
    [updateSticky],
  );

  const handleBringToFront = useCallback(
    async (sticky: EditorSticky) => {
      const max = stickies.reduce(
        (value, item) => Math.max(value, item.zIndex),
        0,
      );
      await updateSticky(sticky, { zIndex: max + 1 });
    },
    [stickies, updateSticky],
  );

  const handleSendToBack = useCallback(
    async (sticky: EditorSticky) => {
      const min = stickies.reduce(
        (value, item) => Math.min(value, item.zIndex),
        0,
      );
      await updateSticky(sticky, { zIndex: min - 1 });
    },
    [stickies, updateSticky],
  );

  const handleDragStart = useCallback(
    (stickyId: string) => {
      const position = positions[stickyId];
      if (!position) return;
      draggingRef.current = true;
      dragBasesRef.current[stickyId] = position;
      setSelectedId(stickyId);
    },
    [positions],
  );

  const handleDragMove = useCallback(
    (stickyId: string, deltaX: number, deltaY: number) => {
      const base = dragBasesRef.current[stickyId];
      if (!base) return;
      const size = cardSizes[stickyId];
      const next = clampStickyPosition(
        { left: base.left + deltaX, top: base.top + deltaY },
        {
          surfaceWidth: effectiveSurfaceSize.width,
          surfaceHeight: effectiveSurfaceSize.height,
          stickyWidth,
          stickyHeight: size?.height ?? stickyMinHeight,
        },
      );
      dragPreviewsRef.current[stickyId] = next;
      setDragPositions((current) => ({ ...current, [stickyId]: next }));
    },
    [
      cardSizes,
      effectiveSurfaceSize.height,
      effectiveSurfaceSize.width,
      stickyMinHeight,
      stickyWidth,
    ],
  );

  const handleDragEnd = useCallback(
    (stickyId: string) => {
      const sticky = stickies.find((item) => item.id === stickyId);
      const base = dragBasesRef.current[stickyId];
      const preview = dragPreviewsRef.current[stickyId];
      delete dragBasesRef.current[stickyId];
      delete dragPreviewsRef.current[stickyId];
      setDragPositions((current) => {
        const next = { ...current };
        delete next[stickyId];
        return next;
      });
      draggingRef.current = false;
      requestMeasure();
      if (!sticky || !base || !preview || !documentKey || !resolvedProjectId)
        return;
      const logical = physicalToLogicalPosition(preview, {
        verticalMode,
        surfaceWidth: effectiveSurfaceSize.width,
        stickyWidth,
      });
      void useEditorStickyStore
        .getState()
        .update(sticky.id, resolvedProjectId, documentKey, logical)
        .catch(() => toast.error("付箋の位置を保存できませんでした"));
    },
    [
      documentKey,
      effectiveSurfaceSize.width,
      requestMeasure,
      resolvedProjectId,
      stickies,
      stickyWidth,
      verticalMode,
    ],
  );

  const handleMeasure = useCallback(
    (stickyId: string, width: number, height: number) => {
      const next = { width, height };
      const previous = cardSizesRef.current[stickyId];
      if (previous?.width === width && previous.height === height) return;
      cardSizesRef.current[stickyId] = next;
      setCardSizes((current) => ({ ...current, [stickyId]: next }));
    },
    [],
  );

  const surfaceStyle: CSSProperties = {
    position: "relative",
    minHeight: "100%",
  };

  return (
    <div
      ref={surfaceRef}
      data-editor-sticky-surface="true"
      className="editor-sticky-surface"
      style={surfaceStyle}
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) setSelectedId(null);
      }}
    >
      {children}
      <div className="editor-sticky-overlay" aria-label="Editor付箋">
        {[...stickies]
          .sort((left, right) => left.zIndex - right.zIndex)
          .map((sticky) => {
            const position = dragPositions[sticky.id] ?? positions[sticky.id];
            if (!position) return null;
            const size = cardSizes[sticky.id];
            return (
              <EditorStickyCard
                key={sticky.id}
                sticky={sticky}
                left={position.left}
                top={position.top}
                width={size?.width ?? stickyWidth}
                minHeight={Math.max(size?.height ?? 0, stickyMinHeight)}
                height={Math.max(size?.height ?? 0, stickyMinHeight)}
                fontSize={fontSize}
                coverage={coverage}
                selected={selectedId === sticky.id}
                editing={editingId === sticky.id}
                onSelect={setSelectedId}
                onEdit={(id) => {
                  setSelectedId(id);
                  setEditingId(id);
                }}
                onStopEditing={(id) => {
                  setEditingId((current) => (current === id ? null : current));
                }}
                onBodySave={handleBodySave}
                onDelete={handleDelete}
                onColorChange={handleColorChange}
                onBringToFront={handleBringToFront}
                onSendToBack={handleSendToBack}
                onDragStart={handleDragStart}
                onDragMove={handleDragMove}
                onDragEnd={handleDragEnd}
                onMeasure={handleMeasure}
              />
            );
          })}
      </div>
    </div>
  );
}
