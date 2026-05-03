import { useRef, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ExternalLink,
  Trash2,
  PanelLeft,
  Tag,
  ChevronRight,
  Check,
} from "lucide-react";
import { useTabStore } from "@/features/editor/tabStore";
import { useLayoutStore } from "@/features/layout/layoutStore";
import { useLabelStore } from "@/features/labels/labelStore";
import { LABEL_PALETTE } from "@/lib/labelPalette";

interface Props {
  nodeId: string;
  onClose: () => void;
  onDelete: () => void;
  anchorRef: React.RefObject<HTMLElement | null>;
}

export function GridCardMenu({ nodeId, onClose, onDelete, anchorRef }: Props) {
  const { t } = useTranslation();
  const menuRef = useRef<HTMLDivElement>(null);
  const [labelMenuOpen, setLabelMenuOpen] = useState(false);

  const allLabels = useLabelStore((s) => s.labels);
  const nodeLabels = useLabelStore((s) => s.nodeLabels);
  const assignedIds = nodeLabels[nodeId] ?? [];

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (
        menuRef.current &&
        !menuRef.current.contains(e.target as Node) &&
        anchorRef.current &&
        !anchorRef.current.contains(e.target as Node)
      ) {
        onClose();
      }
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [onClose, anchorRef]);

  function openInEditor() {
    useTabStore.getState().openPinned(nodeId);
    useLayoutStore.getState().showPanel("editor");
    onClose();
  }

  function showInScenes() {
    useLayoutStore.getState().showPanel("scenes");
    onClose();
  }

  async function handleToggleLabel(labelId: string) {
    const current = useLabelStore.getState().nodeLabels[nodeId] ?? [];
    const next = current.includes(labelId)
      ? current.filter((id) => id !== labelId)
      : [...current, labelId];
    await useLabelStore.getState().setNodeLabels(nodeId, next);
  }

  return (
    <div
      ref={menuRef}
      className="absolute right-0 top-full z-50 mt-1 min-w-[160px] rounded-md border bg-popover p-1 shadow-md text-sm"
    >
      <button
        className="flex w-full items-center gap-2 rounded px-2 py-1.5 hover:bg-accent"
        onClick={openInEditor}
      >
        <ExternalLink className="h-3.5 w-3.5" />
        {t("grid.card.menu.open", "エディタで開く")}
      </button>
      <button
        className="flex w-full items-center gap-2 rounded px-2 py-1.5 hover:bg-accent"
        onClick={showInScenes}
      >
        <PanelLeft className="h-3.5 w-3.5" />
        {t("grid.card.menu.showInScenes", "シーン一覧で表示")}
      </button>

      {/* Add label submenu */}
      {allLabels.length > 0 && (
        <div
          className="relative"
          onMouseEnter={() => setLabelMenuOpen(true)}
          onMouseLeave={() => setLabelMenuOpen(false)}
        >
          <button className="flex w-full items-center gap-2 rounded px-2 py-1.5 hover:bg-accent">
            <Tag className="h-3.5 w-3.5" />
            {t("grid.card.menu.addLabel", "Label を付ける")}
            <ChevronRight className="ml-auto h-3 w-3" />
          </button>
          {labelMenuOpen && (
            <div className="absolute right-full top-0 mr-1 min-w-[160px] rounded-md border bg-popover p-1 shadow-md">
              {allLabels.map((label) => (
                <button
                  key={label.id}
                  className="flex w-full items-center gap-2 rounded px-2 py-1.5 hover:bg-accent text-left"
                  onClick={() => void handleToggleLabel(label.id)}
                >
                  {assignedIds.includes(label.id) ? (
                    <Check className="h-3.5 w-3.5 shrink-0" />
                  ) : (
                    <span className="h-3.5 w-3.5 shrink-0" />
                  )}
                  <span
                    className="h-2.5 w-2.5 rounded-full shrink-0"
                    style={{
                      backgroundColor:
                        LABEL_PALETTE[label.color]?.light ?? "#888888",
                    }}
                  />
                  <span className="truncate">{label.name}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      <hr className="my-1 border-border" />
      <button
        className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-destructive hover:bg-accent"
        onClick={() => {
          onDelete();
          onClose();
        }}
      >
        <Trash2 className="h-3.5 w-3.5" />
        {t("grid.card.menu.delete", "削除")}
      </button>
    </div>
  );
}
