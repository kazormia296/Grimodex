import { useRef, useEffect } from "react";

interface Props {
  x: number;
  y: number;
  sceneName: string;
  onClose: () => void;
  onOpenScene: () => void;
  onAddBeat: () => void;
  onRename: () => void;
  onShowInScenes: () => void;
  onShowInGrid: () => void;
}

export function SceneRowHeaderMenu({
  x,
  y,
  sceneName,
  onClose,
  onOpenScene,
  onAddBeat,
  onRename,
  onShowInScenes,
  onShowInGrid,
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
    { label: `Open scene: ${sceneName}`, action: onOpenScene },
    { label: "Add beat to this scene", action: onAddBeat },
    { label: "Rename scene", action: onRename },
    { label: "Show in Scenes panel", action: onShowInScenes },
    { label: "Show in Grid", action: onShowInGrid },
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
