import { useRef, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { ChevronRight, Tag, HelpCircle } from "lucide-react";

interface Props {
  onClose: () => void;
  anchorRef: React.RefObject<HTMLElement | null>;
  onManageLabels?: () => void;
}

export function GridActionsMenu({ onClose, anchorRef, onManageLabels }: Props) {
  const { t } = useTranslation();
  const menuRef = useRef<HTMLDivElement>(null);

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

  return (
    <div
      ref={menuRef}
      className="absolute right-0 top-full z-50 mt-1 min-w-[200px] rounded-md border bg-popover p-1 shadow-md text-sm"
    >
      <button
        className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-muted-foreground/50 cursor-not-allowed"
        disabled
        title={t("grid.actions.templateComingSoon", "次フェーズで実装予定")}
      >
        <Tag className="h-3.5 w-3.5" />
        {t("grid.actions.applyTemplate", "Label テンプレートを適用")}
        <ChevronRight className="ml-auto h-3 w-3" />
      </button>
      <button
        className="flex w-full items-center gap-2 rounded px-2 py-1.5 hover:bg-accent"
        onClick={() => {
          onManageLabels?.();
          onClose();
        }}
      >
        <Tag className="h-3.5 w-3.5" />
        {t("grid.actions.manageLabels", "Label を管理…")}
      </button>
      <hr className="my-1 border-border" />
      <button
        className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-muted-foreground/50 cursor-not-allowed"
        disabled
      >
        <HelpCircle className="h-3.5 w-3.5" />
        {t("grid.actions.help", "Grid の使い方")}
      </button>
    </div>
  );
}
