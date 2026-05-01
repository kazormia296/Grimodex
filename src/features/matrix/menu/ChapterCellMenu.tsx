import { useRef, useEffect } from "react";

interface Props {
  x: number;
  y: number;
  chapterName: string;
  entryName: string | null;
  onClose: () => void;
  onAddSceneWithEntry: () => void;
  onAddSceneNoEntry: () => void;
  onOpenInScenes: () => void;
}

export function ChapterCellMenu({
  x,
  y,
  chapterName,
  entryName,
  onClose,
  onAddSceneWithEntry,
  onAddSceneNoEntry,
  onOpenInScenes,
}: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="fixed z-50 min-w-[220px] rounded-md border border-border bg-popover py-1 shadow-md"
      style={{ left: x, top: y }}
    >
      {entryName && (
        <button
          type="button"
          className="block w-full px-3 py-1.5 text-left text-xs hover:bg-accent"
          onClick={() => {
            onAddSceneWithEntry();
            onClose();
          }}
        >
          Add scene to {chapterName} (with @{entryName})
        </button>
      )}
      <button
        type="button"
        className="block w-full px-3 py-1.5 text-left text-xs hover:bg-accent"
        onClick={() => {
          onAddSceneNoEntry();
          onClose();
        }}
      >
        Add scene to {chapterName} (no association)
      </button>
      <div className="my-0.5 border-t border-border/50" />
      <button
        type="button"
        className="block w-full px-3 py-1.5 text-left text-xs hover:bg-accent"
        onClick={() => {
          onOpenInScenes();
          onClose();
        }}
      >
        Open chapter folder in Scenes panel
      </button>
    </div>
  );
}
