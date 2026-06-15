import { useRef, useEffect } from "react";
import { useTranslation } from "react-i18next";

interface Props {
  x: number;
  y: number;
  entryName: string;
  entryType: string;
  isPinned: boolean;
  isSectionCollapsed: boolean;
  onClose: () => void;
  onTogglePin: () => void;
  onHide: () => void;
  onToggleTypeSection: () => void;
  onRemoveFromSet?: () => void;
}

export function ColumnHeaderMenu({
  x,
  y,
  entryName,
  entryType,
  isPinned,
  isSectionCollapsed,
  onClose,
  onTogglePin,
  onHide,
  onToggleTypeSection,
  onRemoveFromSet,
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

  const items = [
    {
      label: isPinned
        ? t("matrix.columnMenu.unpin", "ピン解除: {{name}}", {
            name: entryName,
          })
        : t("matrix.columnMenu.pinFirst", "先頭にピン: {{name}}", {
            name: entryName,
          }),
      action: onTogglePin,
    },
    {
      label: t("matrix.columnMenu.hideColumn", "列を非表示: {{name}}", {
        name: entryName,
      }),
      action: onHide,
    },
    {
      label: isSectionCollapsed
        ? t("matrix.columnMenu.expandSection", "「{{type}}」セクションを展開", {
            type: entryType,
          })
        : t(
            "matrix.columnMenu.collapseSection",
            "「{{type}}」セクションを折りたたむ",
            { type: entryType },
          ),
      action: onToggleTypeSection,
    },
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
      {onRemoveFromSet && (
        <>
          <div className="my-1 border-t border-border/50" />
          <button
            type="button"
            className="block w-full px-3 py-1.5 text-left text-xs text-destructive hover:bg-accent"
            onClick={() => {
              onRemoveFromSet();
              onClose();
            }}
          >
            {t("matrix.custom.removeFromSet", "セットから削除")}
          </button>
        </>
      )}
    </div>
  );
}
