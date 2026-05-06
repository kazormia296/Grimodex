import {
  memo,
  useState,
  useRef,
  useCallback,
  useEffect,
  type CSSProperties,
} from "react";
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
import { resolveStickyHex } from "@/lib/stickyPalettes";
import { DURATIONS, EASINGS, useReducedMotion } from "@/lib/animation";

export interface StickyNodeData {
  id: string;
  title: string;
  body: string;
  previewText: string;
  paletteId: string;
  colorSlot: number;
  colorBy?: string;
  rotation?: number;
  isDeleting?: boolean;
  onExitComplete?: (id: string) => void;
  onUpdate?: (updates: {
    title?: string;
    body?: string;
    previewText?: string;
    paletteId?: string;
    colorSlot?: number;
  }) => Promise<void>;
  [key: string]: unknown;
}

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
  const [glueOrient, setGlueOrient] = useState<"left" | "top">("left");
  const latestBodyRef = useRef<string>(d.body);
  const measureRef = useRef<HTMLDivElement>(null);

  // Sync body from parent when not editing
  useEffect(() => {
    if (!editing) {
      latestBodyRef.current = d.body;
    }
  }, [d.body, editing]);

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

  const save = useCallback(async () => {
    const json = latestBodyRef.current;
    const preview = extractPreviewText(json);
    await (d.onUpdate?.({ body: json, previewText: preview }) ??
      updateSticky(d.id, { body: json, previewText: preview }));
  }, [d]);

  const exitEditing = useCallback(async () => {
    setEditing(false);
    await save();
  }, [save]);

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
            data-glue={glueOrient}
            style={
              {
                width: 200,
                minHeight: 52,
                maxHeight: editing ? 480 : 280,
                overflow: editing ? "auto" : "hidden",
                outline: selected ? "2px solid #534AB7" : "none",
                outlineOffset: "2px",
                cursor: editing ? "text" : "default",
                userSelect: editing ? "text" : "none",
                "--sticky-bg-light": resolveStickyHex(d.paletteId, d.colorSlot),
              } as CSSProperties
            }
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
                  {d.previewText}
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
