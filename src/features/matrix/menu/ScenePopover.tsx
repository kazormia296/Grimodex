import { useRef, useEffect, useState } from "react";

interface Props {
  /** Anchor position (cell top-left) */
  anchorX: number;
  anchorY: number;
  onConfirm: (synopsis: string) => void;
  onAddAnother: (synopsis: string) => void;
  onClose: () => void;
}

/**
 * Inline Synopsis input popover shown immediately after a new Scene is created
 * from a Chapter row cell. Matches the beat-add popover UX pattern.
 */
export function ScenePopover({
  anchorX,
  anchorY,
  onConfirm,
  onAddAnother,
  onClose,
}: Props) {
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    function onOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onConfirm(value);
      }
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
  }, [onClose, onConfirm, value]);

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      onConfirm(value);
    }
    if (e.key === "Escape") {
      onClose();
    }
  }

  return (
    <div
      ref={ref}
      className="fixed z-50 w-64 rounded-md border border-border bg-popover p-2 shadow-md"
      style={{ left: anchorX, top: anchorY }}
    >
      <p className="mb-1 text-[10px] text-muted-foreground">
        Synopsis (optional)
      </p>
      <textarea
        ref={inputRef}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
        rows={2}
        className="w-full resize-none rounded border border-border bg-background px-2 py-1 text-xs outline-none"
        placeholder="Enter synopsis…"
      />
      <div className="mt-1.5 flex justify-between gap-1">
        <button
          type="button"
          onClick={() => onAddAnother(value)}
          className="rounded border border-border px-2 py-0.5 text-[10px] hover:bg-accent"
        >
          Add another scene
        </button>
        <button
          type="button"
          onClick={() => onConfirm(value)}
          className="rounded bg-primary px-2 py-0.5 text-[10px] text-primary-foreground"
        >
          Done
        </button>
      </div>
    </div>
  );
}
