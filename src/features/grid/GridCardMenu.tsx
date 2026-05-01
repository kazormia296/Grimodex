import { useRef, useEffect } from "react";
import { useTranslation } from "react-i18next";
import {
  ExternalLink,
  Pencil,
  Trash2,
  PanelLeft,
  PlusCircle,
} from "lucide-react";
import { useTreeStore } from "@/features/tree/treeStore";
import { useTabStore } from "@/features/editor/tabStore";
import { useLayoutStore } from "@/features/layout/layoutStore";

interface Props {
  nodeId: string;
  onClose: () => void;
  onRename: () => void;
  onAddBeat: () => void;
  anchorRef: React.RefObject<HTMLElement | null>;
}

export function GridCardMenu({
  nodeId,
  onClose,
  onRename,
  onAddBeat,
  anchorRef,
}: Props) {
  const { t } = useTranslation();
  const menuRef = useRef<HTMLDivElement>(null);
  const deleteNode = useTreeStore((s) => s.deleteNode);

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

  async function handleDelete() {
    if (
      confirm(t("grid.card.menu.deleteConfirm", "このシーンを削除しますか？"))
    ) {
      await deleteNode(nodeId);
    }
    onClose();
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
        onClick={() => {
          onRename();
          onClose();
        }}
      >
        <Pencil className="h-3.5 w-3.5" />
        {t("grid.card.menu.rename", "名前を変更")}
      </button>
      <button
        className="flex w-full items-center gap-2 rounded px-2 py-1.5 hover:bg-accent"
        onClick={() => {
          onAddBeat();
          onClose();
        }}
      >
        <PlusCircle className="h-3.5 w-3.5" />
        {t("grid.card.menu.addBeat", "+ Beat を追加…")}
      </button>
      <button
        className="flex w-full items-center gap-2 rounded px-2 py-1.5 hover:bg-accent"
        onClick={showInScenes}
      >
        <PanelLeft className="h-3.5 w-3.5" />
        {t("grid.card.menu.showInScenes", "シーン一覧で表示")}
      </button>
      <hr className="my-1 border-border" />
      <button
        className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-destructive hover:bg-accent"
        onClick={() => void handleDelete()}
      >
        <Trash2 className="h-3.5 w-3.5" />
        {t("grid.card.menu.delete", "削除")}
      </button>
    </div>
  );
}
