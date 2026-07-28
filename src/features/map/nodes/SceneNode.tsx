import { Pencil } from "lucide-react";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { NodeProps } from "@xyflow/react";
import { formatShortcut, matchesMod } from "@/lib/platform";
import { FloatingHandle } from "./FloatingHandle";
import { NodeBranchToolbar } from "./NodeBranchToolbar";
import {
  cancelPendingSynopsisSave,
  flushPendingSynopsisSave,
  schedulePendingSynopsisSave,
} from "@/features/editor/pendingSynopsisSaves";
import { toast } from "sonner";
import { useQuiescentDraftParticipant } from "@/application/lifecycle/useQuiescentDraftParticipant";
import {
  useLatestValueDraftController,
  type LatestValueDraftPersistContext,
} from "@/application/lifecycle/latestValueDraftController";
import type { QuiescenceParticipantFlushOptions } from "@/application/lifecycle/quiescenceParticipants";

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
  treeNodeId?: string;
  onTitleChange?: (
    title: string,
    context?: LatestValueDraftPersistContext,
  ) => void | Promise<void>;
  onSynopsisChange?: (synopsis: string) => void | Promise<void>;
  onOpen?: () => void;
  onBranchFrom?: (dir: "left" | "right") => void;
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
  const { t } = useTranslation();
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
          {d.wordCount.toLocaleString()} {t("common.unitChars")}
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
  const { t } = useTranslation();
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
            {t("map.sceneNode.synopsisPlaceholder")}
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
          {d.wordCount != null
            ? `${d.wordCount.toLocaleString()} ${t("common.unitChars")}`
            : ""}
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
          {t("map.sceneNode.openButton")}
        </button>
      </div>
    </div>
  );
}

// ── Title inline editor ────────────────────────────────────────────────────

function TitleEditor({
  nodeId,
  d,
  selected,
  borderColor,
  onPersist,
  onFinish,
  onCancel,
  onTab,
}: {
  nodeId: string;
  d: SceneNodeData;
  selected: boolean;
  borderColor: string;
  onPersist: (
    title: string,
    context?: LatestValueDraftPersistContext,
  ) => Promise<void>;
  onFinish: () => void;
  onCancel: () => void;
  onTab?: () => void;
}) {
  const { t } = useTranslation();
  const [value, setValue] = useState(d.title);
  const inputRef = useRef<HTMLInputElement>(null);
  const editingRef = useRef(true);
  const mountedRef = useRef(true);
  const titleController = useLatestValueDraftController(
    `map-scene-title:${nodeId}`,
    d.title,
    async (next, context) => {
      const trimmed = next.trim() || d.title;
      if (trimmed !== d.title) {
        if (context.preexistingDraft) {
          await onPersist(trimmed, context);
        } else {
          await onPersist(trimmed);
        }
      }
    },
  );

  useEffect(() => {
    mountedRef.current = true;
    inputRef.current?.focus();
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const commit = useCallback(
    async (
      afterPersist: () => void = onFinish,
      options?: QuiescenceParticipantFlushOptions,
    ): Promise<void> => {
      if (!editingRef.current) return;
      if (!titleController.latestValue.trim()) {
        titleController.reset(d.title);
      } else {
        await titleController.save(options);
      }
      if (editingRef.current) {
        editingRef.current = false;
        if (mountedRef.current) afterPersist();
      }
    },
    [d.title, onFinish, titleController],
  );

  const cancel = useCallback(() => {
    editingRef.current = false;
    titleController.reset(d.title);
    if (mountedRef.current) onCancel();
  }, [d.title, onCancel, titleController]);

  useQuiescentDraftParticipant({
    id: `map-scene-title:${nodeId}`,
    enabled: true,
    isDirty: () => editingRef.current && titleController.dirty,
    flush: (options) => commit(onFinish, options),
    discard: cancel,
    recovery: () =>
      editingRef.current && titleController.dirty
        ? {
            kind: "map-scene-title",
            sceneId: nodeId,
            title: titleController.latestValue,
          }
        : null,
  });

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
          onChange={(e) => {
            titleController.markDirty(
              e.target.value.trim() ? e.target.value : d.title,
            );
            setValue(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (e.key === "Enter") {
              e.preventDefault();
              void commit().catch(() => inputRef.current?.focus());
            }
            if (e.key === "Tab") {
              e.preventDefault();
              void commit(onTab ?? onFinish).catch(() =>
                inputRef.current?.focus(),
              );
            }
            if (e.key === "Escape") {
              e.preventDefault();
              cancel();
            }
          }}
          onBlur={() => void commit().catch(() => inputRef.current?.focus())}
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
          {d.synopsis?.trim() || t("map.sceneNode.synopsisPlaceholder")}
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
          {t("map.scene.titleEditorHint")}
        </span>
      </div>
    </div>
  );
}

// ── Synopsis inline editor ─────────────────────────────────────────────────

function SynopsisEditor({
  nodeId,
  d,
  selected,
  borderColor,
  onCommit,
  onCancel,
}: {
  nodeId: string;
  d: SceneNodeData;
  selected: boolean;
  borderColor: string;
  onCommit: (synopsis: string) => Promise<void>;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [value, setValue] = useState(d.synopsis ?? "");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const cancelledRef = useRef(false);
  const dirtyRef = useRef(false);
  const saveOwnerRef = useRef(Symbol(`map-scene-synopsis:${nodeId}`));
  const saveKey = `map-scene-synopsis\u0000${nodeId}`;
  const statusColor =
    STATUS_COLORS[d.status ?? "outline"] ?? STATUS_COLORS.outline;
  const statusCode = STATUS_CODES[d.status ?? "outline"] ?? "OU";

  useEffect(() => {
    textareaRef.current?.focus();
    return () => {
      // React cleanup cannot await. The shared synopsis registry starts the
      // pending write immediately and exposes it to strict quiescence.
      void flushPendingSynopsisSave(saveKey).catch(() => {});
    };
  }, [saveKey]);

  const commit = useCallback(async () => {
    if (cancelledRef.current) return;
    if (!dirtyRef.current) {
      onCancel();
      return;
    }
    try {
      await flushPendingSynopsisSave(saveKey);
    } catch {
      textareaRef.current?.focus();
    }
  }, [onCancel, saveKey]);

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const v = e.target.value;
      setValue(v);
      dirtyRef.current = true;
      schedulePendingSynopsisSave({
        key: saveKey,
        owner: saveOwnerRef.current,
        value: v,
        delayMs: 2000,
        persist: async (synopsis) => {
          await onCommit(synopsis);
          dirtyRef.current = false;
        },
        onError: () => {
          toast.error(
            t("tree.synopsis.saveFailed", "Synopsis の保存に失敗しました"),
          );
        },
      });
    },
    [onCommit, saveKey, t],
  );

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
        onChange={handleChange}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          if (e.key === "Escape") {
            e.preventDefault();
            cancelledRef.current = true;
            cancelPendingSynopsisSave(saveKey, saveOwnerRef.current);
            onCancel();
          }
          if (e.key === "Enter" && matchesMod(e)) {
            e.preventDefault();
            void commit();
          }
        }}
        onBlur={() => void commit()}
        onPointerDown={(e) => e.stopPropagation()}
        placeholder={t("map.sceneNode.synopsisPlaceholder")}
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
          {t("map.scene.synopsisEditorHint", {
            shortcut: formatShortcut("Ctrl+Enter"),
          })}
        </span>
      </div>
    </div>
  );
}

// ── Main SceneNode ─────────────────────────────────────────────────────────

type EditMode = "none" | "title" | "synopsis";

export const SceneNode = memo(function SceneNode({
  id,
  data,
  selected,
  isConnectable,
}: NodeProps) {
  const { t } = useTranslation();
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
    async (title: string, context?: LatestValueDraftPersistContext) => {
      await d.onTitleChange?.(title, context);
    },
    [d],
  );

  const handleSynopsisCommit = useCallback(
    async (synopsis: string) => {
      await d.onSynopsisChange?.(synopsis);
      setEditMode("none");
    },
    [d],
  );

  const handleOpen = useCallback(() => {
    d.onOpen?.();
  }, [d]);

  return (
    <div style={{ ...rotationStyle, position: "relative" }}>
      <FloatingHandle isConnectable={isConnectable} />
      <NodeBranchToolbar onBranchFrom={d.onBranchFrom} />
      <button
        type="button"
        className="map-edit-indicator"
        title={t("map.menu.openInEditor")}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          handleOpen();
        }}
      >
        <Pencil size={11} aria-hidden />
      </button>

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
          nodeId={
            typeof d.treeNodeId === "string"
              ? d.treeNodeId
              : id.replace(/^scene:/, "")
          }
          d={d}
          selected={!!selected}
          borderColor={borderColor}
          onPersist={handleTitleCommit}
          onFinish={() => setEditMode("none")}
          onCancel={() => setEditMode("none")}
          onTab={() => setEditMode("synopsis")}
        />
      )}

      {d.variant === "card" && editMode === "synopsis" && (
        <SynopsisEditor
          nodeId={
            typeof d.treeNodeId === "string"
              ? d.treeNodeId
              : id.replace(/^scene:/, "")
          }
          d={d}
          selected={!!selected}
          borderColor={borderColor}
          onCommit={handleSynopsisCommit}
          onCancel={() => setEditMode("none")}
        />
      )}
    </div>
  );
});
