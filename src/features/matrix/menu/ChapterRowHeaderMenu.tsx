import { useRef, useEffect } from "react";

interface Props {
  x: number;
  y: number;
  chapterName: string;
  isCollapsed: boolean;
  onClose: () => void;
  onAddScene: () => void;
  onRename: () => void;
  onShowInScenes: () => void;
  onToggleCollapse: () => void;
}

export function ChapterRowHeaderMenu({
  x,
  y,
  chapterName,
  isCollapsed,
  onClose,
  onAddScene,
  onRename,
  onShowInScenes,
  onToggleCollapse,
}: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
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
  }, [onClose]);

  const items = [
    { label: `Add scene to ${chapterName}`, action: onAddScene },
    { label: "Rename chapter", action: onRename },
    { label: "Show in Scenes panel", action: onShowInScenes },
    { label: isCollapsed ? "Expand" : "Collapse", action: onToggleCollapse },
  ];

  return (
    <div
      ref={ref}
      className="fixed z-50 min-w-[200px] rounded-md border border-border bg-popover py-1 shadow-md"
      style={{ left: x, top: y }}
    >
      {items.map((item) => (
        <button
          key={item.label}
          type="button"
          className="block w-full px-3 py-1.5 text-left text-xs hover:bg-accent"
          onClick={() => {
            item.action();
            onClose();
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
