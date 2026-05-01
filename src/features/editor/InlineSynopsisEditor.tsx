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

export interface InlineSynopsisEditorHandle {
  startEditing: () => void;
}

interface InlineSynopsisEditorProps {
  nodeId: string;
  synopsis: string | null;
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

  const [isEditing, setIsEditing] = useState(alwaysEditing);
  const [editText, setEditText] = useState(synopsis ?? "");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const composingRef = useRef(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Refs for unmount-flush (avoid stale closures)
  const editTextRef = useRef(editText);
  const synopsisRef = useRef(synopsis);
  const isEditingRef = useRef(isEditing);
  editTextRef.current = editText;
  synopsisRef.current = synopsis;
  isEditingRef.current = isEditing;

  // Sync when synopsis changes externally (also in alwaysEditing mode for AI-generated values)
  useEffect(() => {
    if (!isEditing || alwaysEditing) {
      setEditText(synopsis ?? "");
    }
  }, [synopsis, isEditing, alwaysEditing]);

  // Notify host of editing state changes
  useEffect(() => {
    onEditingChange?.(isEditing);
  }, [isEditing, onEditingChange]);

  // Flush pending save on unmount (e.g. card collapsed while editing)
  useEffect(() => {
    return () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      if (isEditingRef.current && !alwaysEditing) {
        const trimmed = editTextRef.current.trim();
        const original = (synopsisRef.current ?? "").trim();
        if (trimmed !== original) {
          updateSynopsis(nodeId, trimmed).catch(() => {});
        }
      }
    };
  }, [nodeId, updateSynopsis, alwaysEditing]);

  const clearSaveTimer = useCallback(() => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
  }, []);

  const doSave = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      const original = (synopsis ?? "").trim();
      if (trimmed === original) return;
      try {
        await updateSynopsis(nodeId, trimmed);
      } catch {
        toast.error(
          t("tree.synopsis.saveFailed", "Synopsis の保存に失敗しました"),
        );
        // Keep in editing state on failure (re-focus textarea)
        setTimeout(() => textareaRef.current?.focus(), 0);
        throw new Error("save failed");
      }
    },
    [nodeId, synopsis, updateSynopsis, t],
  );

  const saveAndExit = useCallback(async () => {
    clearSaveTimer();
    try {
      await doSave(editText);
    } catch {
      return; // stay in editing mode
    }
    setIsEditing(false);
  }, [editText, doSave, clearSaveTimer]);

  const cancelEdit = useCallback(() => {
    clearSaveTimer();
    setEditText(synopsis ?? "");
    setIsEditing(false);
  }, [synopsis, clearSaveTimer]);

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
      clearSaveTimer();
      saveTimerRef.current = setTimeout(() => {
        const trimmed = value.trim();
        const original = (synopsis ?? "").trim();
        if (trimmed !== original) {
          updateSynopsis(nodeId, trimmed).catch(() => {});
        }
      }, 1000);
    },
    [nodeId, synopsis, updateSynopsis, clearSaveTimer],
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
      clearSaveTimer();
      const trimmed = editText.trim();
      const original = (synopsis ?? "").trim();
      if (trimmed !== original) {
        updateSynopsis(nodeId, trimmed).catch(() => {});
      }
      return;
    }
    saveAndExit();
  }, [
    alwaysEditing,
    editText,
    synopsis,
    nodeId,
    updateSynopsis,
    clearSaveTimer,
    saveAndExit,
  ]);

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
