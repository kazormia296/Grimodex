import { memo, useCallback, useRef, useState } from "react";
import { NodeResizer } from "@xyflow/react";
import type { NodeProps } from "@xyflow/react";

export interface FrameNodeData {
  title: string;
  background: string;
  borderColor: string;
  onTitleChange?: (title: string) => void;
  onDelete?: () => void;
  [key: string]: unknown;
}

export const FrameNode = memo(function FrameNode({
  data,
  selected,
}: NodeProps) {
  const d = data as FrameNodeData;
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleValue, setTitleValue] = useState(d.title);
  const inputRef = useRef<HTMLInputElement>(null);
  const cancelledRef = useRef(false);

  const commitTitle = useCallback(() => {
    setEditingTitle(false);
    if (cancelledRef.current) {
      cancelledRef.current = false;
      return;
    }
    const trimmed = titleValue.trim() || d.title;
    setTitleValue(trimmed);
    d.onTitleChange?.(trimmed);
  }, [titleValue, d]);

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
          setEditingTitle(true);
          setTimeout(() => inputRef.current?.focus(), 0);
        }}
      >
        {editingTitle ? (
          <input
            ref={inputRef}
            value={titleValue}
            onChange={(e) => setTitleValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commitTitle();
              }
              if (e.key === "Escape") {
                e.preventDefault();
                cancelledRef.current = true;
                setTitleValue(d.title);
                setEditingTitle(false);
              }
            }}
            onBlur={commitTitle}
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
