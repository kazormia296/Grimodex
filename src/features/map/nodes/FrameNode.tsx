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

  const commitTitle = useCallback(() => {
    setEditingTitle(false);
    const trimmed = titleValue.trim() || d.title;
    setTitleValue(trimmed);
    d.onTitleChange?.(trimmed);
  }, [titleValue, d]);

  return (
    <>
      <NodeResizer
        isVisible={!!selected}
        minWidth={160}
        minHeight={120}
        color={d.borderColor}
      />
      <div
        style={{
          width: "100%",
          height: "100%",
          border: `2px solid ${selected ? "#534AB7" : d.borderColor}`,
          borderRadius: 8,
          background: d.background,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          pointerEvents: "none",
        }}
      >
        {/* Frame header — drag target */}
        <div
          className="frame-drag-handle"
          style={{
            padding: "4px 10px",
            background: d.borderColor + "44",
            borderBottom: `1px solid ${d.borderColor}`,
            display: "flex",
            alignItems: "center",
            gap: 6,
            cursor: "grab",
            pointerEvents: "all",
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
              }}
            />
          ) : (
            <span
              style={{
                fontSize: 12,
                fontWeight: 600,
                color: "var(--foreground)",
                userSelect: "none",
              }}
            >
              {d.title}
            </span>
          )}
        </div>

        {/* Frame body */}
        <div style={{ flex: 1 }} />
      </div>
    </>
  );
});
