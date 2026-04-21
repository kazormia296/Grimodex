import { memo, useCallback, useEffect, useRef, useState } from "react";
import { Handle, Position } from "@xyflow/react";
import type { NodeProps } from "@xyflow/react";

export interface SceneNodeData {
  title: string;
  synopsis?: string | null;
  chapterLabel?: string;
  status?: string;
  wordCount?: number;
  variant: "compact" | "card" | "image";
  colorBy: "none" | "status";
  corkboardFeel?: boolean;
  rotation?: number;
  onTitleChange?: (title: string) => void;
  onSynopsisChange?: (synopsis: string) => void;
  onOpen?: () => void;
  [key: string]: unknown;
}

const STATUS_COLORS: Record<string, string> = {
  outline: "#888780",
  draft: "#EF9F27",
  complete: "#1D9E75",
  revision: "#7F77DD",
  final: "#22a06b",
};

const STATUS_CODES: Record<string, string> = {
  outline: "OU",
  draft: "DR",
  complete: "CP",
  revision: "RV",
  final: "FN",
};

// ── Compact variant ────────────────────────────────────────────────────────

function CompactScene({
  d,
  selected,
  borderColor,
}: {
  d: SceneNodeData;
  selected: boolean;
  borderColor: string;
}) {
  const statusColor =
    STATUS_COLORS[d.status ?? "outline"] ?? STATUS_COLORS.outline;

  return (
    <div
      style={{
        width: 180,
        background: "var(--card)",
        border: `2px solid ${selected ? "#534AB7" : borderColor}`,
        borderRadius: 6,
        padding: "6px 10px",
        boxShadow: selected
          ? "0 0 0 2px rgba(83,74,183,0.3)"
          : "0 1px 3px rgba(0,0,0,0.12)",
        cursor: "default",
        userSelect: "none",
        fontSize: 12,
        lineHeight: 1.4,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          marginBottom: 2,
        }}
      >
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: statusColor,
            flexShrink: 0,
          }}
        />
        <span
          style={{
            fontWeight: 600,
            color: "var(--muted-foreground)",
            fontSize: 11,
          }}
        >
          {d.chapterLabel ?? ""}
        </span>
      </div>
      <div
        style={{
          fontWeight: 500,
          color: "var(--card-foreground)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
        title={d.title}
      >
        {d.title}
      </div>
      {d.wordCount != null && (
        <div
          style={{
            marginTop: 4,
            color: "var(--muted-foreground)",
            fontSize: 11,
          }}
        >
          {d.wordCount.toLocaleString()} chars
        </div>
      )}
    </div>
  );
}

// ── Card variant ───────────────────────────────────────────────────────────

function CardScene({
  d,
  selected,
  borderColor,
  onTitleDoubleClick,
  onSynopsisDoubleClick,
  onOpen,
}: {
  d: SceneNodeData;
  selected: boolean;
  borderColor: string;
  onTitleDoubleClick: () => void;
  onSynopsisDoubleClick: () => void;
  onOpen: () => void;
}) {
  const statusColor =
    STATUS_COLORS[d.status ?? "outline"] ?? STATUS_COLORS.outline;
  const statusCode = STATUS_CODES[d.status ?? "outline"] ?? "OU";

  const synopsisText = d.synopsis?.trim() ?? "";
  const hasSynopsis = synopsisText.length > 0;

  return (
    <div
      style={{
        width: 260,
        background: "var(--card)",
        border: `2px solid ${selected ? "#534AB7" : borderColor}`,
        borderRadius: 6,
        boxShadow: selected
          ? "0 0 0 2px rgba(83,74,183,0.3)"
          : "0 2px 6px rgba(0,0,0,0.14)",
        cursor: "default",
        userSelect: "none",
        fontSize: 12,
        lineHeight: 1.4,
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      {/* Header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "6px 10px",
          borderBottom: "1px solid var(--border)",
          gap: 4,
        }}
        onDoubleClick={(e) => {
          e.stopPropagation();
          onTitleDoubleClick();
        }}
      >
        <span
          style={{
            fontWeight: 600,
            color: "var(--card-foreground)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            flex: 1,
          }}
          title={d.title}
        >
          {d.title}
        </span>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 4,
            flexShrink: 0,
          }}
        >
          {d.chapterLabel && (
            <span
              style={{
                fontSize: 10,
                color: "var(--muted-foreground)",
                fontWeight: 500,
              }}
            >
              {d.chapterLabel}
            </span>
          )}
          {/* Status stamp */}
          <span
            style={{
              fontSize: 10,
              fontWeight: 700,
              color: statusColor,
              letterSpacing: 0.5,
            }}
          >
            {statusCode}
          </span>
          <span
            style={{
              width: 7,
              height: 7,
              borderRadius: "50%",
              background: statusColor,
              display: "inline-block",
              flexShrink: 0,
            }}
          />
        </div>
      </div>

      {/* Synopsis area */}
      <div
        style={{
          padding: "8px 10px",
          flex: 1,
          minHeight: 80,
          cursor: "text",
        }}
        onDoubleClick={(e) => {
          e.stopPropagation();
          onSynopsisDoubleClick();
        }}
      >
        {hasSynopsis ? (
          <p
            style={{
              margin: 0,
              fontFamily: "Georgia, 'Times New Roman', serif",
              fontSize: 12,
              lineHeight: 1.6,
              color: "var(--card-foreground)",
              display: "-webkit-box",
              WebkitLineClamp: 4,
              WebkitBoxOrient: "vertical",
              overflow: "hidden",
            }}
          >
            {synopsisText}
          </p>
        ) : (
          <p
            style={{
              margin: 0,
              fontFamily: "Georgia, 'Times New Roman', serif",
              fontSize: 12,
              lineHeight: 1.6,
              color: "var(--muted-foreground)",
              fontStyle: "italic",
            }}
          >
            What happens in this scene?
          </p>
        )}
      </div>

      {/* Footer */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "4px 10px",
          borderTop: "1px solid var(--border)",
          background: "var(--muted)",
        }}
      >
        <span style={{ fontSize: 10, color: "var(--muted-foreground)" }}>
          {d.wordCount != null ? `${d.wordCount.toLocaleString()}字` : ""}
        </span>
        <button
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onOpen();
          }}
          style={{
            fontSize: 10,
            padding: "1px 6px",
            borderRadius: 3,
            border: "1px solid var(--border)",
            background: "transparent",
            color: "var(--muted-foreground)",
            cursor: "pointer",
          }}
        >
          Open↗
        </button>
      </div>
    </div>
  );
}

// ── Title inline editor ────────────────────────────────────────────────────

function TitleEditor({
  d,
  selected,
  borderColor,
  onCommit,
  onCancel,
}: {
  d: SceneNodeData;
  selected: boolean;
  borderColor: string;
  onCommit: (title: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(d.title);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const commit = useCallback(() => {
    const trimmed = value.trim();
    onCommit(trimmed || d.title);
  }, [value, d.title, onCommit]);

  return (
    <div
      style={{
        width: 260,
        background: "var(--card)",
        border: `2px solid ${selected ? "#534AB7" : borderColor}`,
        borderRadius: 6,
        boxShadow: "0 2px 6px rgba(0,0,0,0.14)",
        userSelect: "none",
        fontSize: 12,
        overflow: "hidden",
      }}
    >
      <div
        style={{ padding: "6px 10px", borderBottom: "1px solid var(--border)" }}
      >
        <input
          ref={inputRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commit();
            }
            if (e.key === "Escape") {
              e.preventDefault();
              onCancel();
            }
          }}
          onBlur={commit}
          onPointerDown={(e) => e.stopPropagation()}
          style={{
            width: "100%",
            border: "none",
            outline: "none",
            background: "transparent",
            fontWeight: 600,
            color: "var(--card-foreground)",
            fontSize: 12,
          }}
        />
      </div>
      <div style={{ padding: "8px 10px", minHeight: 80 }}>
        <p
          style={{
            margin: 0,
            color: "var(--muted-foreground)",
            fontStyle: "italic",
            fontSize: 12,
          }}
        >
          {d.synopsis?.trim() || "What happens in this scene?"}
        </p>
      </div>
      <div
        style={{
          padding: "4px 10px",
          borderTop: "1px solid var(--border)",
          background: "var(--muted)",
        }}
      >
        <span style={{ fontSize: 10, color: "var(--muted-foreground)" }}>
          Enter で確定 · Esc でキャンセル
        </span>
      </div>
    </div>
  );
}

// ── Synopsis inline editor ─────────────────────────────────────────────────

function SynopsisEditor({
  d,
  selected,
  borderColor,
  onCommit,
  onCancel,
}: {
  d: SceneNodeData;
  selected: boolean;
  borderColor: string;
  onCommit: (synopsis: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(d.synopsis ?? "");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const statusColor =
    STATUS_COLORS[d.status ?? "outline"] ?? STATUS_COLORS.outline;
  const statusCode = STATUS_CODES[d.status ?? "outline"] ?? "OU";

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  const commit = useCallback(() => {
    onCommit(value);
  }, [value, onCommit]);

  return (
    <div
      style={{
        width: 260,
        background: "var(--card)",
        border: `2px solid ${selected ? "#534AB7" : borderColor}`,
        borderRadius: 6,
        boxShadow: "0 2px 6px rgba(0,0,0,0.14)",
        userSelect: "none",
        fontSize: 12,
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
      }}
    >
      {/* Header (non-editable) */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "6px 10px",
          borderBottom: "1px solid var(--border)",
          gap: 4,
        }}
      >
        <span
          style={{
            fontWeight: 600,
            color: "var(--card-foreground)",
            flex: 1,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {d.title}
        </span>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 4,
            flexShrink: 0,
          }}
        >
          {d.chapterLabel && (
            <span
              style={{
                fontSize: 10,
                color: "var(--muted-foreground)",
                fontWeight: 500,
              }}
            >
              {d.chapterLabel}
            </span>
          )}
          <span
            style={{
              fontSize: 10,
              fontWeight: 700,
              color: statusColor,
              letterSpacing: 0.5,
            }}
          >
            {statusCode}
          </span>
          <span
            style={{
              width: 7,
              height: 7,
              borderRadius: "50%",
              background: statusColor,
              display: "inline-block",
            }}
          />
        </div>
      </div>

      {/* Synopsis textarea */}
      <textarea
        ref={textareaRef}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
          if (e.key === "Enter" && e.ctrlKey) {
            e.preventDefault();
            commit();
          }
        }}
        onBlur={commit}
        onPointerDown={(e) => e.stopPropagation()}
        placeholder="What happens in this scene?"
        style={{
          resize: "none",
          border: "none",
          outline: "none",
          background: "transparent",
          fontFamily: "Georgia, 'Times New Roman', serif",
          fontSize: 12,
          lineHeight: 1.6,
          color: "var(--card-foreground)",
          padding: "8px 10px",
          minHeight: 80,
          width: "100%",
          boxSizing: "border-box",
        }}
      />

      {/* Footer */}
      <div
        style={{
          padding: "4px 10px",
          borderTop: "1px solid var(--border)",
          background: "var(--muted)",
        }}
      >
        <span style={{ fontSize: 10, color: "var(--muted-foreground)" }}>
          Ctrl+Enter で保存 · Esc でキャンセル
        </span>
      </div>
    </div>
  );
}

// ── Main SceneNode ─────────────────────────────────────────────────────────

type EditMode = "none" | "title" | "synopsis";

export const SceneNode = memo(function SceneNode({
  data,
  selected,
}: NodeProps) {
  const d = data as SceneNodeData;
  const [editMode, setEditMode] = useState<EditMode>("none");

  const statusColor =
    STATUS_COLORS[d.status ?? "outline"] ?? STATUS_COLORS.outline;

  const borderColor = d.colorBy === "status" ? statusColor : "var(--border)";

  const rotationStyle =
    d.corkboardFeel && d.rotation != null
      ? { transform: `rotate(${d.rotation}deg)` }
      : {};

  const handleTitleCommit = useCallback(
    (title: string) => {
      setEditMode("none");
      d.onTitleChange?.(title);
    },
    [d],
  );

  const handleSynopsisCommit = useCallback(
    (synopsis: string) => {
      setEditMode("none");
      d.onSynopsisChange?.(synopsis);
    },
    [d],
  );

  const handleOpen = useCallback(() => {
    d.onOpen?.();
  }, [d]);

  return (
    <div style={rotationStyle}>
      <Handle type="target" position={Position.Left} style={{ opacity: 0 }} />

      {d.variant === "compact" && (
        <CompactScene d={d} selected={!!selected} borderColor={borderColor} />
      )}

      {d.variant === "card" && editMode === "none" && (
        <CardScene
          d={d}
          selected={!!selected}
          borderColor={borderColor}
          onTitleDoubleClick={() => setEditMode("title")}
          onSynopsisDoubleClick={() => setEditMode("synopsis")}
          onOpen={handleOpen}
        />
      )}

      {d.variant === "card" && editMode === "title" && (
        <TitleEditor
          d={d}
          selected={!!selected}
          borderColor={borderColor}
          onCommit={handleTitleCommit}
          onCancel={() => setEditMode("none")}
        />
      )}

      {d.variant === "card" && editMode === "synopsis" && (
        <SynopsisEditor
          d={d}
          selected={!!selected}
          borderColor={borderColor}
          onCommit={handleSynopsisCommit}
          onCancel={() => setEditMode("none")}
        />
      )}

      <Handle type="source" position={Position.Right} style={{ opacity: 0 }} />
    </div>
  );
});
