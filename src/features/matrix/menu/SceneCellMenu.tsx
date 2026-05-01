import { useRef, useEffect } from "react";
import type { CellSource } from "../lib/deriveCells";

interface Props {
  x: number;
  y: number;
  sceneId: string;
  sceneName: string;
  entryId: string;
  entryName: string;
  source: CellSource | undefined;
  onClose: () => void;
  onOpenScene: () => void;
  onPin: () => void;
  onRemovePin: () => void;
  onAddBeat: () => void;
}

const SOURCE_LABEL: Record<CellSource, string> = {
  body: "本文言及",
  beat: "Beat メンション",
  relation: "明示リレーション",
};

export function SceneCellMenu({
  x,
  y,
  sceneName,
  entryName,
  source,
  onClose,
  onOpenScene,
  onPin,
  onRemovePin,
  onAddBeat,
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

  const items = [
    { label: `Open scene: ${sceneName}`, action: onOpenScene },
    source !== "relation"
      ? { label: `Pin to scene (@${entryName})`, action: onPin }
      : null,
    source === "relation"
      ? { label: "Remove association", action: onRemovePin }
      : null,
    { label: `Add beat (with @${entryName})`, action: onAddBeat },
    source
      ? {
          label: `Show source: ${SOURCE_LABEL[source]}`,
          action: () => {
            /* Phase B: show detail modal */
            onClose();
          },
        }
      : null,
  ].filter(Boolean) as { label: string; action: () => void }[];

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
