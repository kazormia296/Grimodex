import {
  useState,
  useRef,
  useCallback,
  useEffect,
  forwardRef,
  useImperativeHandle,
} from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { useTreeStore } from "@/features/tree/treeStore";
import {
  cancelPendingSynopsisSave,
  flushPendingSynopsisSave,
  schedulePendingSynopsisSave,
} from "./pendingSynopsisSaves";

export interface InlineSynopsisEditorHandle {
  startEditing: () => void;
}

interface InlineSynopsisEditorProps {
  nodeId: string;
  synopsis: string | null;
  /** When set, persists via this callback instead of updateSynopsis. */
  onSave?: (text: string) => Promise<void>;
  saveFailedLabel?: string;
  placeholder?: string;
  rows?: number;
  /** Called when edit state changes — host uses this to disable D&D */
  onEditingChange?: (isEditing: boolean) => void;
  /** Always shows textarea without a click-to-edit toggle (for Editor/detail pane use) */
  alwaysEditing?: boolean;
  /** Whether single click or double click triggers edit mode. Default: "click" */
  triggerOn?: "click" | "doubleClick";
  className?: string;
  textareaClassName?: string;
}

export const InlineSynopsisEditor = forwardRef<
  InlineSynopsisEditorHandle,
  InlineSynopsisEditorProps
>(function InlineSynopsisEditor(
  {
    nodeId,
    synopsis,
    onSave,
    saveFailedLabel,
    placeholder,
    rows = 2,
    onEditingChange,
    alwaysEditing = false,
    triggerOn = "click",
    className,
    textareaClassName,
  },
  ref,
) {
  const { t } = useTranslation();
  const updateSynopsis = useTreeStore((s) => s.updateSynopsis);
  const saveOwnerRef = useRef(Symbol(`inline-synopsis:${nodeId}`));
  const latestScheduledValueRef = useRef<string | null>(null);
  const hasQueuedSaveRef = useRef(false);
  const persist = useCallback(
    async (text: string) => {
      await (onSave ? onSave(text) : updateSynopsis(nodeId, text));
      if (latestScheduledValueRef.current === text) {
        latestScheduledValueRef.current = null;
        hasQueuedSaveRef.current = false;
      }
    },
    [onSave, updateSynopsis, nodeId],
  );
  const saveKey = [
    onSave ? "custom-inline-synopsis" : "tree-synopsis",
    nodeId,
  ].join("\u0000");

  const [isEditing, setIsEditing] = useState(alwaysEditing);
  const [editText, setEditText] = useState(synopsis ?? "");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const composingRef = useRef(false);
  const synopsisRef = useRef(synopsis);
  const mountedRef = useRef(false);
  const activeSaveKeyRef = useRef(saveKey);
  synopsisRef.current = synopsis;
  activeSaveKeyRef.current = saveKey;

  // Sync when synopsis changes externally (also in alwaysEditing mode for AI-generated values)
  useEffect(() => {
    const shouldSyncExternalValue =
      !isEditing || (alwaysEditing && !hasQueuedSaveRef.current);
    if (shouldSyncExternalValue) {
      cancelPendingSynopsisSave(saveKey, saveOwnerRef.current);
      latestScheduledValueRef.current = null;
      hasQueuedSaveRef.current = false;
      setEditText(synopsis ?? "");
    }
  }, [synopsis, isEditing, alwaysEditing, saveKey]);

  // Notify host of editing state changes
  useEffect(() => {
    onEditingChange?.(isEditing);
  }, [isEditing, onEditingChange]);

  const reportSaveFailure = useCallback(
    (_error: unknown) => {
      if (!mountedRef.current || activeSaveKeyRef.current !== saveKey) {
        return;
      }
      toast.error(
        saveFailedLabel ??
          t("tree.synopsis.saveFailed", "Synopsis の保存に失敗しました"),
      );
      // Keep the active editor focused so the draft remains recoverable.
      setTimeout(() => {
        if (mountedRef.current && activeSaveKeyRef.current === saveKey) {
          textareaRef.current?.focus();
        }
      }, 0);
    },
    [saveFailedLabel, saveKey, t],
  );

  // React cleanup cannot await, but the registry starts the write
  // synchronously and exposes it to strict lifecycle quiescence.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      void flushPendingSynopsisSave(saveKey).catch(() => {});
    };
  }, [saveKey]);

  const saveAndExit = useCallback(async () => {
    try {
      await flushPendingSynopsisSave(saveKey);
    } catch {
      return; // stay in editing mode
    }
    latestScheduledValueRef.current = null;
    hasQueuedSaveRef.current = false;
    setIsEditing(false);
  }, [saveKey]);

  const cancelEdit = useCallback(() => {
    cancelPendingSynopsisSave(saveKey, saveOwnerRef.current);
    latestScheduledValueRef.current = null;
    hasQueuedSaveRef.current = false;
    setEditText(synopsis ?? "");
    setIsEditing(false);
  }, [synopsis, saveKey]);

  const startEditing = useCallback(() => {
    setEditText(synopsis ?? "");
    setIsEditing(true);
    setTimeout(() => {
      const ta = textareaRef.current;
      if (ta) {
        ta.focus();
        ta.select();
      }
    }, 0);
  }, [synopsis]);

  useImperativeHandle(ref, () => ({ startEditing }), [startEditing]);

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const value = e.target.value;
      setEditText(value);
      const trimmed = value.trim();
      const original = (synopsisRef.current ?? "").trim();
      if (trimmed === original && !hasQueuedSaveRef.current) {
        cancelPendingSynopsisSave(saveKey, saveOwnerRef.current);
        return;
      }
      latestScheduledValueRef.current = trimmed;
      hasQueuedSaveRef.current = true;
      schedulePendingSynopsisSave({
        key: saveKey,
        owner: saveOwnerRef.current,
        value: trimmed,
        persist,
        onError: reportSaveFailure,
      });
    },
    [persist, reportSaveFailure, saveKey],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Escape" && !alwaysEditing) {
        e.preventDefault();
        cancelEdit();
        return;
      }
      if (e.key === "Enter" && !e.shiftKey && !alwaysEditing) {
        if (composingRef.current) return; // suppress IME commit Enter
        e.preventDefault();
        saveAndExit();
      }
    },
    [alwaysEditing, cancelEdit, saveAndExit],
  );

  const handleBlur = useCallback(() => {
    if (alwaysEditing) {
      // Flush pending debounce immediately on blur (no exit)
      void flushPendingSynopsisSave(saveKey).catch(() => {});
      return;
    }
    void saveAndExit();
  }, [alwaysEditing, saveAndExit, saveKey]);

  const handleTriggerEvent = useCallback(
    (e: React.MouseEvent) => {
      if (alwaysEditing || isEditing) return;
      e.stopPropagation();
      e.preventDefault();
      startEditing();
    },
    [alwaysEditing, isEditing, startEditing],
  );

  const resolvedPlaceholder = placeholder ?? t("scenes.noSynopsis");

  const textarea = (
    <textarea
      ref={textareaRef}
      value={editText}
      onChange={handleChange}
      onBlur={handleBlur}
      onKeyDown={handleKeyDown}
      onCompositionStart={() => {
        composingRef.current = true;
      }}
      onCompositionEnd={() => {
        composingRef.current = false;
      }}
      onMouseDown={(e) => e.stopPropagation()}
      rows={rows}
      placeholder={resolvedPlaceholder}
      className={
        textareaClassName ??
        "w-full resize-none rounded border border-border bg-background px-1.5 py-0.5 text-[11px] text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-ring"
      }
    />
  );

  if (alwaysEditing) {
    return <div className={className}>{textarea}</div>;
  }

  if (isEditing) {
    return (
      // biome-ignore lint/a11y/useKeyWithClickEvents: click stops propagation only
      <div
        className={className}
        onClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {textarea}
      </div>
    );
  }

  if (triggerOn === "doubleClick") {
    return (
      // biome-ignore lint/a11y/useKeyWithClickEvents: dblclick-to-edit pattern
      <div
        className={className}
        onDoubleClick={handleTriggerEvent}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {synopsis ? (
          <span>{synopsis}</span>
        ) : (
          <span className="italic opacity-40">{resolvedPlaceholder}</span>
        )}
      </div>
    );
  }

  // triggerOn === "click"
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: click-to-edit pattern
    <div
      className={className}
      onClick={handleTriggerEvent}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {synopsis ? (
        <span>{synopsis}</span>
      ) : (
        <span className="italic opacity-40">{resolvedPlaceholder}</span>
      )}
    </div>
  );
});
