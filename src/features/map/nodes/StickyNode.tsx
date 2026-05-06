import { memo, useState, useRef, useCallback, useEffect } from "react";
import { motion } from "motion/react";
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
import { DURATIONS, EASINGS, useReducedMotion } from "@/lib/animation";

export interface StickyNodeData {
  id: string;
  title: string;
  body: string;
  previewText: string;
  color: StickyColor;
  colorBy?: string;
  rotation?: number;
  isDeleting?: boolean;
  onExitComplete?: (id: string) => void;
  onUpdate?: (updates: {
    title?: string;
    body?: string;
    previewText?: string;
    color?: StickyColor;
  }) => Promise<void>;
  [key: string]: unknown;
}

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

const STICKY_ANIMATE = {
  opacity: 1,
  y: 0,
  rotateX: 0,
  transition: { duration: DURATIONS.slow, ease: EASINGS.easeOut },
} as const;

const STICKY_EXIT = {
  opacity: 0,
  y: -100,
  rotate: -16,
  transition: { duration: DURATIONS.slow, ease: EASINGS.easeOut },
} as const;

const STICKY_ENTER_VARIANTS = {
  initial: { opacity: 0, y: -14, rotateX: -24 },
  animate: STICKY_ANIMATE,
  exit: STICKY_EXIT,
} as const;

const STICKY_REDUCED_VARIANTS = {
  initial: { opacity: 1, y: 0, rotateX: 0 },
  animate: STICKY_ANIMATE,
  exit: STICKY_EXIT,
} as const;

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
  const rotation = d.rotation ?? 0;
  const isDeleting = d.isDeleting ?? false;
  const reducedMotion = useReducedMotion();
  const enterVariants = reducedMotion
    ? STICKY_REDUCED_VARIANTS
    : STICKY_ENTER_VARIANTS;
  const exitFiredRef = useRef(false);

  const [editing, setEditing] = useState(false);
  const [localTitle, setLocalTitle] = useState(d.title);
  const [localColor, setLocalColor] = useState<StickyColor>(d.color);
  const [showColorPicker, setShowColorPicker] = useState(false);
  const [glueOrient, setGlueOrient] = useState<"left" | "top">("left");
  const latestBodyRef = useRef<string>(d.body);
  const titleRef = useRef<string>(d.title);
  const measureRef = useRef<HTMLDivElement>(null);

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
      setEditing(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ResizeObserver: switch glue side based on content height with hysteresis
  // left→top at >= 110px, top→left at <= 90px (dead band avoids oscillation)
  useEffect(() => {
    const el = measureRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const h = entry.contentRect.height;
      setGlueOrient((prev) => {
        if (prev === "left" && h >= 110) return "top";
        if (prev === "top" && h <= 90) return "left";
        return prev;
      });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

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

      {/* motion wrapper: enter/exit animation. transformOrigin switches on delete. */}
      <motion.div
        data-testid="sticky-motion"
        initial={enterVariants.initial}
        animate={isDeleting ? enterVariants.exit : enterVariants.animate}
        style={{ transformOrigin: isDeleting ? "100% 100%" : "50% 0%" }}
        onAnimationComplete={() => {
          if (isDeleting && !exitFiredRef.current) {
            exitFiredRef.current = true;
            d.onExitComplete?.(d.id);
          }
        }}
      >
        {/* sticky-paper-wrap: carries rotation. */}
        <div
          data-testid="sticky-paper-wrap"
          style={{ position: "relative", transform: `rotate(${rotation}deg)` }}
        >
          <div
            data-testid="sticky-paper"
            className="sticky-paper"
            data-color={localColor}
            data-glue={glueOrient}
            style={{
              width: 240,
              minHeight: 80,
              maxHeight: editing ? 600 : 300,
              overflow: editing ? "auto" : "hidden",
              border: `1.5px solid ${selected ? "#534AB7" : borderColor}`,
              outline: selected ? "2px solid rgba(83,74,183,0.3)" : "none",
              outlineOffset: "1px",
              cursor: editing ? "text" : "default",
              userSelect: editing ? "text" : "none",
            }}
            onDoubleClick={(e) => {
              if (!editing) {
                e.stopPropagation();
                setEditing(true);
              }
            }}
          >
            {/* Content area measured by ResizeObserver */}
            <div
              ref={measureRef}
              data-testid="sticky-content"
              className="sticky-content"
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
                    background: `var(--sticky-bg-${localColor}, #FEF9C3)`,
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
                        background: `var(--sticky-bg-${c}, #FEF9C3)`,
                        cursor: "pointer",
                        padding: 0,
                      }}
                      title={c}
                    />
                  ))}
                </div>
              )}

              {/* Body */}
              {editing ? (
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
          </div>
        </div>
      </motion.div>

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
