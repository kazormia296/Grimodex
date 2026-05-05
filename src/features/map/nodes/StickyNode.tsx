import { memo, useState, useRef, useCallback, useEffect } from "react";
import { Handle, Position } from "@xyflow/react";
import type { NodeProps } from "@xyflow/react";
import { useEditor, EditorContent } from "@tiptap/react";
import { getStickyEditorExtensions } from "@/features/editor/extensions";
import {
  updateSticky,
  extractPreviewText,
  pendingAutoFocusIds,
} from "../mapApi";
import type { StickyColor } from "../types";

export interface StickyNodeData {
  id: string;
  title: string;
  body: string;
  previewText: string;
  color: StickyColor;
  useTipTap: boolean;
  colorBy?: string;
  onUpdate?: (updates: {
    title?: string;
    body?: string;
    previewText?: string;
    color?: StickyColor;
  }) => Promise<void>;
  [key: string]: unknown;
}

const STICKY_BG: Record<StickyColor, string> = {
  yellow: "#FEF9C3",
  orange: "#FED7AA",
  pink: "#FCE7F3",
  green: "#DCFCE7",
  blue: "#DBEAFE",
  purple: "#EDE9FE",
  gray: "#F3F4F6",
  white: "#FFFFFF",
};

const STICKY_BORDER: Record<StickyColor, string> = {
  yellow: "#CA8A04",
  orange: "#EA580C",
  pink: "#DB2777",
  green: "#16A34A",
  blue: "#2563EB",
  purple: "#7C3AED",
  gray: "#6B7280",
  white: "#D1D5DB",
};

const COLOR_KEYS: StickyColor[] = [
  "yellow",
  "orange",
  "pink",
  "green",
  "blue",
  "purple",
  "gray",
  "white",
];

function parseBodyContent(body: string): object | undefined {
  if (!body) return undefined;
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

interface StickyBodyEditorProps {
  body: string;
  onContentChange: (json: string) => void;
  onEscape: () => void;
}

function StickyBodyEditor({
  body,
  onContentChange,
  onEscape,
}: StickyBodyEditorProps) {
  const editor = useEditor({
    extensions: getStickyEditorExtensions(),
    content: parseBodyContent(body),
    onUpdate({ editor: ed }) {
      onContentChange(JSON.stringify(ed.getJSON()));
    },
  });

  useEffect(() => {
    if (editor) {
      setTimeout(() => editor.commands.focus("end"), 0);
    }
  }, [editor]);

  if (!editor) return null;

  return (
    <div
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          onEscape();
        }
      }}
      style={{ fontSize: 12, lineHeight: 1.5 }}
      className="sticky-editor"
    >
      <EditorContent editor={editor} />
    </div>
  );
}

export const StickyNode = memo(function StickyNode({
  data,
  selected,
}: NodeProps) {
  const d = data as StickyNodeData;

  const [editing, setEditing] = useState(false);
  const [localTitle, setLocalTitle] = useState(d.title);
  const [localColor, setLocalColor] = useState<StickyColor>(d.color);
  const [showColorPicker, setShowColorPicker] = useState(false);
  const latestBodyRef = useRef<string>(d.body);
  const titleRef = useRef<string>(d.title);

  // Sync from parent when not editing
  useEffect(() => {
    if (!editing) {
      setLocalTitle(d.title);
      latestBodyRef.current = d.body;
    }
  }, [d.title, d.body, editing]);

  useEffect(() => {
    setLocalColor(d.color);
  }, [d.color]);

  // Auto-enter edit mode for newly created stickies (branch / add)
  useEffect(() => {
    if (pendingAutoFocusIds.has(d.id)) {
      pendingAutoFocusIds.delete(d.id);
      if (d.useTipTap) setEditing(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const bg = STICKY_BG[localColor] ?? STICKY_BG.yellow;
  const borderColor =
    d.colorBy === "status"
      ? "var(--border)"
      : (STICKY_BORDER[localColor] ?? STICKY_BORDER.yellow);

  const save = useCallback(async () => {
    const json = latestBodyRef.current;
    const preview = extractPreviewText(json);
    const title = titleRef.current;
    await (d.onUpdate?.({ title, body: json, previewText: preview }) ??
      updateSticky(d.id, { title, body: json, previewText: preview }));
  }, [d]);

  const exitEditing = useCallback(async () => {
    setEditing(false);
    await save();
  }, [save]);

  const handleColorChange = useCallback(
    async (color: StickyColor) => {
      setLocalColor(color);
      setShowColorPicker(false);
      await (d.onUpdate?.({ color }) ?? updateSticky(d.id, { color }));
    },
    [d],
  );

  const handleTitleChange = useCallback((val: string) => {
    setLocalTitle(val);
    titleRef.current = val;
  }, []);

  return (
    <div style={{ position: "relative" }}>
      <Handle type="target" position={Position.Left} className="map-handle" />

      <div
        style={{
          width: 240,
          minHeight: 80,
          maxHeight: editing ? 600 : 300,
          overflow: editing ? "auto" : "hidden",
          background: bg,
          border: `2px solid ${selected ? "#534AB7" : borderColor}`,
          borderRadius: 6,
          padding: "6px 10px 10px",
          boxShadow: selected
            ? "0 0 0 2px rgba(83,74,183,0.3)"
            : "0 1px 4px rgba(0,0,0,0.12)",
          cursor: editing ? "text" : "default",
          userSelect: editing ? "text" : "none",
        }}
        onDoubleClick={(e) => {
          if (!editing && d.useTipTap) {
            e.stopPropagation();
            setEditing(true);
          }
        }}
      >
        {/* Header row: title + color button */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 4,
            marginBottom: 4,
          }}
        >
          <input
            value={localTitle}
            placeholder="タイトル"
            onChange={(e) => handleTitleChange(e.target.value)}
            onPointerDown={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                exitEditing();
              }
            }}
            style={{
              flex: 1,
              border: "none",
              outline: "none",
              background: "transparent",
              fontSize: 12,
              fontWeight: 600,
              color: "rgba(0,0,0,0.75)",
              padding: 0,
              cursor: "text",
              minWidth: 0,
            }}
          />
          {/* Color picker toggle */}
          <button
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              setShowColorPicker((v) => !v);
            }}
            style={{
              width: 16,
              height: 16,
              borderRadius: "50%",
              border: "1.5px solid rgba(0,0,0,0.2)",
              background: bg,
              cursor: "pointer",
              flexShrink: 0,
              padding: 0,
            }}
            title="色を変更"
          />
        </div>

        {/* Color palette */}
        {showColorPicker && (
          <div
            onPointerDown={(e) => e.stopPropagation()}
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: 4,
              marginBottom: 6,
              padding: "4px 0",
              borderBottom: "1px solid rgba(0,0,0,0.08)",
            }}
          >
            {COLOR_KEYS.map((c) => (
              <button
                key={c}
                onClick={() => handleColorChange(c)}
                style={{
                  width: 20,
                  height: 20,
                  borderRadius: "50%",
                  border:
                    c === localColor
                      ? "2px solid #534AB7"
                      : `1.5px solid ${STICKY_BORDER[c]}`,
                  background: STICKY_BG[c],
                  cursor: "pointer",
                  padding: 0,
                }}
                title={c}
              />
            ))}
          </div>
        )}

        {/* Body */}
        {editing && d.useTipTap ? (
          <StickyBodyEditor
            body={d.body}
            onContentChange={(json) => {
              latestBodyRef.current = json;
            }}
            onEscape={exitEditing}
          />
        ) : (
          <div
            style={{
              fontSize: 12,
              lineHeight: 1.5,
              color: "rgba(0,0,0,0.65)",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              overflow: "hidden",
              display: "-webkit-box",
              WebkitLineClamp: 8,
              WebkitBoxOrient: "vertical",
            }}
          >
            {d.previewText || (localTitle ? "" : "（空）")}
          </div>
        )}
      </div>

      {/* Click-away to exit editing */}
      {editing && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            zIndex: -1,
          }}
          onPointerDown={exitEditing}
        />
      )}

      <Handle type="source" position={Position.Right} className="map-handle" />
    </div>
  );
});
