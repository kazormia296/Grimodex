import { memo, useCallback, useEffect, useRef, useState } from "react";
import { NodeResizer } from "@xyflow/react";
import type { NodeProps } from "@xyflow/react";
import { useQuiescentDraftParticipant } from "@/application/lifecycle/useQuiescentDraftParticipant";
import {
  useLatestValueDraftController,
  type LatestValueDraftPersistContext,
} from "@/application/lifecycle/latestValueDraftController";
import type { QuiescenceParticipantFlushOptions } from "@/application/lifecycle/quiescenceParticipants";

export interface FrameNodeData {
  title: string;
  background: string;
  borderColor: string;
  onTitleChange?: (
    title: string,
    context?: LatestValueDraftPersistContext,
  ) => void | Promise<void>;
  onDelete?: () => void;
  [key: string]: unknown;
}

export const FrameNode = memo(function FrameNode({
  id,
  data,
  selected,
}: NodeProps) {
  const d = data as FrameNodeData;
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleValue, setTitleValue] = useState(d.title);
  const inputRef = useRef<HTMLInputElement>(null);
  const editingTitleRef = useRef(false);
  const mountedRef = useRef(true);
  const titleController = useLatestValueDraftController(
    `map-frame-title:${id}`,
    d.title,
    async (next, context) => {
      const trimmed = next.trim() || d.title;
      if (trimmed !== d.title) {
        if (context.preexistingDraft) {
          await d.onTitleChange?.(trimmed, context);
        } else {
          await d.onTitleChange?.(trimmed);
        }
      }
    },
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (editingTitleRef.current) return;
    titleController.reset(d.title);
    setTitleValue(d.title);
  }, [d.title, titleController]);

  const commitTitle = useCallback(
    async (options?: QuiescenceParticipantFlushOptions): Promise<void> => {
      if (!editingTitleRef.current) return Promise.resolve();
      const trimmed = titleController.latestValue.trim();
      if (!trimmed) {
        titleController.reset(d.title);
      } else {
        await titleController.save(options);
      }
      editingTitleRef.current = false;
      if (mountedRef.current) {
        setTitleValue(titleController.latestValue.trim() || d.title);
        setEditingTitle(false);
      }
    },
    [d.title, titleController],
  );

  const cancelTitle = useCallback(() => {
    editingTitleRef.current = false;
    titleController.reset(d.title);
    if (mountedRef.current) {
      setTitleValue(d.title);
      setEditingTitle(false);
    }
  }, [d.title, titleController]);

  useQuiescentDraftParticipant({
    id: `map-frame-title:${id}`,
    enabled: editingTitle,
    isDirty: () => editingTitleRef.current && titleController.dirty,
    flush: commitTitle,
    discard: cancelTitle,
    recovery: () =>
      editingTitleRef.current
        ? {
            kind: "map-frame-title",
            frameNodeId: id,
            title: titleController.latestValue,
          }
        : null,
  });

  const edgeZoneStyle = {
    position: "absolute" as const,
    cursor: "grab",
    pointerEvents: "all" as const,
  };

  return (
    <>
      {/* Visual frame border (click-through) */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          border: `2px dashed ${selected ? "#534AB7" : d.borderColor}`,
          borderRadius: 8,
          background: "transparent",
          pointerEvents: "none",
        }}
      />

      {selected ? (
        /* Selected: entire interior is a drag zone */
        <div
          className="frame-drag-handle"
          style={{
            position: "absolute",
            inset: 0,
            cursor: "grab",
            pointerEvents: "all",
          }}
        />
      ) : (
        /* Unselected: only the 4 edges are draggable, interior is click-through.
           Corners (20px) are left free so clicking near them doesn't trap drag. */
        <>
          <div
            className="frame-drag-handle"
            style={{
              ...edgeZoneStyle,
              top: -6,
              left: 20,
              right: 20,
              height: 16,
            }}
          />
          <div
            className="frame-drag-handle"
            style={{
              ...edgeZoneStyle,
              bottom: -6,
              left: 20,
              right: 20,
              height: 16,
            }}
          />
          <div
            className="frame-drag-handle"
            style={{
              ...edgeZoneStyle,
              left: -6,
              top: 20,
              bottom: 20,
              width: 16,
            }}
          />
          <div
            className="frame-drag-handle"
            style={{
              ...edgeZoneStyle,
              right: -6,
              top: 20,
              bottom: 20,
              width: 16,
            }}
          />
        </>
      )}

      {/* Title as a floating tab at the top edge */}
      <div
        className="frame-drag-handle"
        style={{
          position: "absolute",
          top: -10,
          left: 24,
          maxWidth: "calc(100% - 48px)",
          background: "var(--background)",
          padding: "1px 6px",
          display: "flex",
          alignItems: "center",
          gap: 6,
          cursor: "grab",
          pointerEvents: "all",
          zIndex: 10,
        }}
        onDoubleClick={(e) => {
          e.stopPropagation();
          if (editingTitleRef.current) return;
          editingTitleRef.current = true;
          titleController.reset(d.title);
          setTitleValue(d.title);
          setEditingTitle(true);
          setTimeout(() => inputRef.current?.focus(), 0);
        }}
      >
        {editingTitle ? (
          <input
            ref={inputRef}
            value={titleValue}
            onChange={(e) => {
              titleController.markDirty(
                e.target.value.trim() ? e.target.value : d.title,
              );
              setTitleValue(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return;
              if (e.key === "Enter") {
                e.preventDefault();
                void commitTitle().catch(() => {});
              }
              if (e.key === "Escape") {
                e.preventDefault();
                cancelTitle();
              }
            }}
            onBlur={() => void commitTitle().catch(() => {})}
            onPointerDown={(e) => e.stopPropagation()}
            style={{
              border: "none",
              outline: "1px solid var(--border)",
              background: "var(--background)",
              borderRadius: 3,
              padding: "1px 4px",
              fontSize: 12,
              fontWeight: 600,
              color: "var(--foreground)",
              width: "100%",
              minWidth: 80,
            }}
          />
        ) : (
          <span
            style={{
              fontSize: 12,
              fontWeight: 600,
              color: "var(--foreground)",
              userSelect: "none",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {d.title}
          </span>
        )}
      </div>

      {/* NodeResizer rendered last so its resize handles stack above the drag zone */}
      <NodeResizer
        isVisible={!!selected}
        minWidth={160}
        minHeight={120}
        color="#534AB7"
      />
    </>
  );
});
