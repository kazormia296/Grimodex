import { useRef, useEffect } from "react";
import { useTranslation } from "react-i18next";
import type { CellSource } from "../lib/deriveCells";

interface Props {
  x: number;
  y: number;
  sceneId: string;
  sceneName: string;
  entryId: string;
  entryName: string;
  source: CellSource | undefined;
  /** Relation can coexist with a stronger visual source such as semantic. */
  hasRelationPin?: boolean;
  onClose: () => void;
  onOpenScene: () => void;
  onPin: () => void;
  onRemovePin: () => void;
  onAddBeat: () => void;
  onShowInGrid: () => void;
}

export function SceneCellMenu({
  x,
  y,
  sceneName,
  entryName,
  source,
  hasRelationPin,
  onClose,
  onOpenScene,
  onPin,
  onRemovePin,
  onAddBeat,
  onShowInGrid,
}: Props) {
  const { t } = useTranslation();
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

  // Only source='relation' represents a removable scene pin. A semantic link
  // is owned by the editor mark and must never be routed through pin removal.
  const isRelationPin = hasRelationPin ?? source === "relation";

  const items = [
    { label: `Open scene: ${sceneName}`, action: onOpenScene },
    { label: "Show in Grid", action: onShowInGrid },
    !isRelationPin
      ? { label: `Pin to scene (@${entryName})`, action: onPin }
      : null,
    isRelationPin ? { label: "Remove association", action: onRemovePin } : null,
    { label: `Add beat (with @${entryName})`, action: onAddBeat },
    source
      ? {
          label: `Show source: ${t(`matrix.sources.${source}`)}`,
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
