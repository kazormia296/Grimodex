import { useState, useRef, useCallback, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useTreeStore } from "./treeStore";

interface InlineSynopsisEditProps {
  nodeId: string;
  synopsis: string | null;
  depth: number;
}

export function InlineSynopsisEdit({
  nodeId,
  synopsis,
  depth,
}: InlineSynopsisEditProps) {
  const { t } = useTranslation();
  const updateSynopsis = useTreeStore((s) => s.updateSynopsis);

  const [isEditing, setIsEditing] = useState(false);
  const [editText, setEditText] = useState(synopsis ?? "");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Refs for unmount-flush (avoid stale closures in cleanup effect)
  const editTextRef = useRef(editText);
  const synopsisRef = useRef(synopsis);
  const isEditingRef = useRef(isEditing);
  editTextRef.current = editText;
  synopsisRef.current = synopsis;
  isEditingRef.current = isEditing;

  // Sync when synopsis changes externally while not editing
  useEffect(() => {
    if (!isEditing) {
      setEditText(synopsis ?? "");
    }
  }, [synopsis, isEditing]);

  // Flush pending save on unmount (e.g. folder collapsed while editing)
  useEffect(() => {
    return () => {
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
        saveTimer.current = null;
      }
      if (isEditingRef.current) {
        const trimmed = editTextRef.current.trim();
        const original = (synopsisRef.current ?? "").trim();
        if (trimmed !== original) {
          updateSynopsis(nodeId, trimmed).catch(() => {});
        }
      }
    };
  }, [nodeId, updateSynopsis]);

  const flushSave = useCallback(() => {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
  }, []);

  const saveAndExit = useCallback(() => {
    flushSave();
    const trimmed = editText.trim();
    const original = (synopsis ?? "").trim();
    if (trimmed !== original) {
      updateSynopsis(nodeId, trimmed).catch(() => {});
    }
    setIsEditing(false);
  }, [editText, synopsis, nodeId, updateSynopsis, flushSave]);

  const cancelEdit = useCallback(() => {
    flushSave();
    setEditText(synopsis ?? "");
    setIsEditing(false);
  }, [synopsis, flushSave]);

  const startEdit = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      e.preventDefault();
      setEditText(synopsis ?? "");
      setIsEditing(true);
      setTimeout(() => {
        const ta = textareaRef.current;
        if (ta) {
          ta.focus();
          ta.select();
        }
      }, 0);
    },
    [synopsis],
  );

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
  }, []);

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const value = e.target.value;
      setEditText(value);
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        const trimmed = value.trim();
        const original = (synopsis ?? "").trim();
        if (trimmed !== original) {
          updateSynopsis(nodeId, trimmed).catch(() => {});
        }
      }, 1000);
    },
    [nodeId, synopsis, updateSynopsis],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        cancelEdit();
      } else if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        saveAndExit();
      }
    },
    [cancelEdit, saveAndExit],
  );

  const paddingLeft = `${depth * 12 + 58}px`;

  if (isEditing) {
    return (
      // biome-ignore lint/a11y/useKeyWithClickEvents: click only stops propagation
      <li
        className="list-none"
        style={{ paddingLeft, paddingBottom: 4 }}
        onClick={(e) => e.stopPropagation()}
        onMouseDown={handleMouseDown}
      >
        <textarea
          ref={textareaRef}
          value={editText}
          onChange={handleChange}
          onBlur={saveAndExit}
          onKeyDown={handleKeyDown}
          rows={2}
          className="w-full resize-none rounded border border-border bg-background px-1.5 py-0.5 text-[11px] text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-ring"
          placeholder={t("scenes.noSynopsis")}
        />
      </li>
    );
  }

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: click-to-edit pattern
    <li
      className="list-none cursor-text text-[11px] text-muted-foreground hover:bg-accent/30 rounded"
      style={{ paddingLeft, paddingBottom: 4 }}
      onClick={startEdit}
      onMouseDown={handleMouseDown}
    >
      {synopsis ?? (
        <span className="italic opacity-40">{t("scenes.noSynopsis")}</span>
      )}
    </li>
  );
}
