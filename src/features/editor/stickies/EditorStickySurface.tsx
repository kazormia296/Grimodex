import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useSyncExternalStore,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import type { Editor } from "@tiptap/core";
import { toast } from "sonner";
import { useGlobalHistoryStore } from "@/store/globalHistoryStore";
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
import { getStickyMetrics } from "@/features/sticky/stickyMetrics";
import {
  getCurrentWorkspaceIdentity,
  subscribeCurrentWorkspaceIdentity,
} from "@/runtime/workspaceIdentity";
import {
  ensureEditorStickySurfaceSize,
  measureEditorStickySurface,
  type EditorStickySurfaceSize,
} from "./editorStickySurfaceGeometry";

const EMPTY_STICKIES: EditorSticky[] = [];
const DEFAULT_HEIGHT = 520;

function getStickyWorkspaceAuthorityKey(): string | null {
  const identity = getCurrentWorkspaceIdentity();
  return identity ? `${identity.path}\u0000${identity.openRevision}` : null;
}

function getUnboundWorkspaceAuthorityKey(): null {
  return null;
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
  visible?: boolean;
  children: ReactNode;
}

function useSurfaceSize(
  surfaceRef: React.RefObject<HTMLDivElement | null>,
  enabled: boolean,
  layoutKey: string,
) {
  const [size, setSize] = useState<EditorStickySurfaceSize>({
    width: 0,
    height: 0,
  });

  useLayoutEffect(() => {
    const surface = surfaceRef.current;
    if (!enabled || !surface) {
      setSize({ width: 0, height: 0 });
      return;
    }
    let frame = 0;
    const measure = () => {
      frame = 0;
      setSize(measureEditorStickySurface(surface));
    };
    const scheduleMeasure = () => {
      if (frame) return;
      if (typeof window.requestAnimationFrame === "function") {
        frame = window.requestAnimationFrame(measure);
      } else {
        measure();
      }
    };
    measure();
    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(scheduleMeasure);
    resizeObserver?.observe(surface);
    const mutationObserver =
      typeof MutationObserver === "undefined"
        ? null
        : new MutationObserver(scheduleMeasure);
    mutationObserver?.observe(surface, {
      subtree: true,
      childList: true,
      characterData: true,
    });
    return () => {
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [enabled, layoutKey, surfaceRef]);

  return size;
}

export function EditorStickySurface({
  editor,
  documentKey,
  projectId,
  fontSize,
  verticalMode,
  visible = true,
  children,
}: EditorStickySurfaceProps) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);
  const stickyMetrics = useMemo(() => getStickyMetrics(fontSize), [fontSize]);
  const {
    width: stickyWidth,
    minHeight: stickyMinHeight,
    maxHeight: stickyMaxHeight,
  } = stickyMetrics;
  const currentProjectId = useCurrentProjectId();
  const resolvedProjectId = projectId ?? currentProjectId;
  const workspaceAuthorityKey = useSyncExternalStore(
    subscribeCurrentWorkspaceIdentity,
    getStickyWorkspaceAuthorityKey,
    getUnboundWorkspaceAuthorityKey,
  );
  const stickies = useEditorStickyStore((state) => {
    if (!resolvedProjectId || !documentKey) return EMPTY_STICKIES;
    return state.getForDocument(resolvedProjectId, documentKey);
  });
  const coverageEnabled = visible && stickies.length > 0;
  const surfaceSize = useSurfaceSize(
    surfaceRef,
    coverageEnabled,
    `${workspaceAuthorityKey ?? "unbound"}:${fontSize}:${verticalMode ? "vertical" : "horizontal"}`,
  );
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
    coverageEnabled,
  );

  useEffect(() => {
    if (!coverageEnabled) return;
    requestMeasure();
  }, [coverageEnabled, fontSize, requestMeasure, verticalMode]);

  useEffect(() => {
    if (!resolvedProjectId || !documentKey || !workspaceAuthorityKey) return;
    void loadEditorStickies(resolvedProjectId, documentKey).catch(() => {
      toast.error("付箋を読み込めませんでした");
    });
  }, [documentKey, resolvedProjectId, workspaceAuthorityKey]);

  const effectiveSurfaceSize = ensureEditorStickySurfaceSize(
    surfaceSize,
    stickyWidth + 48,
    DEFAULT_HEIGHT,
  );

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
      const surface = surfaceRef.current;
      if (!resolvedProjectId || !documentKey || !surface) return;
      const rect = surface.getBoundingClientRect();
      const placementSurfaceSize = ensureEditorStickySurfaceSize(
        measureEditorStickySurface(surface),
        stickyWidth + 48,
        DEFAULT_HEIGHT,
      );
      const position = clampStickyPosition(
        {
          left: clientX - rect.left - stickyWidth / 2,
          top: clientY - rect.top - stickyMinHeight / 2,
        },
        {
          surfaceWidth: placementSurfaceSize.width,
          surfaceHeight: placementSurfaceSize.height,
          stickyWidth,
          stickyHeight: stickyMinHeight,
        },
      );
      const logical = physicalToLogicalPosition(position, {
        verticalMode,
        surfaceWidth: placementSurfaceSize.width,
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
    async (
      sticky: EditorSticky,
      patch: EditorStickyPatch,
      baseVersion?: number,
    ) => {
      if (!documentKey || !resolvedProjectId) {
        throw new Error("Editor sticky document is not active");
      }
      return useEditorStickyStore
        .getState()
        .update(sticky.id, resolvedProjectId, documentKey, patch, baseVersion);
    },
    [documentKey, resolvedProjectId],
  );

  const handleBodySave = useCallback(
    (sticky: EditorSticky, body: string, baseVersion: number) => {
      return updateSticky(sticky, { body }, baseVersion);
    },
    [updateSticky],
  );

  const handleDelete = useCallback(
    async (sticky: EditorSticky) => {
      if (!documentKey || !resolvedProjectId) return;
      const projectId = resolvedProjectId;
      const document = documentKey;
      const deleted = await useEditorStickyStore
        .getState()
        .remove(sticky.id, projectId, document, sticky.version);
      setSelectedId((current) => (current === sticky.id ? null : current));
      setEditingId((current) => (current === sticky.id ? null : current));

      if (useGlobalHistoryStore.getState().isReplaying) return;
      const snapshot = { ...deleted, documentKey: document };
      useGlobalHistoryStore.getState().push({
        kind: "editor",
        label: "Editor付箋を削除",
        entityId: sticky.id,
        documentKey: document,
        async undo() {
          const restored = await useEditorStickyStore
            .getState()
            .create(projectId, document, {
              id: snapshot.id,
              body: snapshot.body,
              paletteId: snapshot.paletteId,
              colorSlot: snapshot.colorSlot,
              inlineOffset: snapshot.inlineOffset,
              blockOffset: snapshot.blockOffset,
              zIndex: snapshot.zIndex,
            });
          setSelectedId(restored.id);
          setEditingId(null);
        },
        async redo() {
          const current = useEditorStickyStore
            .getState()
            .getForDocument(projectId, document)
            .find((item) => item.id === snapshot.id);
          if (!current) return;
          await useEditorStickyStore
            .getState()
            .remove(current.id, projectId, document, current.version);
          setSelectedId((currentId) =>
            currentId === snapshot.id ? null : currentId,
          );
          setEditingId((currentId) =>
            currentId === snapshot.id ? null : currentId,
          );
        },
      });
    },
    [documentKey, resolvedProjectId],
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
      {visible && (
        <div
          className="editor-sticky-overlay"
          role="group"
          aria-label="Editor付箋"
        >
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
                  minHeight={stickyMinHeight}
                  maxHeight={stickyMaxHeight}
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
                    setEditingId((current) =>
                      current === id ? null : current,
                    );
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
      )}
    </div>
  );
}
