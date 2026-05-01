import { useRef, useEffect, useState } from "react";

interface Props {
  anchorX: number;
  anchorY: number;
  /** Initial text pre-filled with @entryName (may be empty for header-based add) */
  initialText: string;
  onConfirm: (text: string) => void;
  onClose: () => void;
}

/**
 * Inline beat-text input popover. Matches Grid's inline beat-add UX.
 */
export function BeatPopover({
  anchorX,
  anchorY,
  initialText,
  onConfirm,
  onClose,
}: Props) {
  const [value, setValue] = useState(initialText);
  const inputRef = useRef<HTMLInputElement>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    // Place cursor at end
    const len = initialText.length;
    inputRef.current?.setSelectionRange(len, len);

    function onOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("mousedown", onOutside);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onOutside);
      document.removeEventListener("keydown", onKey);
    };
  }, [initialText, onClose]);

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      const trimmed = value.trim();
      if (trimmed) onConfirm(trimmed);
      else onClose();
    }
    if (e.key === "Escape") onClose();
  }

  return (
    <div
      ref={ref}
      className="fixed z-50 w-64 rounded-md border border-border bg-popover p-2 shadow-md"
      style={{ left: anchorX, top: anchorY }}
    >
      <p className="mb-1 text-[10px] text-muted-foreground">
        Add beat (Enter to confirm)
      </p>
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
        className="w-full rounded border border-border bg-background px-2 py-1 text-xs outline-none"
        placeholder="Beat content…"
      />
    </div>
  );
}
